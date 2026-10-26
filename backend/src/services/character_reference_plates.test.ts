import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTurnaroundPlate,
  characterPlates,
  identityPlateForShot,
  resolveSceneIdentityPlate,
  buildQwenMultiReferencePrefix,
  isQwenImageWorkflow,
  orderedVisibleCharacters
} from './character_reference_plates';

const character = {
  id: 17,
  name: '陆嘉静',
  visual_tags: {
    assets: {
      avatar_url: '/portrait.png',
      face_url: '/corner-crop.png',
      turnaround_url: '/sheet.png',
      turnaround_front_url: '/front.png',
    },
  },
};

test('close-up uses the portrait and a wide shot uses no image', () => {
  assert.equal(identityPlateForShot({
    shot_type: 'Close-Up',
    shot_master_character_ids: [17],
  }), 'face');
  const close = resolveSceneIdentityPlate({
    gen_type: 'scene',
    shot_type: 'Close-Up',
    shot_master_character_ids: [17],
    character_ref_url: '/sheet.png',
    reference_tier: 'A',
    denoise: 0.62,
  }, [character]);
  assert.equal(close.character_ref_url, '/portrait.png');
  assert.equal(close.identity_plate, 'face');
  assert.equal(close.denoise, 0.62);

  const wide = resolveSceneIdentityPlate({
    gen_type: 'scene',
    shot_type: 'Wide Shot',
    shot_spec: { visible_subjects: ['陆嘉静', '裴雨涵'] },
    character_ref_url: '/portrait.png',
  }, [character]);
  assert.equal(wide.character_ref_url, undefined);
  assert.equal(wide.identity_plate, 'none');
  assert.equal(wide.force_no_character_adapter, true);
});

test('a single full-body shot uses the front panel and does not img2img it', () => {
  const full = resolveSceneIdentityPlate({
    gen_type: 'scene',
    shot_type: 'Full Shot',
    shot_master_character_ids: [17],
    character_ref_url: '/sheet.png',
    denoise: 0.62,
  }, [character]);
  assert.equal(full.character_ref_url, '/front.png');
  assert.equal(full.identity_plate, 'body');
  assert.equal(full.denoise, 1);
  assert.equal(full.character_adapter_weight, 0.45);

  const zhClose = resolveSceneIdentityPlate({
    gen_type: 'scene',
    shot_type: '特写',
    shot_master_character_ids: [17],
  }, [character]);
  assert.equal(zhClose.identity_plate, 'face');
  assert.equal(zhClose.character_ref_url, '/portrait.png');

  const zhFull = resolveSceneIdentityPlate({
    gen_type: 'scene',
    shot_type: '全身',
    shot_master_character_ids: [17],
  }, [character]);
  assert.equal(zhFull.identity_plate, 'body');
  assert.equal(zhFull.character_ref_url, '/front.png');
});

test('adopting a full-body plate moves display and body plate together and drops legacy side/back', () => {
  const assets: Record<string, any> = {
    avatar_url: '/portrait.png',
    turnaround_url: '/old-sheet.png',
    turnaround_front_url: '/old-front.png',
    turnaround_side_url: '/old-side.png',
    turnaround_back_url: '/old-back.png',
  };
  assert.equal(applyTurnaroundPlate(assets, '/new-front.png'), true);
  assert.equal(assets.turnaround_url, '/new-front.png');
  assert.equal(assets.turnaround_front_url, '/new-front.png');
  assert.equal(assets.turnaround_side_url, undefined);
  assert.equal(assets.turnaround_back_url, undefined);
  assert.equal(characterPlates({ assets }).body, '/new-front.png');
  assert.equal(characterPlates({ assets }).face, '/portrait.png');

  // clearing removes the body plate too
  assert.equal(applyTurnaroundPlate(assets, null), true);
  assert.equal(assets.turnaround_url, null);
  assert.equal(characterPlates({ assets }).body, null);
});

test('saving an unchanged turnaround_url leaves a legacy separate front plate untouched', () => {
  const assets: Record<string, any> = {
    turnaround_url: '/legacy-sheet.png',
    turnaround_front_url: '/legacy-front.png',
    turnaround_side_url: '/legacy-side.png',
  };
  assert.equal(applyTurnaroundPlate(assets, '/legacy-sheet.png'), false);
  assert.equal(assets.turnaround_front_url, '/legacy-front.png');
  assert.equal(assets.turnaround_side_url, '/legacy-side.png');
});

