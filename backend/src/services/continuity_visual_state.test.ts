import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContinuityEntity } from '../schemas/continuity';
import { continuityVisualStates, continuityVisualFact, charactersWithConfirmedWardrobe } from './continuity_visual_state';
import { shotImageMaterialsFromSpec } from './english_visual_prompt';
import { packShotSpec, ShotContractFieldsSchema } from '../schemas/shot_contract';
const entities: ContinuityEntity[] = [
  { entity_id: 'lin', project_id: 1, kind: 'character', display_name: '林岚', aliases: [], character_id: 1 },
  { entity_id: 'chen', project_id: 1, kind: 'character', display_name: '陈月', aliases: [], character_id: 2 },
  ...['coat1', 'coat2', 'scarf'].map(entity_id => ({ entity_id, project_id: 1, kind: 'garment' as const, display_name: '外套', aliases: [] })),
  ...['u1', 'u2'].map(entity_id => ({ entity_id, project_id: 1, kind: 'prop' as const, display_name: '黑伞', aliases: [] })),
  { entity_id: 'room', project_id: 1, kind: 'location', display_name: '房间', aliases: [] },
  { entity_id: 'door', project_id: 1, kind: 'object', display_name: '门板', aliases: [] },
  { entity_id: 'glass', project_id: 1, kind: 'component', display_name: '玻璃', aliases: [], parent_entity_id: 'door' },
  { entity_id: 'lock', project_id: 1, kind: 'component', display_name: '门锁', aliases: [], parent_entity_id: 'door' },
  { entity_id: 'lamp', project_id: 1, kind: 'object', display_name: '灯', aliases: [] },
];
const cell = (entity_id: string, attribute_id: string, value: unknown) => ({ entity_id, attribute_id, knowledge_status: 'confirmed', value });
function materials(cells: ReturnType<typeof cell>[]) {
  const states = continuityVisualStates(entities, cells, 'snapshot');
  const packed = JSON.parse(packShotSpec({ location: '房间', primary_action: '陈月站在门边', visible_subjects: ['林岚', '陈月'], continuity_states: states }));
  assert.equal(ShotContractFieldsSchema.parse({ ...packed, shot_intent: undefined, subject_scale: undefined }).continuity_states?.[0]?.entity_id, states[0]?.entity_id);
  return shotImageMaterialsFromSpec(packed, entities.filter(e => e.kind === 'character').map(e => ({ name: e.display_name, visual_tags: { base_model: { tags: { clothing: 'default red coat', hair: 'black hair', accessories: 'default scarf' } } } })));
}
test('CT10 two equal-name garments keep per-item colour, wetness, damage and wearer through compilation', () => {
  const input = [cell('coat1', 'wearer', 'lin'), cell('coat1', 'color', 'blue'), cell('coat1', 'wetness', 'wet'), cell('coat1', 'integrity', 'damaged'), cell('coat2', 'wearer', 'chen'), cell('coat2', 'wetness', 'dry'), cell('scarf', 'wearer', null), cell('scarf', 'owner', 'lin')];
  const before = structuredClone(input); const result = materials(input);
  assert.deepEqual(input, before);
  for (const id of ['coat1', 'coat2', 'scarf']) assert.ok(result.facts.some(f => f.text.includes(`[${id}]`)));
  assert.ok(result.facts.some(f => /coat1.*湿透/.test(f.text)));
  assert.ok(result.facts.some(f => /coat2.*干燥/.test(f.text)));
  assert.ok(result.facts.some(f => /scarf.*明确无此关系/.test(f.text)));
  assert.ok(result.characters.every(c => !c.appearance.clothing && c.appearance.hair === 'black hair'));
});
test('CT10 physical wardrobe suppresses only the current wearer; unknown and unchanged other person defaults remain', () => {
  const states = [cell('coat1', 'wearer', 'chen'), cell('coat1', 'owner', 'lin'), cell('coat1', 'wetness', 'wet')];
  const result = materials(states);
  assert.equal(result.characters.find(c => c.name === '林岚')?.appearance.clothing, 'default red coat');
  assert.equal(result.characters.find(c => c.name === '陈月')?.appearance.clothing, '');
  assert.deepEqual([...charactersWithConfirmedWardrobe(continuityVisualStates(entities, [cell('coat1', 'owner', 'lin')], 'snapshot'))], []);
  assert.equal(continuityVisualStates(entities, [{ entity_id: 'coat1', attribute_id: 'wetness', knowledge_status: 'unknown' }], 'snapshot').length, 0);
});
test('CT11 owner, holder, location, damage and replacement remain independent for same-name props', () => {
  const result = materials([cell('u1', 'owner', 'lin'), cell('u1', 'holder', 'chen'), cell('u1', 'location', 'room'), cell('u1', 'integrity', 'broken'), cell('u2', 'holder', null), cell('u2', 'integrity', 'intact')]);
  const facts = result.facts.map(f => f.text).join('\n');
  assert.match(facts, /u1.*所有者=.*林岚.*lin/); assert.match(facts, /u1.*持有者=.*陈月.*chen/);
  assert.match(facts, /u1.*所在地点=.*房间.*room/); assert.match(facts, /u1.*完整度=.*损坏/);
  assert.match(facts, /u2.*完整度=.*完好/); assert.match(facts, /u2.*持有者=.*明确无此关系/);
  assert.equal(result.characters[0]?.appearance.clothing, 'default red coat');
});
test('CT12 an empty location compiles door, glass, lock and light independently without inventing repairs', () => {
  const states = continuityVisualStates(entities, [cell('door', 'open_state', 'closed'), cell('door', 'integrity', 'intact'), cell('glass', 'integrity', 'broken'), cell('lock', 'lock_function', 'broken'), cell('lamp', 'power_state', 'off')], 'snapshot');
  const result = shotImageMaterialsFromSpec({ location: '房间', primary_action: '空房间', continuity_states: states, visible_subjects: [] });
  assert.equal(result.characters.length, 0);
  const facts = result.facts.map(f => f.text).join('\n');
  assert.match(facts, /door.*开闭=关闭/); assert.match(facts, /lock.*锁功能=损坏/); assert.match(facts, /glass.*组件所属 door.*完整度=损坏/); assert.match(facts, /lamp.*电源=关闭/);
  assert.equal(result.facts.filter(f => f.text.includes('锁功能')).length, 1);
  assert.match(continuityVisualFact(states[0]!), /door/);
});
test('CT10 a shared design and reference revision change preserve independent garment IDs and confirmed story values', () => {
  const before = entities.map(entity => ['coat1', 'coat2'].includes(entity.entity_id) ? { ...entity, asset_id: 9, asset_revision: 1 } : entity);
  const after = before.map(entity => entity.entity_id === 'coat1' ? { ...entity, asset_revision: 2, display_name: '新版外套参考' } : entity);
  const cells = [cell('coat1', 'wetness', 'wet'), cell('coat2', 'wetness', 'dry')];
  const old = continuityVisualStates(before, cells, 'old'), next = continuityVisualStates(after, cells, 'next');
  assert.deepEqual(next.map(state => [state.entity_id, state.canonical_value]), old.map(state => [state.entity_id, state.canonical_value]));
  assert.deepEqual(next.map(state => [state.design_asset_id, state.design_asset_revision]), [[9, 2], [9, 1]]);
});
