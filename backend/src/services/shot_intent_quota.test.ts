import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertChapterShotQuota,
  chapterLikelyHasKeyProps,
  mapShotTypeToIntent,
} from './shot_intent_quota';

test('mapShotTypeToIntent maps Wide Environmental and Insert', () => {
  assert.equal(mapShotTypeToIntent('Wide Environmental Action Shot'), 'wide-action');
  assert.equal(mapShotTypeToIntent('Insert Shot'), 'insert');
  assert.equal(mapShotTypeToIntent('Establishing Shot'), 'establish');
  assert.equal(mapShotTypeToIntent('Overhead Shot'), 'overhead-map');
  assert.equal(mapShotTypeToIntent('Close-Up'), 'reaction');
});

test('rejects 11 shots that are all Wide Environmental Action Shot', () => {
  const shots = Array.from({ length: 11 }, () => ({
    shot_type: 'Wide Environmental Action Shot',
    visual_prompt: 'corridor, lamp post, small creature walking',
  }));
  const result = assertChapterShotQuota(shots, { hasKeyProps: true });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected failure');
  assert.ok(
    result.violation.reason === 'homogenous_shot_type'
      || result.violation.reason === 'homogenous_intent'
      || result.violation.reason === 'missing_insert'
  );
});

test('balanced chapter with insert passes', () => {
  const shots = [
    { shot_type: 'Establishing Shot', visual_prompt: 'arcade entrance, mosaic, lamps' },
    { shot_type: 'Wide Environmental Action Shot', visual_prompt: 'creature walks corridor' },
    { shot_type: 'Wide Shot', visual_prompt: 'touches lamp post' },
    { shot_type: 'Insert Shot', visual_prompt: 'paw presses music-note button on map' },
    { shot_type: 'Medium Shot', visual_prompt: 'creature looks at archway' },
    { shot_type: 'Long Shot', visual_prompt: 'exits to carousel plaza' },
  ];
  const result = assertChapterShotQuota(shots, { hasKeyProps: true });
  assert.equal(result.ok, true);
});

test('chapterLikelyHasKeyProps detects guide map / music box cues', () => {
  assert.equal(chapterLikelyHasKeyProps('按压导览图上的音符按钮'), true);
  assert.equal(chapterLikelyHasKeyProps('抱起八音盒核心'), true);
  assert.equal(chapterLikelyHasKeyProps('只是走过空走廊'), false);
});
