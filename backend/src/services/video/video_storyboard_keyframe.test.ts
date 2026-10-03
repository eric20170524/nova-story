import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../db/database';
import { MediaAssetService } from './media_asset_service';
import { VideoGenerationService } from './video_generation_service';
import { ScriptService } from '../script_service';
import type { VideoGenerationRequest } from '../../schemas/video';

test('video preflight associates the current scene storyboard without reusing another scene asset', async () => {
  const projectId = 9932;
  const chapterId = 'video_storyboard_keyframe_chapter';
  const sceneId = 99321;
  const otherSceneId = 99322;
  const storyboardUrl = '/static/generated/shared_storyboard.png';

  await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
  await db.run('DELETE FROM scene WHERE id IN (?, ?)', sceneId, otherSceneId);
  await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
  await db.run('DELETE FROM project WHERE id = ?', projectId);

  try {
    await db.run('INSERT INTO project (id, title) VALUES (?, ?)', projectId, 'Storyboard Keyframe Test');
    await db.run('INSERT INTO chapter (id, project_id, "index", title) VALUES (?, ?, 1, ?)', chapterId, projectId, 'Chapter');
    await db.run('INSERT INTO scene (id, chapter_id, "index", visual_prompt, asset_url) VALUES (?, ?, 1, ?, ?)', sceneId, chapterId, 'first', storyboardUrl);
    await db.run('INSERT INTO scene (id, chapter_id, "index", visual_prompt) VALUES (?, ?, 2, ?)', otherSceneId, chapterId, 'other');

    const otherAsset = await MediaAssetService.createAsset({
      project_id: projectId,
      scene_id: otherSceneId,
      media_type: 'image',
      role: 'video_keyframe',
      status: 'ready',
      url: storyboardUrl
    });
    const request: VideoGenerationRequest = {
      scene_id: sceneId,
      scene_version: 1,
      profile: 'narrative_clip',
      workflow_id: 'minimax_h3_hongchao_a2a_12gb',
      keyframe_asset_id: 0,
      character_reference_asset_ids: [],
      preset: 'preview_480p_5s',
      run_loop_closer: true
    };

    await VideoGenerationService.preflight(request);
    assert.ok(request.keyframe_asset_id);
    assert.notEqual(request.keyframe_asset_id, otherAsset.id);
    const associated = await MediaAssetService.getAssetById(request.keyframe_asset_id);
    assert.equal(associated?.scene_id, sceneId);
    assert.equal(associated?.url, storyboardUrl);
    assert.equal(associated?.role, 'video_keyframe');

    const repeatRequest = { ...request, keyframe_asset_id: 0 };
    await VideoGenerationService.preflight(repeatRequest);
    assert.equal(repeatRequest.keyframe_asset_id, request.keyframe_asset_id);

    const originalScript = ScriptService.getScriptById;
    const script: any = { id: 5, chapterId, revision: 2, status: 'confirmed', freshness: { sourceChanged: false }, document: { scenes: [{ id: 'sc-1', blocks: [{ id: 'b-1' }] }] } };
    const source = { type: 'script', script_id: 5, script_revision: 1, script_scene_id: 'sc-1', block_ids: ['b-1'] };
    try {
      ScriptService.getScriptById = async () => script;
      const updateSource = () => db.run('UPDATE scene SET shot_spec=? WHERE id=?', JSON.stringify({ source }), sceneId);
      await updateSource();
      assert.ok((await VideoGenerationService.preflight({ ...request })).blockers.some(item => item.includes('Screenplay source is stale')));
      source.script_revision = 2;
      await updateSource();
      assert.ok(!(await VideoGenerationService.preflight({ ...request })).blockers.some(item => item.includes('Screenplay source')));
      script.status = 'draft';
      assert.ok((await VideoGenerationService.preflight({ ...request })).blockers.some(item => item.includes('Screenplay source is stale')));
      script.status = 'confirmed';
      source.block_ids = ['removed-block'];
      await updateSource();
      assert.ok((await VideoGenerationService.preflight({ ...request })).blockers.some(item => item.includes('Screenplay source is stale')));
    } finally { ScriptService.getScriptById = originalScript; }
  } finally {
    await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
    await db.run('DELETE FROM scene WHERE id IN (?, ?)', sceneId, otherSceneId);
    await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
    await db.run('DELETE FROM project WHERE id = ?', projectId);
  }
});
