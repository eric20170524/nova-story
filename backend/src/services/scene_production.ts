import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, withImmediateTransaction } from '../db/database';
import { ScriptDocumentSchema } from '../schemas/script';
import { ContinuityReadSchema, type ContinuityRead } from '../schemas/continuity_snapshot';
import { loadContinuityLedger, currentContinuitySnapshot, bindContinuityShotInTransaction, continuitySourceFingerprint, ContinuityStoreError } from './continuity_store';
import { continuityHash, readContinuityMoment } from './continuity_replay';
import { continuityVisualStates } from './continuity_visual_state';
import { actionBindingSource, entityRoster, needsBindingReview, boundVisibleEntities, validateBinding } from './entity_binding';
import { packShotSpec } from '../schemas/shot_contract';
import { compileNegativePrompt } from './negative_prompt_compiler';
import { ensureSceneVersionBaseline, createSceneVersion, syncActiveVersionFromScene } from './scene_versions';

const fail = (code: string, message: string, status: 404 | 409 | 422 = 409): never => { throw new ContinuityStoreError(code, message, status); };
const scriptSceneIdOf = (scene: { shot_spec?: string | null }) => { try { return JSON.parse(scene.shot_spec || '{}').source?.script_scene_id as string | undefined; } catch { return undefined; } };
const byTimeline = (a: { index: number; id: number }, b: { index: number; id: number }) => Number(a.index) - Number(b.index) || Number(a.id) - Number(b.id);
type AdoptionSlot = { role: 'kept' | 'replaced' | 'inserted'; scene_id: number | null; shot_index: number; index: number };
/** Pair replacements in timeline order and keep the candidate as one span inside the target scene. */
function planSceneAdoption(document: { scenes: { id: string }[] }, timeline: any[], targetSceneId: string, replaceIds: number[], shotCount: number) {
  const targetOrder = document.scenes.findIndex(scene => scene.id === targetSceneId);
  const targetShots = timeline.filter(scene => scriptSceneIdOf(scene) === targetSceneId).sort(byTimeline);
  const selected = new Set(replaceIds);
  const replaced = targetShots.filter(scene => selected.has(Number(scene.id)));
  const anchor = replaced[0];
  const keptBefore = anchor ? targetShots.filter(scene => !selected.has(Number(scene.id)) && byTimeline(scene, anchor) < 0) : targetShots.filter(scene => !selected.has(Number(scene.id)));
  const keptAfter = anchor ? targetShots.filter(scene => !selected.has(Number(scene.id)) && byTimeline(scene, anchor) > 0) : [];
  const later = timeline.find(scene => document.scenes.findIndex(scriptScene => scriptScene.id === scriptSceneIdOf(scene)) > targetOrder);
  const predecessors = timeline.filter(scene => {
    if (keptBefore.some(item => item.id === scene.id)) return true;
    if (scriptSceneIdOf(scene) === targetSceneId) return false;
    if (later && Number(scene.index) >= Number(later.index)) return false;
    if (!anchor) return true;
    return Number(scene.index) < Number(anchor.index);
  });
  const left = Math.max(0, ...predecessors.map(scene => Number(scene.index)));
  const movableCount = shotCount + keptAfter.length;
  const span = later ? Number(later.index) - left : 0;
  const width = span > 0 ? span : movableCount + 1;
  const indexAt = (offset: number) => left + width * (offset + 1) / (movableCount + 1);
  const slots: AdoptionSlot[] = [];
  for (const scene of keptBefore) slots.push({ role: 'kept', scene_id: Number(scene.id), shot_index: -1, index: Number(scene.index) });
  for (let shot_index = 0; shot_index < shotCount; shot_index++) {
    const old = replaced[shot_index];
    slots.push({ role: old ? 'replaced' : 'inserted', scene_id: old ? Number(old.id) : null, shot_index, index: indexAt(shot_index) });
  }
  keptAfter.forEach((scene, offset) => slots.push({ role: 'kept', scene_id: Number(scene.id), shot_index: -1, index: indexAt(shotCount + offset) }));
  return { replaced, slots };
}
export const ProductionRoundSchema = z.enum(['continuity', 'skeleton', 'look', 'completion']);
export const CreateSceneProductionSchema = z.object({ target_scene_id: z.string().min(1), expected_script_revision: z.number().int().positive(), expected_continuity_revision: z.number().int().positive(), request_key: z.string().trim().min(1).max(100), round: ProductionRoundSchema,
  shots: z.array(z.object({ block_ids: z.array(z.string().min(1)).min(1), moment_id: z.string().min(1), phase: z.enum(['before', 'during', 'after']), reads: z.array(ContinuityReadSchema), shot_type: z.enum(['Wide Shot', 'Medium Shot', 'Close-up', 'Insert Shot', 'Long Shot']).default('Medium Shot'), duration: z.number().min(1).max(15).default(5) }).strict()).max(20) }).strict();
