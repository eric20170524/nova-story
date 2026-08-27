import assert from 'node:assert/strict';
import test from 'node:test';
import { Prompts } from './prompts';
import {
  buildCharacterVisualLockBible,
  buildSceneVisualPromptRewritePrompt,
  normalizeVisualPrompt,
} from './scene_visual_prompt_service';
import { formatVisualLockTokens } from './reference_generation_policy';

test('normalizeVisualPrompt does not prepend score_9 or project abstract prefixes', () => {
  const raw =
    'silent amusement park corridor, tiled hallway, dark metal lamp post, small beige creature walking';
  const out = normalizeVisualPrompt(raw, 'Wide Environmental Action Shot');

  assert.equal(out, raw);
  assert.doesNotMatch(out, /^score_9\b/i);
  assert.doesNotMatch(out, /narrative comic panel/i);
  assert.doesNotMatch(out, /environmental storytelling/i);
  assert.doesNotMatch(out, /detailed dreamcore amusement park environment/i);
  assert.doesNotMatch(out, /deep perspective/i);
  assert.doesNotMatch(out, /source_anime/i);
  assert.doesNotMatch(out, /score_8_up/i);
});

test('normalizeVisualPrompt strips banned quality and abstract tokens from LLM output', () => {
  const raw = [
    'score_9',
    'score_8_up',
    'source_anime',
    'narrative comic panel',
    'detailed dreamcore amusement park environment',
    'deep perspective',
    'environmental storytelling',
    'miniature park map',
    'paw pressing music-note button',
  ].join(', ');

  const out = normalizeVisualPrompt(raw, 'Insert Shot');

  assert.equal(out, 'miniature park map, paw pressing music-note button');
  assert.ok(!out.toLowerCase().startsWith('score_9'));
  assert.doesNotMatch(out, /narrative comic panel/i);
  assert.doesNotMatch(out, /environmental storytelling/i);
  assert.doesNotMatch(out, /detailed dreamcore amusement park environment/i);
});

test('normalizeVisualPrompt preserves concrete location-first story tokens', () => {
  const raw =
    'insert shot, (paw pressing a music-note button on a miniature park map:1.4), european arcade, mosaic floor';
  const out = normalizeVisualPrompt(raw);

  assert.match(out, /music-note button/i);
  assert.match(out, /miniature park map/i);
  assert.match(out, /european arcade/i);
  assert.doesNotMatch(out, /^score_/i);
});

const dreamcoreProtagonistTags = {
  base_model: {
    tags: [
      'small beige-and-white furry creature',
      'quadruped',
      'pointed ears',
      'amber eyes',
    ],
  },
};

test('formatVisualLockTokens keeps dreamcore bible lock without inventing kitten', () => {
  const lock = formatVisualLockTokens(dreamcoreProtagonistTags);
  assert.match(lock, /small beige-and-white furry creature/i);
  assert.match(lock, /quadruped/i);
  assert.doesNotMatch(lock, /\bkitten\b/i);
  assert.doesNotMatch(lock, /\b1girl\b/i);
});

test('rewrite prompt uses visual_tags lock and does not hardcode kitten', () => {
  const prompt = buildSceneVisualPromptRewritePrompt(
    { id: 2, title: '无声长廊', content: '小兽按压导览图上的音符按钮' },
    [{ id: 108, index: 0, narration: '按按钮', dialogue: '', visual_prompt: '', shot_type: '' }],
    [{ name: '小兽', role: 'main', visual_tags: dreamcoreProtagonistTags }]
  );

  assert.doesNotMatch(prompt, /cream and white fluffy kitten/i);
  assert.doesNotMatch(prompt, /kitten-like/i);
  assert.match(prompt, /small beige-and-white furry creature/i);
  assert.match(prompt, /Visual Lock/i);
  assert.match(prompt, /never invent kitten/i);
  assert.doesNotMatch(prompt, /current_visual_prompt/i);
  assert.match(prompt, /compilePonyPrompt/i);

  const bible = buildCharacterVisualLockBible([
    { name: '小兽', role: 'main', visual_tags: dreamcoreProtagonistTags },
  ]);
  assert.equal(bible.length, 1);
  const lockLine = bible[0]!;
  assert.match(lockLine.visual_lock, /beige-and-white furry creature/i);
  assert.doesNotMatch(lockLine.visual_lock, /\bkitten\b/i);
});

test('timeline prompt injects visual lock and forbids invented species', () => {
  const profiles = `- Name: 小兽\n  Visual Lock: small beige-and-white furry creature, quadruped, pointed ears, amber eyes`;
  const prompt = Prompts.generateTimeline('小兽走进长廊', profiles, false);

  assert.match(prompt, /small beige-and-white furry creature/i);
  assert.match(prompt, /Do NOT invent species/i);
  assert.doesNotMatch(prompt, /cream and white fluffy kitten/i);
  assert.doesNotMatch(prompt, /hair, clothing, build/i);
  assert.match(prompt, /Never write a Detailed English scene description/i);
  assert.match(prompt, /compilePonyPrompt|Shot Contract/i);
  assert.doesNotMatch(prompt, /visual_prompt MUST be detailed English/i);

  const emptyProfiles = Prompts.generateTimeline('empty bible chapter', '', false);
  assert.doesNotMatch(emptyProfiles, /cream and white fluffy kitten/i);
  assert.match(emptyProfiles, /Never invent species tags/i);
  assert.doesNotMatch(emptyProfiles, /subject count \(1girl/i);
});
