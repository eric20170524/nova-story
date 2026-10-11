import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { confirmedContinuityFixture } from '../test_fixtures/continuity_confirmed';
import { replayContinuityScene, readContinuityMoment, confirmContinuityOverlay, continuityOverlayHash, confirmContinuityEntry,
  continuityEntryHash, type ContinuitySnapshot, type ContinuityReplayInput } from './continuity_replay';
import { ContinuityConfirmationError } from './continuity_confirmation';
import type { ContinuityOverlayProposal } from '../schemas/continuity_snapshot';

function ready(input: ContinuityReplayInput, sceneId: string) {
  const result = replayContinuityScene(input, sceneId);
  assert.equal(result.status, 'ready', JSON.stringify(result));
  if (result.status !== 'ready') throw new Error('Expected ready');
  return result.snapshot;
}
function value(snapshot: ContinuitySnapshot, entity: string, attribute: string) {
  const cell = snapshot.exit_state.find(cell => cell.entity_id === entity && cell.attribute_id === attribute);
  assert.ok(cell && cell.knowledge_status === 'confirmed');
  return cell.knowledge_status === 'confirmed' ? cell.value : undefined;
}
const errorCode = (code: string) => (error: unknown) => error instanceof ContinuityConfirmationError && error.code === code;

test('CT04 C02/C07: F01 3→1→2 and 1→2→3 replay are identical; no model or write input exists', () => {
  const { input } = confirmedContinuityFixture('F01', 'ordered');
  const unordered = ['F01:s3', 'F01:s1', 'F01:s2'].map(scene => ready(input, scene));
  const ordered = ['F01:s1', 'F01:s2', 'F01:s3'].map(scene => ready(input, scene));
  assert.deepEqual(unordered.map(snapshot => [snapshot.script_scene_id, snapshot.state_hash, snapshot.source_hash]).sort(), ordered.map(snapshot => [snapshot.script_scene_id, snapshot.state_hash, snapshot.source_hash]).sort());
  const last = unordered[0]!;
  assert.equal(value(last, 'F01:coat', 'wetness'), 'wet');
  assert.equal(value(last, 'F01:umbrella', 'holder'), 'F01:chen');
  assert.equal(value(last, 'F01:umbrella', 'integrity'), 'broken');
  assert.equal(value(last, 'F01:lock', 'lock_function'), 'broken');
  assert.equal(input.changes.length, 4);
  assert.equal(ordered[0]!.confirmed_changes.length, 3);
  assert.equal(ordered[2]!.confirmed_changes.length, 0);
});

test('CT04 C02: explicit drying changes wetness only, absence does not restore defaults', () => {
  const { input } = confirmedContinuityFixture('F01', 'explicit-drying');
  const first = ready(input, 'F01:s1'), last = ready(input, 'F01:s3');
  assert.equal(value(first, 'F01:coat', 'wetness'), 'wet');
  assert.equal(value(last, 'F01:coat', 'wetness'), 'dry');
  assert.equal(value(last, 'F01:coat', 'color'), 'blue');
  assert.equal(value(last, 'F01:coat', 'wearer'), 'F01:lin');
});

test('CT04 C05: F03 original-place prop/lock survive leaving and returning; closing never repairs', () => {
  for (const caseId of ['leave-and-return', 'closing-is-not-repair']) {
    const { input } = confirmedContinuityFixture('F03', caseId);
    const snapshot = ready(input, 'F03:s3');
    assert.equal(value(snapshot, 'F03:u1', 'location'), 'F03:room');
    assert.equal(value(snapshot, 'F03:u1', 'integrity'), 'broken');
    assert.equal(value(snapshot, 'F03:lock', 'lock_function'), 'broken');
    assert.equal(value(snapshot, 'F03:door', 'integrity'), 'intact');
    assert.equal(value(snapshot, 'F03:door', 'open_state'), 'closed');
  }
  assert.equal(value(ready(confirmedContinuityFixture('F03', 'explicit-repair').input, 'F03:s3'), 'F03:lock', 'lock_function'), 'working');
});

