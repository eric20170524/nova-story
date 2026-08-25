import assert from 'node:assert/strict';
import test from 'node:test';

const MARKDOWN = [
  '# 失声的梦核游乐园',
  '',
  '## 简介',
  '',
  '作品以一只小动物的视角展开。',
  '',
  '## 创作信息',
  '',
  '- 题材：梦核幻想 / 小动物视角 / 治愈系探索',
  '',
  '## 第 1 章 停摆的迎宾广场',
  '',
  '### 章节概要',
  '',
  '主角确认游乐场陷入非自然静止。',
  '',
  '### 正文',
  '',
  '耳朵敏锐地抖了抖。',
].join('\n');

const multipartPayload = async (filename: string, content: string, type: string) => {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), filename);
  const request = new Request('http://localhost/api/projects/import/commit', {
    method: 'POST',
    body: form,
  });
  return {
    headers: Object.fromEntries(request.headers.entries()),
    payload: Buffer.from(await request.arrayBuffer()),
  };
};

test('commits markdown through the canonical import route', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [
    { default: Fastify },
    { default: multipart },
    { projectImportRoutes },
    { db },
  ] = await Promise.all([
    import('fastify'),
    import('@fastify/multipart'),
    import('./project_import'),
    import('../db/database'),
  ]);

  const app = Fastify();
  await app.register(multipart);
  await app.register(projectImportRoutes, { prefix: '/api/projects' });
  await app.ready();

  const upload = await multipartPayload(
    '失声的梦核游乐园.md',
    MARKDOWN,
    'text/markdown'
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/import/commit',
    headers: upload.headers,
    payload: upload.payload,
  });

  assert.equal(response.statusCode, 201, response.body);
  const project = response.json();
  assert.equal(project.title, '失声的梦核游乐园');

  const chapter = await db.get(
    'SELECT * FROM chapter WHERE project_id = ? ORDER BY "index" ASC LIMIT 1',
    project.id
  );
  assert.equal(chapter.title, '第 1 章 停摆的迎宾广场');
  assert.equal(chapter.summary, '主角确认游乐场陷入非自然静止。');
  assert.equal(chapter.content, '耳朵敏锐地抖了抖。');

  const storedProject = await db.get('SELECT settings FROM project WHERE id = ?', project.id);
  const settings = JSON.parse(storedProject.settings);
  assert.deepEqual(settings.story_tags, ['梦核幻想', '小动物视角', '治愈系探索']);

  await app.close();
});

test('restores chapters, scenes, coverage groups, and shots from NovaStory JSON', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [
    { default: Fastify },
    { default: multipart },
    { projectImportRoutes },
    { db },
  ] = await Promise.all([
    import('fastify'),
    import('@fastify/multipart'),
    import('./project_import'),
    import('../db/database'),
  ]);

  const app = Fastify();
  await app.register(multipart);
  await app.register(projectImportRoutes, { prefix: '/api/projects' });
  await app.ready();

  const backup = {
    format: 'novastory-project',
    version: 1,
    project: {
      title: 'JSON Restore',
      description: 'restore test',
      settings: { genre: 'fantasy' },
    },
    screenplay: {
      chapters: [{
        id: 'source-chapter',
        index: 1,
        title: 'Chapter 1',
        content: 'Body',
        summary: 'Summary',
        status: 'draft',
      }],
    },
    character_center: {
      characters: [],
    },
    director: {
      scenes: [{
        id: 10,
        chapter_id: 'source-chapter',
        index: 1,
        visual_prompt: 'Wide shot',
        duration: 3,
        shot_spec: { lens: '24mm' },
      }],
      coverage_groups: [{
        id: 20,
        source_scene_id: 10,
        version: 1,
        status: 'completed',
      }],
      coverage_shots: [{
        id: 30,
        coverage_group_id: 20,
        slot: 1,
        visual_prompt: 'High angle',
      }],
    },
  };

  const upload = await multipartPayload(
    'restore.novastory.json',
    JSON.stringify(backup),
    'application/json'
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/import/commit',
    headers: upload.headers,
    payload: upload.payload,
  });

  assert.equal(response.statusCode, 201, response.body);
  const project = response.json();
  assert.equal(project.title, 'JSON Restore');

  const rows = await db.all(
    `SELECT scene.id AS scene_id, coverage_group.id AS group_id, coverage_shot.id AS shot_id
     FROM chapter
     INNER JOIN scene ON scene.chapter_id = chapter.id
     INNER JOIN coverage_group ON coverage_group.source_scene_id = scene.id
     INNER JOIN coverage_shot ON coverage_shot.coverage_group_id = coverage_group.id
     WHERE chapter.project_id = ?`,
    project.id
  );
  assert.equal(rows.length, 1);

  const scene = await db.get(
    `SELECT scene.*
     FROM scene
     INNER JOIN chapter ON chapter.id = scene.chapter_id
     WHERE chapter.project_id = ?`,
    project.id
  );
  assert.deepEqual(JSON.parse(scene.shot_spec), { lens: '24mm' });

  await app.close();
});

test('rejects bad input at 4xx before persistence starts', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [
    { default: Fastify },
    { default: multipart },
    { projectImportRoutes },
  ] = await Promise.all([
    import('fastify'),
    import('@fastify/multipart'),
    import('./project_import'),
  ]);

  const app = Fastify();
  await app.register(multipart);
  await app.register(projectImportRoutes, { prefix: '/api/projects' });
  await app.ready();

  const upload = await multipartPayload('bad.pdf', 'not a manuscript', 'application/pdf');
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/import/commit',
    headers: upload.headers,
    payload: upload.payload,
  });

  assert.equal(response.statusCode, 415, response.body);
  await app.close();
});
