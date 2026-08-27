import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineShotSchema } from './llm';
import { packShotSpec } from './shot_contract';
import { compilePonyPrompt } from '../services/pony_prompt_compiler';

test('TimelineShotSchema rejects shots without location + primary_action', () => {
  const missingBoth = TimelineShotSchema.safeParse({
    shot_type: 'Wide Shot',
    visual_prompt: 'a long English prose description of the corridor',
  });
  assert.equal(missingBoth.success, false);

  const missingAction = TimelineShotSchema.safeParse({
    location: 'arcade corridor',
    visual_prompt: '',
  });
  assert.equal(missingAction.success, false);

  const missingLocation = TimelineShotSchema.safeParse({
    primary_action: 'presses music-note button',
    visual_prompt: '',
  });
  assert.equal(missingLocation.success, false);
});

test('TimelineShotSchema accepts empty visual_prompt when contract is present', () => {
  const parsed = TimelineShotSchema.parse({
    shot_type: 'Insert Shot',
    shot_intent: 'insert',
    location: 'european arcade',
    primary_action: 'paw presses music-note button',
    key_props: ['miniature park map', 'music-note button'],
    subject_scale: 'absent',
    visual_prompt: '',
  });
  assert.equal(parsed.visual_prompt, '');
  assert.equal(parsed.location, 'european arcade');
  assert.equal(parsed.primary_action, 'paw presses music-note button');
  assert.match(parsed.uniqueness_key || '', /arcade/i);
  assert.match(parsed.uniqueness_key || '', /music-note|map/i);
});

test('compilePonyPrompt fills tokens from contract', () => {
  const { visual_prompt } = compilePonyPrompt({
    shot_intent: 'insert',
    location: 'european arcade',
    primary_action: 'paw presses music-note button',
    key_props: ['miniature park map'],
    subject_scale: 'absent',
  });
  assert.match(visual_prompt, /insert shot/i);
  assert.match(visual_prompt, /music-note button/i);
  assert.match(visual_prompt, /european arcade/i);
  assert.match(visual_prompt, /miniature park map/i);
});

test('packShotSpec writes JSON for scene.shot_spec', () => {
  const raw = packShotSpec({
    shot_intent: 'insert',
    location: 'european arcade',
    primary_action: 'paw presses button',
    key_props: ['map'],
    shot_type: 'Insert Shot',
  });
  const parsed = JSON.parse(raw);
  assert.equal(parsed.shot_intent, 'insert');
  assert.equal(parsed.location, 'european arcade');
  assert.equal(parsed.primary_action, 'paw presses button');
  assert.deepEqual(parsed.key_props, ['map']);
  assert.match(String(parsed.uniqueness_key), /arcade/i);
});
