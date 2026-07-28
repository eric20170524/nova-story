import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeTextFile, parseTextProject } from './text_import';

const QIONGMING_STYLE_TEXT = [
  '《琼明仙女录·初章》',
  '',
  '琼明仙域，云海之上有一座玉楼。',
  '',
  '---',
  '',
  '《琼明仙女录·第二章》',
  '',
  '清暮宫内殿，香炉里燃着合欢香。',
  '',
  '---',
  '',
  '《琼明仙女录·第三章》',
  '',
  '春潮最盛时，三位神女已完全沉沦。'
].join('\n');

test('parses qiongming-style wrapped headings into one project and three chapters', () => {
  const parsed = parseTextProject(
    decodeTextFile(Buffer.from(QIONGMING_STYLE_TEXT)),
    'qiongming.txt'
  );

  assert.equal(parsed.title, '琼明仙女录');
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    ['初章', '第二章', '第三章']
  );
  assert.ok(parsed.chapters[0]!.content.startsWith('琼明仙域'));
});

test('parses common Chinese and English chapter headings', () => {
  const parsed = parseTextProject(
    [
      '《测试故事》',
      '一句简介',
      '',
      '# 第一章：开端',
      '第一章正文',
      '',
      'Chapter 2 - Next',
      'Second chapter'
    ].join('\n'),
    'fallback.txt'
  );

  assert.equal(parsed.title, '测试故事');
  assert.equal(parsed.description, '一句简介');
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    ['第一章：开端', 'Chapter 2 - Next']
  );
});

test('imports an unstructured text file as a single chapter', () => {
  const parsed = parseTextProject('这是一段没有章节标题的正文。', 'single-story.txt');

  assert.equal(parsed.title, 'single-story');
  assert.equal(parsed.chapters.length, 1);
  assert.equal(parsed.chapters[0]!.title, '正文');
  assert.equal(parsed.chapters[0]!.content, '这是一段没有章节标题的正文。');
});

test('imports qiongming-style text through the HTTP route and persists its chapters', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [
    { default: Fastify },
    { default: multipart },
    { projectRoutes },
    { chapterRoutes }
  ] = await Promise.all([
    import('fastify'),
    import('@fastify/multipart'),
    import('../routes/projects'),
    import('../routes/chapters')
  ]);

  const app = Fastify();
  await app.register(multipart);
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(chapterRoutes, { prefix: '/api/chapters' });
  await app.ready();

  const form = new FormData();
  form.append(
    'file',
    new Blob([QIONGMING_STYLE_TEXT], { type: 'text/plain' }),
    'qiongming.txt'
  );
  const request = new Request('http://localhost/api/projects/import', {
    method: 'POST',
    body: form
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/import',
    headers: Object.fromEntries(request.headers.entries()),
    payload: Buffer.from(await request.arrayBuffer())
  });

  assert.equal(response.statusCode, 201, response.body);
  const project = response.json();
  assert.equal(project.title, '琼明仙女录');

  const chaptersResponse = await app.inject({
    method: 'GET',
    url: `/api/chapters/?project_id=${project.id}`
  });
  assert.equal(chaptersResponse.statusCode, 200, chaptersResponse.body);
  assert.deepEqual(
    chaptersResponse.json().map((chapter: { title: string }) => chapter.title),
    ['初章', '第二章', '第三章']
  );

  await app.close();
});
