import '../../test_setup';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { db } from '../../db/database';
import { SettingsManager } from '../../core/settings_manager';
import { getStaticDirectory } from '../../core/paths';
import { GenerationService } from '../generation_service';
import { MediaService } from '../media_service';
import { MediaAssetService } from './media_asset_service';
import { VideoGenerationService } from './video_generation_service';
import type { VideoGenerationRequest } from '../../schemas/video';

test('Shot Master snapshot keeps the inputs used for the image when bindings change during generation', async () => {
  const projectId = 99441;
  const chapterId = 'shot_master_drift_chapter';
  const sceneId = 994411;
  const characterId = 994412;
  const previousVideoFlag = process.env.NOVASTORY_ENABLE_VIDEO;
  const originalLoad = SettingsManager.loadSettings;
  const originalProvider = MediaService.getProvider;
  let seenPrompt = '';
  process.env.NOVASTORY_ENABLE_VIDEO = 'true';
  SettingsManager.loadSettings = (() => ({
    image_provider: 'gemini',
    comfyui: { enabled: false },
    advanced: { nsfw_enabled: false },
    llm: {},
  })) as typeof SettingsManager.loadSettings;
  MediaService.getProvider = (() => ({
    generateImage: async (prompt: string) => {
      seenPrompt = prompt;
      await db.run('UPDATE scene_asset_reference SET asset_revision = 2 WHERE scene_id = ?', sceneId);
      await db.run("UPDATE library_asset SET revision = 2, visual_prompt = 'version two prop prompt' WHERE id = (SELECT asset_id FROM scene_asset_reference WHERE scene_id = ?)", sceneId);
      await db.run('UPDATE character SET active_version = 2 WHERE id = ?', characterId);
      return { data: await sharp({ create: { width: 32, height: 32, channels: 3, background: '#445566' } }).png().toBuffer() };
    },
  })) as typeof MediaService.getProvider;

  try {
    await db.run('INSERT INTO project (id, title) VALUES (?, ?)', projectId, 'Snapshot drift');
    await db.run('INSERT INTO chapter (id, project_id, "index", title) VALUES (?, ?, 1, ?)', chapterId, projectId, 'Chapter');
    await db.run(
      'INSERT INTO scene (id, chapter_id, "index", visual_prompt, shot_spec) VALUES (?, ?, 1, ?, ?)',
      sceneId, chapterId, 'hero in the old temple', JSON.stringify({ primary_subject: 'Hero' })
    );
    await db.run('INSERT INTO character (id, project_id, name, active_version) VALUES (?, ?, ?, 1)', characterId, projectId, 'Hero');
    const prop = await db.run(
      `INSERT INTO library_asset (project_id, kind, name, visual_prompt, image_url, status, revision)
       VALUES (?, 'prop', '铜铃', 'version one prop prompt', '/static/bell.png', 'completed', 1)`,
      projectId
    );
    const propId = Number(prop.lastID);
    await db.run('INSERT INTO scene_asset_reference (scene_id, asset_id, asset_revision) VALUES (?, ?, 1)', sceneId, propId);
    const identity = await MediaAssetService.createAsset({
      project_id: projectId, character_id: characterId, media_type: 'image',
      role: 'character_reference', status: 'ready', url: '/static/hero-snapshot.png',
    });

    await GenerationService.generateAssets('shot-master-drift-task', {
      gen_type: 'scene',
      shot_master_character_ids: [characterId],
    }, sceneId);

    assert.match(seenPrompt, /version one prop prompt/);
    assert.doesNotMatch(seenPrompt, /version two prop prompt/);
    const snapshot = await db.get(
      'SELECT references_json, character_versions_json FROM scene_asset_image_snapshot WHERE scene_id = ?',
      sceneId
    );
    assert.deepEqual(JSON.parse(snapshot.references_json), [{ id: propId, revision: 1 }]);
    assert.deepEqual(JSON.parse(snapshot.character_versions_json), [{ id: characterId, version: 1 }]);

    const scene = await db.get('SELECT asset_url, asset_status FROM scene WHERE id = ?', sceneId);
    assert.equal(scene.asset_status, 'completed');
    const request: VideoGenerationRequest = {
      scene_id: sceneId, scene_version: 1, profile: 'narrative_clip',
      workflow_id: 'minimax_h3_ref2va_official_12gb', keyframe_asset_id: 0,
      character_reference_asset_ids: [identity.id!], preset: 'standard_720p_5s', run_loop_closer: false,
    };
    const preflight = await VideoGenerationService.preflight(request);
    assert.equal(preflight.ready, false);
    assert.ok(preflight.blockers.some(item => item.includes('does not reflect')));
    assert.ok(preflight.blockers.some(item => item.includes(`Character ${characterId} version changed`)));
  } finally {
    SettingsManager.loadSettings = originalLoad;
    MediaService.getProvider = originalProvider;
    if (previousVideoFlag == null) delete process.env.NOVASTORY_ENABLE_VIDEO;
    else process.env.NOVASTORY_ENABLE_VIDEO = previousVideoFlag;
    await db.run('DELETE FROM generation_task WHERE task_id = ?', 'shot-master-drift-task');
    await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
    await db.run('DELETE FROM scene_asset_image_snapshot WHERE scene_id = ?', sceneId);
    await db.run('DELETE FROM scene_asset_reference WHERE scene_id = ?', sceneId);
    await db.run('DELETE FROM library_asset WHERE project_id = ?', projectId);
    await db.run('DELETE FROM scene WHERE id = ?', sceneId);
    await db.run('DELETE FROM character WHERE id = ?', characterId);
    await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
    await db.run('DELETE FROM project WHERE id = ?', projectId);
    fs.rmSync(path.join(getStaticDirectory(), 'generated', 'projects', String(projectId)), { recursive: true, force: true });
  }
});