test('CT04 C07/C13: missing or JSON-shaped entry cannot fall back to legacy state or design', () => {
  const { input } = confirmedContinuityFixture('F01', 'missing-entry');
  const result = replayContinuityScene(input, 'F01:s3');
  assert.equal(result.status, 'pending_review');
  assert.equal(result.issues[0]!.code, 'CONTINUITY_ENTRY_REQUIRED');
  const valid = confirmedContinuityFixture('F01', 'ordered').input;
  assert.equal(replayContinuityScene({ ...valid, entry: structuredClone(valid.entry) }, 'F01:s3').status, 'pending_review');
});

test('CT04 C13: entity/cell/source/change enumeration permutations produce identical hashes', () => {
  const { input } = confirmedContinuityFixture('F02', 'independent-garments');
  const baseline = ready(input, 'F02:s2');
  const entryData = { entry_id: input.entry!.entry_id, entry_revision: 1, binding_revision: 1, story_position: input.entry!.story_position, state: [...input.entry!.state].reverse() };
  const entry = confirmContinuityEntry(entryData, { ...input.context, authority: { kind: 'human', review_id: input.entry!.confirmation.kind === 'human' ? input.entry!.confirmation.review_id : '',
    review_revision: 1, actor_id: 'fixture-reviewer', proposal_hash: continuityEntryHash(entryData) } });
  const other = ready({ ...input, entry, changes: [...input.changes].reverse(), context: { ...input.context, entities: [...input.context.entities].reverse(), sources: [...input.context.sources].reverse(), designs: [...input.context.designs].reverse() } }, 'F02:s2');
  assert.equal(other.state_hash, baseline.state_hash);
  assert.equal(other.source_hash, baseline.source_hash);
});

test('CT04 C13: evidence revision with equal values changes source hash, keeps semantic state hash', () => {
  const { input, approve } = confirmedContinuityFixture('F01', 'explicit-drying');
  const old = ready(input, 'F01:s3');
  const changedSource = input.context.sources.find(source => source.source_document_id === 'dry')!;
  changedSource.source_revision = 2;
  const changes = input.changes.map(change => change.proposal.evidence.some(evidence => evidence.kind === 'source' && evidence.source_document_id === 'dry')
    ? approve({ ...change.proposal, evidence: change.proposal.evidence.map(evidence => evidence.kind === 'source' ? { ...evidence, source_revision: 2 } : evidence) }) : change);
  const changed = ready({ ...input, changes }, 'F01:s3');
  assert.equal(old.state_hash, changed.state_hash);
  assert.notEqual(old.source_hash, changed.source_hash);
  assert.equal(replayContinuityScene(input, 'F01:s3').status, 'pending_review');
});

test('CT04 event order remains semantic, duplicate order is rejected, replay cannot sort events by IDs', () => {
  const { input, approve } = confirmedContinuityFixture('F01', 'explicit-drying');
  const old = ready(input, 'F01:s3');
  const swapped = input.changes.map((change, index) => approve({ ...change.proposal, story_position: { ...input.changes[1 - index]!.proposal.story_position, moment_id: change.proposal.story_position.moment_id } }));
  const other = ready({ ...input, changes: swapped }, 'F01:s3');
  assert.equal(value(other, 'F01:coat', 'wetness'), 'wet');
  assert.notEqual(other.state_hash, old.state_hash);
  assert.notEqual(other.source_hash, old.source_hash);
  const duplicate = approve({ ...input.changes[0]!.proposal, change_id: 'duplicate' });
  assert.equal(replayContinuityScene({ ...input, changes: [...input.changes, duplicate] }, 'F01:s3').status, 'pending_review');
});

