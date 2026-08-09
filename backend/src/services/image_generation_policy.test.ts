import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyPromptEnhancement,
  buildPromptEnhancement,
  inferStyleShotMode,
  normalizeImageModelFamily,
  resolveLoraStack,
  resolveNsfwLora,
  resolveStyleLora,
  stripStyleNarrativeTokens
} from './image_generation_policy';

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
