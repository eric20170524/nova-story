import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyScriptDocument } from '../schemas/script';
import { ContinuityEntitySchema, ContinuityStoryOrderSchema } from '../schemas/continuity';
import { ShotSourceReferenceSchema, packShotSpec } from '../schemas/shot_contract';
import {
  validateContinuityEntities, registerContinuityEntity, continuityEntityCandidates,
  requireContinuityEntity, requireContinuityCharacter, validateContinuityEntityRelation, buildContinuityStoryOrder,
  makeContinuityStoryPosition, validateContinuityStoryPosition, coverageContinuitySource,
  ContinuityIdentityError,
} from './continuity_identity';
import { loadContinuityFixtures, type ContinuityFixture } from '../test_fixtures/continuity';
import { compileCoverageCandidate } from '../routes/coverage';

const resources = { characters: [{ id: 1, project_id: 10 }, { id: 2, project_id: 10 }, { id: 3, project_id: 20 }], assets: [{ id: 70, project_id: 10 }, { id: 80, project_id: 20 }] };
const scopeError = (status = 422) => (error: unknown) => error instanceof ContinuityIdentityError && error.statusCode === status;
function fixtureEntities(fixture: ContinuityFixture) {
  return fixture.entities.map(entity => ({ entity_id: entity.id, project_id: 10, kind: entity.kind,
    display_name: entity.name, aliases: [], ...(entity.character_id !== undefined ? { character_id: entity.character_id } : {}),
    ...(entity.parent_entity_id ? { parent_entity_id: entity.parent_entity_id } : {}),
    ...(entity.asset_id ? { asset_id: 70, asset_revision: 1 } : {}),
  }));
}
function storyFixture() {
  const doc = createEmptyScriptDocument('CT02 三场');
  doc.locations = [{ id: 'room', name: '房间', description: '' }];
  doc.outline.beats = [{ id: 'beat-transfer', purpose: '递交', eventIds: [] }];
  doc.scenes = ['F05:s1', 'F05:s2', 'F05:s3'].map(id => ({ id, locationId: 'room', interiorExterior: 'interior' as const,
    timeOfDay: 'day', characterIds: [], propIds: [], eventIds: [], beatIds: id === 'F05:s2' ? ['beat-transfer'] : [],
    sourceParagraphIds: [], blocks: [{ id: `${id}:block`, type: 'action' as const, text: '陈月握着黑伞。' }],
  }));
  const order = buildContinuityStoryOrder({ project_id: 10, script_id: 30, script_revision: 4, story_segment_id: 'linear-1', document: doc });
  const position = makeContinuityStoryPosition(order, { script_scene_id: 'F05:s2', beat_id: 'beat-transfer', change_order: 1, moment_id: 'F05:after-handover', phase: 'after' });
  const entities = validateContinuityEntities(10, fixtureEntities(loadContinuityFixtures()[4]!.fixture), resources);
  const source = ShotSourceReferenceSchema.parse({ type: 'script', script_id: 30, script_revision: 4, script_scene_id: 'F05:s2', block_ids: ['F05:s2:block'],
    continuity: { story_position: position, entity_ids: ['F05:u1'] },
  });
  return { doc, order, position, entities, source };
}

test('CT02 C01/C04: frozen fixtures register separate garments and same-name physical objects', () => {
  for (const { fixture } of loadContinuityFixtures()) assert.equal(validateContinuityEntities(10, fixtureEntities(fixture), resources).length, fixture.entities.length);
  const fixture = loadContinuityFixtures()[1]!.fixture;
  const entities = validateContinuityEntities(10, fixtureEntities(fixture), resources);
  const umbrellas = continuityEntityCandidates(10, '黑伞', entities);
  assert.deepEqual(umbrellas.map(entity => entity.entity_id), ['F02:u1', 'F02:u2']);
  assert.equal(umbrellas[0]!.asset_id, umbrellas[1]!.asset_id);
  assert.notEqual(umbrellas[0]!.entity_id, umbrellas[1]!.entity_id);
  assert.equal(continuityEntityCandidates(10, '外套', entities).length, 2);
  assert.equal(requireContinuityEntity(10, 'F02:coat1', entities).entity_id, 'F02:coat1');
});

