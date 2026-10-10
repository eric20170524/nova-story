import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeVisualPrompt } from './visual_prompt_sanitizer';

test('keeps sound, smell, and simile wording', () => {
  const { visual_prompt, negative_extras } = sanitizeVisualPrompt(
    [
      'rigid glass-like ice pool',
      'metallic ring echo',
      'claw tip touching surface',
      'sweet scent',
      'scraping sound',
    ].join(', ')
  );

  assert.match(visual_prompt, /metallic ring echo/i);
  assert.match(visual_prompt, /sweet scent/i);
  assert.match(visual_prompt, /scraping sound/i);
  assert.match(visual_prompt, /claw tip touching surface/i);
  assert.match(visual_prompt, /glass-like ice pool/i);
  assert.deepEqual(negative_extras, []);
  const simile = sanitizeVisualPrompt('Clouds outside the window churn like boiling water.');
  assert.match(simile.visual_prompt, /churn like boiling water/i);
  const prose = sanitizeVisualPrompt('Pei Yuhan steadied her waist, while the other hand gently stroked the back of Nangong Xue\'s sweat-dampened neck. Nangong Xue trembled all over at the sound, strands of hair stuck to her cheek');
  assert.match(prose.visual_prompt, /sweat-dampened neck/i);
  assert.match(prose.visual_prompt, /trembled all over at the sound/i);
  assert.match(prose.visual_prompt, /strands of hair/i);
});

test('keeps cloud-like and does not invent nature negatives', () => {
  const { visual_prompt, negative_extras } = sanitizeVisualPrompt(
    'establishing shot, cloud-like platforms, carved carousel horses, pastel park'
  );

  assert.match(visual_prompt, /cloud-like platforms/i);
  assert.match(visual_prompt, /carousel horses/i);
  assert.deepEqual(negative_extras, []);
});

test('strips environmental storytelling and keeps visible music-note props', () => {
  const { visual_prompt } = sanitizeVisualPrompt(
    [
      'environmental storytelling',
      'narrative comic panel',
      'silent atmosphere',
      'european arcade',
      'paw pressing music-note button on miniature park map',
    ].join(', ')
  );

  assert.doesNotMatch(visual_prompt, /environmental storytelling/i);
  assert.doesNotMatch(visual_prompt, /narrative comic panel/i);
  assert.doesNotMatch(visual_prompt, /silent atmosphere/i);
  assert.match(visual_prompt, /music-note button/i);
  assert.match(visual_prompt, /european arcade/i);
});

test('keeps the visible clause after a simile colon', () => {
  const { visual_prompt } = sanitizeVisualPrompt('As if holding some ceremony: the moon-white undergarment half-open, claw tip touching surface');
  assert.match(visual_prompt, /moon-white undergarment half-open/i);
  assert.match(visual_prompt, /claw tip touching surface/i);
  const kept = sanitizeVisualPrompt('as if the room were only a mood, claw tip touching surface');
  assert.match(kept.visual_prompt, /\bas if the room were only a mood/i);
  assert.match(kept.visual_prompt, /claw tip touching surface/i);
});

test('does not leave score_9 or dreamcore project prefixes', () => {
  const { visual_prompt } = sanitizeVisualPrompt(
    'score_9, source_anime, dreamcore, detailed dreamcore amusement park environment, mosaic floor'
  );
  assert.doesNotMatch(visual_prompt, /score_9/i);
  assert.doesNotMatch(visual_prompt, /source_anime/i);
  assert.doesNotMatch(visual_prompt, /\bdreamcore\b/i);
  assert.match(visual_prompt, /mosaic floor/i);
});
