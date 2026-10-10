import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindEntities, boundText, boundVisibleEntities, entityRoster, eventContentCovered, needsBindingReview, proposeBindings, transferTranslationProblem, validateBinding, englishReferenceProblem, bodyOwnerTerms } from './entity_binding';
import { auditFacts, continuityAfter, continuityForScene, continuityLiteral, evidencedContinuityStates, factSourceHash, sceneContext, sceneContextFacts, scopedWardrobeLock } from './storyboard_fact_workflow';
import { createEmptyScriptDocument, validateScriptForConfirmation } from '../schemas/script';
import type { AIProvider } from './ai/base';
import type { VisualFact } from '../schemas/storyboard_facts';

const roster = entityRoster([{ id: 1, name: '林岚' }, { id: 2, name: '陈月' }]);
const fact = (text: string, scene = 's'): VisualFact => ({ id: `f_${scene}`, scene_id: scene, block_id: 'b', text, start: 0, end: text.length, kind: 'visual', beat: 0, states: [], binding: bindEntities(text, roster) });

test('单人同块代词与省略主语自动继承；多人、离场和跨块不自动确认', () => {
  const single = bindEntities('林岚解开外衣。她把里衣褪到腰间。', roster);
  assert.equal(needsBindingReview(single), false);
  assert.equal(single.mentions.at(-1)?.entity?.name, '林岚');
  assert.equal(needsBindingReview(bindEntities('里衣褪到腰间。', roster, '林岚解开外衣。')), false);
  assert.equal(needsBindingReview(bindEntities('林岚看着陈月，她笑了。', roster)), true);
  assert.equal(needsBindingReview(bindEntities('林岚离开。她举起蓝伞。', roster)), true);
  assert.equal(needsBindingReview(bindEntities('她举起蓝伞。', roster)), true);
  assert.equal(needsBindingReview(bindEntities('林岚抱着猫，它叫了一声。', roster)), true);
  assert.equal(needsBindingReview(bindEntities('林岚看着女儿，她笑了。', roster)), true);
  assert.equal(needsBindingReview(bindEntities('林岚看着陈月的照片，她笑了。', roster)), true);
});

test('相反的离场前文进入短任务；模型 resolved 永远只是建议，歧义候选不入镜', async () => {
  const requests: any[] = [];
  const provider = { async generateStructured(prompt: string, schema: any) {
    const input = JSON.parse(prompt); requests.push(input);
    return schema.parse({ bindings: input.mentions.map((m: any) => ({ index: m.index, entity_id: input.context.includes('林岚离开') ? 'character:2' : 'character:1', status: 'resolved' })) });
  } } as AIProvider;
  const one = await proposeBindings(provider, bindEntities('她举起蓝伞。', roster), '她举起蓝伞。', '林岚离开，陈月留在房间。', roster);
  const two = await proposeBindings(provider, bindEntities('她举起蓝伞。', roster), '她举起蓝伞。', '陈月离开，林岚留在房间。', roster);
  assert.notEqual(requests[0].context, requests[1].context);
  assert.notEqual(one.context_hash, two.context_hash);
  assert.notEqual(one.mentions[0]?.entity?.id, two.mentions[0]?.entity?.id);
  for (const binding of [one, two]) {
    assert.equal(needsBindingReview(binding), true);
    assert.deepEqual(boundVisibleEntities(binding), []);
    assert.throws(() => validateBinding({ ...binding, mentions: binding.mentions.map(m => ({ ...m, confirmed: true })) }, '她举起蓝伞。', roster), /未经人工确认/);
  }
  const ambiguous = bindEntities('林岚看着陈月，她笑了。', roster).mentions.find(m => m.text === '她')!;
  assert.equal(ambiguous.status, 'ambiguous'); assert.equal(ambiguous.entity, null);
});

test('照片提及不是本人入镜；同名和代词绑定以稳定人物 ID 表达', () => {
  const binding = bindEntities('林岚看着陈月的照片。', roster);
  assert.deepEqual(boundVisibleEntities(binding).map(e => e.name), ['林岚']);
  assert.equal(binding.mentions.find(m => m.text === '陈月')?.visibility, 'mentioned');
  assert.deepEqual(boundVisibleEntities(bindEntities('照片里的陈月穿蓝外套。', roster)), []);
  const duplicates = entityRoster([{ id: 1, name: '林岚' }, { id: 2, name: '林岚' }]);
  assert.equal(needsBindingReview(bindEntities('林岚举起蓝伞。', duplicates)), true);
});

test('绑定属于原文本版本，修改归属影响契约 hash，不能沿用旧确认', () => {
  const text = '林岚解开外衣。她伸手。';
  const binding = bindEntities(text, roster);
  assert.throws(() => boundText('她伸手。', binding), /文本版本/);
  assert.throws(() => validateBinding(binding, `${text}陈月进门。`, roster), /文本版本/);
  const doc = createEmptyScriptDocument();
  doc.locations = [{ id: 'l', name: '房间', description: '白墙' }];
  doc.scenes = [{ id: 's', locationId: 'l', interiorExterior: 'interior', timeOfDay: 'night', characterIds: [1], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: [{ id: 'b', type: 'action', text, binding }] }];
  const original = fact(text); const changed = structuredClone(original);
  changed.binding!.mentions.at(-1)!.entity = roster[1]!;
  assert.notEqual(factSourceHash(doc, [original], roster), factSourceHash(doc, [changed], roster));
  doc.scenes[0]!.blocks[0]!.text = '她伸手。';
  assert.equal(validateScriptForConfirmation(doc).valid, false);
});

