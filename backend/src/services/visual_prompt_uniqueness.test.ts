import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertChapterUniqueness,
  findAdjacentUniquenessViolation,
  tokenJaccard,
} from './visual_prompt_uniqueness';

/** Chapter 2 style clone corridor prompts (0827 scenes 108–113). */
const CORRIDOR_CLONE =
  'silent dreamcore amusement park corridor interior, tall dark metal lamp post, tiled hallway, cream and white fluffy kitten standing off-center, deep perspective, environmental storytelling';

test('token Jaccard is 1 for byte-identical prompts', () => {
  assert.equal(tokenJaccard(CORRIDOR_CLONE, CORRIDOR_CLONE), 1);
  assert.ok(tokenJaccard(CORRIDOR_CLONE, CORRIDOR_CLONE) >= 0.65);
});

test('chapter-2 six identical corridor prompts fail uniqueness gate', () => {
  const shots = Array.from({ length: 6 }, () => ({ visual_prompt: CORRIDOR_CLONE }));
  const result = assertChapterUniqueness(shots);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected failure');
  assert.equal(result.violation.index, 1);
  assert.equal(result.violation.reason, 'jaccard');
  assert.ok((result.violation.score ?? 0) >= 0.65);
});

test('distinct adjacent prompts pass uniqueness gate', () => {
  const shots = [
    {
      visual_prompt:
        'european arcade corridor, dark metal lamp post, small beige creature walking, mosaic floor',
      uniqueness_key: 'arcade|walk|lamp',
    },
    {
      visual_prompt:
        'insert shot, paw pressing music-note button on miniature park map, arcade background soft',
      uniqueness_key: 'arcade|press|map-button',
    },
    {
      visual_prompt:
        'archway exit to carousel plaza, carved wooden horses ahead, small beige creature silhouette',
      uniqueness_key: 'archway|exit|carousel',
    },
  ];
  const result = assertChapterUniqueness(shots);
  assert.equal(result.ok, true);
  assert.equal(findAdjacentUniquenessViolation(shots), null);
});

test('identical uniqueness_key fails even when prompts differ', () => {
  const shots = [
    { visual_prompt: 'corridor lamp post exploration', uniqueness_key: 'arcade|lamp|touch' },
    { visual_prompt: 'paw on music-note map button insert', uniqueness_key: 'arcade|lamp|touch' },
  ];
  const result = assertChapterUniqueness(shots);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected failure');
  assert.equal(result.violation.reason, 'uniqueness_key');
});
