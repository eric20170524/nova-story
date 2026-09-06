import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoSpecCompiler, cleanPromptForH3 } from './video_spec_compiler';

test('cleanPromptForH3 removes Pony scores and cleans whitespace', () => {
  const dirty = 'score_9, score_8_up, masterpiece, 1girl, lu xueqi, best quality, ice sword';
  const cleaned = cleanPromptForH3(dirty);
  assert.equal(cleaned.includes('score_9'), false);
  assert.equal(cleaned.includes('masterpiece'), false);
  assert.equal(cleaned.includes('best quality'), false);
  assert.ok(cleaned.includes('lu xueqi'));
  assert.ok(cleaned.includes('ice sword'));
});

test('VideoSpecCompiler compiles character_loop with locked camera and closed mouth', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 1,
      scene_version: 1,
      profile: 'character_loop',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [100],
      motion_reference_asset_id: 200,
      preset: 'preview_480p_5s',
      run_loop_closer: true
    },
    scene: {
      id: 1,
      visual_prompt: 'score_9, standing by the bamboo forest'
    },
    character: {
      id: 5,
      name: 'Lu Xueqi',
      description: 'icy blue robe, silver hair accessory'
    }
  });

  assert.equal(spec.profile, 'character_loop');
  assert.equal(spec.output_contract.is_loop, true);
  assert.equal(spec.output_contract.width, 864);
  assert.equal(spec.output_contract.height, 480);
  assert.ok(spec.positive_prompt.includes('Locked camera'));
  assert.ok(spec.positive_prompt.includes('Mouth remains gently closed'));
  assert.ok(spec.positive_prompt.includes('Lu Xueqi'));
  assert.ok(spec.negative_prompt.includes('mouth opening'));
});

test('VideoSpecCompiler compiles narrative_clip with camera movement', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 2,
      scene_version: 1,
      profile: 'narrative_clip',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [100],
      preset: 'standard_720p_5s',
      run_loop_closer: false
    },
    scene: {
      id: 2,
      camera_movement: 'slow pan right',
      visual_prompt: 'raising the Tianya sword with glowing cold aura'
    },
    character: {
      id: 5,
      name: 'Lu Xueqi'
    }
  });

  assert.equal(spec.profile, 'narrative_clip');
  assert.equal(spec.output_contract.is_loop, false);
  assert.equal(spec.output_contract.width, 1280);
  assert.equal(spec.output_contract.height, 720);
  assert.ok(spec.positive_prompt.includes('slow pan right'));
  assert.ok(spec.positive_prompt.includes('raising the Tianya sword'));
});
