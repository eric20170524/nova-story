import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { projectImportRoutes } from './project_import';

const MARKDOWN = [
  '# 失声的梦核游乐园',
  '',
  '## 简介',
  '',
  '一只小动物误入停摆的梦核游乐场。',
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

const buildMultipartRequest = async (filename: string, content: string, type: string) => {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), filename);
  const request = new Request('http://localhost/api/projects/import/preview', {
    method: 'POST',
    body: form,
  });

  return {
    headers: Object.fromEntries(request.headers.entries()),
    payload: Buffer.from(await request.arrayBuffer()),
  };
};

test('previews a markdown import without touching the database', async () => {
  const app = Fastify();
  await app.register(multipart);
  await app.register(projectImportRoutes, { prefix: '/api/projects' });
  await app.ready();

  const multipartRequest = await buildMultipartRequest(
    '失声的梦核游乐园.md',
    MARKDOWN,
    'text/markdown'
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/import/preview',
    headers: multipartRequest.headers,
    payload: multipartRequest.payload,
  });

  assert.equal(response.statusCode, 200, response.body);
  const preview = response.json();
  assert.equal(preview.project.title, '失声的梦核游乐园');
  assert.equal(preview.counts.chapters, 1);
  assert.equal(preview.counts.chapter_summaries, 1);
  assert.equal(preview.counts.chapter_contents, 1);

  await app.close();
});

test('returns 400 for an empty markdown preview', async () => {
  const app = Fastify();
  await app.register(multipart);
  await app.register(projectImportRoutes, { prefix: '/api/projects' });
  await app.ready();

  const multipartRequest = await buildMultipartRequest('empty.md', '', 'text/markdown');
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/import/preview',
    headers: multipartRequest.headers,
    payload: multipartRequest.payload,
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().detail, /empty/i);

  await app.close();
});

test('returns 415 for unsupported preview formats', async () => {
  const app = Fastify();
  await app.register(multipart);
  await app.register(projectImportRoutes, { prefix: '/api/projects' });
  await app.ready();

  const multipartRequest = await buildMultipartRequest('novel.pdf', 'not pdf', 'application/pdf');
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/import/preview',
    headers: multipartRequest.headers,
    payload: multipartRequest.payload,
  });

  assert.equal(response.statusCode, 415, response.body);
  assert.match(response.json().detail, /Only \.txt/);

  await app.close();
});
