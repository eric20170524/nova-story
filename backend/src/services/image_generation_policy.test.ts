import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyPromptEnhancement,
  buildCharacterPromptHeader,
  buildPromptEnhancement,
  inferPromptSubjectType,
  inferStyleShotMode,
  mergeClipPositivePrompt,
  normalizeImageModelFamily,
  resolveGenerationPlan,
  resolveLoraStack,
  resolveNsfwLora,
  resolveStyleLora,
  sanitizeNegativePromptForSubject,
  sanitizePromptForSubject,
  stripStyleNarrativeTokens
} from './image_generation_policy';

test('mergeClipPositivePrompt puts scene before framing and quality; dedupes score/source', () => {
  const REAL_TEMPLATE =
    'score_9, score_8_up, score_7_up, source_anime, cinematic shot';
  const merged = mergeClipPositivePrompt({
    scene: 'paw presses music-note button on miniature park map',
    framing:
      '(narrative insert shot:1.35), source_anime, subject visibly interacting with the specified prop',
    templateText: REAL_TEMPLATE,
  });
  const actionIdx = merged.indexOf('paw presses music-note button');
  const cinematicIdx = merged.indexOf('cinematic shot');
  const scoreIdx = merged.indexOf('score_9');
  const sourceIdx = merged.indexOf('source_anime');
  assert.ok(actionIdx >= 0 && actionIdx < cinematicIdx);
  assert.ok(cinematicIdx >= 0 && cinematicIdx < scoreIdx);
  assert.equal((merged.match(/\bscore_9\b/g) || []).length, 1);
  assert.equal((merged.match(/\bsource_anime\b/g) || []).length, 1);
  assert.ok(sourceIdx > actionIdx);
  assert.match(merged, /cinematic shot/);
});

test('SFW mode never auto-picks Incase as style; NSFW picks Incase for adult slot', () => {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-lora-policy-'));
  const loraDir = path.join(installPath, 'models', 'loras');
  fs.mkdirSync(loraDir, { recursive: true });
  fs.writeFileSync(path.join(loraDir, 'Pony_DetailV2.0.safetensors'), '');
  fs.writeFileSync(path.join(loraDir, 'Incase_Style_PonyXL.safetensors'), '');

  try {
    const styleSfw = resolveStyleLora('pony', false, { installPath, styleLora: null });
    assert.equal(styleSfw, 'Pony_DetailV2.0.safetensors');

    const styleNsfw = resolveStyleLora('pony', true, { installPath, styleLora: null });
    assert.equal(styleNsfw, 'Pony_DetailV2.0.safetensors');

    const nsfw = resolveNsfwLora('pony', { installPath, nsfwLora: null });
    assert.equal(nsfw, 'Incase_Style_PonyXL.safetensors');

    const stack = resolveLoraStack({
      modelFamily: 'pony',
      nsfwEnabled: true,
      installPath,
      styleLora: 'Pony_DetailV2.0.safetensors',
      styleLoraStrength: 0.65,
      nsfwLora: 'Incase_Style_PonyXL.safetensors',
      nsfwLoraStrength: 0.55
    });
    assert.equal(stack.length, 2);
    assert.equal(stack[0]?.role, 'style');
    assert.equal(stack[1]?.role, 'nsfw');
    assert.equal(stack[1]?.strength, 0.55);
  } finally {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
});

test('dedupes when NSFW config wrongly points at the same detail file as style', () => {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-lora-dedupe-'));
  const loraDir = path.join(installPath, 'models', 'loras');
  fs.mkdirSync(loraDir, { recursive: true });
  fs.writeFileSync(path.join(loraDir, 'Pony_DetailV2.0.safetensors'), '');
  fs.writeFileSync(path.join(loraDir, 'Incase_Style_PonyXL.safetensors'), '');

  try {
    const stack = resolveLoraStack({
      modelFamily: 'pony',
      nsfwEnabled: true,
      installPath,
      styleLora: 'Pony_DetailV2.0.safetensors',
      nsfwLora: 'Pony_DetailV2.0.safetensors', // misconfigured like old system_settings
      nsfwLoraStrength: 0.8
    });
    const names = stack.map((s) => s.name);
    assert.ok(names.includes('Pony_DetailV2.0.safetensors'));
    assert.ok(names.includes('Incase_Style_PonyXL.safetensors'));
    assert.equal(names.filter((n) => n === 'Pony_DetailV2.0.safetensors').length, 1);
  } finally {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
});

test('SFW prompt enhancement blocks NSFW; NSFW unlocks without forcing nude on landscape', () => {
  const sfw = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    existingPrompt: 'jade palace above cloud sea'
  });
  assert.match(sfw.negativeExtra, /nsfw/);
  assert.match(sfw.suffix, /source_anime/);

  const nsfwLandscape = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: true,
    existingPrompt: 'jade palace above cloud sea'
  });
  assert.doesNotMatch(nsfwLandscape.negativeExtra, /explicit sexual content/);
  assert.match(nsfwLandscape.suffix, /rating_/);
  assert.doesNotMatch(nsfwLandscape.suffix, /^nude/);

  const nsfwIntimate = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: true,
    existingPrompt: '2girls yuri breast intimate on silk bed'
  });
  assert.match(nsfwIntimate.suffix, /rating_explicit/);

  const applied = applyPromptEnhancement('hero opens a door', sfw);
  assert.match(applied, /hero opens a door/i);
  assert.match(applied, /source_anime/);
});

