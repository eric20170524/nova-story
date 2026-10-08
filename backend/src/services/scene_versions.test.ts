import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import { db, initDb } from '../db/database';
import {
  activateSceneVersion,
  createSceneVersion,
  ensureSceneVersionBaseline,
  listSceneVersions,
  syncActiveVersionFromScene,
  syncActiveVersionAssets
} from './scene_versions';

test('scene versions: baseline, create, activate, sync text', async () => {
  await initDb();

  const projectId = Number(`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9));
  await db.run(
    `INSERT INTO project (id, title, settings, user_id)
     VALUES (?, 'scene-version-test', '{}', 'test')`,
    projectId
  );

  const chapterId = 'test-ver-ch-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content)
     VALUES (?, ?, 99, 'ver-test', 'x')`,
    chapterId,
    projectId
  );
  const ins = await db.run(
    `INSERT INTO scene (chapter_id, "index", visual_prompt, dialogue, asset_status, asset_url, shot_spec)
     VALUES (?, 1, 'prompt A', 'line A', 'completed', '/static/a.png', '{"english_visual_prompt":"English A","location":"courtyard"}')`,
    chapterId
  );
  const sceneId = Number(ins.lastID);

  await ensureSceneVersionBaseline(sceneId);
  let versions = await listSceneVersions(sceneId);
  assert.equal(versions.length, 1);
  assert.equal(versions[0]?.version, 1);
  assert.equal(versions[0]?.visual_prompt, 'prompt A');

  const created = await createSceneVersion(sceneId, { clearAsset: true, activate: true });
  assert.ok(created);
  assert.equal(created!.version.version, 2);
  assert.equal(created!.scene.active_version, 2);
  assert.equal(created!.scene.asset_url, null);
  assert.equal(created!.scene.visual_prompt, 'prompt A');
  assert.equal(JSON.parse(created!.scene.shot_spec).english_visual_prompt, undefined);

  await db.run(`UPDATE scene SET visual_prompt = ? WHERE id = ?`, 'prompt B', sceneId);
  await syncActiveVersionFromScene(sceneId);
  await syncActiveVersionAssets(sceneId, { asset_url: '/static/b.png', english_visual_prompt: 'English B' }, 2);

  versions = await listSceneVersions(sceneId);
  const v2 = versions.find((v) => v.version === 2)!;
  assert.equal(v2.visual_prompt, 'prompt B');
  assert.equal(v2.english_visual_prompt, 'English B');

  const restored = await activateSceneVersion(sceneId, 1);
  assert.equal(restored.active_version, 1);
  assert.equal(restored.visual_prompt, 'prompt A');
  assert.equal(restored.asset_url, '/static/a.png');
  assert.equal(JSON.parse(restored.shot_spec).english_visual_prompt, 'English A');
  assert.equal(JSON.parse(restored.shot_spec).location, 'courtyard');

  // A late worker for v2 must update v2, even if the user has switched to v1.
  await syncActiveVersionAssets(sceneId, { asset_url: '/static/b-late.png', english_visual_prompt: 'English B late' }, 2);
  const stillA = await db.get('SELECT * FROM scene WHERE id = ?', sceneId);
  assert.equal(stillA.asset_url, '/static/a.png');
  assert.equal(JSON.parse(stillA.shot_spec).english_visual_prompt, 'English A');
  const restoredB = await activateSceneVersion(sceneId, 2);
  assert.equal(restoredB.asset_url, '/static/b-late.png');
  assert.equal(JSON.parse(restoredB.shot_spec).english_visual_prompt, 'English B late');

  await db.run('DELETE FROM scene WHERE id = ?', sceneId);
  await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
  await db.run('DELETE FROM project WHERE id = ?', projectId);
});
