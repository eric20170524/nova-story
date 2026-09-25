import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoWorkflowCompiler } from './video_workflow_compiler';
import { VideoSpecCompiler } from './video_spec_compiler';

test('VideoWorkflowCompiler loads experimental Hybrid manifest correctly', () => {
  const bundle = VideoWorkflowCompiler.loadWorkflowBundle('minimax_h3_hongchao_a2a_12gb');
  assert.equal(bundle.manifest.workflow_id, 'minimax_h3_hongchao_a2a_12gb');
  assert.equal(bundle.manifest.stability, 'experimental');
  assert.ok(bundle.workflow['3']);
  assert.equal(bundle.workflow['8'].inputs.type, 'minimax');
  assert.equal(bundle.workflow['30'].inputs.length, 124);
});

test('VideoWorkflowCompiler injects explicit last frame, refs, spec and seed into experimental Hybrid', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 1,
      scene_version: 1,
      profile: 'character_loop',
      workflow_id: 'minimax_h3_hongchao_a2a_12gb',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [100],
      motion_reference_asset_id: 200,
      last_frame_asset_id: 300,
      preset: 'preview_480p_5s',
      seed: 123456,
      run_loop_closer: true
    },
    scene: {
      id: 1,
      visual_prompt: 'standing in snowy bamboo grove'
    },
    character: {
      id: 5,
      name: 'Lu Xueqi'
    }
  });

  const compiled = VideoWorkflowCompiler.compile({
    spec,
    stagedFiles: {
      firstFrameFilename: 'sha_first_frame.png',
      lastFrameFilename: 'sha_last_frame.png',
      characterRefFilenames: ['sha_char1.png'],
      motionRefFilename: 'sha_motion.mp4'
    },
    seed: 123456,
    outputPrefix: 'Test_H3_Output'
  });

  const wf = compiled.workflow;
  assert.equal(wf['6'].inputs.text, spec.positive_prompt);
  assert.equal(wf['7'].inputs.text, spec.negative_prompt);
  assert.equal(wf['10'].inputs.image, 'sha_first_frame.png');
  assert.equal(wf['11'].inputs.image, 'sha_last_frame.png');
  assert.equal(wf['12'].inputs.image, 'sha_char1.png');
  assert.equal(wf['13'].inputs.image, 'sha_char1.png');
  assert.equal(wf['14'].inputs.image, 'sha_char1.png');
  assert.equal(wf['20'].inputs.video, 'sha_motion.mp4');
  assert.equal(wf['30'].inputs.width, 864);
  assert.equal(wf['30'].inputs.height, 480);
  assert.equal(wf['30'].inputs.length, 124);
  assert.equal(wf['30'].inputs.fps, 24);
  assert.equal(wf['3'].inputs.seed, 123456);
  assert.equal(wf['40'].inputs.filename_prefix, 'Test_H3_Output');
  assert.equal(compiled.appliedParams.delivery_frames, 120);
  assert.equal(compiled.appliedParams.workflow_id, 'minimax_h3_hongchao_a2a_12gb');
});

test('VideoWorkflowCompiler keeps K -> K fallback when explicit last frame is omitted', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 1,
      scene_version: 1,
      profile: 'character_loop',
      workflow_id: 'minimax_h3_hongchao_a2a_12gb',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [100],
      motion_reference_asset_id: 200,
      preset: 'preview_480p_5s',
      run_loop_closer: true
    },
    scene: { id: 1 },
    character: { name: 'Lu Xueqi' }
  });

  const compiled = VideoWorkflowCompiler.compile({
    spec,
    stagedFiles: {
      firstFrameFilename: 'same_anchor.png',
      characterRefFilenames: ['identity.png'],
      motionRefFilename: 'motion.mp4'
    }
  });

  assert.equal(compiled.workflow['10'].inputs.image, 'same_anchor.png');
  assert.equal(compiled.workflow['11'].inputs.image, 'same_anchor.png');
});

