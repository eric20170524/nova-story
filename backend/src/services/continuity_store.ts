import { randomUUID } from 'node:crypto';
import { db, withImmediateTransaction } from '../db/database';
import { ContinuityEntitySchema, type ContinuityEntity } from '../schemas/continuity';
import { ScriptDocumentSchema } from '../schemas/script';
import { ContinuityCellSchema, ContinuityConfirmedChangeSchema, type ContinuityCell, type ContinuityConfirmedChange } from '../schemas/continuity_state';
import { ContinuityOverlayProposalSchema, type ContinuityConfirmedOverlay, type ContinuityRead } from '../schemas/continuity_snapshot';
import { validateContinuityEntities, buildContinuityStoryOrder } from './continuity_identity';
import { confirmContinuityChange, revalidateConfirmedContinuityChange, continuityCellApproval, restoreApprovedContinuityCell, createUnknownContinuityCell,
  type ContinuityConfirmationContext } from './continuity_confirmation';
import { continuityHash, canonicalContinuityJson, confirmContinuityEntry, requireVerifiedContinuityEntry, confirmContinuityOverlay, requireVerifiedContinuityOverlay,
  replayContinuityScene, readContinuityMoment, type ContinuityEntry, type ContinuityReplayInput, type ContinuityReplayResult } from './continuity_replay';
import { ensureSceneVersionBaseline } from './scene_versions';
import { confirmContinuityTimePlan, requireContinuityTimePlan } from './continuity_time';