export type ProductionPayload = { production_version: 1; scope: { kind: 'scene'; target_scene_id: string }; scriptId: number; scriptRevision: number; continuityRevision: number; round: z.infer<typeof ProductionRoundSchema>; shots: any[]; coverage: { gaps: Array<{ block_id: string; kind: string; text: string }>; complete: boolean }; source_fingerprint: string | null };
export async function sceneProductionView(scriptId: number) {
  const ledger = await loadContinuityLedger(scriptId), doc = ScriptDocumentSchema.parse(JSON.parse(ledger.script.document_json));
  const timeline = await db.all('SELECT * FROM scene WHERE chapter_id=? ORDER BY "index",id', ledger.script.chapter_id);
  const revision = Number((await db.get('SELECT revision FROM scene_production_revision WHERE script_id=?', scriptId))?.revision || 0);
  const candidates = await db.all("SELECT * FROM script_change WHERE script_id=? AND kind='storyboard' AND state='pending' ORDER BY created_at DESC,rowid DESC", scriptId);
  return { script_id: scriptId, script_revision: ledger.script.revision, continuity_revision: ledger.revision, timeline_revision: revision,
    scenes: await Promise.all(doc.scenes.map(async scene => {
      let moments: any[] = [], issue: string | undefined, issue_code: string | undefined;
      try { moments = [...(await currentContinuitySnapshot(scriptId, scene.id)).snapshot.moments]; } catch (error: any) { issue = error.message; issue_code = error.code || 'CONTINUITY_REVIEW_REQUIRED'; }
      return { scene_id: scene.id, blocks: scene.blocks, moments, issue, issue_code };
    })), timeline, entities: ledger.input?.context.entities || [], candidates: candidates.filter(row => JSON.parse(row.after_json).production_version === 1).map(row => ({ id: row.id, revision: row.candidate_revision, payload: JSON.parse(row.after_json) })) };
}
async function assembleProduction(scriptId: number, raw: unknown): Promise<{ body: z.infer<typeof CreateSceneProductionSchema>; payload: ProductionPayload }> {
  const body = CreateSceneProductionSchema.parse(raw), ledger = await loadContinuityLedger(scriptId);
  if (ledger.script.status !== 'confirmed' || ledger.script.revision !== body.expected_script_revision || ledger.revision !== body.expected_continuity_revision || !ledger.input) return fail('CONTINUITY_REVISION_CONFLICT', 'Confirm the current screenplay and continuity before planning');
  const doc = ScriptDocumentSchema.parse(JSON.parse(ledger.script.document_json)), target = doc.scenes.find(scene => scene.id === body.target_scene_id);
  if (!target) return fail('CONTINUITY_SCOPE_INVALID', 'Production scene is outside this screenplay', 404);
  const current = await currentContinuitySnapshot(scriptId, target.id);
  const cast = await db.all('SELECT id,name FROM character WHERE project_id=? ORDER BY id', ledger.script.project_id), roster = entityRoster(cast);
  const coverage = new Set<string>(), assignedAudio = new Set<string>();
  const shots = body.shots.map((shot, index) => {
    const blocks = shot.block_ids.map(id => target.blocks.find(block => block.id === id) || fail('CONTINUITY_SCOPE_INVALID', 'A shot contains a block outside the selected scene'));
    if (new Set(shot.block_ids).size !== shot.block_ids.length) return fail('CONTINUITY_SCOPE_INVALID', 'Duplicate shot source');
    const facts = blocks.filter(block => block.type === 'action').map(block => {
      if (block.text.length > 240) return fail('CONTINUITY_REVIEW_REQUIRED', 'Split this complete action into screenplay blocks before making a still');
      const binding = block.binding || actionBindingSource(doc, target.id, block.id, roster).automatic;
      validateBinding(binding, block.text, roster);
      if (needsBindingReview(binding)) return fail('CONTINUITY_REVIEW_REQUIRED', 'Review the people in this action before production');
      return { id: `production:${block.id}`, scene_id: target.id, block_id: block.id, start: 0, end: block.text.length, text: block.text, kind: 'visual' as const, beat: index, states: [], binding };
    });
    const audible = blocks.filter(block => block.type !== 'action');
    for (const block of audible) {
      if (assignedAudio.has(block.id)) return fail('CONTINUITY_SCOPE_INVALID', 'An audible source can be assigned only once');
      assignedAudio.add(block.id);
    }
    const speech = audible.filter(block => block.type !== 'sound').reduce((sum, block) => sum + block.text.replace(/\s/g, '').length / 4, 0);
    if (speech > shot.duration) return fail('CONTINUITY_REVIEW_REQUIRED', 'The complete line does not fit this shot; adjust its duration or split the screenplay line');
    const selectedIds = new Set(shot.reads.map(read => read.entity_id));
    const moment = current.snapshot.moments.find(moment => moment.story_position.moment_id === shot.moment_id && moment.story_position.phase === shot.phase);
    if (!moment) return fail('CONTINUITY_REVIEW_REQUIRED', 'Select a confirmed moment for this frame');
    const visibleCharacterIds = new Set(facts.flatMap(fact => boundVisibleEntities(fact.binding)).flatMap(character => ledger.input!.context.entities.filter(entity => entity.character_id === Number(character.id.replace('character:', ''))).map(entity => entity.entity_id)));
    for (const entity of ledger.input!.context.entities.filter(entity => entity.kind !== 'character' && entity.kind !== 'location')) {
      const mentioned = facts.some(fact => [entity.display_name, ...entity.aliases].some(name => name && fact.text.includes(name)));
      const sameName = ledger.input!.context.entities.filter(other => other.kind === entity.kind && other.display_name === entity.display_name);
      if (mentioned && sameName.length === 1) selectedIds.add(entity.entity_id);
      if (mentioned && sameName.length > 1 && !sameName.some(other => selectedIds.has(other.entity_id))) return fail('CONTINUITY_REVIEW_REQUIRED', 'Select the physical identity for this same-name object');
    }
    for (const cell of moment.state) if (cell.attribute_id === 'wearer' && cell.knowledge_status === 'confirmed' && cell.value && visibleCharacterIds.has(cell.value)) selectedIds.add(cell.entity_id);
    let grew = true;
    while (grew) { grew = false; for (const entity of ledger.input!.context.entities) if (entity.parent_entity_id && selectedIds.has(entity.parent_entity_id) && !selectedIds.has(entity.entity_id)) { selectedIds.add(entity.entity_id); grew = true; } }
    const expanded = [...new Map([...shot.reads, ...moment.state.filter(cell => selectedIds.has(cell.entity_id) && cell.knowledge_status === 'confirmed').map(cell => ({ entity_id: cell.entity_id, attribute_id: cell.attribute_id }))].map(read => [`${read.entity_id}:${read.attribute_id}`, read])).values()] as ContinuityRead[];
    const read = readContinuityMoment(current.snapshot, shot.moment_id, shot.phase, expanded);
    const source = { type: 'script' as const, script_id: scriptId, script_revision: ledger.script.revision, script_scene_id: target.id, block_ids: shot.block_ids,
      continuity: { story_position: read.story_position, entity_ids: [...new Set(expanded.map(read => read.entity_id))], reference: { snapshot_id: current.id, snapshot_revision: current.revision, state_hash: read.state_hash, source_hash: read.source_hash, dependency_hash: read.dependency_hash, reads: expanded } } };
    const location = doc.locations.find(location => location.id === target.locationId)?.name || target.locationId;
    const primary_action = facts[0]?.text || location;
    const spec = { location, primary_action, visible_subjects: [...new Set(facts.flatMap(fact => boundVisibleEntities(fact.binding).map(entity => entity.name)))], key_props: doc.props.filter(prop => target.propIds.includes(prop.id) && facts.some(fact => fact.text.includes(prop.name))).map(prop => prop.name).slice(0, 2), shot_type: shot.shot_type, visual_facts: facts, audible_blocks: audible, continuity_states: continuityVisualStates(ledger.input!.context.entities, read.values, current.id), source,
      scene_context: { location_description: doc.locations.find(location => location.id === target.locationId)?.description || '', interior_exterior: target.interiorExterior, time_of_day: target.timeOfDay } };
    shot.block_ids.forEach(id => coverage.add(id));
    return { index: index + 1, script_scene_id: target.id, block_ids: shot.block_ids, source, shot_spec: packShotSpec(spec), visual_prompt: '', dialogue: audible.filter(block => block.type === 'dialogue').map(block => block.text).join('\n'), narration: audible.filter(block => block.type === 'voiceover').map(block => block.text).join('\n'), audio_prompt: audible.filter(block => block.type === 'sound').map(block => block.text).join('\n'), duration: shot.duration, shot_type: shot.shot_type, camera_movement: 'Static', camera_angle: 'Eye-level', negative_prompt: compileNegativePrompt(spec) };
  });
  const gaps = target.blocks.filter(block => !coverage.has(block.id) && block.text.trim()).map(block => ({ block_id: block.id, kind: block.type, text: block.text }));
  return { body, payload: { production_version: 1, scope: { kind: 'scene', target_scene_id: target.id }, scriptId, scriptRevision: ledger.script.revision, continuityRevision: ledger.revision, round: body.round, shots, coverage: { gaps, complete: gaps.length === 0 }, source_fingerprint: await continuitySourceFingerprint(scriptId) } };
}
export async function createSceneProductionCandidate(scriptId: number, raw: unknown): Promise<{ id: string; revision: number; payload: ProductionPayload; replayed?: boolean }> {
  const assembled = await assembleProduction(scriptId, raw), requestHash = continuityHash(assembled.body);
  return withImmediateTransaction(async () => {
    const existing = await db.get("SELECT * FROM script_change WHERE script_id=? AND request_key=?", scriptId, assembled.body.request_key);
    if (existing) {
      if (JSON.parse(existing.generation_info_json || '{}').production_request_hash !== requestHash) return fail('CONTINUITY_REVISION_CONFLICT', 'This draft key belongs to another production request');
      return { id: existing.id, revision: existing.candidate_revision, payload: JSON.parse(existing.after_json), replayed: true };
    }
    const current = await assembleProduction(scriptId, assembled.body);
    if (continuityHash(current.payload) !== continuityHash(assembled.payload)) return fail('CONTINUITY_REVISION_CONFLICT', 'Production inputs changed before saving the draft');
    const id = randomUUID();
    await db.run("INSERT INTO script_change(id,script_id,kind,base_revision,candidate_revision,request_key,state,after_json,generation_info_json) VALUES(?,?,'storyboard',?,1,?,'pending',?,?)", id, scriptId, assembled.body.expected_script_revision, assembled.body.request_key, JSON.stringify(assembled.payload), JSON.stringify({ production_request_hash: requestHash, production_body: assembled.body, production_payload_hash: continuityHash(assembled.payload), continuity_fingerprint: assembled.payload.source_fingerprint }));
    return { id, revision: 1, payload: assembled.payload };
  });
}

