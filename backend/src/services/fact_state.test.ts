import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindEntities, entityRoster } from './entity_binding';
import { FACT_STATE_ATTRIBUTES } from '../schemas/storyboard_facts';
import { reviewExtractedStates, stateCategoryConflict } from './fact_state';
import { FACT_CLASSIFY_INSTRUCTION, anchorSpans, continuityAfter, continuityForScene, inheritedStates } from './storyboard_fact_workflow';
import { createEmptyScriptDocument } from '../schemas/script';
import type { VisualFact } from '../schemas/storyboard_facts';

const roster = entityRoster([{ id: 1, name: '林岚' }, { id: 2, name: '陈月' }]);
const fact = (text: string, scene = 's'): VisualFact => ({
  id: `f_${scene}_${text.length}`, scene_id: scene, block_id: 'b', text, start: 0, end: text.length, kind: 'visual', beat: 0, states: [], binding: bindEntities(text, roster),
});

test('eight state attributes are legal when the value matches the attribute', () => {
  const samples: Record<string, string> = {
    presence: '走进来',
    wardrobe: '灰外套',
    holding: '红杯',
    position: '镜殿',
    pose: '坐在椅上',
    body: '赤足',
    expression: '脸颊发红',
    pending_action: '尚未说完',
  };
  assert.equal(FACT_STATE_ATTRIBUTES.length, 8);
  for (const attribute of FACT_STATE_ATTRIBUTES) assert.equal(stateCategoryConflict(attribute, samples[attribute]!), null);
});

test('an exact illegal pair is rejected without naming another category', async () => {
  for (const message of [
    stateCategoryConflict('wardrobe', '赤足', '赤足'),
    stateCategoryConflict('holding', '赤足'),
    stateCategoryConflict('position', '跨坐'),
    stateCategoryConflict('holding', '拥抱'),
  ]) {
    assert.match(message || '', /不符/);
    assert.doesNotMatch(message || '', /身体|姿势|pose|body/);
  }
  assert.equal(stateCategoryConflict('body', '赤足'), null);
  assert.equal(stateCategoryConflict('pose', '坐在椅上'), null);
  assert.equal(stateCategoryConflict('wardrobe', '脸颊发红'), null);
  assert.equal(stateCategoryConflict('position', '坐忘观'), null);
  assert.equal(stateCategoryConflict('position', '坐在椅上'), null);
  let calls = 0;
  await assert.rejects(() => reviewExtractedStates('林岚赤足。', async (note) => {
    calls += 1;
    assert.doesNotMatch(note, /身体|姿势/);
    return [{ attribute: 'holding', value: '赤足' }];
  }, (state) => stateCategoryConflict(state.attribute, state.value)), /连续状态待核对/);
  assert.equal(calls, 2);
});

test('expression does not carry, pose and body do, and a foreign place does not', () => {
  const seated = fact('林岚坐在椅上，赤足，脸颊发红。');
  seated.states = [
    { entity: '林岚', attribute: 'pose', value: '坐在椅上' },
    { entity: '林岚', attribute: 'body', value: '赤足', item: '赤足' },
    { entity: '林岚', attribute: 'expression', value: '脸颊发红', item: '脸颊' },
    { entity: '林岚', attribute: 'position', value: '花海深处' },
    { entity: '林岚', attribute: 'wardrobe', value: '灰外套', item: '外套' },
  ];
  const carried = continuityAfter([], [seated]);
  assert.equal(carried.some((state) => state.attribute === 'expression'), false);
  assert.equal(carried.some((state) => state.attribute === 'pose'), true);
  assert.equal(carried.some((state) => state.attribute === 'body'), true);
  assert.equal(carried.filter((state) => state.attribute === 'wardrobe').length, 1);
  const later = fact('林岚抬头。', 'later');
  const dropped = inheritedStates(carried, [later], ['林岚'], '镜殿');
  assert.equal(dropped.some((state) => state.value === '花海深处'), false);
  assert.equal(dropped.some((state) => state.attribute === 'pose'), true);
  assert.equal(dropped.some((state) => state.attribute === 'body'), true);
  assert.equal(inheritedStates(carried, [later], ['林岚'], '花海深处').some((state) => state.value === '花海深处'), true);
  const stood = fact('林岚站了起来。', 'stood');
  stood.states = [{ entity: '林岚', attribute: 'pose', value: '站了起来' }, { entity: '林岚', attribute: 'body', value: '赤足', item: '赤足' }];
  const replaced = continuityAfter(carried, [stood]);
  assert.deepEqual(replaced.filter((state) => state.attribute === 'pose').map((state) => state.value), ['站了起来']);
  assert.equal(replaced.filter((state) => state.attribute === 'body' && state.item === '赤足').length, 1);
});

test('a position from another location id is not carried into the next scene', () => {
  const doc = createEmptyScriptDocument();
  doc.locations = [{ id: 'l', name: '花海', description: '' }, { id: 'm', name: '镜殿', description: '' }];
  doc.scenes = ['s', 'next'].map((id, index) => ({ id, locationId: index ? 'm' : 'l', interiorExterior: 'interior' as const, timeOfDay: 'night' as const, characterIds: [1], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: [] }));
  const first = fact('林岚站在花海。');
  first.states = [{ entity: '林岚', attribute: 'position', value: '花海' }, { entity: '林岚', attribute: 'pose', value: '站着' }];
  const next = fact('她走进镜殿。', 'next');
  next.binding!.mentions[0] = { ...next.binding!.mentions[0]!, entity: roster[0]!, authority: 'human', confirmed: true, status: 'resolved', visibility: 'visible' };
  const kept = continuityForScene(continuityAfter([], [first]), doc, [first, next], 'next');
  assert.equal(kept.some((state) => state.attribute === 'position'), false);
  assert.equal(kept.some((state) => state.attribute === 'pose'), true);
  const leaving = fact('林岚离开镜殿。', 'leave');
  leaving.states = [{ entity: '林岚', attribute: 'position', value: '离开镜殿' }];
  const stayed = fact('她仍在镜殿。', 'stay');
  assert.equal(inheritedStates(continuityAfter([], [leaving]), [stayed], ['林岚'], '镜殿').some((state) => state.value === '离开镜殿'), false);
  assert.equal(inheritedStates(continuityAfter([], [leaving]), [stayed], ['林岚'], '琼明仙域·镜殿').some((state) => state.value === '镜殿'), false);
  const named = fact('林岚在镜殿。', 'named');
  named.states = [{ entity: '林岚', attribute: 'position', value: '镜殿' }];
  assert.equal(inheritedStates(continuityAfter([], [named]), [stayed], ['林岚'], '琼明仙域·镜殿').some((state) => state.value === '镜殿'), true);
});

test('a mixed sentence can stay split into a visible span and a speech span', () => {
  const source = '林岚眼眶发热，她问了一句。';
  const spans = anchorSpans('s', 'b', source, { spans: [
    { text: '林岚眼眶发热，', kind: 'visual', beat: 0, states: [] },
    { text: '她问了一句。', kind: 'audio', beat: 0, states: [] },
  ] });
  assert.deepEqual(spans.map((span) => span.kind), ['visual', 'audio']);
  assert.match(FACT_CLASSIFY_INSTRUCTION, /speech act is not visual/);
  assert.match(FACT_CLASSIFY_INSTRUCTION, /说、问、答、应/);
});