export class ContinuityStoreError extends Error {
  constructor(public code: string, message: string, public statusCode: 404 | 409 | 422 = 409) { super(message); }
}
const fail = (code: string, message: string, status: 404 | 409 | 422 = 409): never => { throw new ContinuityStoreError(code, message, status); };
const parse = (raw: string) => JSON.parse(raw);
export type ContinuityStoredRecord = {
  context: Omit<ContinuityConfirmationContext, 'authority'>;
  entry: (Omit<ContinuityEntry, 'state'> & { cells: { cell: ContinuityCell; approval?: ContinuityConfirmedChange }[] }) | null;
  changes: ContinuityConfirmedChange[]; overlays: ContinuityConfirmedOverlay[];
  revisions: ContinuityReplayInput['revisions'];
};
export async function continuityScriptScope(scriptId: number) {
  const script = await db.get(`SELECT s.*, c.project_id, c.content AS chapter_content FROM chapter_script s JOIN chapter c ON c.id=s.chapter_id WHERE s.id=?`, scriptId);
  if (!script) return fail('CONTINUITY_SCOPE_INVALID', 'Script not found', 404);
  return script;
}
async function resources(projectId: number) {
  return { characters: await db.all('SELECT id,project_id FROM character WHERE project_id=?', projectId), assets: await db.all('SELECT id,project_id FROM library_asset WHERE project_id=?', projectId) };
}
function assertContextScript(context: ContinuityConfirmationContext, script: any) {
  if (context.project_id !== script.project_id || context.order.script_id !== script.id) return fail('CONTINUITY_SCOPE_INVALID', 'Continuity context belongs to another project/script', 404);
  const order = buildContinuityStoryOrder({ project_id: script.project_id, script_id: script.id, script_revision: script.revision,
    story_segment_id: context.order.story_segment_id, document: ScriptDocumentSchema.parse(parse(script.document_json)) });
  if (canonicalContinuityJson(order) !== canonicalContinuityJson(context.order)) return fail('CONTINUITY_STALE', 'Actual screenplay order/revision changed');
}
export function serializeContinuityRecord(input: ContinuityReplayInput): ContinuityStoredRecord {
  if(input.context.time_plan)requireContinuityTimePlan(input.context.time_plan,input.context);
  if (input.entry) requireVerifiedContinuityEntry(input.entry);
  input.changes.forEach(change => revalidateConfirmedContinuityChange(change, input.context));
  (input.during_overlays ?? []).forEach(requireVerifiedContinuityOverlay);
  const { authority: _authority, ...context } = input.context;
  const entry = input.entry ? { entry_id: input.entry.entry_id, entry_revision: input.entry.entry_revision, binding_revision: input.entry.binding_revision,
    story_position: input.entry.story_position, confirmation: input.entry.confirmation,
    cells: input.entry.state.map(cell => ({ cell, ...(cell.knowledge_status === 'confirmed' ? { approval: continuityCellApproval(cell) } : {}) })) } : null;
  if (entry?.cells.some(cell => cell.cell.knowledge_status === 'confirmed' && !cell.approval)) return fail('CONTINUITY_REVIEW_REQUIRED', 'Entry cell lacks its original approval');
  return { context, entry, changes: [...input.changes], overlays: [...(input.during_overlays ?? [])], revisions: input.revisions };
}
/** This is used ONLY for records obtained from the server ledger/revision tables. */
export function restoreContinuityRecord(record: ContinuityStoredRecord, context = record.context): ContinuityReplayInput {
  if(context.time_plan)context={...context,time_plan:confirmContinuityTimePlan(context.time_plan.proposal,{...context,authority:context.time_plan.confirmation})};
  const restoreChange = (raw: ContinuityConfirmedChange) => {
    const saved = ContinuityConfirmedChangeSchema.parse(raw);
    const result = confirmContinuityChange(saved.proposal, { ...context, authority: saved.confirmation });
    if (result.status !== 'confirmed') return fail(result.issues[0]!.code, result.issues[0]!.message);
    return result.change;
  };
  let entry: ContinuityEntry | undefined;
  if (record.entry) {
    const saved = record.entry;
    const state = saved.cells.map(({ cell: raw, approval }) => {
      const cell = ContinuityCellSchema.parse(raw);
      if (cell.knowledge_status === 'unknown') return createUnknownContinuityCell(context, cell.entity_id, cell.attribute_id);
      if (!approval) return fail('CONTINUITY_REVIEW_REQUIRED', 'Stored entry cell has no human/rule record');
      return restoreApprovedContinuityCell(cell, restoreChange(approval), context);
    });
    entry = confirmContinuityEntry({ entry_id: saved.entry_id, entry_revision: saved.entry_revision, binding_revision: saved.binding_revision,
      story_position: saved.story_position, state }, { ...context, authority: saved.confirmation.kind === 'human' ? saved.confirmation : undefined });
  }
  const overlays = record.overlays.map(overlay => confirmContinuityOverlay(ContinuityOverlayProposalSchema.parse(overlay.proposal), {
    ...context, authority: overlay.confirmation.kind === 'human' ? overlay.confirmation : undefined }));
  return { context, entry, changes: record.changes.map(restoreChange), during_overlays: overlays, revisions: record.revisions };
}
async function saveEntities(context: ContinuityConfirmationContext) {
  validateContinuityEntities(context.project_id, context.entities, await resources(context.project_id));
  for (const entity of context.entities) {
    const existing = await db.get('SELECT project_id FROM continuity_entity WHERE entity_id=?', entity.entity_id);
    if (existing && existing.project_id !== context.project_id) return fail('CONTINUITY_SCOPE_INVALID', 'Entity belongs to another project', 404);
    if (entity.asset_id !== undefined && entity.asset_revision !== undefined) {
      const asset = await db.get('SELECT * FROM library_asset WHERE id=? AND project_id=?', entity.asset_id, context.project_id);
      const historical = await db.get('SELECT 1 FROM continuity_reference_version WHERE project_id=? AND asset_id=? AND asset_revision=?', context.project_id, entity.asset_id, entity.asset_revision);
      if (!historical && asset.revision !== entity.asset_revision) return fail('CONTINUITY_STALE', 'Asset reference revision is not available');
      if (!historical) await db.run('INSERT INTO continuity_reference_version(project_id,asset_id,asset_revision,reference_json) VALUES(?,?,?,?)', context.project_id, entity.asset_id, entity.asset_revision, JSON.stringify(asset));
    }
    await db.run('INSERT INTO continuity_entity(entity_id,project_id,entity_json) VALUES(?,?,?) ON CONFLICT(entity_id) DO UPDATE SET entity_json=excluded.entity_json', entity.entity_id, context.project_id, JSON.stringify(entity));
  }
}
export async function loadContinuityLedger(scriptId: number) {
  const script = await continuityScriptScope(scriptId);
  const row = await db.get('SELECT * FROM continuity_ledger WHERE script_id=?', scriptId);
  if (!row) return { script, revision: 0, record: null, input: null, issues: [{ code: 'CONTINUITY_ENTRY_REQUIRED', message: 'Confirm this scene entry state' }] };
  const record: ContinuityStoredRecord = { context: parse(row.context_json), entry: row.entry_json ? parse(row.entry_json) : null,
    changes: parse(row.changes_json), overlays: parse(row.overlays_json), revisions: parse(row.context_json).revisions };
  // Source/version context is server-owned. Physical identities are always loaded from their project table.
  const ids = new Set(record.context.entities.map(entity => entity.entity_id));
  const entities = (await db.all('SELECT entity_json FROM continuity_entity WHERE project_id=?', script.project_id))
    .map((row: any) => ContinuityEntitySchema.parse(parse(row.entity_json))).filter((entity: ContinuityEntity) => ids.has(entity.entity_id));
  record.context = { ...record.context, entities };
  try {
    if (parse(row.context_json).import_review_required) return fail('CONTINUITY_REVIEW_REQUIRED', 'Imported approval has not been authenticated; review the preserved state');
    assertContextScript(record.context, script);
    const storedInputs = parse(row.context_json).stored_inputs;
    if (!storedInputs || storedInputs.chapter_hash !== continuityHash(script.chapter_content) || storedInputs.document_hash !== continuityHash(parse(script.document_json))) return fail('CONTINUITY_STALE', 'Source text changed; review continuity before using the saved snapshot');
    validateContinuityEntities(script.project_id, entities, await resources(script.project_id));
    const input = restoreContinuityRecord(record);
    return { script, revision: Number(row.revision), record, input, issues: [] };
  } catch (error) {
    return { script, revision: Number(row.revision), record, input: null, issues: [{ code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'CONTINUITY_REVIEW_REQUIRED', message: error instanceof Error ? error.message : 'Review required' }] };
  }
}
export async function continuitySourceFingerprint(scriptId: number): Promise<string | null> {
  const row = await db.get('SELECT * FROM continuity_ledger WHERE script_id=?', scriptId);
  if (!row) return null;
  const script = await continuityScriptScope(scriptId);
  const entities = await db.all('SELECT entity_id,entity_json FROM continuity_entity WHERE project_id=? ORDER BY entity_id', script.project_id);
  return continuityHash({ schema_version: 1, policy_version: 'continuity-state-1', revision: row.revision, context: parse(row.context_json),
    entry: row.entry_json ? parse(row.entry_json) : null, changes: parse(row.changes_json), overlays: parse(row.overlays_json), entities,
    script_revision: script.revision, document: parse(script.document_json), chapter_content: script.chapter_content });
}
export type ContinuityCommitResult = { revision: number; snapshots: { id: string; script_scene_id: string; state_hash: string; source_hash: string }[];
  stale_shot_ids: number[]; revalidated_shot_ids: number[]; issues: { script_scene_id: string; code: string; message: string }[] };