function cupOverlay(design = false) {
  const data = confirmedContinuityFixture('F04', 'three-moments');
  const event = data.input.changes.find(change => change.proposal.attribute_id === 'integrity')!;
  const source = data.input.context.sources.find(source => source.source_document_id === 'explicit')!;
  const proposal: ContinuityOverlayProposal = { schema_version: 1, policy_version: 'continuity-state-1', overlay_id: 'cup-airborne', overlay_revision: 1,
    binding_revision: 1, story_position: { ...event.proposal.story_position, moment_id: 'F04:airborne', phase: 'during' },
    event_change_id: event.proposal.change_id, after_change_id: null,
    values: [{ entity_id: 'F04:cup', attribute_id: 'holder', value: null }, { entity_id: 'F04:cup', attribute_id: 'visible_position', value: { mode: 'airborne' } }],
    evidence: design ? [{ kind: 'design', design_id: 'F04:cup:entry-design', design_revision: 1 }]
      : [{ kind: 'source', source_type: 'novel', source_document_id: source.source_document_id, source_revision: source.source_revision,
        source_text_hash: createHash('sha256').update(source.text).digest('hex'), evidence_quote: source.text, start: 0, end: source.text.length }],
  };
  const approve = (raw = proposal) => confirmContinuityOverlay(raw, { ...data.input.context, authority: { kind: 'human', review_id: 'cup-frame-review', review_revision: 1, actor_id: 'fixture-reviewer', proposal_hash: continuityOverlayHash(raw) } });
  return { ...data, proposal, approveOverlay: approve };
}

test('CT04 C06: independent cup during overlay stays intact/airborne, exit remains broken/on floor', () => {
  const { input, approveOverlay } = cupOverlay();
  const snapshot = ready({ ...input, during_overlays: [approveOverlay()] }, 'F04:s1');
  const during = readContinuityMoment(snapshot, 'F04:airborne', 'during', [{ entity_id: 'F04:cup', attribute_id: 'integrity' }, { entity_id: 'F04:cup', attribute_id: 'holder' }, { entity_id: 'F04:cup', attribute_id: 'visible_position' }]);
  assert.equal(during.values.find(value => value.attribute_id === 'integrity')!.value, 'intact');
  assert.equal(during.values.find(value => value.attribute_id === 'holder')!.value, null);
  assert.deepEqual(during.values.find(value => value.attribute_id === 'visible_position')!.value, { mode: 'airborne' });
  assert.equal(value(snapshot, 'F04:cup', 'integrity'), 'broken');
  assert.equal(value(snapshot, 'F04:cup', 'location'), 'F04:floor');
  assert.equal(snapshot.exit_state.some(cell => String(cell.attribute_id) === 'visible_position'), false);
});

test('CT04 C06: absent during evidence blocks a frame, explicit frame design is a valid positive', () => {
  const { input } = confirmedContinuityFixture('F04', 'missing-during-evidence');
  const snapshot = ready(input, 'F04:s1');
  assert.throws(() => readContinuityMoment(snapshot, 'F04:airborne', 'during', [{ entity_id: 'F04:cup', attribute_id: 'integrity' }]), errorCode('CONTINUITY_REVIEW_REQUIRED'));
  const { input: designed, approveOverlay, proposal } = cupOverlay(true);
  const valid = ready({ ...designed, during_overlays: [approveOverlay()] }, 'F04:s1');
  assert.equal(readContinuityMoment(valid, proposal.story_position.moment_id, 'during', [{ entity_id: 'F04:cup', attribute_id: 'integrity' }]).values[0]!.value, 'intact');
});

test('CT04 overlay requires exact approval and a legal event/subevent; cannot read after or persist exit', () => {
  const { input, proposal, approveOverlay } = cupOverlay();
  assert.throws(() => confirmContinuityOverlay(proposal, input.context), errorCode('CONTINUITY_REVIEW_REQUIRED'));
  const same = approveOverlay({ ...proposal, after_change_id: proposal.event_change_id });
  assert.equal(replayContinuityScene({ ...input, during_overlays: [same] }, 'F04:s1').status, 'pending_review');
  const future = approveOverlay({ ...proposal, after_change_id: input.changes[2]!.proposal.change_id });
  assert.equal(replayContinuityScene({ ...input, during_overlays: [future] }, 'F04:s1').status, 'pending_review');
  const otherEvent = approveOverlay({ ...proposal, event_change_id: 'unknown' });
  assert.equal(replayContinuityScene({ ...input, during_overlays: [otherEvent] }, 'F04:s1').status, 'pending_review');
  assert.equal(replayContinuityScene({ ...input, during_overlays: [structuredClone(approveOverlay())] }, 'F04:s1').status, 'pending_review');
});