test('VideoWorkflowCompiler selects the Official Ref2VA candidate from VideoSpec', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 2,
      scene_version: 1,
      profile: 'narrative_clip',
      workflow_id: 'minimax_h3_ref2va_official_12gb',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [100],
      motion_reference_asset_id: 200,
      preset: 'preview_480p_5s',
      run_loop_closer: false
    },
    scene: { id: 2, visual_prompt: 'walk forward slowly' },
    character: { name: 'Lu Xueqi' }
  });

  const compiled = VideoWorkflowCompiler.compile({
    spec,
    stagedFiles: {
      firstFrameFilename: 'scene.png',
      characterRefFilenames: ['identity.png'],
      motionRefFilename: 'motion.mp4'
    },
    seed: 7
  });

  assert.equal(compiled.manifest.workflow_family, 'ref2va');
  assert.equal(compiled.appliedParams.workflow_id, 'minimax_h3_ref2va_official_12gb');
  assert.equal(compiled.appliedParams.steps, 20);
  assert.equal(compiled.workflow['10'].class_type, 'MiniMaxH3ReferenceToVideo');
  assert.equal(compiled.workflow['10'].inputs.length, 124);
  assert.equal(compiled.workflow['4'].inputs.image, 'scene.png');
  assert.equal(compiled.workflow['5'].inputs.image, 'identity.png');
  assert.equal(compiled.workflow['8'].inputs.video, 'motion.mp4');
});

test('VideoWorkflowCompiler selects Official FL2VA and injects distinct boundary frames', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 3,
      scene_version: 1,
      profile: 'character_loop',
      workflow_id: 'minimax_h3_fl2va_official_12gb',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [],
      last_frame_asset_id: 11,
      preset: 'preview_480p_5s',
      run_loop_closer: true
    },
    scene: { id: 3, visual_prompt: 'subtle breathing' },
    character: null
  });

  const compiled = VideoWorkflowCompiler.compile({
    spec,
    stagedFiles: {
      firstFrameFilename: 'first.png',
      lastFrameFilename: 'last.png'
    },
    seed: 9
  });

  assert.equal(compiled.manifest.workflow_family, 'fl2va');
  assert.equal(compiled.appliedParams.workflow_id, 'minimax_h3_fl2va_official_12gb');
  assert.equal(compiled.workflow['10'].class_type, 'MiniMaxH3ImageToVideo');
  assert.equal(compiled.workflow['4'].inputs.image, 'first.png');
  assert.equal(compiled.workflow['5'].inputs.image, 'last.png');
  assert.equal(compiled.workflow['10'].inputs.length, 124);
  assert.equal(compiled.workflow['11'].inputs.noise_seed, 9);
});

test('VideoWorkflowCompiler validates exact model availability from Comfy object_info', () => {
  const bundle = VideoWorkflowCompiler.loadWorkflowBundle('minimax_h3_hongchao_a2a_12gb');
  const classTypes = new Set(Object.values(bundle.workflow).map((node: any) => node.class_type));
  const objectInfo: Record<string, any> = {};
  for (const classType of classTypes) {
    objectInfo[String(classType)] = { input: { required: {} } };
  }
  objectInfo.UNETLoader.models = ['minimax_h3_ref2va_pruned_int8_convrot.safetensors'];
  objectInfo.CLIPLoader.models = ['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'];
  // Deliberately omit video VAE.

  const validation = VideoWorkflowCompiler.validateAgainstComfyObjectInfo(
    objectInfo,
    bundle.manifest,
    bundle.workflow
  );
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.missingModels, ['minimax_h3_video_vae_fp16.safetensors']);
});

test('VideoWorkflowCompiler throws when unknown slot node is referenced', () => {
  assert.throws(() => {
    VideoWorkflowCompiler.validateSlot({}, { node: '999', input: 'text' }, 'test_slot');
  }, /declared in slot 'test_slot' does not exist/);
});

test('VideoWorkflowCompiler compiles official Multi-Frame workflow with identity and anchored frame guide', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 39,
      scene_version: 1,
      profile: 'narrative_clip',
      workflow_id: 'minimax_h3_multiframe_official_12gb',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [100, 101],
      guide_frame_asset_id: 300,
      guide_frame_idx: 39,
      preset: 'preview_480p_5s',
      run_loop_closer: false
    },
    scene: { id: 39, visual_prompt: 'insert shot, Lu Jiajing hand hesitates over glowing mirror' },
    character: { name: 'Lu Jiajing' }
  });

  const compiled = VideoWorkflowCompiler.compile({
    spec,
    stagedFiles: {
      firstFrameFilename: 'first_frame.png',
      characterRefFilenames: ['lu_ref1.png', 'lu_ref2.png'],
      guideFrameFilename: 'scene-39-composition-reference-v2.png'
    },
    guideFrameIdx: 39,
    seed: 42
  });

  assert.equal(compiled.manifest.workflow_family, 'multiframe_ref2va');
  assert.equal(compiled.appliedParams.workflow_id, 'minimax_h3_multiframe_official_12gb');
  assert.equal(compiled.appliedParams.guide_frame_idx, 39);
  assert.equal(compiled.workflow['10'].class_type, 'MiniMaxH3ReferenceToVideo');
  assert.equal(compiled.workflow['4'].inputs.image, 'first_frame.png');
  assert.equal(compiled.workflow['5'].inputs.image, 'lu_ref1.png');
  assert.equal(compiled.workflow['6'].inputs.image, 'lu_ref2.png');
  assert.equal(compiled.workflow['20'].class_type, 'LoadImage');
  assert.equal(compiled.workflow['20'].inputs.image, 'scene-39-composition-reference-v2.png');
  assert.equal(compiled.workflow['21'].class_type, 'MiniMaxH3AddGuide');
  assert.equal(compiled.workflow['21'].inputs.frame_idx, 39);
  // Without last_frame, basic guider connects directly to node 21
  assert.deepEqual(compiled.workflow['14'].inputs.conditioning, ['21', 0]);
  assert.match(spec.positive_prompt, /Pin and stabilize the critical action pose/);
  assert.match(spec.positive_prompt, /frame 39/);
});

