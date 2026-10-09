import assert from 'node:assert/strict';
import test from 'node:test';
import { splitReviewFact, stabilizeReviewBeats, type ReviewFact } from './storyboardFactReview';

const fact = (text: string, beat: number, scene_id = 'scene'): ReviewFact => ({ scene_id, block_id: 'source', text, beat, kind: 'visual', states: [{ entity: '门', attribute: 'position', value: '门外' }] });

for (const parts of [2, 3, 4]) test(`拆为${parts}段后后续节拍顺延，其他场次不变`, () => {
  const original = [fact('灯亮。', 0), fact(Array.from({ length: parts }, (_, i) => `动作${i}。`).join('\n'), 1), fact('后续动作。', 2), fact('同节拍状态。', 2), fact('其他场。', 0, 'other')];
  const result = splitReviewFact(original, 1);
  assert.deepEqual(result.filter(f => f.scene_id === 'scene').map(f => f.beat), [0, ...Array.from({ length: parts }, (_, i) => i + 1), parts + 1, parts + 1]);
  assert.equal(result.at(-1)!.beat, 0);
  assert.equal(original[2]!.beat, 2);
  assert.ok(result.slice(1, parts + 1).every(f => f.kind === 'uncertain' && f.states.length === 0));
  assert.equal(result.slice(1, parts + 1).map(f => f.text).join(''), original[1]!.text.replaceAll('\n', ''));
});

test('同一块里偏高的前句顺序号降到后句', () => {
  const facts = [fact('钟声响起。', 6), fact('阿岚仍站在原地。', 5)];
  const healed = stabilizeReviewBeats(facts);
  assert.deepEqual(healed.map(item => item.beat), [5, 5]);
  assert.equal(facts[0]!.beat, 6);
});

test('没有多个非空行时不改变节拍和来源状态', () => {
  const facts = [fact('完整动作。\n\n', 3)];
  assert.equal(splitReviewFact(facts, 0), facts);
});
