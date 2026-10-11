import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/database';
import { ContinuityEntitySchema } from '../schemas/continuity';
import { continuityProposalHash, confirmContinuityChange, restoreApprovedContinuityCell, createUnknownContinuityCell } from './continuity_confirmation';
import { canonicalContinuityJson, continuityHash, continuityEntryHash, continuityOverlayHash, confirmContinuityEntry, confirmContinuityOverlay, replayContinuityScene, readContinuityMoment } from './continuity_replay';
import { continuityScriptScope, serializeContinuityRecord, loadContinuityLedger, ContinuityStoreError, type ContinuityStoredRecord } from './continuity_store';
import { requireProductionReferencePin } from './scene_production_media';
import { confirmContinuityTimePlan,continuityTimePlanHash } from './continuity_time';

const Row = z.record(z.string(), z.unknown());
const Bundle = z.object({ version: z.literal(1), project_id: z.number().int().positive(),
  entities: z.array(Row), ledgers: z.array(Row), revisions: z.array(Row), snapshots: z.array(Row), dependencies: z.array(Row), suggestions: z.array(Row), references: z.array(Row), versions: z.array(Row),
  recoveries: z.array(Row).optional(), production_frames: z.array(Row).optional(), production_revisions: z.array(Row).optional(), signature: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
type Backup = z.infer<typeof Bundle>;
const json = (raw: unknown) => typeof raw === 'string' ? JSON.parse(raw) : raw;
async function secret() {
  await db.run('INSERT OR IGNORE INTO continuity_backup_key(id,secret) VALUES(1,?)', randomBytes(32).toString('hex'));
  return String((await db.get('SELECT secret FROM continuity_backup_key WHERE id=1')).secret);
}
async function signature(payload: Omit<Backup, 'signature'>) { return createHmac('sha256', await secret()).update(canonicalContinuityJson(payload)).digest('hex'); }
export async function exportContinuity(projectId: number): Promise<Backup> {
  const scriptRows = (table: string) => db.all(`SELECT t.* FROM ${table} t JOIN chapter_script s ON s.id=t.script_id JOIN chapter c ON c.id=s.chapter_id WHERE c.project_id=?`, projectId);
  const ledgers=await scriptRows('continuity_ledger');
  for(const row of ledgers)row.approval_current=Boolean((await loadContinuityLedger(Number(row.script_id))).input);
  const frames=await db.all('SELECT f.* FROM scene_production_frame f JOIN scene s ON s.id=f.scene_id JOIN chapter c ON c.id=s.chapter_id WHERE c.project_id=?',projectId);
  for(const row of frames){
    const scene=await db.get('SELECT * FROM scene WHERE id=?',row.scene_id);row.pin_valid=false;
    if(scene&&Number(scene.active_version||1)===row.scene_version)try{await requireProductionReferencePin(scene);row.pin_valid=true;}catch(error){if(!(error instanceof ContinuityStoreError))throw error;}
  }
  const payload = { version: 1 as const, project_id: projectId,
    entities: await db.all('SELECT * FROM continuity_entity WHERE project_id=?', projectId), ledgers,
    revisions: await scriptRows('continuity_revision'), snapshots: await scriptRows('continuity_snapshot'), dependencies: await scriptRows('continuity_shot_dependency'), suggestions: await scriptRows('continuity_suggestion'),
    recoveries: await scriptRows('continuity_shot_recovery'),
    production_frames: frames,
    production_revisions: await scriptRows('scene_production_revision'),
    references: await db.all('SELECT * FROM continuity_reference_version WHERE project_id=?', projectId),
    versions: await db.all('SELECT v.*,s.active_version AS source_active_version FROM scene_version v JOIN scene s ON s.id=v.scene_id JOIN chapter c ON c.id=s.chapter_id WHERE c.project_id=?', projectId) };
  return { ...payload, signature: await signature(payload) };
}
type Maps = { scripts: Map<number, number>; chapters: Map<string, string>; characters: Map<number, number>; scenes: Map<string, number>; assets: Map<number, number> };
function mapped<K, V>(map: Map<K, V>, key: K, label: string): V { const value = map.get(key); if (value === undefined) throw new Error(`Dangling ${label} in continuity backup`); return value; }
/** Caller owns copy/import transaction. Only a server-authenticated receipt preserves approval authority. */
export async function restoreContinuity(raw: unknown, projectId: number, maps: Maps) {
  if (raw == null) return { trusted: false, entities: 0, ledgers: 0 };
  const bundle = Bundle.parse(raw);
  const { signature: supplied, ...payload } = bundle;
  const expected = await signature(payload);
  const trusted = Boolean(supplied && timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex')));
  const entities = new Map<string, string>(), snapshots = new Map<string, string>();
  for (const row of bundle.entities) {
    const entity = ContinuityEntitySchema.parse(json(row.entity_json));
    if (entity.project_id !== bundle.project_id || entities.has(entity.entity_id)) throw new Error('Invalid/duplicate continuity identity in backup');
    entities.set(entity.entity_id, randomUUID());
  }
  for (const row of bundle.snapshots) {
    if (typeof row.id !== 'string' || snapshots.has(row.id)) throw new Error('Invalid/duplicate snapshot identity');
    snapshots.set(row.id, randomUUID());
  }
  const remap = (value: any, key = '', parent?: any): any => {
    if (value == null) return value;
    if (Array.isArray(value)) return value.map(item => remap(item, key, parent));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, k, value)]));
    if (key === 'project_id') return projectId;
    if (['entity_id', 'parent_entity_id', 'anchor_entity_id'].includes(key)) return mapped(entities, String(value), key);
    if (key === 'entity_ids') return mapped(entities, String(value), key);
    if (key === 'character_id') return mapped(maps.characters, Number(value), key);
    if (key === 'asset_id') return mapped(maps.assets, Number(value), key);
    if (key === 'script_id') return mapped(maps.scripts, Number(value), key);
    if (key === 'chapter_id') return mapped(maps.chapters, String(value), key);
    if (key === 'source_shot_id') return mapped(maps.scenes, String(value), key);
    if (key === 'snapshot_id' || key === 'continuity_snapshot_id') return mapped(snapshots, String(value), key);
    if (key === 'source_document_id') {const source=String(value),match=/^script:(\d+):(.*)$/.exec(source);return match?`script:${mapped(maps.scripts,Number(match[1]),'source script')}:${match[2]}`:maps.chapters.get(source) ?? (maps.scripts.has(Number(value)) ? String(maps.scripts.get(Number(value))) : value);}
    if ((key === 'value' && (['wearer', 'holder', 'owner', 'location'].includes(parent?.attribute_id) || parent?.knowledge_status === 'confirmed' && entities.has(String(value)))) || key === 'from') return mapped(entities, String(value), key);
    return value;
  };
  const reapprove = (rawRecord: ContinuityStoredRecord) => {
    const record = remap(rawRecord) as ContinuityStoredRecord;
    const context = record.context;
    if(context.time_plan)context.time_plan=confirmContinuityTimePlan(context.time_plan.proposal,{...context,authority:{...context.time_plan.confirmation,proposal_hash:continuityTimePlanHash(context.time_plan.proposal)}});
    const change = (rawChange: any) => {
      const confirmation = { ...rawChange.confirmation, proposal_hash: continuityProposalHash(rawChange.proposal) };
      const result = confirmContinuityChange(rawChange.proposal, { ...context, authority: confirmation });
      if (result.status !== 'confirmed') throw new Error(`Copied approval no longer validates: ${result.issues[0]?.message}`);
      return result.change;
    };
    const entry = record.entry;
    let approvedEntry;
    if (entry) {
      if (entry.confirmation.kind !== 'human') throw new Error('Entry requires its human review receipt');
      const state = entry.cells.map(({ cell, approval }) => {
        if (cell.knowledge_status === 'unknown') return createUnknownContinuityCell(context, cell.entity_id, cell.attribute_id);
        if (!approval) throw new Error('Backup entry lacks its original approval');
        const approved = change(approval);
        const restored = { ...cell, provenance: { change_id: approved.proposal.change_id, change_revision: approved.proposal.change_revision, confirmation: approved.confirmation, evidence: approved.proposal.evidence } };
        return restoreApprovedContinuityCell(restored, approved, context);
      });
      const proposal = { entry_id: entry.entry_id, entry_revision: entry.entry_revision, binding_revision: entry.binding_revision, story_position: entry.story_position, state };
      approvedEntry = confirmContinuityEntry(proposal, { ...context, authority: { ...entry.confirmation, proposal_hash: continuityEntryHash(proposal) } });
    }
    const overlays = record.overlays.map(overlay => {
      if (overlay.confirmation.kind !== 'human') throw new Error('Overlay requires its human review receipt');
      return confirmContinuityOverlay(overlay.proposal, { ...context, authority: { ...overlay.confirmation, proposal_hash: continuityOverlayHash(overlay.proposal) } });
    });
    const input = { context, entry: approvedEntry, changes: record.changes.map(change), during_overlays: overlays, revisions: record.revisions };
    return { record: serializeContinuityRecord(input), input };
  };
  for (const row of bundle.entities) {
    const entity = ContinuityEntitySchema.parse(remap(json(row.entity_json)));
    await db.run('INSERT INTO continuity_entity(entity_id,project_id,entity_json) VALUES(?,?,?)', entity.entity_id, projectId, JSON.stringify(entity));
  }
  for (const row of bundle.references) {
    const assetId = mapped(maps.assets, Number(row.asset_id), 'asset');
    const reference = remap(json(row.reference_json)); reference.id = assetId; reference.project_id = projectId;
    if (reference.source_chapter_ids) reference.source_chapter_ids = JSON.stringify(json(reference.source_chapter_ids).map((id: string) => mapped(maps.chapters, id, 'reference chapter')));
    await db.run('INSERT INTO continuity_reference_version(project_id,asset_id,asset_revision,reference_json) VALUES(?,?,?,?)', projectId, assetId, row.asset_revision, JSON.stringify(reference));
  }
  const current = new Map<number, ReturnType<typeof reapprove>>();
  for (const row of bundle.ledgers) {
    const scriptId = mapped(maps.scripts, Number(row.script_id), 'script');
    const currentApproval=trusted&&row.approval_current===true;
    const sourceRecord = { context: json(row.context_json), entry: row.entry_json ? json(row.entry_json) : null, changes: json(row.changes_json), overlays: json(row.overlays_json), revisions: json(row.context_json).revisions };
    const restored = trusted ? reapprove(sourceRecord) : { record: remap(sourceRecord) as ContinuityStoredRecord };
    if ('input' in restored&&currentApproval) current.set(scriptId, restored);
    const actual = await continuityScriptScope(scriptId);
    const context = { ...restored.record.context, revisions: restored.record.revisions, import_review_required: !currentApproval,
      stored_inputs: { chapter_hash: continuityHash(actual.chapter_content), document_hash: continuityHash(json(actual.document_json)) } };
    await db.run('INSERT INTO continuity_ledger(script_id,project_id,revision,context_json,entry_json,changes_json,overlays_json) VALUES(?,?,?,?,?,?,?)',
      scriptId, projectId, row.revision, JSON.stringify(context), restored.record.entry ? JSON.stringify(restored.record.entry) : null, JSON.stringify(restored.record.changes), JSON.stringify(restored.record.overlays));
  }
  const snapshotValues = new Map<string, any>();
  for (const row of bundle.snapshots) {
    const target = remap(row); let snapshot = remap(json(row.snapshot_json));
    const ledger = await db.get('SELECT revision FROM continuity_ledger WHERE script_id=?', target.script_id);
    const input = current.get(target.script_id)?.input;
    if (input && row.ledger_revision === ledger.revision) {
      const replay = replayContinuityScene(input, String(row.script_scene_id));
      if (replay.status !== 'ready') throw new Error('Copied current snapshot cannot be replayed');
      snapshot = replay.snapshot; snapshotValues.set(String(row.id), snapshot);
    }
    await db.run('INSERT INTO continuity_snapshot(id,script_id,script_scene_id,ledger_revision,script_revision,source_hash,state_hash,snapshot_json,status) VALUES(?,?,?,?,?,?,?,?,?)',
      mapped(snapshots, String(row.id), 'snapshot'), target.script_id, target.script_scene_id, target.ledger_revision, target.script_revision, snapshot.source_hash, snapshot.state_hash, JSON.stringify(snapshot), trusted && snapshotValues.has(String(row.id)) ? 'current' : 'stale');
  }
  for (const row of bundle.revisions) {
    const record = trusted ? reapprove(json(row.record_json)).record : remap(json(row.record_json));
    await db.run('INSERT INTO continuity_revision(script_id,revision,request_key,request_hash,actor_id,reason,record_json,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      mapped(maps.scripts, Number(row.script_id), 'script'), row.revision, `restore:${randomUUID()}`, continuityHash(record), row.actor_id, `${trusted ? 'Verified restore' : 'Unverified import'}: ${row.reason}`, JSON.stringify(record), JSON.stringify(remap(json(row.result_json))), row.created_at);
  }
  for (const row of bundle.versions) {
    const sceneId = mapped(maps.scenes, String(row.scene_id), 'scene');
    // The existing copy/import route may already have materialized a baseline.
    await db.run('DELETE FROM scene_version WHERE scene_id=? AND version=?', sceneId, row.version);
    const fields = ['version','label','visual_prompt','audio_prompt','dialogue','narration','duration','shot_type','camera_movement','camera_angle','negative_prompt','asset_status','task_id','asset_url','english_visual_prompt','created_at','continuity_status','continuity_reason_json','continuity_snapshot_id','continuity_revision','shot_spec'];
    const target = remap(row);
    if (!trusted && target.continuity_status !== 'legacy') { target.continuity_status = 'pending_review'; target.continuity_reason_json = JSON.stringify({ code: 'CONTINUITY_REVIEW_REQUIRED', message: 'Imported review receipt requires confirmation' }); }
    await db.run(`INSERT INTO scene_version(scene_id,${fields.join(',')}) VALUES(${['scene_id',...fields].map(() => '?').join(',')})`, sceneId, ...fields.map(field => target[field] ?? null));
    if (row.source_active_version === row.version) await db.run('UPDATE scene SET active_version=? WHERE id=?', row.version, sceneId);
  }
  for (const row of bundle.dependencies) {
    const target = remap(row), sceneId = mapped(maps.scenes, String(row.scene_id), 'scene');
    const reads = remap(json(row.reads_json)); const snapshot = snapshotValues.get(String(row.snapshot_id));
    const read = snapshot && trusted ? readContinuityMoment(snapshot, String(row.moment_id), row.phase as any, reads) : null;
    const status = read && row.status === 'current' ? 'current' : 'stale';
    const reason = status === 'current' ? null : JSON.stringify({ code: trusted ? 'CONTINUITY_STALE' : 'CONTINUITY_REVIEW_REQUIRED', imported_reason: json(row.reason_json) });
    await db.run('INSERT INTO continuity_shot_dependency(scene_id,scene_version,script_id,script_scene_id,snapshot_id,ledger_revision,moment_id,phase,reads_json,dependency_hash,source_hash,status,reason_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      sceneId, row.scene_version, target.script_id, target.script_scene_id, target.snapshot_id, target.ledger_revision, target.moment_id, target.phase, JSON.stringify(reads), read?.dependency_hash ?? row.dependency_hash, read?.source_hash ?? row.source_hash, status, reason);
    await db.run('UPDATE scene_version SET continuity_status=?,continuity_reason_json=? WHERE scene_id=? AND version=?', status, reason, sceneId, row.scene_version);
  }
  for (const row of bundle.suggestions) await db.run('INSERT INTO continuity_suggestion(id,script_id,script_scene_id,raw_json,status,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), mapped(maps.scripts, Number(row.script_id), 'script'), row.script_scene_id, JSON.stringify(remap(json(row.raw_json))), 'pending_review', row.created_at);
  for (const row of bundle.production_frames??[]) {
    const sceneId=mapped(maps.scenes,String(row.scene_id),'production scene');
    const original=json(row.reference_versions_json),pin=remap(original);
    if(pin?.version===1){
      pin.scene_id=sceneId;
      for(const ref of pin.references||[])ref.id=mapped(ref.kind==='character'?maps.characters:maps.assets,Number(ref.id),'pinned reference');
      for(const character of pin.text_characters||[])character.id=mapped(maps.characters,Number(character.id),'frozen character');
      const dependency=await db.get('SELECT * FROM continuity_shot_dependency WHERE scene_id=? AND scene_version=?',sceneId,row.scene_version);
      // Preserve old frozen state. Only a current, authenticated dependency can renew its hashes.
      const currentPin=trusted&&row.pin_valid===true&&dependency?.status==='current';
      if(currentPin){
        pin.dependency_hash=dependency.dependency_hash;pin.source_hash=dependency.source_hash;
        for(const ref of pin.references||[]){
          const source=ref.kind==='character'?await db.get('SELECT * FROM character_version WHERE character_id=? AND version=?',ref.id,ref.version):json((await db.get('SELECT reference_json FROM continuity_reference_version WHERE project_id=? AND asset_id=? AND asset_revision=?',projectId,ref.id,ref.version))?.reference_json);
          if(!source)throw new Error('Missing copied pinned reference version');ref.content_hash=continuityHash(source);
        }
        for(const character of pin.text_characters||[]){const source=await db.get('SELECT * FROM character_version WHERE character_id=? AND version=?',character.id,character.version);if(!source)throw new Error('Missing copied frozen character version');character.content_hash=continuityHash(source);}
      }
      const review=row.image_review_json?json(row.image_review_json):null;
      if(review){review.reference_hash=continuityHash(pin);review.dependency_hash=pin.dependency_hash;if(!currentPin){review.original_verdict=review.verdict;review.verdict='pending_review';review.review_required=true;}}
      await db.run('INSERT INTO scene_production_frame(scene_id,scene_version,round,reference_versions_json,image_review_json) VALUES(?,?,?,?,?)',sceneId,row.scene_version,row.round,JSON.stringify(pin),review?JSON.stringify(review):null);
    }
  }
  for(const row of bundle.production_revisions??[])await db.run('INSERT INTO scene_production_revision(script_id,revision) VALUES(?,?) ON CONFLICT(script_id) DO UPDATE SET revision=excluded.revision',mapped(maps.scripts,Number(row.script_id),'production script'),row.revision);
  for (const row of bundle.recoveries??[]) {
    const sceneId=mapped(maps.scenes,String(row.scene_id),'recovery scene'),scriptId=mapped(maps.scripts,Number(row.script_id),'recovery script');
    const review=remap(json(row.review_json));review.scene_id=sceneId;
    const result=json(row.result_json);result.scene_id=sceneId;
    await db.run('INSERT INTO continuity_shot_recovery(script_id,request_key,request_hash,scene_id,actor_id,reason,review_json,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',scriptId,`restore:${randomUUID()}`,continuityHash(review),sceneId,row.actor_id,row.reason,JSON.stringify(review),JSON.stringify(result),row.created_at);
  }
  for (const sceneId of maps.scenes.values()) {
    await db.run(`UPDATE scene SET continuity_status=COALESCE((SELECT continuity_status FROM scene_version v WHERE v.scene_id=scene.id AND v.version=scene.active_version),'legacy'),
      continuity_reason_json=(SELECT continuity_reason_json FROM scene_version v WHERE v.scene_id=scene.id AND v.version=scene.active_version),
      continuity_snapshot_id=(SELECT continuity_snapshot_id FROM scene_version v WHERE v.scene_id=scene.id AND v.version=scene.active_version),
      continuity_revision=(SELECT continuity_revision FROM scene_version v WHERE v.scene_id=scene.id AND v.version=scene.active_version) WHERE id=?`, sceneId);
  }
  const remapSpec = (rawSpec: string, remapScript = false) => {
    const spec = json(rawSpec || '{}');
    if (!spec.source?.continuity) return rawSpec;
    if (remapScript && spec.source.script_id != null) spec.source.script_id = mapped(maps.scripts, Number(spec.source.script_id), 'version script');
    // The existing route has already remapped source.script_id; remap only the continuity sub-contract here.
    spec.source.continuity = remap(spec.source.continuity);
    const ref = spec.source.continuity.reference;
    if (ref) {
      const original = [...snapshots].find(([, id]) => id === ref.snapshot_id)?.[0];
      const snapshot = original ? snapshotValues.get(original) : undefined;
      if (snapshot) { const read = readContinuityMoment(snapshot, spec.source.continuity.story_position.moment_id, spec.source.continuity.story_position.phase, ref.reads); Object.assign(ref, { state_hash: read.state_hash, source_hash: read.source_hash, dependency_hash: read.dependency_hash }); }
    }
    return JSON.stringify(spec);
  };
  for (const row of await db.all('SELECT s.id,s.shot_spec FROM scene s JOIN chapter c ON c.id=s.chapter_id WHERE c.project_id=?', projectId)) await db.run('UPDATE scene SET shot_spec=? WHERE id=?', remapSpec(row.shot_spec), row.id);
  for (const row of await db.all('SELECT q.id,q.shot_spec FROM coverage_shot q JOIN coverage_group g ON g.id=q.coverage_group_id JOIN scene s ON s.id=g.source_scene_id JOIN chapter c ON c.id=s.chapter_id WHERE c.project_id=?', projectId)) await db.run('UPDATE coverage_shot SET shot_spec=? WHERE id=?', remapSpec(row.shot_spec), row.id);
  for (const row of await db.all('SELECT v.id,v.shot_spec FROM scene_version v JOIN scene s ON s.id=v.scene_id JOIN chapter c ON c.id=s.chapter_id WHERE c.project_id=?', projectId)) if (row.shot_spec) await db.run('UPDATE scene_version SET shot_spec=? WHERE id=?', remapSpec(row.shot_spec, true), row.id);
  const remapCandidate = (value: any): any => {
    if (Array.isArray(value)) return value.map(remapCandidate);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,
      key === 'shot_spec' && typeof item === 'string' ? remapSpec(item) : key === 'continuity' ? remap(item) : remapCandidate(item)]));
  };
  for (const row of await db.all('SELECT q.id,q.after_json,q.before_json,q.generation_info_json FROM script_change q JOIN chapter_script s ON s.id=q.script_id JOIN chapter c ON c.id=s.chapter_id WHERE c.project_id=?', projectId)) {
    await db.run('UPDATE script_change SET after_json=?,before_json=?,generation_info_json=? WHERE id=?', JSON.stringify(remapCandidate(json(row.after_json))), row.before_json ? JSON.stringify(remapCandidate(json(row.before_json))) : null,
      JSON.stringify({ ...json(row.generation_info_json || '{}'), ...(bundle.ledgers.length ? { continuity_restore_review_required: true } : {}) }), row.id);
  }
  return { trusted, entities: bundle.entities.length, ledgers: bundle.ledgers.length };
}
