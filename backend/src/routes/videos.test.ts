import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../server';
import { db } from '../db/database';
import { MediaAssetService } from '../services/video/media_asset_service';
import { VideoRuntimeInspector } from '../services/video/video_runtime_inspector';
import { getGeneratedDirectory } from '../core/paths';

const multipartUpload = async (
  filename: string,
  content: Buffer | string,
  type: string,
  fields: Record<string, string> = {}
) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
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
  const originalInspect = VideoRuntimeInspector.inspect;
  delete process.env.NOVASTORY_ENABLE_VIDEO;
  delete process.env.ENABLE_VIDEO_GENERATION;

  const app = await buildApp({ logger: false });

  await db.run('DELETE FROM scene WHERE id IN (9991, 9992)');
  await db.run('DELETE FROM chapter WHERE id = "chap_vid_1"');
  await db.run('DELETE FROM project WHERE id = 999');

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

  // G0 remains a hard blocker even before the runtime is inspected.
  const gatedPreflightRes = await app.inject({
    method: 'POST',
    url: '/api/videos/preflight',
    payload: { scene_id: 9991, profile: 'narrative_clip' }
  });
  assert.equal(gatedPreflightRes.statusCode, 200);
  const gatedPreflight = JSON.parse(gatedPreflightRes.body);
  assert.equal(gatedPreflight.ready, false);
  assert.ok(gatedPreflight.blockers.some((b: string) => b.includes('Gate G0')));

  process.env.NOVASTORY_ENABLE_VIDEO = 'true';

  // Route contracts must not depend on a real GPU/Comfy service. Explicitly mock a
  // healthy runtime; separate inspector tests own offline/model-missing behavior.
  (VideoRuntimeInspector as any).inspect = async (workflowId: string = 'minimax_h3_hongchao_a2a_12gb') => ({
    workflow_id: workflowId,
    workflow_family: workflowId.includes('fl2va') ? 'fl2va' : workflowId.includes('ref2va_official') ? 'ref2va' : 'hybrid',
    workflow_stability: workflowId.includes('hongchao') ? 'experimental' : 'candidate',
    video_generation_enabled: true,
    ffmpeg_available: true,
    ffprobe_available: true,
    comfyui_online: true,
    h3_workflow_ready: true,
    gpu_available: true,
    gpu_name: 'Mock GPU',
    vram_free_bytes: 12 * 1024 ** 3,
    supported_presets: ['preview_480p_5s', 'standard_720p_5s'],
    supported_profiles: ['narrative_clip', 'character_loop'],
    missing_components: []
  });

  // 1. Capabilities now report the selected workflow runtime.
  const capRes = await app.inject({ method: 'GET', url: '/api/videos/capabilities' });
  assert.equal(capRes.statusCode, 200);
  const caps = JSON.parse(capRes.body);
  assert.equal(caps.video_generation_enabled, true);
  assert.equal(caps.workflow_id, 'minimax_h3_hongchao_a2a_12gb');

  // 2. Reference upload contract.
  const validImgUpload = await multipartUpload('hero_ref.png', 'mock_hero_png', 'image/png', {
    project_id: '999', scene_id: '9991', role: 'character_reference'
  });
  const upImgRes = await app.inject({
    method: 'POST', url: '/api/videos/references/upload',
    headers: validImgUpload.headers, payload: validImgUpload.payload
  });
  assert.equal(upImgRes.statusCode, 200);
  const uploadedCharAsset = JSON.parse(upImgRes.body);
  assert.equal(uploadedCharAsset.role, 'character_reference');
  assert.equal(uploadedCharAsset.media_type, 'image');

  const illegalRoleUpload = await multipartUpload('illegal.mp4', 'data', 'video/mp4', {
    project_id: '999', role: 'loop_master'
  });
  const illegalRes = await app.inject({
    method: 'POST', url: '/api/videos/references/upload',
    headers: illegalRoleUpload.headers, payload: illegalRoleUpload.payload
  });
  assert.equal(illegalRes.statusCode, 400);

  const badMotionUpload = await multipartUpload('motion.png', 'not-video', 'image/png', {
    project_id: '999', role: 'motion_reference'
  });
  const badMotionRes = await app.inject({
    method: 'POST', url: '/api/videos/references/upload',
    headers: badMotionUpload.headers, payload: badMotionUpload.payload
  });
  assert.equal(badMotionRes.statusCode, 400);
  assert.ok(JSON.parse(badMotionRes.body).error.includes("requires media_type 'video'"));

  const noFileRes = await app.inject({
    method: 'POST', url: '/api/videos/references/upload',
    headers: { 'content-type': 'application/json' }, payload: {}
  });
  assert.equal(noFileRes.statusCode, 400);

  // 3. Source asset registration.
  const registerRes = await app.inject({
    method: 'POST',
    url: '/api/videos/assets/register',
    payload: {
      project_id: 999, scene_id: 9991, media_type: 'image',
      role: 'video_keyframe', url: '/static/generated/test_kf.png'
    }
  });
  assert.equal(registerRes.statusCode, 200);
  const kfAsset = JSON.parse(registerRes.body);

  const lastFrameAsset = await MediaAssetService.createAsset({
    project_id: 999, scene_id: 9991, scene_version: 1,
    media_type: 'image', role: 'video_keyframe', status: 'ready',
    url: '/static/generated/test_last_kf.png'
  });

  const badRegisterRes = await app.inject({
    method: 'POST', url: '/api/videos/assets/register', payload: { project_id: 999 }
  });
  assert.equal(badRegisterRes.statusCode, 400);

  const motionAsset = await MediaAssetService.createAsset({
    project_id: 999, media_type: 'video', role: 'motion_reference', status: 'ready',
    url: '/static/generated/test_motion.mp4'
  });
  const loopMasterAsset = await MediaAssetService.createAsset({
    project_id: 999, scene_id: 9991, media_type: 'video', role: 'loop_master', status: 'draft',
    url: '/static/generated/test_loop_master.mp4'
  });
  const narrativeFinalAsset = await MediaAssetService.createAsset({
    project_id: 999, scene_id: 9991, media_type: 'video', role: 'narrative_final', status: 'draft',
    url: '/static/generated/test_narrative_final.mp4'
  });

  // 4. Input + runtime preflight.
  const preflightLoopRes = await app.inject({
    method: 'POST', url: '/api/videos/preflight',
    payload: {
      scene_id: 9991, scene_version: 1, profile: 'character_loop',
      keyframe_asset_id: kfAsset.id, last_frame_asset_id: lastFrameAsset.id,
      character_reference_asset_ids: [uploadedCharAsset.id],
      motion_reference_asset_id: motionAsset.id, preset: 'preview_480p_5s'
    }
  });
  assert.equal(preflightLoopRes.statusCode, 200);
  const preflightLoop = JSON.parse(preflightLoopRes.body);
  assert.equal(preflightLoop.ready, true);
  assert.equal(preflightLoop.blockers.length, 0);
  assert.equal(preflightLoop.compiled_spec.output_contract.frames, 124);
  assert.equal(preflightLoop.runtime.comfyui_online, true);
  assert.ok(preflightLoop.compiled_spec.positive_prompt.includes('<Video 1>'));

  const preflightNarrativeRes = await app.inject({
    method: 'POST', url: '/api/videos/preflight',
    payload: {
      scene_id: 9991, scene_version: 1, profile: 'narrative_clip',
      keyframe_asset_id: kfAsset.id, preset: 'preview_480p_5s'
    }
  });
  assert.equal(preflightNarrativeRes.statusCode, 200);
  assert.equal(JSON.parse(preflightNarrativeRes.body).ready, true);

  const preflightMissingMotionRes = await app.inject({
    method: 'POST', url: '/api/videos/preflight',
    payload: {
      scene_id: 9991, profile: 'character_loop', keyframe_asset_id: kfAsset.id,
      character_reference_asset_ids: [uploadedCharAsset.id]
    }
  });
  // Strategy validation now rejects the invalid request before service preflight.
  assert.equal(preflightMissingMotionRes.statusCode, 400);

  const preflightFallbackRes = await app.inject({
    method: 'POST', url: '/api/videos/preflight',
    payload: { scene_id: 9991, profile: 'narrative_clip' }
  });
  assert.equal(preflightFallbackRes.statusCode, 200);
  assert.equal(JSON.parse(preflightFallbackRes.body).ready, true);

  const preflightNonExistentScene = await app.inject({
    method: 'POST', url: '/api/videos/preflight',
    payload: { scene_id: 88888, profile: 'narrative_clip' }
  });
  assert.equal(preflightNonExistentScene.statusCode, 200);
  assert.equal(JSON.parse(preflightNonExistentScene.body).ready, false);

  const badPreflightRes = await app.inject({
    method: 'POST', url: '/api/videos/preflight', payload: { scene_id: -1 }
  });
  assert.equal(badPreflightRes.statusCode, 400);

  // Ref2VA explicitly rejects hard-last-frame semantics; FL2VA accepts them.
  const badRef2vaBoundary = await app.inject({
    method: 'POST', url: '/api/videos/preflight',
    payload: {
      scene_id: 9991, profile: 'narrative_clip',
      workflow_id: 'minimax_h3_ref2va_official_12gb',
      keyframe_asset_id: kfAsset.id, last_frame_asset_id: lastFrameAsset.id
    }
  });
  assert.equal(badRef2vaBoundary.statusCode, 400);

  const fl2vaBoundary = await app.inject({
    method: 'POST', url: '/api/videos/preflight',
    payload: {
      scene_id: 9991, profile: 'character_loop',
      workflow_id: 'minimax_h3_fl2va_official_12gb',
      keyframe_asset_id: kfAsset.id, last_frame_asset_id: lastFrameAsset.id,
      character_reference_asset_ids: []
    }
  });
  assert.equal(fl2vaBoundary.statusCode, 200);
  assert.equal(JSON.parse(fl2vaBoundary.body).ready, true);

  // 5. Generate is allowed only after the runtime gate is explicitly ready.
  const genRes = await app.inject({
    method: 'POST', url: '/api/videos/generate',
    payload: {
      scene_id: 9991, scene_version: 1, profile: 'character_loop',
      keyframe_asset_id: kfAsset.id, last_frame_asset_id: lastFrameAsset.id,
      character_reference_asset_ids: [uploadedCharAsset.id],
      motion_reference_asset_id: motionAsset.id, preset: 'preview_480p_5s'
    }
  });
  assert.equal(genRes.statusCode, 202);
  const genData = JSON.parse(genRes.body);
  assert.ok(genData.task_id);

  const persistedTask = await db.get('SELECT request_json FROM generation_task WHERE task_id = ?', genData.task_id);
  assert.equal(JSON.parse(persistedTask.request_json).last_frame_asset_id, lastFrameAsset.id);

  const badGenRes = await app.inject({
    method: 'POST', url: '/api/videos/generate',
    payload: { scene_id: 77777, profile: 'narrative_clip', keyframe_asset_id: kfAsset.id }
  });
  assert.equal(badGenRes.statusCode, 400);

  // 6. Task lookup / cancel.
  const taskRes = await app.inject({ method: 'GET', url: `/api/videos/tasks/${genData.task_id}` });
  assert.equal(taskRes.statusCode, 200);
  assert.equal(JSON.parse(taskRes.body).task_id, genData.task_id);

  const notFoundTaskRes = await app.inject({ method: 'GET', url: '/api/videos/tasks/non_existent_task_12345' });
  assert.equal(notFoundTaskRes.statusCode, 404);

  const cancelRes = await app.inject({ method: 'POST', url: `/api/videos/tasks/${genData.task_id}/cancel` });
  assert.equal(cancelRes.statusCode, 200);
  assert.equal(JSON.parse(cancelRes.body).ok, true);

  const cancelMissingRes = await app.inject({ method: 'POST', url: '/api/videos/tasks/fake_task_9999/cancel' });
  assert.equal(cancelMissingRes.statusCode, 200);
  assert.equal(JSON.parse(cancelMissingRes.body).ok, false);

  // 7. Scene media and promotion.
  const mediaRes = await app.inject({ method: 'GET', url: '/api/videos/scenes/9991/media' });
  assert.equal(mediaRes.statusCode, 200);
  const mediaData = JSON.parse(mediaRes.body);
  assert.ok(mediaData.assets.some((a: any) => a.role === 'video_keyframe'));
  assert.ok(mediaData.assets.some((a: any) => a.role === 'loop_master'));

  const mediaVersionRes = await app.inject({ method: 'GET', url: '/api/videos/scenes/9991/media?version=1' });
  assert.equal(mediaVersionRes.statusCode, 200);

  const promoteLoopRes = await app.inject({ method: 'POST', url: `/api/videos/assets/${loopMasterAsset.id}/promote` });
  assert.equal(promoteLoopRes.statusCode, 200);
  assert.equal(JSON.parse(promoteLoopRes.body).status, 'ready');

  const promoteNarrativeRes = await app.inject({ method: 'POST', url: `/api/videos/assets/${narrativeFinalAsset.id}/promote` });
  assert.equal(promoteNarrativeRes.statusCode, 200);

  const rejectMotionPromote = await app.inject({ method: 'POST', url: `/api/videos/assets/${motionAsset.id}/promote` });
  assert.equal(rejectMotionPromote.statusCode, 400);

  // 8. Reprocess rejects missing/non-video source assets. Valid immutable reprocess
  // is covered by MediaAssetService/LoopCloser tests with actual ffmpeg fixtures.
  const reprocessMissingRes = await app.inject({
    method: 'POST', url: '/api/videos/assets/9999999/reprocess', payload: { run_loop_closer: true }
  });
  assert.equal(reprocessMissingRes.statusCode, 400);

  const reprocessNonRawRes = await app.inject({
    method: 'POST', url: `/api/videos/assets/${kfAsset.id}/reprocess`, payload: { run_loop_closer: true }
  });
  assert.equal(reprocessNonRawRes.statusCode, 400);

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

  (VideoRuntimeInspector as any).inspect = originalInspect;
  if (previousVideoFlag == null) delete process.env.NOVASTORY_ENABLE_VIDEO;
  else process.env.NOVASTORY_ENABLE_VIDEO = previousVideoFlag;
});