test('style preset injects guofeng boosters for xianxia stories', () => {
  const enh = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    stylePreset: 'xianxia_immortal',
    existingPrompt: 'immortal woman on jade steps'
  });
  assert.match(enh.suffix, /xianxia|jade|ethereal/i);
});

test('animal story scenes never receive invented female-human identity tags', () => {
  const prompt =
    "The animal slowly steps forward, its paw pressing into a glowing patch on the marble floor.";
  const enh = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    stylePreset: 'xianxia_immortal',
    existingPrompt: prompt,
    genType: 'scene',
    subjectType: 'nonhuman'
  });

  assert.equal(inferPromptSubjectType(prompt), 'nonhuman');
  assert.doesNotMatch(enh.suffix, /beautiful East Asian woman|chinese beauty|\bfemale\b|\bwoman\b/i);
  assert.doesNotMatch(enh.negativeExtra, /\bmale\b|\bman\b|\bboy\b|western face/i);
  assert.match(enh.suffix, /xianxia|jade|ethereal/i);
});

test('nonhuman subject strips legacy portrait contamination from old clients', () => {
  const positive = sanitizePromptForSubject(
    'The animal crosses the plaza, beautiful East Asian woman, delicate feminine face, long flowing hair, cool jade tones',
    'nonhuman'
  );
  const negative = sanitizeNegativePromptForSubject(
    'western face, caucasian, male, man, boy, low quality, watermark',
    'nonhuman'
  );

  assert.match(positive, /animal crosses the plaza|cool jade tones/i);
  assert.doesNotMatch(positive, /woman|feminine face|flowing hair/i);
  assert.equal(negative, 'low quality, watermark');
});

test('wide welcome-plaza scene remains environment-only', () => {
  const prompt =
    'A vast, colorful welcome plaza under a golden sunset, frozen flags above smooth marble.';
  const enh = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    stylePreset: 'xianxia_immortal',
    existingPrompt: prompt,
    genType: 'scene',
    shotType: 'Wide Shot',
    subjectType: 'environment'
  });

  assert.equal(inferStyleShotMode(prompt, { shotType: 'Wide Shot' }), 'environment');
  assert.equal(
    inferStyleShotMode('A furry creature crosses the plaza.', {
      shotType: 'Wide Shot',
      subjectType: 'nonhuman'
    }),
    'environment'
  );
  assert.match(enh.suffix, /environment-dominant|expansive detailed location/i);
  assert.match(enh.negativeExtra, /close-up|face filling frame|centered character portrait/i);
  assert.doesNotMatch(enh.suffix, /beautiful East Asian woman|chinese beauty|\bfemale\b|\bwoman\b/i);
});

test('insert shotIntent never stacks environment-dominant composition', () => {
  const insertPrompt =
    'insert shot, paw pressing music-note button on miniature park map, european arcade in soft background';
  const insertEnh = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    stylePreset: 'cinematic_grid',
    existingPrompt: insertPrompt,
    genType: 'scene',
    shotType: 'Insert Shot',
    shotIntent: 'insert',
    subjectType: 'nonhuman',
  });
  assert.match(insertEnh.suffix, /narrative insert shot/i);
  assert.doesNotMatch(insertEnh.suffix, /environment-dominant cinematic composition/i);

  const wideEnh = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    existingPrompt: 'european arcade corridor, creature walks past lamp post',
    genType: 'scene',
    shotType: 'Wide Shot',
    shotIntent: 'wide-action',
    subjectType: 'nonhuman',
  });
  assert.match(wideEnh.suffix, /environment-dominant cinematic composition/i);
  assert.doesNotMatch(wideEnh.suffix, /narrative insert shot/i);
});

