import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../server';
import { db } from '../db/database';
import { MediaAssetService } from '../services/video/media_asset_service';
import { getGeneratedDirectory } from '../core/paths';

const multipartUpload = async (
  filename: string,
  content: Buffer | string,
  type: string,
  fields: Record<string, string> = {}
) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, v);
  }
  const blob = new Blob([content], { type });
  form.append('file', blob, filename);
  const request = new Request('http://localhost', { method: 'POST', body: form });
  return {
    headers: Object.fromEntries(request.headers.entries()),
    payload: Buffer.from(await request.arrayBuffer())
  };
};

test('Comprehensive /api/videos route verification', async () => {
  const previousVideoFlag = process.env.NOVASTORY_ENABLE_VIDEO;
  delete process.env.NOVASTORY_ENABLE_VIDEO;
  delete process.env.ENABLE_VIDEO_GENERATION;

  const app = await buildApp({ logger: false });

  // Cleanup any leftover test rows from previous run
  await db.run('DELETE FROM scene WHERE id IN (9991, 9992)');
  await db.run('DELETE FROM chapter WHERE id = "chap_vid_1"');
  await db.run('DELETE FROM project WHERE id = 999');

  // Seed minimal test project and scenes
  await db.run(`INSERT INTO project (id, title) VALUES (999, 'Video Test Project')`);
  await db.run(`INSERT INTO chapter (id, project_id, "index", title) VALUES ('chap_vid_1', 999, 1, 'Chap 1')`);
  await db.run(`INSERT INTO scene (id, chapter_id, "index", visual_prompt, asset_url) VALUES (9991, 'chap_vid_1', 1, 'Ice sword cold aura', '/static/generated/scene_fallback.png')`);
  await db.run(`INSERT INTO scene (id, chapter_id, "index", visual_prompt) VALUES (9992, 'chap_vid_1', 2, 'Fire warrior battle')`);

  const genDir = getGeneratedDirectory();
  const kfPath = path.join(genDir, 'test_kf.png');
  const lastKfPath = path.join(genDir, 'test_last_kf.png');
  const charPath = path.join(genDir, 'test_char.png');
  const motionPath = path.join(genDir, 'test_motion.mp4');
  const loopMasterPath = path.join(genDir, 'test_loop_master.mp4');
  const narrativeFinalPath = path.join(genDir, 'test_narrative_final.mp4');
  const fallbackScenePath = path.join(genDir, 'scene_fallback.png');

  fs.writeFileSync(kfPath, Buffer.from('mock_kf_data'));
  fs.writeFileSync(lastKfPath, Buffer.from('mock_last_kf_data'));
  fs.writeFileSync(charPath, Buffer.from('mock_char_data'));
  fs.writeFileSync(motionPath, Buffer.from('mock_motion_data'));
  fs.writeFileSync(loopMasterPath, Buffer.from('mock_loop_master_data'));
  fs.writeFileSync(narrativeFinalPath, Buffer.from('mock_narrative_final_data'));
  fs.writeFileSync(fallbackScenePath, Buffer.from('mock_scene_fallback_data'));

  // Gate G0 is a hard preflight blocker while the feature is disabled.
  const gatedPreflightRes = await app.inject({
    method: 'POST',
    url: '/api/videos/preflight',
    payload: {
      scene_id: 9991,
      profile: 'narrative_clip'
    }
  });
  assert.equal(gatedPreflightRes.statusCode, 200);
  const gatedPreflight = JSON.parse(gatedPreflightRes.body);
  assert.equal(gatedPreflight.ready, false);
  assert.ok(gatedPreflight.blockers.some((b: string) => b.includes('Gate G0')));

  // Enable the feature for the remainder of this route contract test. Runtime
  // Comfy/ffmpeg readiness is covered by /capabilities and dedicated integration tests.
  process.env.NOVASTORY_ENABLE_VIDEO = 'true';

  // 1. GET /api/videos/capabilities
  const capRes = await app.inject({
    method: 'GET',
    url: '/api/videos/capabilities'
  });
  assert.equal(capRes.statusCode, 200);
  const caps = JSON.parse(capRes.body);
  assert.equal(typeof caps.video_generation_enabled, 'boolean');
  assert.ok(Array.isArray(caps.supported_presets));
  assert.ok(Array.isArray(caps.supported_profiles));
  assert.ok(Array.isArray(caps.missing_components));

  // 2. POST /api/videos/references/upload
  // 2a. Valid image upload as character_reference
  const validImgUpload = await multipartUpload('hero_ref.png', 'mock_hero_png', 'image/png', {
    project_id: '999',
    scene_id: '9991',
    role: 'character_reference'
  });
  const upImgRes = await app.inject({
    method: 'POST',
    url: '/api/videos/references/upload',
    headers: validImgUpload.headers,
    payload: validImgUpload.payload
  });
  assert.equal(upImgRes.statusCode, 200);
  const uploadedCharAsset = JSON.parse(upImgRes.body);
  assert.equal(uploadedCharAsset.role, 'character_reference');
  assert.equal(uploadedCharAsset.media_type, 'image');
  assert.equal(uploadedCharAsset.status, 'ready');

  // 2b. Reject illegal upload role (e.g. raw_video / loop_master)
  const illegalRoleUpload = await multipartUpload('illegal.mp4', 'data', 'video/mp4', {
    project_id: '999',
    role: 'loop_master'
  });
  const illegalRes = await app.inject({
    method: 'POST',
    url: '/api/videos/references/upload',
    headers: illegalRoleUpload.headers,
    payload: illegalRoleUpload.payload
  });
  assert.equal(illegalRes.statusCode, 400);
  assert.ok(JSON.parse(illegalRes.body).error.includes('Direct upload not allowed'));

  // 2c. Reject a role/media mismatch before writing it as an asset.
  const badMotionUpload = await multipartUpload('motion.png', 'not-video', 'image/png', {
    project_id: '999',
    role: 'motion_reference'
  });
  const badMotionRes = await app.inject({
    method: 'POST',
    url: '/api/videos/references/upload',
    headers: badMotionUpload.headers,
    payload: badMotionUpload.payload
  });
  assert.equal(badMotionRes.statusCode, 400);
  assert.ok(JSON.parse(badMotionRes.body).error.includes("requires media_type 'video'"));

  // 2d. Reject upload when no file is provided
  const noFileRes = await app.inject({
    method: 'POST',
    url: '/api/videos/references/upload',
    headers: { 'content-type': 'application/json' },
    payload: {}
  });
  assert.equal(noFileRes.statusCode, 400);

  // 3. POST /api/videos/assets/register
  // 3a. Valid asset registration
  const registerRes = await app.inject({
    method: 'POST',
    url: '/api/videos/assets/register',
    payload: {
      project_id: 999,
      scene_id: 9991,
      media_type: 'image',
      role: 'video_keyframe',
      url: '/static/generated/test_kf.png'
    }
  });
  assert.equal(registerRes.statusCode, 200);
  const kfAsset = JSON.parse(registerRes.body);
  assert.equal(kfAsset.role, 'video_keyframe');

  const lastFrameAsset = await MediaAssetService.createAsset({
    project_id: 999,
    scene_id: 9991,
    scene_version: 1,
    media_type: 'image',
    role: 'video_keyframe',
    status: 'ready',
    url: '/static/generated/test_last_kf.png'
  });

  // 3b. Missing required fields in asset registration
  const badRegisterRes = await app.inject({
    method: 'POST',
    url: '/api/videos/assets/register',
    payload: {
      project_id: 999
    }
  });
  assert.equal(badRegisterRes.statusCode, 400);

  // Register motion reference and loop_master assets for subsequent tests
  const motionAsset = await MediaAssetService.createAsset({
    project_id: 999,
    media_type: 'video',
    role: 'motion_reference',
    status: 'ready',
    url: '/static/generated/test_motion.mp4'
  });

  const loopMasterAsset = await MediaAssetService.createAsset({
    project_id: 999,
    scene_id: 9991,
    media_type: 'video',
    role: 'loop_master',
    status: 'draft',
    url: '/static/generated/test_loop_master.mp4'
  });

  const narrativeFinalAsset = await MediaAssetService.createAsset({
    project_id: 999,
    scene_id: 9991,
    media_type: 'video',
    role: 'narrative_final',
    status: 'draft',
    url: '/static/generated/test_narrative_final.mp4'
  });

  // 4. POST /api/videos/preflight
  // 4a. Valid character_loop preflight with an explicit last frame
  const preflightLoopRes = await app.inject({
    method: 'POST',
    url: '/api/videos/preflight',
    payload: {
      scene_id: 9991,
      scene_version: 1,
      profile: 'character_loop',
      keyframe_asset_id: kfAsset.id,
      last_frame_asset_id: lastFrameAsset.id,
      character_reference_asset_ids: [uploadedCharAsset.id],
      motion_reference_asset_id: motionAsset.id,
      preset: 'preview_480p_5s'
    }
  });
  assert.equal(preflightLoopRes.statusCode, 200);
  const preflightLoop = JSON.parse(preflightLoopRes.body);
  assert.equal(preflightLoop.ready, true);
  assert.equal(preflightLoop.blockers.length, 0);
  assert.equal(preflightLoop.compiled_spec.output_contract.frames, 124);
  assert.ok(preflightLoop.compiled_spec.positive_prompt.includes('<Picture 1>'));
  assert.ok(preflightLoop.compiled_spec.positive_prompt.includes('<Video 1>'));
  assert.ok(preflightLoop.compiled_spec.positive_prompt.includes('Locked camera'));

  // 4b. Valid narrative_clip preflight without character or motion refs
  const preflightNarrativeRes = await app.inject({
    method: 'POST',
    url: '/api/videos/preflight',
    payload: {
      scene_id: 9991,
      scene_version: 1,
      profile: 'narrative_clip',
      keyframe_asset_id: kfAsset.id,
      preset: 'preview_480p_5s'
    }
  });
  assert.equal(preflightNarrativeRes.statusCode, 200);
  const preflightNarrative = JSON.parse(preflightNarrativeRes.body);
  assert.equal(preflightNarrative.ready, true);
  assert.equal(preflightNarrative.blockers.length, 0);

  // 4c. Incomplete character_loop (missing motion reference) -> returns 200 with ready: false
  const preflightMissingMotionRes = await app.inject({
    method: 'POST',
    url: '/api/videos/preflight',
    payload: {
      scene_id: 9991,
      profile: 'character_loop',
      keyframe_asset_id: kfAsset.id,
      character_reference_asset_ids: [uploadedCharAsset.id]
    }
  });
  assert.equal(preflightMissingMotionRes.statusCode, 200);
  const missingMotionData = JSON.parse(preflightMissingMotionRes.body);
  assert.equal(missingMotionData.ready, false);
  assert.ok(missingMotionData.blockers.some((b: string) => b.includes('motion_reference_asset_id')));

  // 4d. Preflight auto-fallback to scene.asset_url when keyframe_asset_id is 0
  const preflightFallbackRes = await app.inject({
    method: 'POST',
    url: '/api/videos/preflight',
    payload: {
      scene_id: 9991,
      profile: 'narrative_clip'
    }
  });
  assert.equal(preflightFallbackRes.statusCode, 200);
  const fallbackData = JSON.parse(preflightFallbackRes.body);
  assert.equal(fallbackData.ready, true);

  // 4e. Preflight for non-existent scene ID -> returns ready: false
  const preflightNonExistentScene = await app.inject({
    method: 'POST',
    url: '/api/videos/preflight',
    payload: {
      scene_id: 88888,
      profile: 'narrative_clip'
    }
  });
  assert.equal(preflightNonExistentScene.statusCode, 200);
  assert.equal(JSON.parse(preflightNonExistentScene.body).ready, false);
  assert.ok(JSON.parse(preflightNonExistentScene.body).blockers.some((b: string) => b.includes('88888')));

  // 4f. Malformed preflight request (e.g. invalid scene_id type) -> returns 400
  const badPreflightRes = await app.inject({
    method: 'POST',
    url: '/api/videos/preflight',
    payload: {
      scene_id: -1
    }
  });
  assert.equal(badPreflightRes.statusCode, 400);

  // 5. POST /api/videos/generate
  // 5a. Successful generation task creation preserves explicit last-frame request
  const genRes = await app.inject({
    method: 'POST',
    url: '/api/videos/generate',
    payload: {
      scene_id: 9991,
      scene_version: 1,
      profile: 'character_loop',
      keyframe_asset_id: kfAsset.id,
      last_frame_asset_id: lastFrameAsset.id,
      character_reference_asset_ids: [uploadedCharAsset.id],
      motion_reference_asset_id: motionAsset.id,
      preset: 'preview_480p_5s'
    }
  });
  assert.equal(genRes.statusCode, 202);
  const genData = JSON.parse(genRes.body);
  assert.ok(genData.task_id);
  assert.equal(typeof genData.queue_position, 'number');

  const persistedTask = await db.get('SELECT request_json FROM generation_task WHERE task_id = ?', genData.task_id);
  assert.equal(JSON.parse(persistedTask.request_json).last_frame_asset_id, lastFrameAsset.id);

  // 5b. Reject generation for non-existent scene
  const badGenRes = await app.inject({
    method: 'POST',
    url: '/api/videos/generate',
    payload: {
      scene_id: 77777,
      profile: 'narrative_clip',
      keyframe_asset_id: kfAsset.id
    }
  });
  assert.equal(badGenRes.statusCode, 400);

  // 6. GET /api/videos/tasks/:task_id
  // 6a. Existing task lookup
  const taskRes = await app.inject({
    method: 'GET',
    url: `/api/videos/tasks/${genData.task_id}`
  });
  assert.equal(taskRes.statusCode, 200);
  const taskData = JSON.parse(taskRes.body);
  assert.equal(taskData.task_id, genData.task_id);
  assert.equal(taskData.scene_id, 9991);

  // 6b. Non-existent task lookup -> returns 404
  const notFoundTaskRes = await app.inject({
    method: 'GET',
    url: '/api/videos/tasks/non_existent_task_12345'
  });
  assert.equal(notFoundTaskRes.statusCode, 404);

  // 7. POST /api/videos/tasks/:task_id/cancel
  // 7a. Cancel existing task
  const cancelRes = await app.inject({
    method: 'POST',
    url: `/api/videos/tasks/${genData.task_id}/cancel`
  });
  assert.equal(cancelRes.statusCode, 200);
  assert.equal(JSON.parse(cancelRes.body).ok, true);

  // 7b. Cancel non-existent task
  const cancelMissingRes = await app.inject({
    method: 'POST',
    url: '/api/videos/tasks/fake_task_9999/cancel'
  });
  assert.equal(cancelMissingRes.statusCode, 200);
  assert.equal(JSON.parse(cancelMissingRes.body).ok, false);

  // 8. GET /api/scenes/:scene_id/media
  // 8a. List all assets for scene 9991
  const mediaRes = await app.inject({
    method: 'GET',
    url: '/api/scenes/9991/media'
  });
  assert.equal(mediaRes.statusCode, 200);
  const mediaData = JSON.parse(mediaRes.body);
  assert.equal(mediaData.scene_id, 9991);
  assert.ok(mediaData.assets.length >= 3);
  assert.ok(mediaData.assets.some((a: any) => a.role === 'video_keyframe'));
  assert.ok(mediaData.assets.some((a: any) => a.role === 'loop_master'));
  assert.ok(mediaData.assets.some((a: any) => a.role === 'narrative_final'));

  // 8b. Filter by version
  const mediaVersionRes = await app.inject({
    method: 'GET',
    url: '/api/scenes/9991/media?version=1'
  });
  assert.equal(mediaVersionRes.statusCode, 200);

  // 9. POST /api/videos/assets/:asset_id/promote
  // 9a. Promote loop_master -> succeeds
  const promoteLoopRes = await app.inject({
    method: 'POST',
    url: `/api/videos/assets/${loopMasterAsset.id}/promote`
  });
  assert.equal(promoteLoopRes.statusCode, 200);
  assert.equal(JSON.parse(promoteLoopRes.body).id, loopMasterAsset.id);
  assert.equal(JSON.parse(promoteLoopRes.body).status, 'ready');

  // 9b. Promote narrative_final -> succeeds
  const promoteNarrativeRes = await app.inject({
    method: 'POST',
    url: `/api/videos/assets/${narrativeFinalAsset.id}/promote`
  });
  assert.equal(promoteNarrativeRes.statusCode, 200);
  assert.equal(JSON.parse(promoteNarrativeRes.body).id, narrativeFinalAsset.id);

  // 9c. Reject promoting motion_reference or character_reference -> 400
  const rejectMotionPromote = await app.inject({
    method: 'POST',
    url: `/api/videos/assets/${motionAsset.id}/promote`
  });
  assert.equal(rejectMotionPromote.statusCode, 400);

  // 9d. Reject promoting non-existent asset ID -> 400
  const rejectNonExistentPromote = await app.inject({
    method: 'POST',
    url: '/api/videos/assets/9999999/promote'
  });
  assert.equal(rejectNonExistentPromote.statusCode, 400);

  // 10. POST /api/videos/assets/:asset_id/reprocess
  // 10a. Reject reprocessing non-existent asset ID -> 400
  const reprocessMissingRes = await app.inject({
    method: 'POST',
    url: '/api/videos/assets/9999999/reprocess',
    payload: { run_loop_closer: true }
  });
  assert.equal(reprocessMissingRes.statusCode, 400);

  // 10b. Reject reprocessing non-raw_video asset -> 400
  const reprocessNonRawRes = await app.inject({
    method: 'POST',
    url: `/api/videos/assets/${kfAsset.id}/reprocess`,
    payload: { run_loop_closer: true }
  });
  assert.equal(reprocessNonRawRes.statusCode, 400);

  // Cleanup test rows and files
  try { fs.unlinkSync(kfPath); } catch {}
  try { fs.unlinkSync(lastKfPath); } catch {}
  try { fs.unlinkSync(charPath); } catch {}
  try { fs.unlinkSync(motionPath); } catch {}
  try { fs.unlinkSync(loopMasterPath); } catch {}
  try { fs.unlinkSync(narrativeFinalPath); } catch {}
  try { fs.unlinkSync(fallbackScenePath); } catch {}
  await db.run('DELETE FROM scene WHERE id IN (9991, 9992)');
  await db.run('DELETE FROM chapter WHERE id = "chap_vid_1"');
  await db.run('DELETE FROM project WHERE id = 999');
  await app.close();

  if (previousVideoFlag == null) delete process.env.NOVASTORY_ENABLE_VIDEO;
  else process.env.NOVASTORY_ENABLE_VIDEO = previousVideoFlag;
});