/** Marks only current image versions. It never deletes, clears URLs or replaces chapter rows. */
export async function markContinuityStale(scriptId: number, results: Map<string, { id: string; result: ContinuityReplayResult }>, revision: number) {
  const dependencies = await db.all(`SELECT d.*, s.active_version FROM continuity_shot_dependency d JOIN scene s ON s.id=d.scene_id WHERE d.script_id=? AND d.scene_version=s.active_version`, scriptId);
  const stale: number[] = [], revalidated: number[] = [];
  for (const dependency of dependencies) {
    const target = results.get(dependency.script_scene_id);
    let nextHash: string | undefined, issue: unknown, nextRead: ReturnType<typeof readContinuityMoment> | undefined;
    if (target?.result.status === 'ready') {
      try { nextRead = readContinuityMoment(target.result.snapshot, dependency.moment_id, dependency.phase, parse(dependency.reads_json)); nextHash = nextRead.dependency_hash; }
      catch (error) { issue = error instanceof Error ? error.message : 'Required state is unavailable'; }
    } else issue = target?.result.status === 'conflict' ? target.result.issues : target?.result.status === 'pending_review' ? target.result.issues : 'Source scene removed';
    if (nextHash === dependency.dependency_hash && dependency.status === 'current' && target?.result.status === 'ready') {
      await db.run('UPDATE continuity_shot_dependency SET snapshot_id=?,ledger_revision=?,source_hash=?,reason_json=NULL WHERE scene_id=? AND scene_version=?', target.id, revision, target.result.snapshot.source_hash, dependency.scene_id, dependency.scene_version);
      await db.run('UPDATE scene SET continuity_snapshot_id=?,continuity_revision=? WHERE id=?', target.id, revision, dependency.scene_id);
      await db.run('UPDATE scene_version SET continuity_snapshot_id=?,continuity_revision=? WHERE scene_id=? AND version=?', target.id, revision, dependency.scene_id, dependency.scene_version);
      const scene = await db.get('SELECT shot_spec FROM scene WHERE id=?', dependency.scene_id);
      const spec = parse(scene.shot_spec || '{}');
      if (spec.source?.continuity?.reference) {
        Object.assign(spec.source.continuity.reference, { snapshot_id: target.id, snapshot_revision: revision, source_hash: nextRead!.source_hash, state_hash: nextRead!.state_hash, dependency_hash: nextRead!.dependency_hash });
        await db.run('UPDATE scene SET shot_spec=? WHERE id=?', JSON.stringify(spec), dependency.scene_id);
        await db.run('UPDATE scene_version SET shot_spec=? WHERE scene_id=? AND version=?', JSON.stringify(spec), dependency.scene_id, dependency.scene_version);
      }
      revalidated.push(dependency.scene_id);
    } else {
      const reason = JSON.stringify({ code: 'CONTINUITY_STALE', old_dependency_hash: dependency.dependency_hash, new_dependency_hash: nextHash ?? null,
        old_revision: dependency.ledger_revision, new_revision: revision, reads: parse(dependency.reads_json), issue: issue ?? 'Actual read dependency changed' });
      const status = target?.result.status === 'conflict' ? 'conflict' : 'stale';
      await db.run('UPDATE continuity_shot_dependency SET status=?,reason_json=? WHERE scene_id=? AND scene_version=?', status, reason, dependency.scene_id, dependency.scene_version);
      await db.run('UPDATE scene SET continuity_status=?,continuity_reason_json=? WHERE id=?', status, reason, dependency.scene_id);
      await db.run('UPDATE scene_version SET continuity_status=?,continuity_reason_json=? WHERE scene_id=? AND version=?', status, reason, dependency.scene_id, dependency.scene_version);
      stale.push(dependency.scene_id);
    }
  }
  return { stale, revalidated };
}
type ContinuityCommitInput = { script_id: number; expected_revision: number; expected_script_revision: number;
  request_key: string; actor_id: string; reason: string; input: ContinuityReplayInput; expected_source_hash?: string; request_body_hash?: string };