export const ApplySceneProductionSchema = z.object({ target_scene_id: z.string().min(1), expected_script_revision: z.number().int().positive(), expected_continuity_revision: z.number().int().positive(), expected_candidate_revision: z.number().int().positive(), expected_timeline_revision: z.number().int().nonnegative(), replace_scene_ids: z.array(z.number().int().positive()).default([]), request_key: z.string().trim().min(1).max(100), expected_impact_hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
async function productionImpact(scriptId: number, changeId: string, body: z.infer<typeof ApplySceneProductionSchema>) {
  const ledger = await loadContinuityLedger(scriptId), candidate = await db.get('SELECT * FROM script_change WHERE id=? AND script_id=?', changeId, scriptId);
  if (!candidate) return fail('CONTINUITY_SCOPE_INVALID', 'Production candidate was not found', 404);
  const payload = JSON.parse(candidate.after_json) as ProductionPayload, info = JSON.parse(candidate.generation_info_json || '{}');
  if (payload.production_version !== 1 || payload.scope.target_scene_id !== body.target_scene_id || candidate.state !== 'pending' || candidate.candidate_revision !== body.expected_candidate_revision || continuityHash(payload) !== info.production_payload_hash) return fail('CONTINUITY_REVISION_CONFLICT', 'Review the current scene draft before adoption');
  if (ledger.script.revision !== body.expected_script_revision || ledger.revision !== body.expected_continuity_revision) return fail('CONTINUITY_REVISION_CONFLICT', 'The screenplay or continuity changed');
  const rebuilt = await assembleProduction(scriptId, info.production_body);
  if (continuityHash(rebuilt.payload) !== continuityHash(payload)) return fail('CONTINUITY_STALE', 'The saved production draft is stale');
  if (!payload.shots.length) return fail('CONTINUITY_REVIEW_REQUIRED', 'A continuity-only round has no timeline shots to adopt');
  const revision = Number((await db.get('SELECT revision FROM scene_production_revision WHERE script_id=?', scriptId))?.revision || 0);
  if (revision !== body.expected_timeline_revision) return fail('CONTINUITY_REVISION_CONFLICT', 'The timeline changed before scene adoption');
  if (new Set(body.replace_scene_ids).size !== body.replace_scene_ids.length || body.replace_scene_ids.length > payload.shots.length) return fail('CONTINUITY_SCOPE_INVALID', 'Each replaced shot requires its own retained replacement version');
  const timeline = await db.all('SELECT * FROM scene WHERE chapter_id=? ORDER BY "index",id', ledger.script.chapter_id);
  const replaced = body.replace_scene_ids.map(id => timeline.find(scene => scene.id === id) || fail('CONTINUITY_SCOPE_INVALID', 'Replacement shot is outside this chapter'));
  const document = ScriptDocumentSchema.parse(JSON.parse(ledger.script.document_json));
  const audibleIds = new Set(document.scenes.find(scene => scene.id === body.target_scene_id)!.blocks.filter(block => block.type !== 'action').map(block => block.id));
  const retainedAudio = new Set(timeline.filter(scene => !body.replace_scene_ids.includes(scene.id)).flatMap(scene => {
    const source = JSON.parse(scene.shot_spec || '{}').source;
    return source?.script_scene_id === body.target_scene_id ? (source.block_ids || []).filter((id: string) => audibleIds.has(id)) : [];
  }));
  if (payload.shots.some(shot => shot.block_ids.some((id: string) => retainedAudio.has(id)))) return fail('CONTINUITY_REVIEW_REQUIRED', 'This audible source is already on a retained shot; replace its original shot or remove the duplicate assignment');
  for (const scene of replaced) {
    if (JSON.parse(scene.shot_spec || '{}').source?.script_scene_id !== body.target_scene_id) return fail('CONTINUITY_SCOPE_INVALID', 'Replacement range contains another screenplay scene');
    if (await db.get("SELECT 1 FROM generation_task WHERE scene_id=? AND status IN ('queued','processing')", scene.id)) return fail('CONTINUITY_REVISION_CONFLICT', 'A selected shot is still being produced');
    if (await db.get("SELECT 1 FROM media_asset WHERE scene_id=? AND role='narrative_final' AND status='ready'", scene.id)) return fail('CONTINUITY_REVIEW_REQUIRED', 'Preserve the accepted video before replacing this shot');
  }
  const plan = planSceneAdoption(document, timeline, body.target_scene_id, body.replace_scene_ids, payload.shots.length);
  const reviewed = { ...body }; delete reviewed.expected_impact_hash;
  const impact_hash = continuityHash([reviewed, candidate.after_json, timeline, await db.all('SELECT * FROM scene_version WHERE scene_id IN (SELECT id FROM scene WHERE chapter_id=?) ORDER BY scene_id,version', ledger.script.chapter_id), revision]);
  return { ledger, candidate, payload, timeline, replaced: plan.replaced, revision, impact_hash, plan };
}
export async function previewSceneProductionApply(scriptId: number, changeId: string, raw: unknown) {
  const body = ApplySceneProductionSchema.parse(raw);
  return withImmediateTransaction(async () => {
    const impact = await productionImpact(scriptId, changeId, body);
    return { impact_hash: impact.impact_hash, target_scene_id: body.target_scene_id, replacement_ids: impact.replaced.map(scene => scene.id), new_shot_count: impact.payload.shots.length - impact.replaced.length, preserved_other_scene_ids: impact.timeline.filter(scene => !body.replace_scene_ids.includes(scene.id)).map(scene => scene.id), placement: impact.plan.slots.map(({ role, scene_id, shot_index }) => ({ role, scene_id, shot_index })), coverage: impact.payload.coverage, timeline_revision: impact.revision };
  });
}
export async function applySceneProduction(scriptId: number, changeId: string, raw: unknown) {
  const body = ApplySceneProductionSchema.parse(raw), requestHash = continuityHash([changeId, body]);
  return withImmediateTransaction(async () => {
    const previous = await db.get('SELECT * FROM scene_production_receipt WHERE script_id=? AND request_key=?', scriptId, body.request_key);
    if (previous) { if (previous.request_hash !== requestHash) return fail('CONTINUITY_REVISION_CONFLICT', 'Adoption key belongs to another reviewed range'); return { ...JSON.parse(previous.result_json), replayed: true }; }
    const impact = await productionImpact(scriptId, changeId, body);
    if (!body.expected_impact_hash || body.expected_impact_hash !== impact.impact_hash) return fail('CONTINUITY_REVISION_CONFLICT', 'Preview the current adoption impact first');
    const shotIds = new Array<number>(impact.payload.shots.length), retained: any[] = [];
    for (const slot of impact.plan.slots) {
      if (slot.role === 'kept') {
        const current = impact.timeline.find(scene => scene.id === slot.scene_id);
        if (current && Number(current.index) !== slot.index) await db.run('UPDATE scene SET "index"=? WHERE id=?', slot.index, slot.scene_id);
        continue;
      }
      const shot = impact.payload.shots[slot.shot_index]!; let sceneId: number;
      if (slot.role === 'replaced') {
        const old = impact.timeline.find(scene => scene.id === slot.scene_id)!;
        const version = await createSceneVersion(old.id, { clearAsset: true, label: `${impact.payload.round}-${changeId.slice(0, 8)}` });
        sceneId = old.id; retained.push({ scene_id: old.id, old_version: old.active_version || 1, old_image_url: old.asset_url, new_version: version!.version.version });
      } else {
        const floor = await db.get('SELECT MAX(value) AS maximum FROM (SELECT COALESCE(MAX(id),0) AS value FROM scene UNION ALL SELECT COALESCE(MAX(scene_id),0) AS value FROM media_asset)');
        const row = await db.run('INSERT INTO scene(id,chapter_id,"index",active_version,asset_status) VALUES(?,?,?,1,\'idle\')', Number(floor.maximum || 0) + 1, impact.ledger.script.chapter_id, slot.index);
        sceneId = Number(row.lastID);
      }
      await db.run('UPDATE scene SET "index"=?,shot_spec=?,visual_prompt=?,audio_prompt=?,dialogue=?,narration=?,duration=?,shot_type=?,camera_movement=?,camera_angle=?,negative_prompt=?,asset_url=NULL,asset_status=\'idle\',task_id=NULL WHERE id=?', slot.index, shot.shot_spec, shot.visual_prompt, shot.audio_prompt, shot.dialogue, shot.narration, shot.duration, shot.shot_type, shot.camera_movement, shot.camera_angle, shot.negative_prompt, sceneId);
      shotIds[slot.shot_index] = sceneId;
      await ensureSceneVersionBaseline(sceneId);
      const ref = shot.source.continuity;
      await bindContinuityShotInTransaction(sceneId, { script_id: scriptId, script_scene_id: body.target_scene_id, moment_id: ref.story_position.moment_id, phase: ref.story_position.phase, reads: ref.reference.reads });
      await syncActiveVersionFromScene(sceneId);
      const scene = await db.get('SELECT active_version FROM scene WHERE id=?', sceneId);
      await db.run('INSERT INTO scene_production_frame(scene_id,scene_version,round) VALUES(?,?,?)', sceneId, scene.active_version, impact.payload.round);
    }
    const sceneIds = shotIds;
    const revision = impact.revision + 1;
    await db.run('INSERT INTO scene_production_revision(script_id,revision) VALUES(?,?) ON CONFLICT(script_id) DO UPDATE SET revision=excluded.revision', scriptId, revision);
    const result = { scene_ids: sceneIds, retained_versions: retained, timeline_revision: revision, target_scene_id: body.target_scene_id, coverage: impact.payload.coverage };
    await db.run("UPDATE script_change SET state='applied',applied_revision=?,result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", body.expected_script_revision, JSON.stringify(result), changeId);
    await db.run('INSERT INTO scene_production_receipt(script_id,request_key,request_hash,result_json) VALUES(?,?,?,?)', scriptId, body.request_key, requestHash, JSON.stringify(result));
    return result;
  });
}