test('qwen_image resolves multiple character identity plates in wide multi-person shots', () => {
  const char1 = {
    id: 20,
    name: '陆嘉静',
    english_name: 'Lu Jiajing',
    visual_tags: {
      design: { gender: 'female' },
      assets: { avatar_url: '/static/generated/portrait_20.png', turnaround_front_url: '/static/generated/front_20.png' }
    }
  };
  const char2 = {
    id: 22,
    name: '南宫雪',
    english_name: 'Nangong Xue',
    visual_tags: {
      design: { gender: 'female' },
      assets: { avatar_url: '/static/generated/portrait_22.png', turnaround_front_url: '/static/generated/front_22.png' }
    }
  };
  const char3 = {
    id: 21,
    name: '裴雨涵',
    english_name: 'Pei Yuhan',
    visual_tags: {
      design: { gender: 'female' },
      assets: { avatar_url: '/static/generated/portrait_21.png', turnaround_front_url: '/static/generated/front_21.png' }
    }
  };

  const wideShot = {
    gen_type: 'scene',
    model_type: 'qwen_image',
    shot_type: 'Wide Shot',
    shot_spec: { visible_subjects: ['陆嘉静', '南宫雪', '裴雨涵'] }
  };

  assert.equal(isQwenImageWorkflow(wideShot), true);
  const ordered = orderedVisibleCharacters(wideShot, [char2, char1, char3]);
  assert.deepEqual(ordered.map(c => c.name), ['陆嘉静', '南宫雪', '裴雨涵']);

  const resolved = resolveSceneIdentityPlate(wideShot, [char2, char1, char3]);
  assert.equal(resolved.identity_plate, 'multi');
  assert.equal(resolved.character_ref_urls.length, 3);
  assert.equal(resolved.character_ref_urls[0], '/static/generated/portrait_20.png');
  assert.equal(resolved.character_ref_urls[1], '/static/generated/portrait_22.png');
  assert.equal(resolved.character_ref_urls[2], '/static/generated/portrait_21.png');
  assert.equal(resolved.character_ref_bindings.length, 3);
  assert.equal(resolved.character_ref_bindings[0].slot, 1);
  assert.equal(resolved.character_ref_bindings[0].name, '陆嘉静');
  assert.equal(resolved.character_ref_bindings[0].gender, 'female');
  assert.equal(resolved.force_no_character_adapter, false);

  const prefix = buildQwenMultiReferencePrefix(resolved.character_ref_bindings);
  assert.match(prefix, /<Picture 1> \(image 1\) is the identity reference for Lu Jiajing \(adult woman, female/);
  assert.match(prefix, /<Picture 2> \(image 2\) is the identity reference for Nangong Xue \(adult woman, female/);
  assert.match(prefix, /<Picture 3> \(image 3\) is the identity reference for Pei Yuhan \(adult woman, female/);
  assert.equal(/[\u4e00-\u9fa5]/.test(prefix), false, 'Prefix must not contain Chinese characters');

  // Empty overhead / absent shots do not attach character plates
  const emptyShot = {
    gen_type: 'scene',
    model_type: 'qwen_image',
    shot_type: 'Wide Shot',
    shot_intent: 'overhead-map',
    shot_spec: { shot_intent: 'overhead-map', visible_subjects: [] }
  };
  const emptyResolved = resolveSceneIdentityPlate(emptyShot, [char1, char2]);
  assert.equal(emptyResolved.identity_plate, 'none');
  assert.equal(emptyResolved.character_ref_bindings, undefined);
  assert.equal(emptyResolved.character_ref_urls, undefined);

  // Legacy Pony/SDXL keeps single-person / non-wide restriction
  const ponyWide = {
    gen_type: 'scene',
    model_type: 'pony',
    shot_type: 'Wide Shot',
    shot_spec: { visible_subjects: ['陆嘉静', '南宫雪'] }
  };
  assert.equal(isQwenImageWorkflow(ponyWide), false);
  const ponyResolved = resolveSceneIdentityPlate(ponyWide, [char1, char2]);
  assert.equal(ponyResolved.identity_plate, 'none');
  assert.equal(ponyResolved.character_ref_urls, undefined);
});
