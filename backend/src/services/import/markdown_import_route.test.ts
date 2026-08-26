import assert from 'node:assert/strict';
import test from 'node:test';

const MARKDOWN_NOVEL = [
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
  '第一章概要。',
  '',
  '### 正文',
  '',
  '第一章正文。',
  '',
  '## 第 2 章 无声长廊的触碰',
  '',
  '### 章节概要',
  '',
  '第二章概要。',
  '',
  '### 正文',
  '',
  '第二章正文。',
].join('\n');

test('imports Markdown through HTTP and persists summary/content/story settings', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [
    { default: Fastify },
    { default: multipart },
    { projectRoutes },
    { chapterRoutes },
  ] = await Promise.all([
    import('fastify'),
    import('@fastify/multipart'),
    import('../../routes/projects'),
    import('../../routes/chapters'),
  ]);

  const app = Fastify();
  await app.register(multipart);
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(chapterRoutes, { prefix: '/api/chapters' });
  await app.ready();

  const form = new FormData();
  form.append(
    'file',
    new Blob([MARKDOWN_NOVEL], { type: 'text/markdown' }),
    '失声的梦核游乐园.md'
  );
  const request = new Request('http://localhost/api/projects/import', {
    method: 'POST',
    body: form,
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/import',
    headers: Object.fromEntries(request.headers.entries()),
    payload: Buffer.from(await request.arrayBuffer()),
  });

  assert.equal(response.statusCode, 201, response.body);
  const project = response.json();
  assert.equal(project.title, '失声的梦核游乐园');
  assert.equal(project.description, '作品以一只小动物的视角展开。');

  const settings = JSON.parse(project.settings);
  assert.equal(
    settings.genre,
    '梦核幻想 / 小动物视角 / 治愈系探索'
  );
  assert.deepEqual(settings.story_tags, [
    '梦核幻想',
    '小动物视角',
    '治愈系探索',
  ]);
  assert.deepEqual(settings.import_info.source, {
    filename: '失声的梦核游乐园.md',
    format: 'markdown',
  });

  const chaptersResponse = await app.inject({
    method: 'GET',
    url: `/api/chapters/?project_id=${project.id}`,
  });
  assert.equal(chaptersResponse.statusCode, 200, chaptersResponse.body);

  const chapters = chaptersResponse.json();
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '第 1 章 停摆的迎宾广场');
  assert.equal(chapters[0].summary, '第一章概要。');
  assert.equal(chapters[0].content, '第一章正文。');
  assert.ok(!chapters[0].content.includes('### 章节概要'));
  assert.ok(!chapters[0].content.includes('### 正文'));

  await app.close();
});
