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

test('does not leave score_9 or dreamcore project prefixes', () => {
  const { visual_prompt } = sanitizeVisualPrompt(
    'score_9, source_anime, dreamcore, detailed dreamcore amusement park environment, mosaic floor'
  );
  assert.doesNotMatch(visual_prompt, /score_9/i);
  assert.doesNotMatch(visual_prompt, /source_anime/i);
  assert.doesNotMatch(visual_prompt, /\bdreamcore\b/i);
  assert.match(visual_prompt, /mosaic floor/i);
});