export async function commitContinuityLedger(params: ContinuityCommitInput): Promise<ContinuityCommitResult> {
  return withImmediateTransaction(()=>commitContinuityLedgerInTransaction(params));
}
/** The caller owns the transaction containing the review and its impact check. */
export async function commitContinuityLedgerInTransaction(params: ContinuityCommitInput): Promise<ContinuityCommitResult> {
  const record = serializeContinuityRecord(params.input);
  const requestHash = continuityHash({ expected_revision: params.expected_revision, expected_script_revision: params.expected_script_revision, actor_id: params.actor_id, reason: params.reason, record });
    const script = await continuityScriptScope(params.script_id);
    const repeated = await db.get('SELECT request_hash,request_body_hash,result_json FROM continuity_revision WHERE script_id=? AND request_key=?', params.script_id, params.request_key);
    if (repeated) {
      if (params.request_body_hash ? repeated.request_body_hash !== params.request_body_hash : repeated.request_hash !== requestHash) return fail('CONTINUITY_REVISION_CONFLICT', 'Request key belongs to different review content');
      return parse(repeated.result_json) as ContinuityCommitResult;
    }
    const current = await db.get('SELECT revision FROM continuity_ledger WHERE script_id=?', params.script_id);
    if (Number(current?.revision ?? 0) !== params.expected_revision || script.revision !== params.expected_script_revision) return fail('CONTINUITY_REVISION_CONFLICT', 'Continuity or script revision changed');
    if (params.expected_source_hash && params.expected_source_hash !== continuityHash([script.chapter_content,parse(script.document_json)])) return fail('CONTINUITY_STALE', 'Source changed while reviewing continuity');
    if (!params.request_key.trim() || params.request_key.length > 100 || !params.actor_id.trim() || !params.reason.trim()) return fail('CONTINUITY_SCOPE_INVALID', 'Review requires actor, reason and request key', 422);
    assertContextScript(params.input.context, script);
    await saveEntities(params.input.context);
    const revision = params.expected_revision + 1;
    const committedRecord = { ...record, revisions: { ...record.revisions, confirmation_revision: revision } };
    const replayInput = { ...params.input, revisions: committedRecord.revisions };
    const context = { ...record.context, revisions: committedRecord.revisions, stored_inputs: { chapter_hash: continuityHash(script.chapter_content), document_hash: continuityHash(parse(script.document_json)) } };
    await db.run(`INSERT INTO continuity_ledger(script_id,project_id,revision,context_json,entry_json,changes_json,overlays_json) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(script_id) DO UPDATE SET revision=excluded.revision,context_json=excluded.context_json,entry_json=excluded.entry_json,changes_json=excluded.changes_json,overlays_json=excluded.overlays_json`,
      params.script_id, script.project_id, revision, JSON.stringify(context), record.entry ? JSON.stringify(record.entry) : null, JSON.stringify(record.changes), JSON.stringify(record.overlays));
    const snapshots: ContinuityCommitResult['snapshots'] = [], issues: ContinuityCommitResult['issues'] = [];
    const results = new Map<string, { id: string; result: ContinuityReplayResult }>();
    // Full later replay, deliberately no early cutoff at an assign.
    for (const scene of params.input.context.order.scenes) {
      const result = replayContinuityScene(replayInput, scene.script_scene_id);
      const id = randomUUID(); results.set(scene.script_scene_id, { id, result });
      if (result.status === 'ready') {
        await db.run('INSERT INTO continuity_snapshot(id,script_id,script_scene_id,ledger_revision,script_revision,source_hash,state_hash,snapshot_json) VALUES(?,?,?,?,?,?,?,?)',
          id, params.script_id, scene.script_scene_id, revision, script.revision, result.snapshot.source_hash, result.snapshot.state_hash, JSON.stringify(result.snapshot));
        snapshots.push({ id, script_scene_id: scene.script_scene_id, state_hash: result.snapshot.state_hash, source_hash: result.snapshot.source_hash });
      } else issues.push(...result.issues.map(issue => ({ script_scene_id: scene.script_scene_id, ...issue })));
    }
    await db.run("UPDATE continuity_snapshot SET status='stale' WHERE script_id=? AND ledger_revision<?", params.script_id, revision);
    const marked = await markContinuityStale(params.script_id, results, revision);
    const result: ContinuityCommitResult = { revision, snapshots, stale_shot_ids: marked.stale, revalidated_shot_ids: marked.revalidated, issues };
    await db.run('INSERT INTO continuity_revision(script_id,revision,request_key,request_hash,request_body_hash,actor_id,reason,record_json,result_json) VALUES(?,?,?,?,?,?,?,?,?)',
      params.script_id, revision, params.request_key, requestHash, params.request_body_hash ?? null, params.actor_id, params.reason, JSON.stringify(committedRecord), JSON.stringify(result));
    return result;
}
export async function currentContinuitySnapshot(scriptId: number, sceneId: string) {
  const ledger = await loadContinuityLedger(scriptId);
  if (!ledger.input) return fail(ledger.issues[0]!.code, ledger.issues[0]!.message);
  const result = replayContinuityScene(ledger.input, sceneId);
  if (result.status !== 'ready') return fail(result.issues[0]!.code, result.issues[0]!.message);
  const row = await db.get('SELECT * FROM continuity_snapshot WHERE script_id=? AND script_scene_id=? AND ledger_revision=?', scriptId, sceneId, ledger.revision);
  if (!row || row.source_hash !== result.snapshot.source_hash || row.state_hash !== result.snapshot.state_hash) return fail('CONTINUITY_STALE', 'Stored snapshot no longer matches current source');
  return { id: String(row.id), revision: ledger.revision, snapshot: result.snapshot };
}
type ShotBindingInput = { script_id: number; script_scene_id: string; moment_id: string; phase: 'before' | 'during' | 'after'; reads: ContinuityRead[] };
/** Caller owns the write transaction; coverage/local adoption use this after their version checks. */
export async function bindContinuityShotInTransaction(sceneId: number, input: ShotBindingInput) {
  const scene = await db.get('SELECT s.*,c.project_id FROM scene s JOIN chapter c ON c.id=s.chapter_id WHERE s.id=?', sceneId);
  const script = await continuityScriptScope(input.script_id);
  if (!scene || scene.project_id !== script.project_id || scene.chapter_id !== script.chapter_id) return fail('CONTINUITY_SCOPE_INVALID', 'Shot does not belong to this screenplay', 404);
  await ensureSceneVersionBaseline(sceneId);
  const current = await currentContinuitySnapshot(input.script_id, input.script_scene_id);
  const read = readContinuityMoment(current.snapshot, input.moment_id, input.phase, input.reads);
  const spec = parse(scene.shot_spec || '{}');
  spec.source = { type: 'script', script_id: input.script_id, script_revision: script.revision, script_scene_id: input.script_scene_id, block_ids: spec.source?.block_ids ?? [],
    continuity: { story_position: read.story_position, entity_ids: [...new Set(input.reads.map(read => read.entity_id))], source_shot_id: spec.source?.continuity?.source_shot_id ?? sceneId,
      reference: { snapshot_id: current.id, snapshot_revision: current.revision, state_hash: read.state_hash, source_hash: read.source_hash, dependency_hash: read.dependency_hash, reads: input.reads } } };
  await db.run('UPDATE scene SET shot_spec=? WHERE id=?', JSON.stringify(spec), sceneId);
  await db.run('UPDATE scene_version SET shot_spec=? WHERE scene_id=? AND version=?', JSON.stringify(spec), sceneId, scene.active_version ?? 1);
  await db.run(`INSERT INTO continuity_shot_dependency(scene_id,scene_version,script_id,script_scene_id,snapshot_id,ledger_revision,moment_id,phase,reads_json,dependency_hash,source_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scene_id,scene_version) DO UPDATE SET script_id=excluded.script_id,script_scene_id=excluded.script_scene_id,snapshot_id=excluded.snapshot_id,
    ledger_revision=excluded.ledger_revision,moment_id=excluded.moment_id,phase=excluded.phase,reads_json=excluded.reads_json,dependency_hash=excluded.dependency_hash,source_hash=excluded.source_hash,status='current',reason_json=NULL`,
    sceneId, scene.active_version ?? 1, input.script_id, input.script_scene_id, current.id, current.revision, input.moment_id, input.phase, JSON.stringify(input.reads), read.dependency_hash, current.snapshot.source_hash);
  await db.run("UPDATE scene SET continuity_status='current',continuity_reason_json=NULL,continuity_snapshot_id=?,continuity_revision=? WHERE id=?", current.id, current.revision, sceneId);
  await db.run("UPDATE scene_version SET continuity_status='current',continuity_reason_json=NULL,continuity_snapshot_id=?,continuity_revision=? WHERE scene_id=? AND version=?", current.id, current.revision, sceneId, scene.active_version ?? 1);
  return { ...read, snapshot_id: current.id, snapshot_revision: current.revision };
}
export async function bindContinuityShot(sceneId: number, input: ShotBindingInput) {
  return withImmediateTransaction(() => bindContinuityShotInTransaction(sceneId, input));
}
