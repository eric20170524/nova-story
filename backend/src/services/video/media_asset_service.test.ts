import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../db/database';
import { MediaAssetService } from './media_asset_service';

test('MediaAssetService resolves a final derivative back to its raw parent', async () => {
  const projectId = 9911;
  const chapterId = 'video_asset_lineage_chapter';
  const sceneId = 99111;

  await db.run('DELETE FROM scene WHERE id = ?', sceneId);
  await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
  await db.run('DELETE FROM project WHERE id = ?', projectId);

  await db.run('INSERT INTO project (id, title) VALUES (?, ?)', projectId, 'Video Lineage Test');
  await db.run('INSERT INTO chapter (id, project_id, "index", title) VALUES (?, ?, 1, ?)', chapterId, projectId, 'Chapter');
  await db.run('INSERT INTO scene (id, chapter_id, "index", visual_prompt) VALUES (?, ?, 1, ?)', sceneId, chapterId, 'test');

  const raw = await MediaAssetService.createAsset({
    project_id: projectId,
    scene_id: sceneId,
    scene_version: 1,
    media_type: 'video',
    role: 'raw_video',
    profile: 'character_loop',
    status: 'ready',
    url: `/static/generated/videos/${projectId}/${sceneId}/raw.mp4`
  });
  const final = await MediaAssetService.createAsset({
    project_id: projectId,
    scene_id: sceneId,
    scene_version: 1,
    parent_asset_id: raw.id,
    media_type: 'video',
    role: 'loop_master',
    profile: 'character_loop',
    status: 'draft',
    url: `/static/generated/videos/${projectId}/${sceneId}/final.mp4`
  });

  const resolved = await MediaAssetService.resolveRawVideoForReprocess(final.id!);
  assert.equal(resolved.id, raw.id);
  assert.equal(resolved.role, 'raw_video');

  await db.run('DELETE FROM project WHERE id = ?', projectId);
});

test('MediaAssetService refuses to promote rejected final candidates', async () => {
  const projectId = 9912;
  const chapterId = 'video_asset_rejected_chapter';
  const sceneId = 99121;

  await db.run('DELETE FROM scene WHERE id = ?', sceneId);
  await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
  await db.run('DELETE FROM project WHERE id = ?', projectId);

  await db.run('INSERT INTO project (id, title) VALUES (?, ?)', projectId, 'Rejected Candidate Test');
  await db.run('INSERT INTO chapter (id, project_id, "index", title) VALUES (?, ?, 1, ?)', chapterId, projectId, 'Chapter');
  await db.run('INSERT INTO scene (id, chapter_id, "index", visual_prompt) VALUES (?, ?, 1, ?)', sceneId, chapterId, 'test');

  const asset = await MediaAssetService.createAsset({
    project_id: projectId,
    scene_id: sceneId,
    scene_version: 1,
    media_type: 'video',
    role: 'loop_master',
    profile: 'character_loop',
    status: 'rejected',
    url: `/static/generated/videos/${projectId}/${sceneId}/rejected.mp4`
  });

  await assert.rejects(() => MediaAssetService.promoteAsset(asset.id!), /Cannot promote a rejected video asset/);
  await db.run('DELETE FROM project WHERE id = ?', projectId);
});
