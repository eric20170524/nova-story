import { db } from '../db/database';
import { ShotSourceReferenceSchema } from '../schemas/shot_contract';
import { ContinuityReadSchema, type ContinuityRead } from '../schemas/continuity_snapshot';
import { currentContinuitySnapshot, ContinuityStoreError } from './continuity_store';
import { canonicalContinuityJson, readContinuityMoment } from './continuity_replay';
const fail = (code: string, message: string): never => { throw new ContinuityStoreError(code, message); };
export async function requireCurrentContinuityShot(scene: any, candidateSpec?: string) {
  const spec = JSON.parse(scene.shot_spec || '{}');
  if (!spec.source?.continuity?.reference) return fail('CONTINUITY_ENTRY_REQUIRED', 'Confirm this shot’s entry state and story moment before production');
  const source = ShotSourceReferenceSchema.parse(spec.source), continuity = source.continuity!, ref = continuity.reference!;
  if (scene.continuity_status !== 'current') return fail(scene.continuity_status === 'conflict' ? 'CONTINUITY_PRECONDITION_CONFLICT' : 'CONTINUITY_STALE', 'Review the changed dependencies; the previous image remains available');
  const current = await currentContinuitySnapshot(source.script_id!, source.script_scene_id!);
  const reads = ref.reads.map(read => ContinuityReadSchema.parse(read) as ContinuityRead);
  const read = readContinuityMoment(current.snapshot, continuity.story_position.moment_id, continuity.story_position.phase, reads);
  const dependency = await db.get('SELECT * FROM continuity_shot_dependency WHERE scene_id=? AND scene_version=?', scene.id, scene.active_version || 1);
  if (!dependency || dependency.status !== 'current' || dependency.snapshot_id !== current.id || dependency.ledger_revision !== current.revision || dependency.dependency_hash !== read.dependency_hash ||
      ref.snapshot_id !== current.id || ref.snapshot_revision !== current.revision || ref.source_hash !== read.source_hash || ref.state_hash !== read.state_hash || ref.dependency_hash !== read.dependency_hash ||
      canonicalContinuityJson(continuity.story_position) !== canonicalContinuityJson(read.story_position) ||
      canonicalContinuityJson([...continuity.entity_ids].sort()) !== canonicalContinuityJson([...new Set(reads.map(read => read.entity_id))].sort())) return fail('CONTINUITY_STALE', 'Shot moment/reference changed; review before continuing');
  if (candidateSpec) {
    const candidate = JSON.parse(candidateSpec);
    if (canonicalContinuityJson(candidate.source) !== canonicalContinuityJson(source) || candidate.location !== spec.location || candidate.primary_action !== spec.primary_action) return fail('CONTINUITY_STALE', 'Coverage candidate no longer shares the source shot’s confirmed moment');
  }
  return { source, read, spec, binding: { script_id: source.script_id!, script_scene_id: source.script_scene_id!, moment_id: read.story_position.moment_id, phase: read.story_position.phase, reads } };
}
