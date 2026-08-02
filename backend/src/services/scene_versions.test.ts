import assert from 'node:assert/strict';
import test from 'node:test';
import { db, initDb } from '../db/database';
import {
  activateSceneVersion,
  createSceneVersion,
  ensureSceneVersionBaseline,
  listSceneVersions,
  syncActiveVersionFromScene
} from './scene_versions';

test('scene versions: baseline, create, activate, sync text', async () => {
  await initDb();

  const chapterId = 'test-ver-ch-' + Date.now();
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content) VALUES (?, 1, 99, 'ver-test', 'x')`,
    chapterId
  );
  const ins = await db.run(
    `INSERT INTO scene (chapter_id, "index", visual_prompt, dialogue, asset_status, asset_url)
     VALUES (?, 1, 'prompt A', 'line A', 'completed', '/static/a.png')`,
    chapterId
  );
  const sceneId = Number(ins.lastID);

  await ensureSceneVersionBaseline(sceneId);
  let versions = await listSceneVersions(sceneId);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, 1);
  assert.equal(versions[0].visual_prompt, 'prompt A');

  const created = await createSceneVersion(sceneId, { clearAsset: true, activate: true });
  assert.ok(created);
  assert.equal(created!.version.version, 2);
  assert.equal(created!.scene.active_version, 2);
  assert.equal(created!.scene.asset_url, null);
  assert.equal(created!.scene.visual_prompt, 'prompt A');

  await db.run(`UPDATE scene SET visual_prompt = ? WHERE id = ?`, 'prompt B', sceneId);
  await syncActiveVersionFromScene(sceneId);

  versions = await listSceneVersions(sceneId);
  const v2 = versions.find((v) => v.version === 2)!;
  assert.equal(v2.visual_prompt, 'prompt B');

  const restored = await activateSceneVersion(sceneId, 1);
  assert.equal(restored.active_version, 1);
  assert.equal(restored.visual_prompt, 'prompt A');
  assert.equal(restored.asset_url, '/static/a.png');

  await db.run('DELETE FROM scene WHERE id = ?', sceneId);
  await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
});
