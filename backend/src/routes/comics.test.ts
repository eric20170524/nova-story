import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

const createImage = async (filePath: string, background: string) => {
  await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background,
    }
  }).png().toFile(filePath);
};

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
  await createImage(path.join(generatedDirectory, 'scene.png'), '#334155');

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

test('project comic status blocks incomplete books and generates one strict full-book PDF when ready', async () => {
  const [
    { default: Fastify },
    { db },
    { comicRoutes }
  ] = await Promise.all([
    import('fastify'),
    import('../db/database'),
    import('./comics')
  ]);

  const staticDirectory = process.env.NOVASTORY_STATIC_DIR!;
  const generatedDirectory = path.join(staticDirectory, 'generated');
  await createImage(path.join(generatedDirectory, 'book-1.png'), '#475569');
  await createImage(path.join(generatedDirectory, 'book-2.png'), '#64748b');

  const project = await db.run("INSERT INTO project (title) VALUES ('Whole Book')");
  const projectId = Number(project.lastID);
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content)
     VALUES ('book-chapter-1', ?, 1, '第一章', '正文一')`,
    projectId
  );
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content)
     VALUES ('book-chapter-2', ?, 2, '第二章', '正文二')`,
    projectId
  );
  const firstScene = await db.run(
    `INSERT INTO scene (
       chapter_id, "index", visual_prompt, dialogue, asset_status, asset_url
     ) VALUES ('book-chapter-1', 1, 'Scene one', '第一页', 'completed', '/static/generated/book-1.png')`
  );
  const secondScene = await db.run(
    `INSERT INTO scene (
       chapter_id, "index", visual_prompt, dialogue, asset_status, asset_url
     ) VALUES ('book-chapter-2', 1, 'Scene two', '第二页', 'idle', NULL)`
  );

  const app = Fastify();
  await app.register(comicRoutes, { prefix: '/api/comics' });
  await app.ready();

  const notReadyStatus = await app.inject({
    method: 'GET',
    url: `/api/comics/project/${projectId}/status`,
  });
  assert.equal(notReadyStatus.statusCode, 200, notReadyStatus.body);
  const notReady = notReadyStatus.json();
  assert.equal(notReady.ready, false);
  assert.equal(notReady.total_chapters, 2);
  assert.equal(notReady.ready_chapters, 1);
  assert.equal(notReady.total_scenes, 2);
  assert.equal(notReady.ready_scenes, 1);
  assert.deepEqual(notReady.chapters[1].missing_scene_ids, [Number(secondScene.lastID)]);
  assert.equal(notReady.chapters[1].blocker, 'missing_assets');

  const blocked = await app.inject({
    method: 'POST',
    url: `/api/comics/project/${projectId}/generate`,
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().details.ready, false);

  await db.run(
    `UPDATE scene SET asset_status = 'completed', asset_url = ? WHERE id = ?`,
    '/static/generated/book-2.png',
    secondScene.lastID
  );

  const readyStatus = await app.inject({
    method: 'GET',
    url: `/api/comics/project/${projectId}/status`,
  });
  assert.equal(readyStatus.statusCode, 200, readyStatus.body);
  assert.equal(readyStatus.json().ready, true);
  assert.equal(readyStatus.json().ready_chapters, 2);

  const generated = await app.inject({
    method: 'POST',
    url: `/api/comics/project/${projectId}/generate`,
  });
  assert.equal(generated.statusCode, 200, generated.body);
  const body = generated.json();
  assert.equal(body.status, 'completed');
  assert.equal(body.project_id, projectId);
  assert.equal(body.total_chapters, 2);
  assert.equal(body.total_scenes, 2);
  assert.equal(body.generated_count, 2);
  assert.deepEqual(
    body.pages.map((page: any) => [page.chapter_id, page.scene_id]),
    [
      ['book-chapter-1', Number(firstScene.lastID)],
      ['book-chapter-2', Number(secondScene.lastID)],
    ]
  );
  assert.deepEqual(
    body.chapters.map((chapter: any) => [chapter.chapter_id, chapter.page_count]),
    [
      ['book-chapter-1', 1],
      ['book-chapter-2', 1],
    ]
  );
  assert.equal(body.pdf_url, `/static/comics/project_${projectId}_comic.pdf`);
  assert.ok(
    fs.existsSync(path.join(staticDirectory, 'comics', `project_${projectId}_comic.pdf`))
  );

  await app.close();
});
