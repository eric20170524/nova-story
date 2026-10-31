import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../../db/database';
import { MediaAssetService } from './media_asset_service';
import { VideoGenerationService } from './video_generation_service';
import { ScriptService } from '../script_service';
import type { VideoGenerationRequest } from '../../schemas/video';
import { recordShotMasterSnapshot } from './shot_master_snapshot';
import { getGeneratedDirectory } from '../../core/paths';

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
      const currentScript = await VideoGenerationService.preflight({ ...request });
      assert.ok(!currentScript.blockers.some(item => item.includes('Screenplay source')));
      assert.ok(currentScript.blockers.some(item => item.startsWith('Continuity gate:')));
      assert.equal(currentScript.compiled_spec, undefined);
      await db.run('UPDATE scene SET continuity_status=?, shot_spec=? WHERE id=?', 'stale', JSON.stringify({ source: { ...source, continuity: { reference: { snapshot_id: 'old' } } }, continuity_states: [{ entity: 'Hero', attribute: 'holding', value: 'cup' }] }), sceneId);
      const stale = await VideoGenerationService.preflight({ ...request });
      assert.ok(stale.blockers.some(item => item.startsWith('Continuity gate:')));
      assert.equal(stale.compiled_spec, undefined);
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

test('DT-AC08: last_frame_reference candidate adoption writes snapshot and preflight enforces dual-frame character version check', async () => {
  const projectId = 9934;
  const chapterId = 'dt_ac08_last_frame_chapter';
  const sceneId = 99341;
  const characterId = 99342;
  try {
    await db.run('INSERT INTO project (id, title) VALUES (?, ?)', projectId, 'DT-AC08 Test');
    await db.run('INSERT INTO chapter (id, project_id, "index", title) VALUES (?, ?, 1, ?)', chapterId, projectId, 'Chapter');
    await db.run('INSERT INTO scene (id, chapter_id, "index", visual_prompt, shot_spec) VALUES (?, ?, 1, ?, ?)', sceneId, chapterId, 'transition shot', JSON.stringify({ primary_subject: 'Hero' }));
    await db.run('INSERT INTO character (id, project_id, name, active_version) VALUES (?, ?, ?, 1)', characterId, projectId, 'Hero');

    const keyframe = await MediaAssetService.createAsset({
      project_id: projectId, scene_id: sceneId, scene_version: 1,
      media_type: 'image', role: 'video_keyframe', status: 'ready', url: '/static/dt08-first.png',
    });
    await recordShotMasterSnapshot({ sceneId, projectId, imageUrl: keyframe.url, characterIds: [characterId] });

    const lastCandidate = await MediaAssetService.createAsset({
      project_id: projectId, scene_id: sceneId, scene_version: 1,
      media_type: 'image', role: 'last_frame_reference', status: 'draft', url: '/static/dt08-last.png',
    });
    const identity = await MediaAssetService.createAsset({
      project_id: projectId, character_id: characterId,
      media_type: 'image', role: 'character_reference', status: 'ready', url: '/static/dt08-hero.png',
    });

    const request: VideoGenerationRequest = {
      scene_id: sceneId, scene_version: 1, profile: 'narrative_clip',
      workflow_id: 'minimax_h3_multiframe_official_12gb',
      keyframe_asset_id: keyframe.id!,
      last_frame_asset_id: lastCandidate.id!,
      character_reference_asset_ids: [identity.id!],
      preset: 'standard_720p_5s', run_loop_closer: false,
    };

    // Unadopted draft last_frame_reference is blocked
    const beforeAdopt = await VideoGenerationService.preflight(request);
    assert.ok(beforeAdopt.blockers.some(item => item.includes('not ready') || item.includes('Last-frame Shot Master')));

    // Adopt candidate -> writes scene_asset_image_snapshot and promotes status to ready
    const adopted = await MediaAssetService.adoptLastFrameCandidate(lastCandidate.id!, { characterIds: [characterId] });
    assert.equal(adopted.status, 'ready');
    const afterAdopt = await VideoGenerationService.preflight(request);
    assert.ok(!afterAdopt.blockers.some(item => item.includes('Last-frame')));

    // Bump character version -> re-snapshot only first frame -> last frame still blocked!
    await db.run('UPDATE character SET active_version = 2 WHERE id = ?', characterId);
    await recordShotMasterSnapshot({ sceneId, projectId, imageUrl: keyframe.url, characterIds: [characterId] });
    const driftedLast = await VideoGenerationService.preflight(request);
    assert.ok(driftedLast.blockers.some(item => item.includes('version changed after Last-frame Shot Master')));

    // Restore character version snapshot, then test non-16:9 last_frame_reference blocker
    await recordShotMasterSnapshot({ sceneId, projectId, imageUrl: adopted.url, characterIds: [characterId] });
    await db.run('UPDATE media_asset SET width = 1024, height = 1024 WHERE id = ?', adopted.id);
    const badAspectLast = await VideoGenerationService.preflight(request);
    assert.ok(badAspectLast.blockers.some(item => item.includes('Last-frame asset must be 16:9')));
    await db.run('UPDATE media_asset SET width = 1280, height = 720 WHERE id = ?', adopted.id);

    // 8s scene duration allows setGuideFrameIdx(150) even when preset is omitted
    await db.run('UPDATE scene SET duration = 8 WHERE id = ?', sceneId);
    const guide8s = await MediaAssetService.createAsset({
      project_id: projectId, scene_id: sceneId, scene_version: 1,
      media_type: 'image', role: 'guide_frame_reference', status: 'ready', url: '/static/dt08-guide.png',
    });
    const updatedGuide = await MediaAssetService.setGuideFrameIdx(guide8s.id!, 150);
    assert.equal(JSON.parse(updatedGuide.metadata_json || '{}').guide_frame_idx, 150);
  } finally {
    await db.run('DELETE FROM scene_asset_image_snapshot WHERE scene_id = ?', sceneId);
    await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
    await db.run('DELETE FROM scene WHERE id = ?', sceneId);
    await db.run('DELETE FROM character WHERE id = ?', characterId);
    await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
    await db.run('DELETE FROM project WHERE id = ?', projectId);
  }
});

