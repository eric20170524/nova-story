import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCoverageCandidate } from './coverage';
import { LLMService } from '../services/llm';

test('compileCoverageCandidate fills empty visual_prompt from contract', () => {
  const compiled = compileCoverageCandidate(
    {
      slot: 7,
      shot_type: 'Extreme Close-Up',
      shot_intent: 'insert',
      location: 'arcade corridor',
      primary_action: 'paw presses music-note button',
      key_props: ['music-note button'],
      primary_subject: 'paw-only',
      subject_scale: 'absent',
      visual_prompt: '',
    },
    [{ name: '小兽', lock: 'small beige-and-white furry creature' }],
    6
  );
  assert.equal(compiled.visual_prompt, '');
  assert.match(compiled.negative_prompt, /aerial|landscape/i);
  assert.match(compiled.negative_prompt, /child, loli, shota/);
  assert.doesNotMatch(compiled.negative_prompt, /\bwoman\b|\bgirl\b/i);
  assert.match(String(compiled.shot_spec), /insert/);
  assert.match(String(compiled.shot_spec), /paw presses music-note button/);
});

test('coverage fallback inherits source contract and fails closed without it', () => {
  const ok = LLMService.buildCoverageFallbackFromSource({
    shot_spec: JSON.stringify({
      location: 'arcade corridor',
      primary_action: 'creature walks past lamp',
      key_props: ['dark metal lamp post'],
      primary_subject: '小兽',
    }),
    audio_prompt: 'ambience',
  });
  assert.equal(ok.length, 9);
  assert.equal(ok[0].location, 'arcade corridor');
  assert.equal(ok[0].primary_action, 'creature walks past lamp');
  assert.equal(ok[0].visual_prompt, '');
  assert.equal(ok[6].shot_intent, 'insert');

  assert.throws(
    () => LLMService.buildCoverageFallbackFromSource({ visual_prompt: 'prose only' }),
    /location \+ primary_action/
  );
});
