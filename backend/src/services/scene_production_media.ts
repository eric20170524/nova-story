import { z } from 'zod';
import { db, withImmediateTransaction } from '../db/database';
import { requireCurrentContinuityShot } from './continuity_shot_gate';
import { continuityHash } from './continuity_replay';
import { ContinuityStoreError, bindContinuityShotInTransaction } from './continuity_store';
import { syncActiveVersionAssets } from './scene_versions';
import { ensureCharacterVersionBaseline } from './character_versions';

const fail = (code: string, message: string): never => { throw new ContinuityStoreError(code, message); };
const ReferenceChoice = z.object({ entity_id: z.string().min(1), kind: z.enum(['asset', 'character']), id: z.number().int().positive(), version: z.number().int().positive() }).strict();
export const BindProductionReferencesSchema = z.object({ expected_version: z.number().int().positive(), references: z.array(ReferenceChoice).max(5), reason: z.string().trim().min(1).max(300) }).strict();
export type ProductionReference = z.infer<typeof ReferenceChoice> & { image_url: string; visual_tags?: string; name: string; asset_kind?: string; content_hash: string };
export type ProductionReferencePin = { version: 1; scene_id: number; scene_version: number; dependency_hash: string; source_hash: string; references: ProductionReference[]; text_characters: Array<{id:number;version:number;name:string;english_name:string;visual_tags:string;content_hash:string}>; state_values?: Array<{entity_id:string;attribute_id:string;value:unknown}>; reason: string };
const pinFrom = (frame: any): ProductionReferencePin | null => { try { const pin = JSON.parse(frame?.reference_versions_json || 'null'); return pin?.version === 1 ? pin : null; } catch { return null; } };
async function ownedScene(scriptId: number, sceneId: number) {
  const row = await db.get('SELECT s.*,c.project_id FROM scene s JOIN chapter c ON c.id=s.chapter_id JOIN chapter_script p ON p.chapter_id=c.id WHERE s.id=? AND p.id=?', sceneId, scriptId);
  if (!row || JSON.parse(row.shot_spec || '{}').source?.script_id !== scriptId) return fail('CONTINUITY_SCOPE_INVALID', 'This shot is outside the selected screenplay');
  return row;
}
async function choicesFor(scene: any, gate: Awaited<ReturnType<typeof requireCurrentContinuityShot>>) {
  const ledger = await db.get('SELECT context_json FROM continuity_ledger WHERE script_id=?', gate.source.script_id);
  const entities = JSON.parse(ledger.context_json).entities as any[];
  const required = new Set(gate.source.continuity!.entity_ids);
  const visible = new Set<number>((gate.spec.visual_facts || []).flatMap((fact: any) => [...(fact.binding?.actor_bindings || []), ...(fact.binding?.beneficiary_bindings || [])].map((binding: any) => Number(binding.entity_id || binding.character_id))));
  for (const entity of entities) if (entity.kind === 'character' && (gate.spec.visible_subjects || []).includes(entity.display_name)) visible.add(Number(entity.character_id));
  const available: Array<z.infer<typeof ReferenceChoice> & { name: string; image_url: string; roles?: Array<{ role: string; image_url: string }> }> = [];
  for (const entity of entities) {
    if (entity.kind === 'character' && visible.has(Number(entity.character_id))) {
      await ensureCharacterVersionBaseline(entity.character_id);
      for (const row of await db.all('SELECT * FROM character_version WHERE character_id=? ORDER BY version', entity.character_id)) {
        const tags = JSON.parse(row.visual_tags || '{}'), image = tags.assets?.face_url || tags.assets?.avatar_url || tags.face_url || tags.avatar_url || tags.assets?.turnaround_url || tags.turnaround_url;
        const roles = [
          ...(tags.assets?.face_url || tags.face_url ? [{ role: 'face', image_url: tags.assets?.face_url || tags.face_url }] : []),
          ...(tags.assets?.turnaround_url || tags.turnaround_url ? [{ role: 'body', image_url: tags.assets?.turnaround_url || tags.turnaround_url }] : []),
        ];
        if (image) available.push({ entity_id: entity.entity_id, kind: 'character', id: entity.character_id, version: row.version, name: entity.display_name, image_url: image, roles });
      }
    } else if (required.has(entity.entity_id) && entity.asset_id) {
      for (const row of await db.all('SELECT * FROM continuity_reference_version WHERE project_id=? AND asset_id=? ORDER BY asset_revision', scene.project_id, entity.asset_id)) {
        const ref = JSON.parse(row.reference_json);
        if (ref.image_url && ref.status === 'completed') available.push({ entity_id: entity.entity_id, kind: 'asset', id: row.asset_id, version: row.asset_revision, name: entity.display_name, image_url: ref.image_url });
      }
    }
  }
  return { entities, available, visible };
}
export async function productionMediaView(scriptId: number, sceneId: number) {
  const scene = await ownedScene(scriptId, sceneId);
  const frame = await db.get('SELECT * FROM scene_production_frame WHERE scene_id=? AND scene_version=?', sceneId, scene.active_version || 1);
  const adjacent = await db.all('SELECT id,asset_url,active_version,continuity_status FROM scene WHERE chapter_id=? AND id<>? ORDER BY ABS("index"-?) LIMIT 2', scene.chapter_id, sceneId, scene.index);
  const pin = pinFrom(frame);
  let values: any[] = pin?.state_values || [], available: any[] = [], issue: string | null = null;
  try { const gate = await requireCurrentContinuityShot(scene); values = gate.read.values; available = (await choicesFor(scene, gate)).available; }
  catch (error) { if (!(error instanceof ContinuityStoreError)) throw error; issue = error.code; }
  const ledger = await db.get('SELECT context_json FROM continuity_ledger WHERE script_id=?',scriptId);
  const entities = ledger ? JSON.parse(ledger.context_json).entities : [];
  return { scene_id: sceneId, scene_version: scene.active_version || 1, image_url: scene.asset_url, text_status: issue ? 'stale' : 'current', issue, values, entities, available_references: available, reference_pin: pin, reference_hash: pin ? continuityHash(pin) : null, review: JSON.parse(frame?.image_review_json || 'null'), adjacent };
}
export async function bindProductionReferences(scriptId: number, sceneId: number, raw: unknown) {
  const body = BindProductionReferencesSchema.parse(raw);
  return withImmediateTransaction(async () => {
    const scene = await ownedScene(scriptId, sceneId), gate = await requireCurrentContinuityShot(scene);
    if (Number(scene.active_version || 1) !== body.expected_version || scene.asset_status === 'generating') return fail('CONTINUITY_REVISION_CONFLICT', 'The image version changed or is generating');
    const { available, visible } = await choicesFor(scene, gate);
    if (new Set(body.references.map(ref => ref.entity_id)).size !== body.references.length) return fail('CONTINUITY_SCOPE_INVALID', 'Choose one reference per physical identity');
    const references: ProductionReference[] = [];
    for (const selected of body.references) {
      const option = available.find(ref => ref.entity_id === selected.entity_id && ref.kind === selected.kind && ref.id === selected.id && ref.version === selected.version);
      if (!option) return fail('CONTINUITY_SCOPE_INVALID', 'Reference must match a visible identity and available project version');
      const source = selected.kind === 'character' ? await db.get('SELECT * FROM character_version WHERE character_id=? AND version=?', selected.id, selected.version) : JSON.parse((await db.get('SELECT reference_json FROM continuity_reference_version WHERE project_id=? AND asset_id=? AND asset_revision=?', scene.project_id, selected.id, selected.version)).reference_json);
      references.push({ ...selected, name: option.name, image_url: option.image_url, visual_tags: selected.kind === 'character' ? source.visual_tags : undefined, asset_kind: selected.kind === 'asset' ? source.kind : undefined, content_hash: continuityHash(source) });
    }
    const text_characters: ProductionReferencePin['text_characters'] = [];
    for (const id of [...visible].sort((a,b) => a-b)) {
      const character = await db.get('SELECT * FROM character WHERE id=? AND project_id=?',id,scene.project_id);
      if (!character) continue;
      const version = references.find(ref => ref.kind === 'character' && ref.id === id)?.version || Number(character.active_version || 1);
      const source = await db.get('SELECT * FROM character_version WHERE character_id=? AND version=?',id,version);
      if (!source) return fail('CONTINUITY_STALE','The visible character version is unavailable');
      text_characters.push({id,version,name:character.name,english_name:character.english_name,visual_tags:source.visual_tags,content_hash:continuityHash(source)});
    }
    const pin: ProductionReferencePin = { version: 1, scene_id: sceneId, scene_version: body.expected_version, dependency_hash: gate.read.dependency_hash, source_hash: gate.read.source_hash, references: references.sort((a,b) => a.entity_id.localeCompare(b.entity_id)), text_characters, state_values: gate.read.values.map(cell=>({entity_id:cell.entity_id,attribute_id:cell.attribute_id,value:cell.value})), reason: body.reason };
    const previous = await db.get('SELECT reference_versions_json FROM scene_production_frame WHERE scene_id=? AND scene_version=?', sceneId, body.expected_version);
    if (scene.asset_url && previous?.reference_versions_json !== JSON.stringify(pin)) return fail('CONTINUITY_REVIEW_REQUIRED', 'Create a new image version before changing references for an existing image');
    await db.run("INSERT INTO scene_production_frame(scene_id,scene_version,round,reference_versions_json) VALUES(?,?,'look',?) ON CONFLICT(scene_id,scene_version) DO UPDATE SET reference_versions_json=excluded.reference_versions_json,image_review_json=NULL", sceneId, body.expected_version, JSON.stringify(pin));
    return { pin, reference_hash: continuityHash(pin) };
  });
}
export async function requireProductionReferencePin(scene: any, expected?: { expected_version: number; reference_hash: string }) {
  const gate = await requireCurrentContinuityShot(scene), frame = await db.get('SELECT * FROM scene_production_frame WHERE scene_id=? AND scene_version=?', scene.id, scene.active_version || 1), pin = pinFrom(frame);
  if (!pin) return fail('CONTINUITY_REFERENCE_REVIEW_REQUIRED', 'Bind references to the current confirmed state before generating');
  // The full ledger source hash may change for an unrelated item. The verified read
  // dependency already includes this frame's values, provenance and entity versions.
  if (pin.scene_id !== scene.id || pin.scene_version !== Number(scene.active_version || 1) || pin.dependency_hash !== gate.read.dependency_hash) return fail('CONTINUITY_STALE', 'Bind references to the current confirmed state before generating');
  if (expected && (expected.expected_version !== pin.scene_version || expected.reference_hash !== continuityHash(pin))) return fail('CONTINUITY_REVISION_CONFLICT', 'The selected reference or image version changed');
  for (const ref of pin.references) {
    const source = ref.kind === 'character' ? await db.get('SELECT * FROM character_version WHERE character_id=? AND version=?', ref.id, ref.version) : await db.get('SELECT reference_json FROM continuity_reference_version WHERE project_id=? AND asset_id=? AND asset_revision=?', gate.source.continuity!.story_position.project_id, ref.id, ref.version);
    if (!source || continuityHash(ref.kind === 'asset' ? JSON.parse(source.reference_json) : source) !== ref.content_hash) return fail('CONTINUITY_STALE', 'A pinned reference version changed; review before generating');
  }
  for (const character of pin.text_characters || []) {
    const source = await db.get('SELECT * FROM character_version WHERE character_id=? AND version=?',character.id,character.version);
    if (!source || continuityHash(source) !== character.content_hash) return fail('CONTINUITY_STALE','A frozen character appearance changed');
  }
  return { gate, pin, frame };
}
export const ProductionImageGuardSchema = z.object({ expected_version: z.number().int().positive(), reference_hash: z.string().regex(/^[a-f0-9]{64}$/), redraw: z.boolean() }).strict();
/** Caller owns the asset queue transaction. Never trust client-provided reference URLs. */
export async function prepareProductionImage(sceneId: number, raw: unknown, asNewVersion: boolean) {
  if (raw == null) return fail('CONTINUITY_REFERENCE_REVIEW_REQUIRED', 'Open the scene production review and bind references before generating');
  const body = ProductionImageGuardSchema.parse(raw), scene = await db.get('SELECT * FROM scene WHERE id=?', sceneId);
  const { gate, pin } = await requireProductionReferencePin(scene, body);
  if (body.redraw !== asNewVersion) return fail('CONTINUITY_SCOPE_INVALID', 'Existing images require an explicit redraw action');
  if (await db.get("SELECT 1 FROM generation_task WHERE scene_id=? AND kind='image' AND status IN ('queued','processing')", sceneId)) return fail('CONTINUITY_REVISION_CONFLICT', 'This shot is already queued');
  if (!body.redraw && scene.asset_url) return fail('CONTINUITY_REVIEW_REQUIRED', 'This version already has an image; use explicit redraw');
  return { gate, pin };
}
export async function copyProductionImagePin(sceneId: number, prepared: Awaited<ReturnType<typeof prepareProductionImage>>) {
  const scene = await db.get('SELECT * FROM scene WHERE id=?', sceneId);
  await bindContinuityShotInTransaction(sceneId, prepared.gate.binding);
  const pin = { ...prepared.pin, scene_version: Number(scene.active_version || 1) };
  await db.run("INSERT INTO scene_production_frame(scene_id,scene_version,round,reference_versions_json) VALUES(?,?,'look',?) ON CONFLICT(scene_id,scene_version) DO UPDATE SET reference_versions_json=excluded.reference_versions_json", sceneId, pin.scene_version, JSON.stringify(pin));
  return pin;
}
export async function productionQueuePlan(scriptId: number, target: string) {
  const shots = await db.all('SELECT * FROM scene WHERE chapter_id=(SELECT chapter_id FROM chapter_script WHERE id=?) ORDER BY "index",id', scriptId), eligible: any[] = [], skipped: any[] = [];
  for (const scene of shots) {
    if (JSON.parse(scene.shot_spec || '{}').source?.script_scene_id !== target) continue;
    try {
      if (scene.asset_url) { skipped.push({ scene_id: scene.id, reason: 'image_exists' }); continue; }
      if (await db.get("SELECT 1 FROM generation_task WHERE scene_id=? AND kind='image' AND status IN ('queued','processing')", scene.id)) { skipped.push({ scene_id: scene.id, reason: 'already_queued' }); continue; }
      const { pin } = await requireProductionReferencePin(scene);
      eligible.push({ scene_id: scene.id, scene_version: pin.scene_version, reference_hash: continuityHash(pin) });
    } catch (error: any) { skipped.push({ scene_id: scene.id, reason: error.code || 'review_required', detail: error.message }); }
  }
  return { eligible, skipped, eligible_count: eligible.length, skipped_count: skipped.length };
}
const ReviewSchema = z.object({ expected_version: z.number().int().positive(), expected_image_url: z.string().min(1), reference_hash: z.string().regex(/^[a-f0-9]{64}$/), verdict: z.enum(['accepted', 'rejected']), checks: z.object({ wardrobe: z.boolean(), damage: z.boolean(), count: z.boolean(), holder: z.boolean(), openings: z.boolean(), space: z.boolean() }).strict(), note: z.string().trim().min(1).max(500) }).strict();
export async function reviewProductionImage(scriptId: number, sceneId: number, raw: unknown) {
  const body = ReviewSchema.parse(raw);
  return withImmediateTransaction(async () => {
    const scene = await ownedScene(scriptId, sceneId);
    const pin = pinFrom(await db.get('SELECT * FROM scene_production_frame WHERE scene_id=? AND scene_version=?',sceneId,body.expected_version));
    if (!pin || Number(scene.active_version || 1) !== body.expected_version || continuityHash(pin) !== body.reference_hash) return fail('CONTINUITY_REVISION_CONFLICT','The reviewed image or reference version changed');
    if (body.verdict === 'accepted') await requireProductionReferencePin(scene,body);
    if (!scene.asset_url || scene.asset_url !== body.expected_image_url || scene.asset_status !== 'completed') return fail('CONTINUITY_REVISION_CONFLICT', 'Review the current completed image');
    if (body.verdict === 'accepted' && Object.values(body.checks).some(value => !value)) return fail('CONTINUITY_REVIEW_REQUIRED', 'Every image check must pass before accepting this image');
    const review = { ...body, actor_id: 'local_reviewer', reviewed_at: new Date().toISOString(), dependency_hash: pin.dependency_hash, image_only: true };
    await db.run('UPDATE scene_production_frame SET image_review_json=? WHERE scene_id=? AND scene_version=?', JSON.stringify(review), sceneId, body.expected_version);
    return review;
  });
}
/** Keep late results in their original version and refuse to publish them as current. */
export async function persistProductionImageResult(sceneId: number, pin: ProductionReferencePin, taskId: string, patch: any) {
  return withImmediateTransaction(async () => {
    const scene = await db.get('SELECT * FROM scene WHERE id=?', sceneId);
    let current = Number(scene?.active_version || 1) === pin.scene_version && scene?.task_id === taskId;
    try { const valid = await requireProductionReferencePin(scene); current = current && continuityHash(valid.pin) === continuityHash(pin); } catch { current = false; }
    if (current) await syncActiveVersionAssets(sceneId, patch, pin.scene_version);
    else {
      await db.run('UPDATE scene_version SET asset_url=?,asset_status=?,task_id=?,english_visual_prompt=?,continuity_status=\'stale\',continuity_reason_json=? WHERE scene_id=? AND version=?', patch.asset_url || null, patch.asset_status, taskId, patch.english_visual_prompt || null, JSON.stringify({ code: 'CONTINUITY_STALE', reason: 'generation_inputs_changed' }), sceneId, pin.scene_version);
      if (Number(scene?.active_version || 1) === pin.scene_version && scene?.task_id === taskId) await db.run("UPDATE scene SET asset_status=?,asset_url=?,continuity_status='stale' WHERE id=?", patch.asset_status, patch.asset_url || null, sceneId);
    }
    return { current, scene_version: pin.scene_version };
  });
}
