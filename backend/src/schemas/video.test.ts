import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VideoGenerationRequestSchema,
  MediaAssetSchema
} from './video';

test('VideoGenerationRequestSchema defaults to experimental Hybrid for compatibility', () => {
  const parsed = VideoGenerationRequestSchema.parse({
    scene_id: 1,
    scene_version: 1,
    profile: 'narrative_clip',
    keyframe_asset_id: 10,
    character_reference_asset_ids: [],
    preset: 'preview_480p_5s'
  });
  assert.equal(parsed.profile, 'narrative_clip');
  assert.equal(parsed.workflow_id, 'minimax_h3_hongchao_a2a_12gb');
  assert.equal(parsed.preset, 'preview_480p_5s');
  assert.equal(parsed.run_loop_closer, true);
});

test('Hybrid character_loop rejects missing character references', () => {
  assert.throws(() => {
    VideoGenerationRequestSchema.parse({
      scene_id: 1,
      profile: 'character_loop',
      workflow_id: 'minimax_h3_hongchao_a2a_12gb',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [],
      motion_reference_asset_id: 201
    });
  }, /character_reference_asset_ids/);
});

test('Ref2VA character_loop rejects missing motion reference', () => {
  assert.throws(() => {
    VideoGenerationRequestSchema.parse({
      scene_id: 1,
      profile: 'character_loop',
      workflow_id: 'minimax_h3_ref2va_official_12gb',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [101]
    });
  }, /motion_reference_asset_id/);
});

test('Ref2VA rejects a hard last-frame request instead of silently ignoring it', () => {
  assert.throws(() => {
    VideoGenerationRequestSchema.parse({
      scene_id: 1,
      profile: 'narrative_clip',
      workflow_id: 'minimax_h3_ref2va_official_12gb',
      keyframe_asset_id: 10,
      last_frame_asset_id: 11
    });
  }, /does not provide a hard last-frame boundary/);
});

test('Multi-Frame workflow accepts character references, guide frame, and frame index', () => {
  const parsed = VideoGenerationRequestSchema.parse({
    scene_id: 39,
    profile: 'narrative_clip',
    workflow_id: 'minimax_h3_multiframe_official_12gb',
    keyframe_asset_id: 10,
    character_reference_asset_ids: [101, 102],
    guide_frame_asset_id: 201,
    guide_frame_idx: 39
  });
  assert.equal(parsed.workflow_id, 'minimax_h3_multiframe_official_12gb');
  assert.equal(parsed.guide_frame_asset_id, 201);
  assert.equal(parsed.guide_frame_idx, 39);
  assert.deepEqual(parsed.character_reference_asset_ids, [101, 102]);
});

test('Multi-Frame workflow rejects guide frame indices outside the 124-frame clip', () => {
  for (const guide_frame_idx of [0, 124, -1]) {
    assert.throws(() => VideoGenerationRequestSchema.parse({
      scene_id: 1,
      workflow_id: 'minimax_h3_multiframe_official_12gb',
      keyframe_asset_id: 10,
      guide_frame_asset_id: 201,
      guide_frame_idx
    }), /guide_frame_idx|too_small|too_big/i);
  }
});

test('Multi-Frame workflow allows optional last-frame boundary guide', () => {
  const parsed = VideoGenerationRequestSchema.parse({
    scene_id: 50,
    profile: 'narrative_clip',
    workflow_id: 'minimax_h3_multiframe_official_12gb',
    keyframe_asset_id: 10,
    last_frame_asset_id: 12
  });
  assert.equal(parsed.workflow_id, 'minimax_h3_multiframe_official_12gb');
  assert.equal(parsed.last_frame_asset_id, 12);
});

test('Ref2VA rejects guide_frame_asset_id', () => {
  assert.throws(() => {
    VideoGenerationRequestSchema.parse({
      scene_id: 1,
      profile: 'narrative_clip',
      workflow_id: 'minimax_h3_ref2va_official_12gb',
      keyframe_asset_id: 10,
      guide_frame_asset_id: 201
    });
  }, /does not consume guide_frame_asset_id/);
});

test('FL2VA allows a boundary-only character loop without identity/motion references', () => {
  const parsed = VideoGenerationRequestSchema.parse({
    scene_id: 1,
    profile: 'character_loop',
    workflow_id: 'minimax_h3_fl2va_official_12gb',
    keyframe_asset_id: 10,
    last_frame_asset_id: 11,
    character_reference_asset_ids: []
  });
  assert.equal(parsed.workflow_id, 'minimax_h3_fl2va_official_12gb');
  assert.equal(parsed.last_frame_asset_id, 11);
});

test('FL2VA rejects identity/motion refs it cannot consume', () => {
  assert.throws(() => {
    VideoGenerationRequestSchema.parse({
      scene_id: 1,
      profile: 'character_loop',
      workflow_id: 'minimax_h3_fl2va_official_12gb',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [101],
      motion_reference_asset_id: 201
    });
  }, /does not consume/);
});

test('VideoGenerationRequestSchema rejects more than 3 character references', () => {
  assert.throws(() => {
    VideoGenerationRequestSchema.parse({
      scene_id: 1,
      profile: 'narrative_clip',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [101, 102, 103, 104]
    });
  });
});

test('MediaAssetSchema accepts review_required final candidates', () => {
  const asset = MediaAssetSchema.parse({
    project_id: 1,
    scene_id: 2,
    scene_version: 1,
    media_type: 'video',
    role: 'loop_master',
    profile: 'character_loop',
    status: 'review_required',
    url: '/static/generated/videos/1/2/100/final.mp4',
    width: 864,
    height: 480,
    fps: 24,
    frame_count: 120,
    duration_ms: 5000,
    sha256: 'abcdef1234567890'
  });
  assert.equal(asset.role, 'loop_master');
  assert.equal(asset.status, 'review_required');
});

test('MediaAssetSchema accepts explicit last-frame reference assets', () => {
  const asset = MediaAssetSchema.parse({
    project_id: 1,
    scene_id: 2,
    scene_version: 1,
    media_type: 'image',
    role: 'last_frame_reference',
    status: 'ready',
    url: '/static/generated/references/1/last-frame.png'
  });
  assert.equal(asset.role, 'last_frame_reference');
  assert.equal(asset.media_type, 'image');
});
