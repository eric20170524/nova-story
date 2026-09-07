import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoSpecCompiler, alignH3FrameCount, cleanPromptForH3 } from './video_spec_compiler';

test('cleanPromptForH3 removes Pony scores and cleans whitespace', () => {
  const dirty = 'score_9, score_8_up, masterpiece, 1girl, lu xueqi, best quality, ice sword';
  const cleaned = cleanPromptForH3(dirty);
  assert.equal(cleaned.includes('score_9'), false);
  assert.equal(cleaned.includes('masterpiece'), false);
  assert.equal(cleaned.includes('best quality'), false);
  assert.ok(cleaned.includes('lu xueqi'));
  assert.ok(cleaned.includes('ice sword'));
});

test('alignH3FrameCount follows the MiniMax H3 17k+5 frame grid', () => {
  assert.equal(alignH3FrameCount(5), 5);
  assert.equal(alignH3FrameCount(120), 124);
  assert.equal(alignH3FrameCount(121), 124);
  assert.equal(alignH3FrameCount(124), 124);
});

test('VideoSpecCompiler compiles experimental Hybrid character_loop with H3 tags', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 1,
      scene_version: 1,
      profile: 'character_loop',
      workflow_id: 'minimax_h3_hongchao_a2a_12gb',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [100, 101],
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
  assert.equal(spec.workflow_id, 'minimax_h3_hongchao_a2a_12gb');
  assert.equal(spec.output_contract.is_loop, true);
  assert.equal(spec.output_contract.width, 864);
  assert.equal(spec.output_contract.height, 480);
  assert.equal(spec.output_contract.frames, 124);
  assert.ok(spec.positive_prompt.includes('<Picture 1>'));
  assert.ok(spec.positive_prompt.includes('<Picture 2>'));
  assert.ok(spec.positive_prompt.includes('<Video 1>'));
  assert.ok(spec.positive_prompt.includes('motion-timing and body-pose reference only'));
  assert.ok(spec.positive_prompt.includes('Locked camera'));
  assert.ok(spec.positive_prompt.includes('Mouth remains gently closed'));
  assert.ok(spec.positive_prompt.includes('Lu Xueqi'));
  assert.ok(spec.negative_prompt.includes('mouth opening'));
});

test('Official Ref2VA reserves Picture 1 for the scene keyframe and starts identity refs at Picture 2', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 1,
      scene_version: 1,
      profile: 'character_loop',
      workflow_id: 'minimax_h3_ref2va_official_12gb',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [100, 101],
      motion_reference_asset_id: 200,
      preset: 'preview_480p_5s',
      run_loop_closer: true
    },
    scene: { id: 1, visual_prompt: 'standing still' },
    character: { id: 5, name: 'Lu Xueqi' }
  });

  assert.ok(spec.positive_prompt.includes('<Picture 1> is the scene/keyframe reference'));
  assert.ok(spec.positive_prompt.includes('<Picture 2>, <Picture 3>'));
  assert.ok(spec.positive_prompt.includes('<Video 1>'));
});

test('Official FL2VA prompt uses keyframe boundary semantics instead of Ref2VA tags', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 1,
      scene_version: 1,
      profile: 'character_loop',
      workflow_id: 'minimax_h3_fl2va_official_12gb',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [],
      last_frame_asset_id: 11,
      preset: 'preview_480p_5s',
      run_loop_closer: true
    },
    scene: { id: 1, visual_prompt: 'subtle breathing' },
    character: null
  });

  assert.equal(spec.positive_prompt.includes('<Picture'), false);
  assert.equal(spec.positive_prompt.includes('<Video'), false);
  assert.ok(spec.positive_prompt.includes('hard visual boundary anchors'));
});

test('VideoSpecCompiler compiles narrative_clip with camera movement', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 2,
      scene_version: 1,
      profile: 'narrative_clip',
      workflow_id: 'minimax_h3_hongchao_a2a_12gb',
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
  assert.equal(spec.output_contract.frames, 124);
  assert.ok(spec.positive_prompt.includes('<Picture 1>'));
  assert.ok(spec.positive_prompt.includes('slow pan right'));
  assert.ok(spec.positive_prompt.includes('raising the Tianya sword'));
});
