import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VideoGenerationRequestSchema,
  VideoSpecSchema,
  MediaAssetSchema,
  VideoQAReportSchema
} from './video';

test('VideoGenerationRequestSchema allows valid narrative_clip without motion reference or character refs', () => {
  const parsed = VideoGenerationRequestSchema.parse({
    scene_id: 1,
    scene_version: 1,
    profile: 'narrative_clip',
    keyframe_asset_id: 10,
    character_reference_asset_ids: [],
    preset: 'preview_480p_5s'
  });
  assert.equal(parsed.profile, 'narrative_clip');
  assert.equal(parsed.preset, 'preview_480p_5s');
  assert.equal(parsed.run_loop_closer, true);
  assert.deepEqual(parsed.character_reference_asset_ids, []);
});

test('VideoGenerationRequestSchema rejects character_loop without character references', () => {
  assert.throws(() => {
    VideoGenerationRequestSchema.parse({
      scene_id: 1,
      scene_version: 1,
      profile: 'character_loop',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [],
      motion_reference_asset_id: 201
    });
  }, /character_reference_asset_ids/);
});

test('VideoGenerationRequestSchema rejects character_loop without motion reference', () => {
  assert.throws(() => {
    VideoGenerationRequestSchema.parse({
      scene_id: 1,
      scene_version: 1,
      profile: 'character_loop',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [101]
    });
  }, /motion_reference_asset_id/);
});

test('VideoGenerationRequestSchema allows valid character_loop with 1 motion ref', () => {
  const parsed = VideoGenerationRequestSchema.parse({
    scene_id: 1,
    scene_version: 1,
    profile: 'character_loop',
    keyframe_asset_id: 10,
    character_reference_asset_ids: [101],
    motion_reference_asset_id: 201,
    preset: 'preview_480p_5s'
  });
  assert.equal(parsed.profile, 'character_loop');
  assert.equal(parsed.motion_reference_asset_id, 201);
});

test('VideoGenerationRequestSchema rejects more than 3 character references', () => {
  assert.throws(() => {
    VideoGenerationRequestSchema.parse({
      scene_id: 1,
      scene_version: 1,
      profile: 'narrative_clip',
      keyframe_asset_id: 10,
      character_reference_asset_ids: [101, 102, 103, 104]
    });
  });
});

test('MediaAssetSchema parses valid media asset row', () => {
  const asset = MediaAssetSchema.parse({
    project_id: 1,
    scene_id: 2,
    scene_version: 1,
    media_type: 'video',
    role: 'loop_master',
    profile: 'character_loop',
    url: '/static/generated/videos/1/2/100/final.mp4',
    width: 864,
    height: 480,
    fps: 24,
    frame_count: 120,
    duration_ms: 5000,
    sha256: 'abcdef1234567890'
  });
  assert.equal(asset.role, 'loop_master');
  assert.equal(asset.status, 'ready');
});