test('environment shots skip portrait-detail style LoRA', () => {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-environment-lora-'));
  const loraDir = path.join(installPath, 'models', 'loras');
  fs.mkdirSync(loraDir, { recursive: true });
  fs.writeFileSync(path.join(loraDir, 'Pony_DetailV2.0.safetensors'), '');

  try {
    const plan = resolveGenerationPlan({
      modelFamily: 'pony',
      nsfwEnabled: false,
      runtimeSettings: {
        comfyui: {
          install_path: installPath,
          pony_lora: 'Pony_DetailV2.0.safetensors',
          pony_lora_strength: 0.65
        }
      },
      workflowData: {
        gen_type: 'scene',
        subject_type: 'nonhuman',
        shot_type: 'Wide Shot'
      },
      basePrompt: 'A furry creature crosses a vast abandoned amusement park.'
    });
    const style = plan.loras.find((slot) => slot.role === 'style');
    assert.equal(style, undefined);
  } finally {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
});

test('narrative close-ups retain story context and reject studio portraits', () => {
  const enh = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    existingPrompt: 'A furry creature sniffs beside a blue soda machine.',
    genType: 'scene',
    shotType: 'Close-Up',
    subjectType: 'nonhuman'
  });
  assert.match(enh.suffix, /contextual narrative close-up|story location|props remain visible/i);
  assert.match(enh.negativeExtra, /front-facing studio portrait|centered ID photo|isolated character/i);
});

test('insert shots emphasize the clue and exclude a full animal portrait', () => {
  const enh = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    existingPrompt: 'One padded paw touches a frozen light patch on marble.',
    genType: 'scene',
    shotType: 'Insert Shot',
    subjectType: 'nonhuman'
  });
  assert.match(enh.suffix, /narrative insert shot|specified prop or body part only/i);
  assert.match(enh.negativeExtra, /animal portrait|full animal|no full face|face/i);
});

test('insert-shot intent takes precedence over environment words in the prompt', () => {
  const enh = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    existingPrompt: 'A paper cup and three tickets on an amusement-park ticket booth counter.',
    genType: 'scene',
    shotType: 'Insert Shot',
    subjectType: 'environment'
  });

  assert.match(enh.suffix, /narrative insert shot|extreme detail/i);
  assert.doesNotMatch(enh.suffix, /wide shot|establishing shot|environment-dominant/i);
  assert.doesNotMatch(enh.negativeExtra, /^.*close-up.*$/i);
});

test('explicit female characters still receive the intended identity enhancement', () => {
  const enh = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    existingPrompt: '1girl, adult swordswoman standing on jade steps',
    genType: 'scene'
  });
  assert.match(enh.suffix, /East Asian|chinese beauty|female/i);
  assert.match(enh.negativeExtra, /western face|male/i);
});

test('SFW never injects fully clothed artistic portrait by default', () => {
  const glam = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    stylePreset: 'sensual_gufeng',
    existingPrompt: 'elegant immortal woman standing on jade balcony'
  });
  assert.doesNotMatch(glam.suffix, /fully clothed/i);
  assert.doesNotMatch(glam.suffix, /artistic portrait/i);
  // sensual tokens kept on non-action general shots
  assert.match(glam.suffix, /alluring|guofeng|silk/i);
});

test('action/aftermath auto-strips alluring and blocks fashion portrait', () => {
  const battle = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    stylePreset: 'sensual_gufeng',
    existingPrompt:
      '2girls hand-to-hand combat, torn robes, battle damage, defeated on her back pinned to stone floor'
  });
  assert.doesNotMatch(battle.suffix, /fully clothed/);
  assert.doesNotMatch(battle.suffix, /artistic portrait/);
  assert.doesNotMatch(battle.suffix, /\balluring\b/i);
  assert.doesNotMatch(battle.suffix, /\bintimate\b/i);
  assert.match(battle.suffix, /ripped fabric|combat aftermath|action still/i);
  assert.match(battle.negativeExtra, /intact pristine dress|fashion pose/i);
});

test('portrait mode may keep soft elegance without clothing lock', () => {
  const port = buildPromptEnhancement({
    modelFamily: 'pony',
    nsfwEnabled: false,
    stylePreset: 'alluring_portrait',
    existingPrompt: '1girl portrait close-up looking at viewer, moon-white dress',
    genType: 'portrait'
  });
  assert.doesNotMatch(port.suffix, /fully clothed/i);
  assert.match(port.suffix, /tasteful elegance|beauty lighting|portrait/i);
});

