import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCharacterAppearanceSnippet,
  formatVisualLockTokens,
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

test('img2img policy allows turnaround and reads people from the contract', () => {
  const turn = resolveReferenceImg2ImgPolicy({ gen_type: 'turnaround' }, '');
  assert.equal(turn.useImg2Img, true);
  assert.equal(turn.denoise, 0.55);

  const wordsOnly = resolveReferenceImg2ImgPolicy(
    { gen_type: 'scene', denoise: 0.65 },
    '2girls, yuri, embracing on silk couch, Qingmu Palace'
  );
  assert.equal(wordsOnly.reason, 'generic_scene_clamped');
  assert.notEqual(wordsOnly.reason, 'multi_person_story');
  assert.notEqual(wordsOnly.reason, 'wide_story');
  assert.notEqual(wordsOnly.reason, 'action_story');

  const twoPeople = resolveReferenceImg2ImgPolicy(
    {
      gen_type: 'scene',
      shot_spec: { visible_subjects: ['裴雨涵', '陆嘉静'], shot_type: 'Wide Shot' },
    },
    'a quiet portrait in Qingmu Palace'
  );
  assert.equal(twoPeople.useImg2Img, false);
  assert.equal(twoPeople.reason, 'multi_person_story');

  const bound = resolveReferenceImg2ImgPolicy({
    shot_spec: {
      visible_subjects: ['南宫雪'],
      visual_facts: [{
        binding: {
          mentions: [
            { text: '她', confirmed: true, visibility: 'visible', entity: { name: '裴雨涵' } },
            { text: '她', confirmed: false, visibility: 'visible', entity: { name: '陆嘉静' } },
          ],
        },
      }],
    },
  }, 'embrace, kiss');
  assert.equal(bound.reason, 'multi_person_story');

  const widePerson = resolveReferenceImg2ImgPolicy({
    gen_type: 'scene',
    shot_type: 'Wide Shot',
    shot_spec: {
      visible_subjects: ['裴雨涵'],
      shot_intent: 'wide-action',
      subject_scale: 'dominant',
    },
  }, 'Qingmu Palace, embracing, kiss, wide shot');
  assert.equal(widePerson.reason, 'scene_txt2img_default');

  const empty = resolveReferenceImg2ImgPolicy({
    gen_type: 'scene',
    subject_scale: 'absent',
    shot_spec: { visible_subjects: ['裴雨涵'], shot_intent: 'establish' },
  }, '1girl, palace');
  assert.equal(empty.useImg2Img, false);
  assert.equal(empty.reason, 'empty_plate');

  const establishEmpty = resolveReferenceImg2ImgPolicy({
    gen_type: 'scene',
    shot_intent: 'overhead-map',
    visible_subjects: [],
  }, 'palace interior');
  assert.equal(establishEmpty.reason, 'empty_plate');

  const close = resolveReferenceImg2ImgPolicy({
    gen_type: 'scene',
    shot_type: 'Close-Up',
    visible_subjects: ['裴雨涵'],
  }, 'palace');
  assert.equal(close.useImg2Img, true);
  assert.equal(close.reason, 'single_closeup');
  assert.equal(close.denoise, 0.62);
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

test('IP-Adapter follows the contract and ignores paragraph words', () => {
  const adapters = { characterAdapter: true, compositionControl: false };

  const wordsOnly = planReferenceGeneration(
    {
      gen_type: 'scene',
      character_ref_url: '/static/generated/face.png',
    },
    '2girls, martial arts clash, establishing shot, Qingmu Palace, kiss',
    adapters
  );
  assert.equal(wordsOnly.useCharacterAdapter, false);
  assert.equal(wordsOnly.img2img.reason, 'scene_txt2img_default');
  assert.equal(wordsOnly.tier, 'A');

  const multi = planReferenceGeneration(
    {
      gen_type: 'scene',
      character_ref_url: '/static/generated/face.png',
      shot_spec: { visible_subjects: ['裴雨涵', '陆嘉静'] },
    },
    'a quiet room',
    adapters
  );
  assert.equal(multi.useCharacterAdapter, false);
  assert.equal(multi.img2img.reason, 'multi_person_story');
  assert.ok(multi.notes.some((n) => /multi_person_story/i.test(n)));

  const widePerson = planReferenceGeneration(
    {
      gen_type: 'scene',
      shot_type: 'Wide Shot',
      character_ref_url: '/static/generated/face.png',
      shot_spec: { visible_subjects: ['裴雨涵'], shot_intent: 'wide-action' },
    },
    'establishing shot, cloud sea cliff arena, embrace',
    adapters
  );
  assert.equal(widePerson.useCharacterAdapter, false);
  assert.notEqual(widePerson.img2img.reason, 'wide_story');
  assert.notEqual(widePerson.img2img.reason, 'empty_plate');

  const empty = planReferenceGeneration(
    {
      gen_type: 'scene',
      character_ref_url: '/static/generated/face.png',
      shot_spec: { subject_scale: 'absent', shot_intent: 'establish' },
    },
    '1girl, palace',
    adapters
  );
  assert.equal(empty.useCharacterAdapter, false);
  assert.equal(empty.img2img.reason, 'empty_plate');

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

test('formatVisualLockTokens accepts array base_model.tags', () => {
  const lock = formatVisualLockTokens({
    base_model: {
      tags: ['small beige-and-white furry creature', 'quadruped', 'amber eyes'],
    },
  });
  assert.match(lock, /beige-and-white furry creature/);
  assert.match(lock, /quadruped/);
  assert.doesNotMatch(lock, /\bkitten\b/);
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

test('mergeAppearanceIntoPrompt skips paraphrased identity anchors but keeps generic prompts', () => {
  const snippet =
    '主角小兽 outfit & build: short fluffy light beige and white fur, pointed animal ears, cute paws';
  const detailed = mergeAppearanceIntoPrompt(
    'A small beige-and-white furry creature waits at the corridor threshold.',
    [snippet]
  );
  assert.doesNotMatch(detailed, /outfit & build/i);

  const generic = mergeAppearanceIntoPrompt(
    'A small furry creature waits at the corridor threshold.',
    [snippet]
  );
  assert.match(generic, /outfit & build/i);
});
