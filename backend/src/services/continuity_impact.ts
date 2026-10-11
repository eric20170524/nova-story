import { db } from '../db/database';
import type { ContinuityReplayInput } from './continuity_replay';
import { canonicalContinuityJson, continuityHash, replayContinuityScene, readContinuityMoment } from './continuity_replay';

const value = (cell: any) => cell ? { knowledge_status: cell.knowledge_status, ...(cell.knowledge_status === 'confirmed' ? { value: cell.value, evidence: cell.provenance?.evidence ?? [] } : {}) } : { knowledge_status: 'unknown' };
/** Full replay and actual active-version reads, with no early assign cutoff or writes. */
export async function previewContinuityImpact(scriptId: number, previous: ContinuityReplayInput | null, next: ContinuityReplayInput, review: unknown) {
  const changes: any[] = [];
  const results = new Map(next.context.order.scenes.map(scene => [scene.script_scene_id, replayContinuityScene(next, scene.script_scene_id)]));
  const previousResults = new Map(previous?.context.order.scenes.map(scene => [scene.script_scene_id,replayContinuityScene(previous,scene.script_scene_id)])??[]);
  for (const scene of next.context.order.scenes) {
    const after = results.get(scene.script_scene_id)!;
    const before = previous ? replayContinuityScene(previous, scene.script_scene_id) : null;
    if (after.status !== 'ready') { changes.push({ script_scene_id: scene.script_scene_id, issue: after.issues }); continue; }
    const old = before?.status === 'ready' ? before.snapshot.exit_state : [];
    const keys = new Set([...old, ...after.snapshot.exit_state].map(cell => `${cell.entity_id}\u0000${cell.attribute_id}`));
    for (const key of keys) {
      const [entity_id, attribute_id] = key.split('\u0000');
      const from = value(old.find(cell => cell.entity_id === entity_id && cell.attribute_id === attribute_id));
      const to = value(after.snapshot.exit_state.find(cell => cell.entity_id === entity_id && cell.attribute_id === attribute_id));
      if (canonicalContinuityJson(from) !== canonicalContinuityJson(to)) changes.push({ script_scene_id: scene.script_scene_id, entity_id, attribute_id, before: from, after: to });
    }
  }
  const dependencies = await db.all(`SELECT s.id,s.active_version,s.asset_url,s.continuity_status,d.script_scene_id,d.moment_id,d.phase,d.reads_json,d.dependency_hash FROM scene s
    JOIN continuity_shot_dependency d ON d.scene_id=s.id AND d.scene_version=COALESCE(s.active_version,1) WHERE d.script_id=? ORDER BY s.id`, scriptId);
  const shots = dependencies.map(row => {
    const replay = results.get(row.script_scene_id);
    try {
      if (replay?.status !== 'ready') return { ...row, affected: true, issue: replay?.issues ?? [{ code: 'CONTINUITY_SCOPE_INVALID' }] };
      const read = readContinuityMoment(replay.snapshot, row.moment_id, row.phase, JSON.parse(row.reads_json));
      const old = previousResults.get(row.script_scene_id);
      const currentRead = old?.status==='ready'?readContinuityMoment(old.snapshot,row.moment_id,row.phase,JSON.parse(row.reads_json)):null;
      return { ...row, affected: read.dependency_hash !== (currentRead?.dependency_hash??row.dependency_hash), previous_values:currentRead?.values??[],next_values: read.values };
    } catch (error: any) { return { ...row, affected: true, issue: [{ code: error.code, message: error.message }] }; }
  });
  const script = await db.get('SELECT revision,document_json FROM chapter_script WHERE id=?', scriptId);
  const ledger = await db.get('SELECT revision FROM continuity_ledger WHERE script_id=?', scriptId);
  return { changes, shots, affected_shot_ids: shots.filter(shot => shot.affected).map(shot => shot.id),
    impact_hash: continuityHash({ script, ledger, review, dependencies, changes }) };
}
