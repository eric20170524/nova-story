import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

test('generates rasterized subtitle pages and a PDF from local scene images', async () => {
  process.env.DATABASE_URL = ':memory:';
  const staticDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'novastory-comic-')
  );
  process.env.NOVASTORY_STATIC_DIR = staticDirectory;

  const [
    { default: Fastify },
    { db },
    { comicRoutes }
  ] = await Promise.all([
    import('fastify'),
    import('../db/database'),
    import('./comics')
  ]);

  const generatedDirectory = path.join(staticDirectory, 'generated');
  fs.mkdirSync(generatedDirectory, { recursive: true });
  await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: '#334155'
    }
  }).png().toFile(path.join(generatedDirectory, 'scene.png'));

  const project = await db.run(
    "INSERT INTO project (title) VALUES ('Comic')"
  );
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content)
     VALUES ('comic-chapter', ?, 1, 'Comic Chapter', 'Content')`,
    project.lastID
  );
  await db.run(
    `INSERT INTO scene (
       chapter_id, "index", visual_prompt, dialogue, asset_status, asset_url
     ) VALUES (
       'comic-chapter', 1, 'A blue room', '角色：出发。', 'completed',
       '/static/generated/scene.png'
     )`
  );

  const app = Fastify();
  await app.register(comicRoutes, { prefix: '/api/comics' });
  await app.ready();
  const response = await app.inject({
    method: 'POST',
    url: '/api/comics/comic-chapter/generate'
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().generated_count, 1);
  assert.equal(
    response.json().pages[0].url,
    '/static/comics/comic_scene_1.jpg'
  );
  assert.ok(
    fs.existsSync(path.join(staticDirectory, 'comics', 'comic_scene_1.jpg'))
  );
  assert.ok(
    fs.existsSync(
      path.join(staticDirectory, 'comics', 'chapter_comic-chapter_comic.pdf')
    )
  );

  await app.close();
});
