import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../db/database';
import { MediaAssetService } from './media_asset_service';
import { VideoGenerationService } from './video_generation_service';
import { ScriptService } from '../script_service';
import type { VideoGenerationRequest } from '../../schemas/video';
import { recordShotMasterSnapshot } from './shot_master_snapshot';

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

test('video preflight blocks a Shot Master after its character version changes', async () => {
  const projectId = 9933;
  const chapterId = 'shot_master_version_chapter';
  const sceneId = 99331;
  const characterId = 99332;
  const supportingCharacterId = 99333;
  try {
    await db.run('INSERT INTO project (id, title) VALUES (?, ?)', projectId, 'Version test');
    await db.run('INSERT INTO chapter (id, project_id, "index", title) VALUES (?, ?, 1, ?)', chapterId, projectId, 'Chapter');
    await db.run('INSERT INTO scene (id, chapter_id, "index", visual_prompt) VALUES (?, ?, 1, ?)', sceneId, chapterId, 'character');
    await db.run('INSERT INTO character (id, project_id, name, active_version) VALUES (?, ?, ?, 1)', characterId, projectId, 'Hero');
    await db.run('INSERT INTO character (id, project_id, name, active_version) VALUES (?, ?, ?, 1)', supportingCharacterId, projectId, 'Friend');
    await db.run('UPDATE scene SET shot_spec = ? WHERE id = ?', JSON.stringify({ primary_subject: 'Hero' }), sceneId);
    const keyframe = await MediaAssetService.createAsset({
      project_id: projectId, scene_id: sceneId, scene_version: 1,
      media_type: 'image', role: 'video_keyframe', status: 'ready', url: '/static/shot-master-version.png',
    });
    const identity = await MediaAssetService.createAsset({
      project_id: projectId, character_id: characterId,
      media_type: 'image', role: 'character_reference', status: 'ready', url: '/static/hero-version.png',
    });
    await recordShotMasterSnapshot({ sceneId, projectId, imageUrl: keyframe.url, characterIds: [characterId] });
    const request: VideoGenerationRequest = {
      scene_id: sceneId, scene_version: 1, profile: 'narrative_clip',
      workflow_id: 'minimax_h3_ref2va_official_12gb', keyframe_asset_id: keyframe.id!,
      character_reference_asset_ids: [identity.id!], preset: 'standard_720p_5s', run_loop_closer: false,
    };
    const before = await VideoGenerationService.preflight(request);
    assert.ok(!before.blockers.some(item => item.includes('version changed')));
    await db.run('UPDATE scene SET shot_spec = ? WHERE id = ?', JSON.stringify({ primary_subject: 'Hero', visible_subjects: ['Friend'] }), sceneId);
    const newCast = await VideoGenerationService.preflight(request);
    assert.ok(newCast.blockers.some(item => item.includes(`Character ${supportingCharacterId} is absent`)));
    await recordShotMasterSnapshot({ sceneId, projectId, imageUrl: keyframe.url, characterIds: [characterId] });
    const castCaptured = await VideoGenerationService.preflight(request);
    assert.ok(!castCaptured.blockers.some(item => item.includes('absent from the Shot Master')));
    await db.run('UPDATE character SET active_version = 2 WHERE id = ?', supportingCharacterId);
    const supportingChanged = await VideoGenerationService.preflight(request);
    assert.ok(supportingChanged.blockers.some(item => item.includes(`Character ${supportingCharacterId} version changed`)));
    await db.run('UPDATE character SET active_version = 1 WHERE id = ?', supportingCharacterId);
    await db.run('UPDATE media_asset SET width = 1024, height = 1024 WHERE id = ?', keyframe.id);
    const square = await VideoGenerationService.preflight(request);
    assert.ok(square.blockers.some(item => item.includes('must be 16:9')));
    await db.run('UPDATE media_asset SET width = 1280, height = 720 WHERE id = ?', keyframe.id);
    await db.run('UPDATE character SET active_version = 2 WHERE id = ?', characterId);
    const after = await VideoGenerationService.preflight(request);
    assert.ok(after.blockers.some(item => item.includes('version changed after Shot Master')));
  } finally {
    await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
    await db.run('DELETE FROM scene WHERE id = ?', sceneId);
    await db.run('DELETE FROM character WHERE id IN (?, ?)', characterId, supportingCharacterId);
    await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
    await db.run('DELETE FROM project WHERE id = ?', projectId);
  }
});
