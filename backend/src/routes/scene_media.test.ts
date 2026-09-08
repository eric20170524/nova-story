import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../server';
import { db } from '../db/database';
import { getGeneratedDirectory } from '../core/paths';

test('GET /api/scenes/:id/media exposes Character Center refs without copying assets', async () => {
  const projectId = 9921;
  const chapterId = 'scene_media_route_chapter';
  const sceneId = 99211;
  const characterId = 992101;
  const generatedDir = getGeneratedDirectory();
  fs.mkdirSync(generatedDir, { recursive: true });
  const filename = 'scene_media_route_face.png';
  const sourcePath = path.join(generatedDir, filename);
  const url = `/static/generated/${filename}`;
  fs.writeFileSync(sourcePath, Buffer.from('scene-media-route-face'));

  await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
  await db.run('DELETE FROM character WHERE id = ?', characterId);
  await db.run('DELETE FROM scene WHERE id = ?', sceneId);
  await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
  await db.run('DELETE FROM project WHERE id = ?', projectId);

  const app = await buildApp({ logger: false });
  try {
    await db.run('INSERT INTO project (id, title) VALUES (?, ?)', projectId, 'Scene Media Route Test');
    await db.run(
      'INSERT INTO chapter (id, project_id, "index", title) VALUES (?, ?, 1, ?)',
      chapterId,
      projectId,
      'Chapter'
    );
    await db.run(
      'INSERT INTO scene (id, chapter_id, "index", visual_prompt, active_version) VALUES (?, ?, 1, ?, 1)',
      sceneId,
      chapterId,
      'route test'
    );
    await db.run(
      'INSERT INTO character (id, project_id, name, visual_tags) VALUES (?, ?, ?, ?)',
      characterId,
      projectId,
      'Route Hero',
      JSON.stringify({ assets: { face_url: url } })
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/scenes/${sceneId}/media?version=1`
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.scene_id, sceneId);
    const ref = body.assets.find((asset: any) =>
      asset.role === 'character_reference' && asset.character_id === characterId
    );
    assert.ok(ref);
    assert.equal(ref.url, url);
    assert.equal(JSON.parse(ref.metadata_json).no_copy, true);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'scene-media-route-face');

    const badVersion = await app.inject({
      method: 'GET',
      url: `/api/scenes/${sceneId}/media?version=bad`
    });
    assert.equal(badVersion.statusCode, 400);
  } finally {
    await app.close();
    await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
    await db.run('DELETE FROM character WHERE id = ?', characterId);
    await db.run('DELETE FROM scene WHERE id = ?', sceneId);
    await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
    await db.run('DELETE FROM project WHERE id = ?', projectId);
    try { fs.unlinkSync(sourcePath); } catch {}
  }
});
