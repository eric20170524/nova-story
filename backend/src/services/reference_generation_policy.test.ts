import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCharacterAppearanceSnippet,
  mergeAppearanceIntoPrompt,
  planReferenceGeneration,
  resolveReferenceImg2ImgPolicy,
  resolveReferenceUrls
} from './reference_generation_policy';

test('resolveReferenceUrls maps legacy ref to character and keeps composition separate', () => {
  const refs = resolveReferenceUrls({
    ref_image_url: '/static/generated/face.png',
    composition_ref_url: '/static/generated/pose.png'
  });
  assert.equal(refs.characterRefUrl, '/static/generated/face.png');
  assert.equal(refs.compositionRefUrl, '/static/generated/pose.png');
  assert.equal(refs.legacyRefUrl, '/static/generated/face.png');
  assert.equal(refs.urlsToCopy.length, 2);
});

test('character_ref_url wins over legacy ref_image_url', () => {
  const refs = resolveReferenceUrls({
    ref_image_url: '/static/generated/old.png',
    character_ref_url: '/static/generated/new.png'
  });
  assert.equal(refs.characterRefUrl, '/static/generated/new.png');
  assert.equal(refs.legacyRefUrl, '/static/generated/old.png');
});

test('img2img policy: turnaround_panel is pure txt2img', () => {
  const panel = resolveReferenceImg2ImgPolicy({ gen_type: 'turnaround_panel' }, '');
  assert.equal(panel.useImg2Img, false);
  assert.equal(panel.denoise, 1);
});

test('img2img policy allows turnaround and skips multi-person story', () => {
  const turn = resolveReferenceImg2ImgPolicy({ gen_type: 'turnaround' }, '');
  assert.equal(turn.useImg2Img, true);
  assert.equal(turn.denoise, 0.55);

  const story = resolveReferenceImg2ImgPolicy(
    { gen_type: 'scene', denoise: 0.65 },
    '2girls, yuri, embracing on silk couch'
  );
  assert.equal(story.useImg2Img, false);
  assert.equal(story.reason, 'multi_person_story');
});

test('planReferenceGeneration stays Tier A when adapters unavailable', () => {
  const plan = planReferenceGeneration(
    {
      gen_type: 'turnaround',
      character_ref_url: '/static/generated/a.png',
      composition_ref_url: '/static/generated/b.png'
    },
    '1girl, turnaround'
  );
  assert.equal(plan.tier, 'A+character_img2img');
  assert.equal(plan.useCharacterAdapter, false);
  assert.equal(plan.useCompositionControl, false);
  assert.equal(plan.img2img.useImg2Img, true);
  assert.ok(plan.notes.some((n) => /composition_ref present/i.test(n)));
});

test('IP-Adapter blocked on multi-person / wide / action even when adapter installed', () => {
  const adapters = { characterAdapter: true, compositionControl: false };

  const multi = planReferenceGeneration(
    {
      gen_type: 'scene',
      character_ref_url: '/static/generated/face.png',
      denoise: 1.0
    },
    '2girls, martial arts clash, white and red combat women',
    adapters
  );
  assert.equal(multi.useCharacterAdapter, false);
  assert.equal(multi.tier, 'A');
  assert.ok(multi.notes.some((n) => /adapter skipped/i.test(n)));

  const wide = planReferenceGeneration(
    {
      gen_type: 'scene',
      shot_type: 'Extreme Long Shot',
      character_ref_url: '/static/generated/face.png'
    },
    'establishing shot, cloud sea cliff arena',
    adapters
  );
  assert.equal(wide.useCharacterAdapter, false);

  const action = planReferenceGeneration(
    {
      gen_type: 'scene',
      character_ref_url: '/static/generated/face.png'
    },
    '1girl, whip kick battle damage, ripped fabric',
    adapters
  );
  assert.equal(action.useCharacterAdapter, false);

  const portrait = planReferenceGeneration(
    {
      gen_type: 'portrait',
      character_ref_url: '/static/generated/face.png'
    },
    '1girl, portrait, close-up face',
    adapters
  );
  assert.equal(portrait.useCharacterAdapter, true);
  assert.equal(portrait.tier, 'A+character_adapter');
});

test('reference_tier A forces no character adapter', () => {
  const plan = planReferenceGeneration(
    {
      gen_type: 'portrait',
      reference_tier: 'A',
      character_ref_url: '/static/generated/face.png'
    },
    '1girl portrait',
    { characterAdapter: true, compositionControl: false }
  );
  assert.equal(plan.useCharacterAdapter, false);
});

test('buildCharacterAppearanceSnippet prefers tags then description', () => {
  const withTags = buildCharacterAppearanceSnippet({
    name: '陆嘉静',
    description: 'ignored when tags exist',
    visual_tags: { hair: 'long silver hair', eyes: 'violet eyes' }
  });
  assert.match(withTags, /陆嘉静 appearance/);
  assert.match(withTags, /silver hair/);

  const wide = buildCharacterAppearanceSnippet(
    {
      name: '陆嘉静',
      visual_tags: { hair: 'long silver hair', eyes: 'violet eyes', outfit: 'white robe' }
    },
    { wideShot: true }
  );
  assert.match(wide, /outfit & build/);
  assert.doesNotMatch(wide, /violet eyes/);

  const descOnly = buildCharacterAppearanceSnippet({
    name: '裴雨涵',
    description: 'tall cultivator in dark green cloak'
  });
  assert.match(descOnly, /dark green cloak/);
});

test('mergeAppearanceIntoPrompt skips duplicates', () => {
  const base = 'close-up, 1girl, 陆嘉静 appearance: silver hair';
  const merged = mergeAppearanceIntoPrompt(base, ['陆嘉静 appearance: silver hair', '裴雨涵 appearance: black hair']);
  assert.equal((merged.match(/陆嘉静 appearance/g) || []).length, 1);
  assert.match(merged, /裴雨涵 appearance: black hair/);
});
