import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileNegativePrompt,
  inferIdentityMode,
} from './negative_prompt_compiler';

test('insert negatives include landscape / aerial / plain background', () => {
  const neg = compileNegativePrompt({
    shot_type: 'Insert Shot',
    visual_prompt: 'paw pressing music-note button on miniature park map',
    key_props: ['miniature park map', 'music-note button'],
    identity_mode: 'nonhuman',
  });
  assert.match(neg, /landscape/i);
  assert.match(neg, /aerial/i);
  assert.match(neg, /plain background/i);
  assert.match(neg, /full park aerial|text captions/i);
});

test('wide negatives must not include simple background', () => {
  const neg = compileNegativePrompt({
    shot_type: 'Wide Environmental Action Shot',
    visual_prompt: 'european arcade corridor, lamp post, small beige creature walking',
    location: 'arcade corridor',
    identity_mode: 'nonhuman',
  });
  assert.doesNotMatch(neg, /\bsimple background\b/i);
  assert.match(neg, /close-up face|studio portrait/i);
  assert.match(neg, /mountains|outdoor nature/i);
});

test('music box / mechanism props exclude mecha helmet spaceship', () => {
  const neg = compileNegativePrompt({
    shot_type: 'Insert Shot',
    visual_prompt: 'ornate music box with brass gears on red velvet',
    key_props: ['music box', 'gears'],
    identity_mode: 'nonhuman',
  });
  assert.match(neg, /\bmecha\b/i);
  assert.match(neg, /\bhelmet\b/i);
  assert.match(neg, /\bspaceship\b/i);
});

test('different intents compile different negative strings', () => {
  const insert = compileNegativePrompt({
    shot_type: 'Insert Shot',
    visual_prompt: 'music box insert',
  });
  const wide = compileNegativePrompt({
    shot_type: 'Wide Shot',
    visual_prompt: 'park plaza establishing',
  });
  assert.notEqual(insert, wide);
  assert.match(insert, /aerial|landscape/i);
  assert.doesNotMatch(wide, /\bsimple background\b/i);
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

test('mixed human+animal does not apply identity lock', () => {
  const input = {
    shot_type: 'Medium Shot',
    visual_prompt: '1girl stands beside a furry creature',
    identity_mode: 'auto' as const,
  };
  assert.equal(inferIdentityMode(input), 'mixed');
  const neg = compileNegativePrompt(input);
  assert.doesNotMatch(neg, /\bhuman\b|\bperson\b|\bfox\b/i);
});

test('auto with only creature cues resolves nonhuman', () => {
  assert.equal(
    inferIdentityMode({
      visual_prompt: 'small beige furry creature, paw on map',
      identity_mode: 'auto',
    }),
    'nonhuman'
  );
});