test('CT04 multiple during moments use the explicitly completed subevent without changing persistent states', () => {
  const { input, proposal, approveOverlay } = cupOverlay();
  const first = approveOverlay(), second = approveOverlay({ ...proposal, overlay_id: 'cup-over-floor', story_position: { ...proposal.story_position, moment_id: 'cup-over-floor' },
    after_change_id: input.changes[0]!.proposal.change_id, values: [{ entity_id: 'F04:cup', attribute_id: 'visible_position', value: { mode: 'airborne', anchor_entity_id: 'F04:floor' } }] });
  const snapshot = ready({ ...input, during_overlays: [first, second] }, 'F04:s1');
  assert.equal(snapshot.moments.filter(moment => moment.story_position.phase === 'during').length, 2);
  assert.equal(readContinuityMoment(snapshot, 'cup-over-floor', 'during', [{ entity_id: 'F04:cup', attribute_id: 'holder' }]).values[0]!.value, null);
  assert.equal(value(snapshot, 'F04:cup', 'integrity'), 'broken');
});

test('CT04 shot dependency projection leaves unrelated coat read reusable after prop correction', () => {
  const { input, approve } = confirmedContinuityFixture('F06', 'upstream-revision');
  const oldInput = { ...input, changes: input.changes.filter(change => change.proposal.attribute_id !== 'integrity') };
  const old = ready(oldInput, 'F06:s3'), revised = ready(input, 'F06:s3');
  const reads = (snapshot: ContinuitySnapshot, attribute: 'integrity' | 'wetness', entity: string) => readContinuityMoment(snapshot, 'F06:s3:exit', 'after', [{ entity_id: entity, attribute_id: attribute }]);
  assert.notEqual(reads(old, 'integrity', 'F06:u1').dependency_hash, reads(revised, 'integrity', 'F06:u1').dependency_hash);
  assert.equal(reads(old, 'wetness', 'F06:coat').dependency_hash, reads(revised, 'wetness', 'F06:coat').dependency_hash);
  const invalidTransfer = approve({ ...input.changes[1]!.proposal, precondition: { knowledge_status: 'confirmed', value: null } });
  const result = replayContinuityScene({ ...input, changes: [input.changes[0]!, invalidTransfer] }, 'F06:s3');
  assert.equal(result.status, 'conflict');
  assert.equal(value(old, 'F06:u1', 'integrity'), 'broken');
});

test('CT04 hash preimages exclude runtime metadata and canonicalize alias sets', () => {
  const { input } = confirmedContinuityFixture('F01', 'ordered');
  input.context.entities[0]!.aliases = ['甲', '乙'];
  const initial = ready(input, 'F01:s3');
  input.context.entities[0]!.aliases.reverse();
  const other = ready({ ...input, revisions: { ...input.revisions, request_id: 'runtime-only', elapsed_ms: 100 } as typeof input.revisions }, 'F01:s3');
  assert.equal(initial.state_hash, other.state_hash);
  assert.equal(initial.source_hash, other.source_hash);
});

test('CT04 reads cannot certify snapshot JSON or turn missing/unknown cells into defaults', () => {
  const { input } = confirmedContinuityFixture('F02', 'unknown-is-not-dry');
  const snapshot = ready(input, 'F02:s1');
  for (const attribute_id of ['wetness', 'location'] as const) assert.throws(() => readContinuityMoment(snapshot, 'F02:s1:exit', 'after', [{ entity_id: 'F02:coat1', attribute_id }]), errorCode('CONTINUITY_REVIEW_REQUIRED'));
  assert.throws(() => readContinuityMoment(structuredClone(snapshot), 'F02:s1:exit', 'after', [{ entity_id: 'F02:coat2', attribute_id: 'wetness' }]), errorCode('CONTINUITY_REVIEW_REQUIRED'));
});

test('CT04 frozen F08 source whitespace changes source hash without changing values or state hash', () => {
  const { input } = confirmedContinuityFixture('F08', 'repeat-and-equivalent-permutation');
  const old = ready(input, 'F08:s1');
  input.context.sources.find(source => source.source_document_id === 'wardrobe')!.text += '\n';
  const other = ready(input, 'F08:s1');
  assert.equal(old.state_hash, other.state_hash);
  assert.notEqual(old.source_hash, other.source_hash);
  assert.equal(replayContinuityScene({ ...input, context: { ...input.context, time_relation: 'unknown' } }, 'F08:s1').status, 'pending_review');
});
