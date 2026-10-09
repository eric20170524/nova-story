import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeVisualPrompt } from './visual_prompt_sanitizer';

test('deletes metallic ring echo and other sound / smell tokens', () => {
  const { visual_prompt, negative_extras } = sanitizeVisualPrompt(
    [
      'rigid glass-like ice pool',
      'metallic ring echo',
      'claw tip touching surface',
      'sweet scent',
      'scraping sound',
    ].join(', ')
  );

  assert.doesNotMatch(visual_prompt, /metallic ring echo/i);
  assert.doesNotMatch(visual_prompt, /\becho\b/i);
  assert.doesNotMatch(visual_prompt, /\bscent\b/i);
  assert.doesNotMatch(visual_prompt, /scraping sound/i);
  assert.match(visual_prompt, /claw tip touching surface/i);
  assert.match(visual_prompt, /ice pool|glass/i);
  assert.doesNotMatch(visual_prompt, /glass-like/i);
  const simile = sanitizeVisualPrompt('Clouds outside the window churn like boiling water.');
  assert.match(simile.visual_prompt, /churn like boiling water/i);
  const prose = sanitizeVisualPrompt('Pei Yuhan steadied her waist, while the other hand gently stroked the back of Nangong Xue\'s sweat-dampened neck. Nangong Xue trembled all over at the sound, strands of hair stuck to her cheek');
  assert.match(prose.visual_prompt, /sweat-dampened neck/i);
  assert.match(prose.visual_prompt, /trembled all over at the sound/i);
  assert.match(prose.visual_prompt, /strands of hair/i);
  // sound phrase removed; optional scale negatives may be attached when phrase was seen
  void negative_extras;
});

test('grounds cloud-like platform and adds nature negatives', () => {
  const { visual_prompt, negative_extras } = sanitizeVisualPrompt(
    'establishing shot, cloud-like platforms, carved carousel horses, pastel park'
  );

  assert.doesNotMatch(visual_prompt, /cloud-like/i);
  assert.match(visual_prompt, /platform/i);
  assert.match(visual_prompt, /walkable|flat/i);
  assert.match(visual_prompt, /carousel horses/i);
  assert.ok(negative_extras.some((t) => /real clouds/i.test(t)));
  assert.ok(negative_extras.some((t) => /mountains/i.test(t)));
  assert.ok(negative_extras.some((t) => /outdoor nature/i.test(t)));
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
  const stripped = sanitizeVisualPrompt('as if the room were only a mood, claw tip touching surface');
  assert.doesNotMatch(stripped.visual_prompt, /\bas if\b/i);
  assert.match(stripped.visual_prompt, /claw tip touching surface/i);
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