test('交换施受关系不再靠词面通过，同关系被动句通过；英文模型自审 true 也不能放行反转', async () => {
  const source = '林岚把蓝伞递给陈月。';
  assert.equal(eventContentCovered(source, '陈月把蓝伞递给林岚。'), false);
  assert.equal(eventContentCovered(source, '蓝伞被林岚递给陈月。'), true);
  assert.equal(eventContentCovered('林岚用右手把蓝伞递给陈月。', '蓝伞被林岚用右手递给陈月。'), true);
  const glossary = { 林岚: 'Lin Lan', 陈月: 'Chen Yue' };
  assert.equal(transferTranslationProblem(source, 'Lin Lan hands the blue umbrella to Chen Yue.', glossary), null);
  assert.equal(transferTranslationProblem(source, 'The blue umbrella is handed to Chen Yue by Lin Lan.', glossary), null);
  const provider = { async generateStructured(_p: string, schema: any) { return schema.parse({ faithful: true }); } } as AIProvider;
  await assert.rejects(() => auditFacts(provider, [{ id: 'f', text: source }], 'Chen Yue hands the blue umbrella to Lin Lan.', { glossary }), /施受关系/);
  await assert.rejects(() => auditFacts(provider, [{ id: 'f', text: '林岚用右手把蓝伞递给陈月。' }], "Lin Lan hands the blue umbrella to Chen Yue with Chen Yue's right hand.", { glossary }), /身体部位归属/);
});

test('衣着状态逐件继承，外观锁不再按衣类删除', () => {
  const first = fact('林岚解开外衣。');
  first.states = [{ entity: '林岚', attribute: 'wardrobe', value: '解开外衣', item: '外衣' }, { entity: '林岚', attribute: 'wardrobe', value: '围巾', item: '围巾' }];
  const next = fact('林岚把里衣褪到腰间。', 'next');
  next.states = [{ entity: '林岚', attribute: 'wardrobe', value: '里衣褪到腰间', item: '里衣' }];
  const state = continuityAfter([], [first, next]);
  assert.equal(state.length, 3);
  const removed = fact('林岚摘掉围巾。'); removed.states = [{ entity: '林岚', attribute: 'wardrobe', value: '围巾', item: '围巾', operation: 'remove' }];
  const after = continuityAfter(state, [removed]);
  assert.equal(after.filter(s => s.operation !== 'remove').length, 2);
  assert.ok(continuityLiteral(after).some(s => s.text === '林岚 已脱下衣物：围巾'));
  assert.equal(scopedWardrobeLock('林岚', 'red scarf, gray coat, long hair', [], after), 'red scarf, gray coat, long hair');
  assert.equal(scopedWardrobeLock('陈月', 'gray coat, long hair', [first]), 'gray coat, long hair');
  assert.equal(scopedWardrobeLock('林岚', 'gray coat, long hair', [first]), 'gray coat, long hair');
  assert.equal(evidencedContinuityStates('陈月穿红外套。', [{ entity: '林岚', attribute: 'wardrobe', value: '红外套' }], '林岚站在门旁。').rejected.length, 1);
  assert.equal(evidencedContinuityStates('她穿红外套。', [{ entity: '林岚', attribute: 'wardrobe', value: '红外套' }]).rejected.length, 1);
  assert.equal(evidencedContinuityStates('她穿红外套。', [{ entity: '林岚', attribute: 'wardrobe', value: '红外套' }], '', ['林岚']).accepted.length, 1);
});

test('跨场代词确认后保留衣着；地点描述、内外景和昼夜都进入事实输入', () => {
  const doc = createEmptyScriptDocument();
  doc.locations = [{ id: 'l', name: '房间', description: '白墙' }];
  doc.scenes = ['s', 'next'].map(id => ({ id, locationId: 'l', interiorExterior: 'interior', timeOfDay: 'night', characterIds: [1], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: [] }));
  const first = fact('林岚穿灰外套。'); first.states = [{ entity: '林岚', attribute: 'wardrobe', value: '灰外套', item: '外套' }];
  const next = fact('她伸手。', 'next');
  next.binding!.mentions[0] = { ...next.binding!.mentions[0]!, entity: roster[0]!, authority: 'human', confirmed: true, status: 'resolved', visibility: 'visible' };
  assert.equal(continuityForScene(continuityAfter([], [first]), doc, [first, next], 'next').length, 1);
  assert.deepEqual(sceneContextFacts(sceneContext(doc, doc.scenes[1]!)).map(f => f.text), ['白墙', '室内', '夜间']);
});

test('明确完成递交解除旧持有者，递出但未接过不提前转移', () => {
  const first = fact('林岚握着蓝伞。'); first.states = [{ entity: '林岚', attribute: 'holding', item: '蓝伞', value: '蓝伞' }];
  const handed = fact('林岚把蓝伞递给陈月。', 'next');
  const state = continuityAfter([], [first, handed]);
  assert.deepEqual(state.filter(s => s.attribute === 'holding').map(s => [s.entity, s.item]), [['陈月', '蓝伞']]);
  const offered = fact('林岚向陈月递出蓝伞。', 'next');
  assert.equal(continuityAfter([], [first, offered])[0]?.entity, '林岚');
});

test('英文代词保留错误证据，不分男女；姓名 Qing He 不被误拦', () => {
  assert.equal(englishReferenceProblem('Qing He raises a cup.', { 青禾: 'Qing He' }), null);
  assert.ok(englishReferenceProblem('Qing He straddles him.', { 青禾: 'Qing He' }));
  assert.ok(englishReferenceProblem('Lin Lan touches her arm.', { 林岚: 'Lin Lan' }));
  assert.ok(englishReferenceProblem('They leave.', { 贺: 'He' }));
  assert.deepEqual(bodyOwnerTerms('林岚用右手把蓝伞递给陈月。', { 林岚: 'Lin Lan', 陈月: 'Chen Yue' }), ["Lin Lan's right hand"]);
});
