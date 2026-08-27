import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePonyPrompt } from './pony_prompt_compiler';
import { compileNegativePrompt } from './negative_prompt_compiler';

const FURRY_LOCK =
  'one small beige-and-white furry creature, quadruped, pointed ears, amber eyes';

test('G1 insert map button keeps prop focus without kitten or corridor lead', () => {
  const { visual_prompt } = compilePonyPrompt(
    {
      shot_intent: 'insert',
      location: 'european arcade, mosaic floor, dark metal lamp post',
      primary_action: 'paw presses music-note button',
      key_props: ['miniature park map', 'music-note button'],
      subject_scale: 'absent',
      primary_subject: 'paw-only',
    },
    FURRY_LOCK
  );

  assert.match(visual_prompt, /insert/i);
  assert.match(visual_prompt, /music-note|button/i);
  assert.match(visual_prompt, /map|guide/i);
  assert.doesNotMatch(visual_prompt, /\bkitten\b/i);
  assert.doesNotMatch(visual_prompt, /environmental storytelling/i);
  // First meaningful subject should not be corridor / lamp post
  const head = visual_prompt.slice(0, 80).toLowerCase();
  assert.doesNotMatch(head, /^[^,]*(corridor|lamp post)/i);
});

test('G2 establish grounds cloud-like platform and adds nature negatives', () => {
  const compiled = compilePonyPrompt(
    {
      shot_intent: 'establish',
      location: 'carousel plaza with cloud-like platforms',
      primary_action: 'view carved carousel horses and platforms',
      key_props: ['carved carousel horses', 'cloud-like platforms'],
      subject_scale: 'absent',
    },
    FURRY_LOCK
  );
  assert.doesNotMatch(compiled.visual_prompt, /cloud-like/i);
  assert.match(compiled.visual_prompt, /carousel|wooden horses|horses/i);
  assert.match(compiled.visual_prompt, /platform/i);

  const neg = compileNegativePrompt({
    shot_intent: 'establish',
    location: 'carousel plaza with cloud-like platforms',
    visual_prompt: compiled.visual_prompt,
    key_props: ['carved carousel horses', 'cloud-like platforms'],
  });
  const mergedNeg = [neg, ...compiled.negative_extras].join(', ');
  assert.match(mergedNeg, /mountains/i);
  assert.match(mergedNeg, /real clouds|outdoor nature/i);
});

test('G3 ice pool insert drops sound words and keeps texture negatives', () => {
  const compiled = compilePonyPrompt(
    {
      shot_intent: 'insert',
      location: 'rigid glass-like ice pool',
      primary_action: 'claw taps ice, concentric ripples',
      key_props: ['ice pool'],
      subject_scale: 'absent',
      primary_subject: 'paw-only',
    },
    FURRY_LOCK
  );
  assert.doesNotMatch(compiled.visual_prompt, /\becho\b|\bring\b|\bscent\b/i);

  const neg = compileNegativePrompt({
    shot_intent: 'insert',
    visual_prompt: compiled.visual_prompt,
    key_props: ['ice pool'],
  });
  assert.match(neg, /abstract|scales|macro texture/i);
});

test('G4 music box insert keeps box/velvet and aerial/mecha negatives', () => {
  const compiled = compilePonyPrompt(
    {
      shot_intent: 'insert',
      location: 'purple gondola cabin, red velvet seat',
      primary_action: 'holds miniature brass music box',
      key_props: ['miniature brass music box', 'red velvet'],
      subject_scale: 'absent',
    },
    FURRY_LOCK
  );
  assert.match(compiled.visual_prompt, /music box/i);
  assert.match(compiled.visual_prompt, /velvet/i);
  assert.doesNotMatch(compiled.visual_prompt, /farmland|satellite photo|aerial park/i);

  const neg = compileNegativePrompt({
    shot_intent: 'insert',
    visual_prompt: compiled.visual_prompt,
    key_props: ['music box'],
    location: 'cabin',
  });
  assert.match(neg, /aerial|satellite/i);
  assert.match(neg, /spaceship|mecha/i);
});

test('G5 payoff core into groove keeps budget and mecha negatives', () => {
  const compiled = compilePonyPrompt(
    {
      shot_intent: 'payoff',
      location: 'circular hub chamber',
      primary_action: 'core seats into engraved groove',
      key_props: ['music box core', 'engraved groove'],
      subject_scale: 'medium-20-40',
      primary_subject: FURRY_LOCK,
    },
    FURRY_LOCK
  );
  assert.match(compiled.visual_prompt, /core|music box/i);
  assert.match(compiled.visual_prompt, /groove|slot|socket/i);
  // Concept budget: must not list five revival events at once
  assert.doesNotMatch(
    compiled.visual_prompt,
    /flags.*rides.*water.*lights|rides.*water.*lights.*flags/i
  );

  const neg = compileNegativePrompt({
    shot_intent: 'payoff',
    visual_prompt: compiled.visual_prompt,
    key_props: ['music box core', 'mechanism'],
  });
  assert.match(neg, /mecha|helmet/i);
});

test('primary_subject name resolves to visual lock instead of replacing it', () => {
  const { visual_prompt } = compilePonyPrompt(
    {
      shot_intent: 'medium-action',
      location: 'arcade corridor',
      primary_action: 'Lin approaches the lamp post',
      primary_subject: 'Lin',
      key_props: ['dark metal lamp post'],
      subject_scale: 'medium-20-40',
    },
    [{ name: 'Lin', aliases: ['the guide'], lock: 'black hair, red coat, adult woman' }]
  );
  assert.match(visual_prompt, /black hair/i);
  assert.match(visual_prompt, /red coat/i);
  // Must keep the appearance lock — not replace it with the bare name alone.
  assert.doesNotMatch(visual_prompt, /, Lin(?:,|$)/);
});

test('visible_subjects injects every matched lock and never dumps unmatched casts', () => {
  const locks = [
    { name: 'Lin', lock: 'black hair, red coat' },
    { name: 'Ash', lock: 'silver bob, blue scarf' },
    { name: 'Extra', lock: 'should not appear' },
  ];
  const { visual_prompt } = compilePonyPrompt(
    {
      shot_intent: 'medium-action',
      location: 'plaza',
      primary_action: 'Lin talks with Ash',
      primary_subject: 'Lin',
      visible_subjects: ['Lin', 'Ash'],
      key_props: [],
      subject_scale: 'medium-20-40',
    },
    locks
  );
  assert.match(visual_prompt, /black hair/i);
  assert.match(visual_prompt, /blue scarf/i);
  assert.doesNotMatch(visual_prompt, /should not appear/i);
});

test('quality score tokens are not compiled into stored visual_prompt', () => {
  const { visual_prompt } = compilePonyPrompt(
    {
      shot_intent: 'wide-action',
      location: 'arcade',
      primary_action: 'walks',
      key_props: [],
      subject_scale: 'small-15-20',
    },
    FURRY_LOCK,
    'dreamcore'
  );
  assert.doesNotMatch(visual_prompt, /score_9|score_8_up|source_anime/i);
});