test('CT02 physical registration creates new IDs even with the same name and shared design', () => {
  const input = { kind: 'prop' as const, display_name: '黑伞', asset_id: 70, aliases: ['雨伞'] };
  const first = registerContinuityEntity(10, input, [], resources);
  const second = registerContinuityEntity(10, input, [first], resources);
  assert.notEqual(first.entity_id, second.entity_id);
  assert.equal(continuityEntityCandidates(10, '雨伞', [first, second]).length, 2);
  const renamed = validateContinuityEntities(10, [{ ...first, display_name: '左侧黑伞', asset_revision: 2 }, second], resources);
  assert.equal(renamed[0]!.entity_id, first.entity_id);
  assert.equal(second.display_name, '黑伞');
});

test('CT02 characters reference project characters; duplicate names may refer to different people', () => {
  const first = registerContinuityEntity(10, { kind: 'character', display_name: '林岚', character_id: 1 }, [], resources);
  const second = registerContinuityEntity(10, { kind: 'character', display_name: '林岚', character_id: 2 }, [first], resources);
  assert.equal(continuityEntityCandidates(10, '林岚', [first, second]).length, 2);
  assert.equal(requireContinuityCharacter(10, 1, [first, second]).entity_id, first.entity_id);
  assert.equal(requireContinuityCharacter(10, 2, [first, second]).entity_id, second.entity_id);
  assert.throws(() => requireContinuityCharacter(20, 1, [first, second]), scopeError(404));
  assert.throws(() => requireContinuityCharacter(10, 1, [first, { ...first, entity_id: 'corrupt-duplicate' }]), scopeError(409));
  assert.throws(() => registerContinuityEntity(10, { kind: 'character', display_name: '别名', character_id: 1 }, [first], resources), /already has/);
  assert.equal(ContinuityEntitySchema.safeParse({ entity_id: 'x', project_id: 10, kind: 'prop', display_name: '伞', character_id: 1 }).success, false);
});

test('CT02 foreign or missing project resources fail closed', () => {
  for (const input of [
    { kind: 'character' as const, display_name: '外部人物', character_id: 3 },
    { kind: 'prop' as const, display_name: '外部资产', asset_id: 80 },
    { kind: 'prop' as const, display_name: '缺失资产', asset_id: 999 },
  ]) assert.throws(() => registerContinuityEntity(10, input, [], resources), scopeError(404));
  const entity = registerContinuityEntity(10, { kind: 'prop', display_name: '无资产实物' }, [], resources);
  assert.throws(() => validateContinuityEntities(20, [entity], resources), scopeError(404));
});

test('CT02 component parents reject cross-project links, self references and cycles', () => {
  const door = registerContinuityEntity(10, { kind: 'object', display_name: '门', entity_id: 'door' }, [], resources);
  const lock = registerContinuityEntity(10, { kind: 'component', display_name: '锁', parent_entity_id: 'door', entity_id: 'lock' }, [door], resources);
  assert.equal(lock.parent_entity_id, door.entity_id);
  assert.throws(() => registerContinuityEntity(10, { kind: 'component', display_name: '锁', parent_entity_id: 'foreign' }, [door], resources), scopeError(404));
  assert.throws(() => validateContinuityEntities(10, [{ ...door, parent_entity_id: 'lock' }, lock], resources), /cycle/);
  assert.equal(ContinuityEntitySchema.safeParse({ ...lock, parent_entity_id: 'lock' }).success, false);
  assert.throws(() => validateContinuityEntities(10, [door, { ...door, display_name: '另一扇门' }], resources), /Duplicate physical/);
});

test('CT02 relations use scoped IDs rather than names or asset IDs', () => {
  const entities = validateContinuityEntities(10, fixtureEntities(loadContinuityFixtures()[1]!.fixture), resources);
  const relation = { project_id: 10, entity_id: 'F02:u2', target_entity_id: 'F02:lin' };
  assert.deepEqual(validateContinuityEntityRelation(10, relation, entities), relation);
  for (const invalid of [{ ...relation, project_id: 20 }, { ...relation, target_entity_id: '林岚' }, { ...relation, entity_id: '70' }, { ...relation, target_entity_id: 'F01:lin' }]) {
    assert.throws(() => validateContinuityEntityRelation(10, invalid, entities), scopeError(404));
  }
});

test('CT02 C07: requesting positions 3→1→2 yields the same positions as 1→2→3', () => {
  const { order } = storyFixture();
  const make = (number: number) => makeContinuityStoryPosition(order, { script_scene_id: `F05:s${number}`, change_order: 0, moment_id: `moment-${number}`, phase: 'before' });
  const normal = [1, 2, 3].map(make);
  const shuffled = [3, 1, 2].map(make).sort((a, b) => a.scene_order - b.scene_order);
  assert.deepEqual(normal, shuffled);
  assert.deepEqual(normal.map(position => position.scene_order), [0, 1, 2]);
});