test('stripStyleNarrativeTokens removes alluring/intimate/portrait locks', () => {
  const s = stripStyleNarrativeTokens(
    'alluring ancient guofeng, sheer fabric rim light, intimate haze, warm gold, luxurious silk'
  );
  assert.doesNotMatch(s, /alluring|intimate|sheer fabric/i);
  assert.match(s, /warm gold|luxurious silk/i);
  assert.equal(
    inferStyleShotMode('defeated on her back, torn crimson outfit'),
    'aftermath'
  );
  assert.equal(inferStyleShotMode('whip kick clash hand-to-hand combat'), 'action');
});

test('normalizeImageModelFamily maps sd15 / flux / pony', () => {
  assert.equal(normalizeImageModelFamily('pony'), 'pony');
  assert.equal(normalizeImageModelFamily('sd15'), 'sd15');
  assert.equal(normalizeImageModelFamily('SD 1.5 Draft'), 'sd15');
  assert.equal(normalizeImageModelFamily('flux'), 'flux');
  assert.equal(normalizeImageModelFamily('flux_dev_gguf'), 'flux');
  assert.equal(normalizeImageModelFamily(undefined), 'pony');
});

test('SD1.5 draft never auto-stacks Pony style/NSFW LoRAs', () => {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-sd15-policy-'));
  const loraDir = path.join(installPath, 'models', 'loras');
  fs.mkdirSync(loraDir, { recursive: true });
  fs.writeFileSync(path.join(loraDir, 'Pony_DetailV2.0.safetensors'), '');
  fs.writeFileSync(path.join(loraDir, 'Incase_Style_PonyXL.safetensors'), '');

  try {
    assert.equal(resolveStyleLora('sd15', true, { installPath, styleLora: null }), null);
    assert.equal(resolveNsfwLora('sd15', { installPath, nsfwLora: null }), null);
    const stack = resolveLoraStack({
      modelFamily: 'sd15',
      nsfwEnabled: true,
      installPath,
      styleLora: 'Pony_DetailV2.0.safetensors',
      nsfwLora: 'Incase_Style_PonyXL.safetensors'
    });
    assert.equal(stack.length, 0);

    const enh = buildPromptEnhancement({
      modelFamily: 'sd15',
      nsfwEnabled: false,
      existingPrompt: '1girl standing in mist'
    });
    assert.match(applyPromptEnhancement('1girl standing in mist', enh), /masterpiece|best quality/i);
    assert.doesNotMatch(enh.negativeExtra, /rating_/);
  } finally {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
});

test('FLUX discovers asian style and aidma unlock separately', () => {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-flux-policy-'));
  const loraDir = path.join(installPath, 'models', 'loras');
  fs.mkdirSync(loraDir, { recursive: true });
  fs.writeFileSync(path.join(loraDir, 'flux_asian_style.safetensors'), '');
  fs.writeFileSync(path.join(loraDir, 'aidmaNSFWunlock.safetensors'), '');
  fs.writeFileSync(path.join(loraDir, 'XLabs_Flux_Realism.safetensors'), '');

  try {
    const style = resolveStyleLora('flux', true, { installPath, styleLora: null });
    assert.equal(style, 'flux_asian_style.safetensors');

    const nsfw = resolveNsfwLora('flux', { installPath, nsfwLora: null });
    assert.equal(nsfw, 'aidmaNSFWunlock.safetensors');

    const stack = resolveLoraStack({
      modelFamily: 'flux',
      nsfwEnabled: true,
      installPath
    });
    assert.ok(stack.some((s) => s.role === 'style'));
    assert.ok(stack.some((s) => s.role === 'nsfw' && s.triggerWords === 'aidmaNSFWunlock'));
  } finally {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
});

test('normalizeImageModelFamily correctly normalizes redcraft and krea variants', () => {
  assert.equal(normalizeImageModelFamily('redcraft_krea2'), 'redcraft_krea2');
  assert.equal(normalizeImageModelFamily('redcraft'), 'redcraft_krea2');
  assert.equal(normalizeImageModelFamily('krea2'), 'redcraft_krea2');
  assert.equal(normalizeImageModelFamily('krea'), 'redcraft_krea2');
  assert.equal(normalizeImageModelFamily('赤佬'), 'redcraft_krea2');
  assert.equal(normalizeImageModelFamily('chilao'), 'redcraft_krea2');
  assert.equal(normalizeImageModelFamily('RedCraft 3.0 (Krea2)'), 'redcraft_krea2');
});

test('RedCraft Krea2 isolates LoRAs from Pony and discovers RedCraft LoRAs', () => {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-redcraft-policy-'));
  const loraDir = path.join(installPath, 'models', 'loras');
  fs.mkdirSync(loraDir, { recursive: true });
  fs.writeFileSync(path.join(loraDir, 'Pony_DetailV2.0.safetensors'), '');
  fs.writeFileSync(path.join(loraDir, 'Incase_Style_PonyXL.safetensors'), '');
  fs.writeFileSync(path.join(loraDir, 'redcraft_krea2_style.safetensors'), '');
  fs.writeFileSync(path.join(loraDir, 'krea2_nsfw_detail.safetensors'), '');

  try {
    // Style discovery should find redcraft_krea2_style, ignoring Pony
    const style = resolveStyleLora('redcraft_krea2', true, { installPath, styleLora: null });
    assert.equal(style, 'redcraft_krea2_style.safetensors');

    // NSFW discovery should find krea2_nsfw_detail, ignoring Pony
    const nsfw = resolveNsfwLora('redcraft_krea2', { installPath, nsfwLora: null });
    assert.equal(nsfw, 'krea2_nsfw_detail.safetensors');

    // Pony LoRAs passed explicitly should be ignored/filtered out for redcraft_krea2
    const stack = resolveLoraStack({
      modelFamily: 'redcraft_krea2',
      nsfwEnabled: true,
      installPath,
      styleLora: 'Pony_DetailV2.0.safetensors',
      nsfwLora: 'Incase_Style_PonyXL.safetensors'
    });
    // Pony files should not match redcraft patterns and thus return empty or fallback
    const names = stack.map((s) => s.name);
    assert.ok(!names.includes('Pony_DetailV2.0.safetensors'));
    assert.ok(!names.includes('Incase_Style_PonyXL.safetensors'));

    // When valid RedCraft LoRAs are provided, they are correctly stacked with targetModel 'model_only'
    const validStack = resolveLoraStack({
      modelFamily: 'redcraft_krea2',
      nsfwEnabled: true,
      installPath,
      styleLora: 'redcraft_krea2_style.safetensors',
      styleLoraStrength: 0.8,
      nsfwLora: 'krea2_nsfw_detail.safetensors',
      nsfwLoraStrength: 0.7
    });
    assert.equal(validStack.length, 2);
    assert.equal(validStack[0]?.name, 'redcraft_krea2_style.safetensors');
    assert.equal(validStack[0]?.strength, 0.8);
    assert.equal(validStack[1]?.name, 'krea2_nsfw_detail.safetensors');
    assert.equal(validStack[1]?.strength, 0.7);
  } finally {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
});

test('RedCraft Krea2 prompt enhancement uses natural language and no score_9 tags', () => {
  const sfw = buildPromptEnhancement({
    modelFamily: 'redcraft_krea2',
    nsfwEnabled: false,
    existingPrompt: 'hero standing in an ancient garden'
  });
  // Must not have anime score/source tags
  assert.doesNotMatch(sfw.suffix, /score_9|source_anime|danbooru/i);
  // Natural language booster
  assert.match(sfw.suffix, /high aesthetic photographic detail|rich textures|studio lighting/i);
  // Negative prompt should contain standard quality/nsfw guards in natural language
  assert.match(sfw.negativeExtra, /nsfw|explicit nudity|ugly|deformed/i);
  assert.doesNotMatch(sfw.negativeExtra, /source_anime|score_6|score_4/i);

  const nsfw = buildPromptEnhancement({
    modelFamily: 'redcraft_krea2',
    nsfwEnabled: true,
    existingPrompt: 'hero and heroine intimate touching on silk sheets'
  });
  // NSFW mode must not block NSFW in negative
  assert.doesNotMatch(nsfw.negativeExtra, /nsfw|explicit nudity/i);
  // Intimate prompts get natural language adult enhancers
  assert.match(nsfw.suffix, /natural uncensored details|erotic sensual atmosphere/i);
});

test('RedCraft Krea2 buildCharacterPromptHeader generates natural language portrait headers', () => {
  const portrait = buildCharacterPromptHeader('redcraft_krea2', false, 'portrait');
  assert.match(portrait.prefix, /high quality character portrait/i);
  assert.match(portrait.prefix, /clean studio background/i);
  assert.match(portrait.negative, /low quality/i);
  assert.match(portrait.negative, /nsfw/i);
  assert.doesNotMatch(portrait.prefix, /score_9|source_anime/i);

  const turnaround = buildCharacterPromptHeader('redcraft_krea2', true, 'turnaround');
  assert.match(turnaround.prefix, /full body character design|consistent character identity/i);
  assert.doesNotMatch(turnaround.negative, /nsfw/i);
  assert.doesNotMatch(turnaround.prefix, /score_9|source_anime/i);
});

