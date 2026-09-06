import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoWorkflowCompiler } from './video_workflow_compiler';
import { VideoSpecCompiler } from './video_spec_compiler';

test('VideoWorkflowCompiler loads manifest and workflow template correctly', () => {
  const bundle = VideoWorkflowCompiler.loadWorkflowBundle('minimax_h3_hongchao_a2a_12gb');
  assert.equal(bundle.manifest.workflow_id, 'minimax_h3_hongchao_a2a_12gb');
  assert.ok(bundle.workflow['3']);
});

test('VideoWorkflowCompiler injects spec, staged filenames, and seeds into slots', () => {
  const spec = VideoSpecCompiler.compile({
    request: {
      scene_id: 1,
      scene_version: 1,
      profile: 'character_loop',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [100],
      motion_reference_asset_id: 200,
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
      characterRefFilenames: ['sha_char1.png'],
      motionRefFilename: 'sha_motion.mp4'
    },
    seed: 123456,
    outputPrefix: 'Test_H3_Output'
  });

  const wf = compiled.workflow;
  // Positive prompt injected
  assert.equal(wf['6'].inputs.text, spec.positive_prompt);
  // Negative prompt injected
  assert.equal(wf['7'].inputs.text, spec.negative_prompt);
  // First frame injected
  assert.equal(wf['10'].inputs.image, 'sha_first_frame.png');
  // Motion ref injected
  assert.equal(wf['20'].inputs.video, 'sha_motion.mp4');
  // Dimensions injected
  assert.equal(wf['30'].inputs.width, 864);
  assert.equal(wf['30'].inputs.height, 480);
  assert.equal(wf['30'].inputs.fps, 24);
  // Seed injected
  assert.equal(wf['3'].inputs.seed, 123456);
  // Prefix injected
  assert.equal(wf['40'].inputs.filename_prefix, 'Test_H3_Output');
});

test('VideoWorkflowCompiler throws when unknown slot node is referenced', () => {
  assert.throws(() => {
    VideoWorkflowCompiler.validateSlot({}, { node: '999', input: 'text' }, 'test_slot');
  }, /declared in slot 'test_slot' does not exist/);
});
