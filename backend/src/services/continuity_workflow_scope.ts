import { z } from 'zod';
import type { ScriptDocument } from '../schemas/script';
import type { VisualFact } from '../schemas/storyboard_facts';
import type { ContinuityEntity } from '../schemas/continuity';
import { ContinuityReadSchema, type ContinuityRead } from '../schemas/continuity_snapshot';
import { currentContinuitySnapshot, loadContinuityLedger, ContinuityStoreError } from './continuity_store';
import { readContinuityMoment, canonicalContinuityJson, type ContinuitySnapshot } from './continuity_replay';
import { continuityVisualStates } from './continuity_visual_state';

export const ContinuityMomentBindingSchema = z.object({ block_id: z.string().nullable(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
  moment_id: z.string().min(1), phase: z.enum(['before','during','after']), reads: z.array(ContinuityReadSchema) }).strict();
export type ContinuityMomentBinding = Omit<z.infer<typeof ContinuityMomentBindingSchema>, 'reads'> & { reads: ContinuityRead[] };
export type ContinuityWorkflowScope = { target_scene_id: string; snapshot: ContinuitySnapshot; snapshot_id: string; snapshot_revision: number; entities: readonly ContinuityEntity[]; bindings: ContinuityMomentBinding[] };
const fail = (message: string): never => { throw new ContinuityStoreError('CONTINUITY_REVIEW_REQUIRED', message); };
export function continuitySceneDocument(doc: ScriptDocument, target: string): ScriptDocument {
  const scene = doc.scenes.find(scene => scene.id === target);
  if (!scene) throw new ContinuityStoreError('CONTINUITY_SCOPE_INVALID', 'Target scene does not belong to this screenplay', 404);
  return { ...doc, scenes: [scene], locations: doc.locations.filter(location => location.id === scene.locationId), props: doc.props.filter(prop => scene.propIds.includes(prop.id)),
    outline: { ...doc.outline, beats: doc.outline.beats.filter(beat => scene.beatIds.includes(beat.id)), mustKeepEvents: doc.outline.mustKeepEvents.filter(event => scene.eventIds.includes(event.id)), visibleBeats: (doc.outline.visibleBeats || []).filter(beat => (beat as any).sceneId === target || scene.blocks.some(block => block.text.includes(beat.text))) } };
}
export async function prepareContinuityWorkflowScope(scriptId: number, doc: ScriptDocument, target: string, rawBindings: unknown): Promise<ContinuityWorkflowScope> {
  const scoped = continuitySceneDocument(doc, target), scene = scoped.scenes[0]!;
  const bindings = z.array(ContinuityMomentBindingSchema).min(1).parse(rawBindings) as ContinuityMomentBinding[];
  const current = await currentContinuitySnapshot(scriptId, target);
  const ledger = await loadContinuityLedger(scriptId);
  const actions = scene.blocks.filter(block => block.type === 'action' && block.text.length);
  for (const block of actions) {
    const ranges = bindings.filter(binding => binding.block_id === block.id).sort((a,b) => a.start-b.start); let cursor = 0;
    for (const range of ranges) { if (range.start !== cursor || range.end <= range.start || range.end > block.text.length) fail('Select a confirmed moment for every complete action range'); cursor = range.end; }
    if (cursor !== block.text.length) fail('An action range has no confirmed shot moment');
  }
  if (bindings.some(binding => binding.block_id !== null && !actions.some(block => block.id === binding.block_id))) fail('Moment binding contains a block outside the target scene');
  if (!actions.length && (bindings.length !== 1 || bindings[0]!.block_id !== null || bindings[0]!.start !== 0 || bindings[0]!.end !== 0)) fail('An empty scene requires an explicit frame moment');
  for (const binding of bindings) readContinuityMoment(current.snapshot, binding.moment_id, binding.phase, binding.reads);
  return { target_scene_id: target, snapshot: current.snapshot, snapshot_id: current.id, snapshot_revision: current.revision, entities: ledger.input!.context.entities, bindings };
}
export function continuityReadForFacts(scope: ContinuityWorkflowScope, facts: readonly Pick<VisualFact,'block_id'|'start'|'end'>[]) {
  const selected = facts.length ? facts.map(fact => scope.bindings.find(binding => binding.block_id === fact.block_id && binding.start <= fact.start && binding.end >= fact.end) ?? fail('A pictured action crosses confirmed moments; split or review this frame')) : [scope.bindings[0]!];
  const first = selected[0]!;
  if (selected.some(binding => binding.moment_id !== first.moment_id || binding.phase !== first.phase)) fail('One frame cannot combine different story moments');
  const reads = [...new Map(selected.flatMap(binding => binding.reads).map(read => [canonicalContinuityJson(read),read])).values()];
  const result = readContinuityMoment(scope.snapshot, first.moment_id, first.phase, reads);
  const states = continuityVisualStates(scope.entities, result.values, scope.snapshot_id);
  return { ...result, states, reference: { story_position: result.story_position, entity_ids: [...new Set(reads.map(read => read.entity_id))],
    reference: { snapshot_id: scope.snapshot_id, snapshot_revision: scope.snapshot_revision, state_hash: result.state_hash, source_hash: result.source_hash, dependency_hash: result.dependency_hash, reads } } };
}