test('VideoWorkflowCompiler chains both guide_frame and last_frame when both are supplied', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 50,
      scene_version: 1,
      profile: 'character_loop',
      workflow_id: 'minimax_h3_multiframe_official_12gb',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [100],
      guide_frame_asset_id: 301,
      guide_frame_idx: 50,
      last_frame_asset_id: 302,
      preset: 'preview_480p_5s',
      run_loop_closer: true
    },
    scene: { id: 50, visual_prompt: 'close-up, Nangong Xue accepts the offered hand' },
    character: { name: 'Nangong Xue' }
  });

  const compiled = VideoWorkflowCompiler.compile({
    spec,
    stagedFiles: {
      firstFrameFilename: 'first.png',
      characterRefFilenames: ['nangong.png'],
      guideFrameFilename: 'scene-50-composition-reference.png',
      lastFrameFilename: 'last.png'
    },
    guideFrameIdx: 50,
    seed: 88
  });

  assert.equal(compiled.workflow['20'].inputs.image, 'scene-50-composition-reference.png');
  assert.equal(compiled.workflow['21'].inputs.frame_idx, 50);
  assert.equal(compiled.workflow['22'].inputs.image, 'last.png');
  assert.equal(compiled.workflow['23'].inputs.frame_idx, 120);
  // With last_frame, basic guider connects to node 23 which chains from node 21
  assert.deepEqual(compiled.workflow['14'].inputs.conditioning, ['23', 0]);
  assert.deepEqual(compiled.workflow['23'].inputs.positive, ['21', 0]);
});

test('VideoWorkflowCompiler validates official Multi-Frame against Comfy object_info', () => {
  const bundle = VideoWorkflowCompiler.loadWorkflowBundle('minimax_h3_multiframe_official_12gb');
  const classTypes = new Set(Object.values(bundle.workflow).map((node: any) => node.class_type));
  const objectInfo: Record<string, any> = {};
  for (const classType of classTypes) {
    objectInfo[String(classType)] = { input: { required: {} } };
  }
  objectInfo.UNETLoader.models = ['minimax_h3_ref2va_pruned_int8_convrot.safetensors'];
  objectInfo.CLIPLoader.models = ['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'];
  objectInfo.VAELoader.models = ['minimax_h3_video_vae_fp16.safetensors'];

  const validation = VideoWorkflowCompiler.validateAgainstComfyObjectInfo(
    objectInfo,
    bundle.manifest,
    bundle.workflow
  );
  assert.equal(validation.valid, true);
  assert.equal(validation.missingNodes.length, 0);
  assert.equal(validation.missingSlots.length, 0);
  assert.equal(validation.missingModels.length, 0);
});

test('VideoWorkflowCompiler rejects a graph loader model missing from the manifest and ComfyUI', () => {
  const bundle = VideoWorkflowCompiler.loadWorkflowBundle('minimax_h3_multiframe_official_12gb');
  bundle.workflow['2'].inputs.clip_name = 'different_clip.safetensors';
  const objectInfo: Record<string, any> = {};
  for (const node of Object.values(bundle.workflow) as any[]) {
    objectInfo[node.class_type] = { input: { required: {} } };
  }
  objectInfo.UNETLoader.models = ['minimax_h3_ref2va_pruned_int8_convrot.safetensors'];
  objectInfo.CLIPLoader.models = ['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'];
  objectInfo.VAELoader.models = ['minimax_h3_video_vae_fp16.safetensors'];

  const validation = VideoWorkflowCompiler.validateAgainstComfyObjectInfo(objectInfo, bundle.manifest, bundle.workflow);
  assert.equal(validation.valid, false);
  assert.ok(validation.missingSlots.some((issue) => issue.includes('different_clip.safetensors')));
  assert.deepEqual(validation.missingModels, ['different_clip.safetensors']);
});
