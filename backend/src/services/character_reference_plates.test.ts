import test from 'node:test';
import assert from 'node:assert/strict';
import { identityPlateForShot, resolveSceneIdentityPlate } from './character_reference_plates';

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
