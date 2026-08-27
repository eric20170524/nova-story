import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDreamcoreAc } from './dreamcore_ac_verify';

const passingFixture = [
  {
    chapter_index: 2,
    scenes: [
      {
        index: 1,
        shot_type: 'Insert Shot',
        shot_intent: 'insert',
        visual_prompt: 'insert shot, paw presses music-note button on miniature park map',
        negative_prompt: 'aerial, landscape',
      },
    ],
  },
  {
    chapter_index: 3,
    scenes: [
      {
        index: 1,
        visual_prompt: 'carved carousel horses, candy-floss cloud-shaped platforms',
      },
    ],
  },
  {
    chapter_index: 8,
    scenes: [
      {
        index: 8,
        shot_intent: 'insert',
        visual_prompt: 'ornate music box on red velvet',
        negative_prompt: 'aerial, satellite photo, mecha',
      },
    ],
  },
  {
    chapter_index: 10,
    scenes: [
      {
        index: 4,
        shot_intent: 'payoff',
        visual_prompt: 'core seats into engraved groove',
        negative_prompt: 'mecha, helmet, spaceship',
      },
    ],
  },
];

test('assertDreamcoreAc passes golden fixture', () => {
  const result = assertDreamcoreAc(passingFixture);
  assert.equal(result.ok, true);
});

test('assertDreamcoreAc fails cloud-like and missing payoff', () => {
  const bad = structuredClone(passingFixture);
  bad[1]!.scenes[0]!.visual_prompt = 'cloud-like platforms in the sky';
  bad[3]!.scenes = [{ visual_prompt: 'park lights', negative_prompt: 'watermark' }];
  const result = assertDreamcoreAc(bad);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected failure');
  assert.ok(result.failures.some((f) => f.rule === 'no_cloud_like'));
  assert.ok(result.failures.some((f) => f.rule === 'payoff_core_groove'));
});