test('DT-AC10: relayKeyframeFromPreviousShot extracts delivery_frames - 1, writes snapshot, and enforces relay_depth <= 2', async () => {
  const projectId = 9935;
  const chapterId = 'dt_ac10_relay_chapter';
  const scene1 = 99351;
  const scene2 = 99352;
  const scene3 = 99353;
  const scene4 = 99354;
  try {
    await db.run('INSERT INTO project (id, title) VALUES (?, ?)', projectId, 'DT-AC10 Relay Test');
    await db.run('INSERT INTO chapter (id, project_id, "index", title) VALUES (?, ?, 1, ?)', chapterId, projectId, 'Chapter');
    await db.run('INSERT INTO scene (id, chapter_id, "index", visual_prompt) VALUES (?, ?, 1, ?)', scene1, chapterId, 'shot 1');
    await db.run('INSERT INTO scene (id, chapter_id, "index", visual_prompt) VALUES (?, ?, 2, ?)', scene2, chapterId, 'shot 2');
    await db.run('INSERT INTO scene (id, chapter_id, "index", visual_prompt) VALUES (?, ?, 3, ?)', scene3, chapterId, 'shot 3');
    await db.run('INSERT INTO scene (id, chapter_id, "index", visual_prompt) VALUES (?, ?, 4, ?)', scene4, chapterId, 'shot 4');

    const videoDir = path.join(getGeneratedDirectory(), 'references', String(projectId));
    fs.mkdirSync(videoDir, { recursive: true });
    const dummyVideoPath = path.join(videoDir, 'shot1_8s.mp4');
    fs.writeFileSync(dummyVideoPath, 'dummy_video_bytes');

    const video1 = await MediaAssetService.createAsset({
      project_id: projectId, scene_id: scene1, scene_version: 1,
      media_type: 'video', role: 'narrative_final', status: 'ready',
      url: `/static/generated/references/${projectId}/shot1_8s.mp4`,
      frame_count: 191,
      metadata_json: JSON.stringify({ compiled_params: { delivery_frames: 192 } }),
    });

    await db.run(
      'INSERT INTO scene_version (scene_id, version, visual_prompt, asset_status) VALUES (?, 1, ?, ?)',
      scene2, 'shot 2', 'idle',
    );

    let extractedIdx = -1;
    const relay1 = await MediaAssetService.relayKeyframeFromPreviousShot(scene2, scene1, {
      extractFrameFn: async (_videoPath, targetPath, frameIndex) => {
        extractedIdx = frameIndex;
        fs.writeFileSync(targetPath, 'extracted_frame_191_png');
      },
    });
    assert.equal(extractedIdx, 191);
    assert.equal(relay1.parent_asset_id, video1.id);
    assert.equal(JSON.parse(relay1.metadata_json || '{}').relay_depth, 1);

    const s2Ver = await db.get('SELECT asset_url, asset_status FROM scene_version WHERE scene_id = ? AND version = 1', scene2);
    assert.equal(s2Ver?.asset_url, relay1.url);
    assert.equal(s2Ver?.asset_status, 'completed');

    const snapshot = await db.get('SELECT * FROM scene_asset_image_snapshot WHERE scene_id = ? AND image_url = ?', scene2, relay1.url);
    assert.ok(snapshot);

    // Relay 2 (depth = 2) from static last_frame_reference on scene 2 -> scene 3
    await MediaAssetService.createAsset({
      project_id: projectId, scene_id: scene2, scene_version: 1,
      media_type: 'image', role: 'last_frame_reference', status: 'ready',
      url: relay1.url,
      metadata_json: JSON.stringify({ relay_depth: 1 }),
    });
    const relay2 = await MediaAssetService.relayKeyframeFromPreviousShot(scene3, scene2);
    assert.equal(JSON.parse(relay2.metadata_json || '{}').relay_depth, 2);

    // Relay 3 (depth > 2) from scene 3 -> scene 4 is rejected
    await MediaAssetService.createAsset({
      project_id: projectId, scene_id: scene3, scene_version: 1,
      media_type: 'image', role: 'last_frame_reference', status: 'ready',
      url: relay2.url,
      metadata_json: JSON.stringify({ relay_depth: 2 }),
    });
    await assert.rejects(
      () => MediaAssetService.relayKeyframeFromPreviousShot(scene4, scene3),
      /Relay depth limit \(2\) exceeded/,
    );

    // Relay filters by sourceScene.active_version: switching scene3 to active_version = 2 ignores v1 assets
    await db.run('UPDATE scene SET active_version = 2 WHERE id = ?', scene3);
    await assert.rejects(
      () => MediaAssetService.relayKeyframeFromPreviousShot(scene4, scene3),
      /has no ready last_frame_reference or narrative_final video/,
    );
  } finally {
    await db.run('DELETE FROM scene_asset_image_snapshot WHERE scene_id IN (?, ?, ?, ?)', scene1, scene2, scene3, scene4);
    await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
    await db.run('DELETE FROM scene WHERE id IN (?, ?, ?, ?)', scene1, scene2, scene3, scene4);
    await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
    await db.run('DELETE FROM project WHERE id = ?', projectId);
  }
});