test('CT02 screenplay version and beat ownership are validated', () => {
  const { order, position } = storyFixture();
  assert.throws(() => validateContinuityStoryPosition({ ...position, script_revision: 3 }, order), scopeError(409));
  assert.throws(() => validateContinuityStoryPosition({ ...position, screenplay_order_revision: 3 }, order), scopeError(409));
  assert.throws(() => validateContinuityStoryPosition({ ...position, project_id: 20 }, order), scopeError(404));
  assert.throws(() => validateContinuityStoryPosition({ ...position, script_scene_id: 'F05:s3', scene_order: 2 }, order), scopeError());
  assert.throws(() => makeContinuityStoryPosition(order, { script_scene_id: 'timeline-shot-100', change_order: 0, moment_id: 'm', phase: 'before' }), scopeError());
  assert.throws(() => makeContinuityStoryPosition(order, { script_scene_id: 'F05:s1', beat_id: 'beat-transfer', change_order: 0, moment_id: 'm', phase: 'before' }), scopeError());
});

test('CT02 timeline indexes cannot enter the story-order contract', () => {
  const { doc, order } = storyFixture();
  const dirty = structuredClone(order) as any;
  dirty.scenes[0].index = 99;
  assert.equal(ContinuityStoryOrderSchema.safeParse(dirty).success, false);
  const changedDocument = structuredClone(doc);
  changedDocument.scenes.reverse();
  const next = buildContinuityStoryOrder({ project_id: 10, script_id: 30, script_revision: 5, story_segment_id: 'linear-1', document: changedDocument });
  assert.equal(next.scenes[0]!.script_scene_id, 'F05:s3');
  assert.equal(next.screenplay_order_revision, 5);
  assert.equal(order.scenes[0]!.script_scene_id, 'F05:s1');
});

test('CT02 C08: coverage compilation and before/after/replace placement preserve the same moment', () => {
  const { order, position, source, entities } = storyFixture();
  const frozen = structuredClone({ order, source });
  for (const placement of ['before', 'after', 'replace']) {
    // Placement controls timeline rows only; it is never passed into story-position construction.
    const copied = coverageContinuitySource({ project_id: 10, source_shot_id: 102, source }, order, entities);
    const compiled = compileCoverageCandidate({ slot: 1, location: '房间', primary_action: '陈月握着黑伞', shot_type: 'Wide Shot' }, [], 0, copied);
    const serialized = JSON.parse(compiled.shot_spec);
    assert.deepEqual(serialized.source.continuity.story_position, position, placement);
    assert.equal(serialized.source.continuity.source_shot_id, 102);
    assert.deepEqual(serialized.source.continuity.entity_ids, ['F05:u1']);
    copied.continuity!.entity_ids.push('new-copy-only');
  }
  assert.deepEqual({ order, source }, frozen);
});

test('CT02 coverage helpers reject stale and mismatched references, with a valid positive case', () => {
  const { order, source, entities } = storyFixture();
  assert.ok(coverageContinuitySource({ project_id: 10, source_shot_id: 102, source }, order, entities));
  const stale = structuredClone(source);
  stale.script_revision = 3; stale.continuity!.story_position.script_revision = 3;
  assert.throws(() => coverageContinuitySource({ project_id: 10, source_shot_id: 102, source: stale }, order, entities), scopeError(409));
  assert.throws(() => coverageContinuitySource({ project_id: 20, source_shot_id: 102, source }, order, entities), scopeError(404));
  assert.throws(() => coverageContinuitySource({ project_id: 10, source_shot_id: 102, source }, order, []), scopeError(404));
  assert.throws(() => coverageContinuitySource({ project_id: 10, source_shot_id: 102, source: { type: 'script', script_id: 30 } }, order, entities), scopeError(409));
});

test('CT02 packed shot provenance cannot claim another scene or chapter moment', () => {
  const { source } = storyFixture();
  for (const invalid of [{ ...source, type: 'chapter' as const }, { ...source, script_scene_id: 'F05:s3' }, { ...source, script_id: 31 }]) {
    assert.equal(ShotSourceReferenceSchema.safeParse(invalid).success, false);
    assert.throws(() => packShotSpec({ location: '房间', primary_action: '握着黑伞', source: invalid }));
  }
  const legacy = JSON.parse(packShotSpec({ location: '房间', primary_action: '握着黑伞', source: { type: 'script', script_id: 30, script_revision: 4, script_scene_id: 'F05:s2' } }));
  assert.equal(Object.hasOwn(legacy.source, 'continuity'), false);
});
