import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileNegativePrompt,
  inferIdentityMode,
} from './negative_prompt_compiler';

test('shot type and prop words do not add landscape or mecha negatives', () => {
  const neg = compileNegativePrompt({
    shot_type: 'Insert Shot',
    visual_prompt: 'paw pressing music-note button on miniature park map, ornate music box with brass gears',
    key_props: ['miniature park map', 'music box', 'gears'],
    location: 'arcade corridor',
    identity_mode: 'nonhuman',
  });
  assert.doesNotMatch(neg, /landscape|aerial|full park aerial|text captions|mountains|outdoor nature/i);
  assert.doesNotMatch(neg, /\bmecha\b|\bhelmet\b|\bspaceship\b/i);
  assert.match(neg, /\bhuman\b/i);
  assert.match(neg, /child, loli, shota/);
});

test('an explicit intent still adds its own inverse, without location words', () => {
  const wide = compileNegativePrompt({
    shot_intent: 'wide-action',
    shot_type: 'Wide Environmental Action Shot',
    visual_prompt: 'european arcade corridor, lamp post, small beige creature walking',
    location: 'arcade corridor',
    identity_mode: 'nonhuman',
  });
  assert.doesNotMatch(wide, /\bsimple background\b/i);
  assert.match(wide, /close-up face|studio portrait/i);
  assert.doesNotMatch(wide, /mountains|outdoor nature/i);

  const payoff = compileNegativePrompt({
    shot_intent: 'payoff',
    visual_prompt: 'ornate music box with brass gears on red velvet',
    key_props: ['music box', 'gears'],
  });
  assert.match(payoff, /\bmecha\b/i);
  assert.match(payoff, /\bhelmet\b/i);
  assert.match(payoff, /\bspaceship\b/i);
});

test('different explicit intents compile different negative strings', () => {
  const guessedInsert = compileNegativePrompt({
    shot_type: 'Insert Shot',
    visual_prompt: 'music box insert',
  });
  const guessedWide = compileNegativePrompt({
    shot_type: 'Wide Shot',
    visual_prompt: 'park plaza establishing',
  });
  assert.equal(guessedInsert, guessedWide);

  const insert = compileNegativePrompt({
    shot_intent: 'insert',
    visual_prompt: 'music box insert',
  });
  const wide = compileNegativePrompt({
    shot_intent: 'wide-action',
    visual_prompt: 'park plaza establishing',
  });
  assert.notEqual(insert, wide);
  assert.match(insert, /aerial|landscape/i);
  assert.doesNotMatch(wide, /\bsimple background\b/i);
  assert.doesNotMatch(insert, /\bmecha\b/i);
});

test('auto with human coat/hair lock stays unknown and does not ban human', () => {
  const input = {
    shot_type: 'Medium Shot',
    visual_prompt: 'Lin stands by the lamp post',
    character_lock: 'Lin, black hair, red coat',
    identity_mode: 'auto' as const,
  };
  assert.equal(inferIdentityMode(input), 'unknown');
  const neg = compileNegativePrompt(input);
  assert.doesNotMatch(neg, /\bhuman\b|\bperson\b|\bwoman\b|\bgirl\b/i);
});

test('fox protagonist nonhuman excludes humans but not fox', () => {
  const neg = compileNegativePrompt({
    shot_type: 'Wide Shot',
    visual_prompt: 'orange fox walks the plaza',
    character_lock: 'orange fox, bushy tail',
    identity_mode: 'nonhuman',
  });
  assert.match(neg, /\bhuman\b/i);
  assert.match(neg, /\bperson\b/i);
  assert.doesNotMatch(neg, /\bfox\b|\bwolf\b|\bdog\b/i);
});

test('auto does not infer identity from girl or paw words', () => {
  const mixedWords = {
    shot_type: 'Medium Shot',
    visual_prompt: '1girl stands beside a furry creature',
    identity_mode: 'auto' as const,
  };
  assert.equal(inferIdentityMode(mixedWords), 'unknown');
  const neg = compileNegativePrompt(mixedWords);
  assert.doesNotMatch(neg, /\bhuman\b|\bperson\b|\bwoman\b|\bgirl\b|\bfox\b/i);

  const explicitMixed = compileNegativePrompt({
    ...mixedWords,
    identity_mode: 'mixed',
  });
  assert.doesNotMatch(explicitMixed, /\bhuman\b|\bperson\b|\bfox\b/i);

  assert.equal(
    inferIdentityMode({
      visual_prompt: 'small beige furry creature, paw on map, girl nearby',
      identity_mode: 'auto',
    }),
    'unknown'
  );
});
