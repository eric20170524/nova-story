import assert from 'node:assert/strict';
import test from 'node:test';

const multipartPayload = async (filename: string, content: string, type: string) => {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), filename);
  const request = new Request('http://localhost/api/projects/import', {
    method: 'POST',
    body: form,
  });
  return {
    headers: Object.fromEntries(request.headers.entries()),
    payload: Buffer.from(await request.arrayBuffer()),
  };
};

test('legacy import endpoint delegates NovaStory JSON to canonical restore', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [
    { default: Fastify },
    { default: multipart },
    { projectRoutes },
    { db },
  ] = await Promise.all([
    import('fastify'),
    import('@fastify/multipart'),
    import('./projects'),
    import('../db/database'),
  ]);

  const app = Fastify();
  await app.register(multipart);
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.ready();

  const backup = {
    format: 'novastory-project',
    version: 1,
    project: {
      title: 'Legacy Canonical Restore',
      settings: { genre: 'fantasy' },
    },
    screenplay: {
      chapters: [{
        id: 'legacy-source-chapter',
        index: 1,
        title: 'Legacy Chapter',
        content: 'Body',
        summary: 'Summary',
      }],
    },
    director: {
      scenes: [{
        id: 101,
        chapter_id: 'legacy-source-chapter',
        index: 1,
        visual_prompt: 'Wide shot',
      }],
      coverage_groups: [{
        id: 201,
        source_scene_id: 101,
        version: 1,
      }],
      coverage_shots: [{
        coverage_group_id: 201,
        slot: 1,
        visual_prompt: 'Close shot',
      }],
    },
  };

  const upload = await multipartPayload(
    'legacy-restore.novastory.json',
    JSON.stringify(backup),
    'application/json'
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/import',
    headers: upload.headers,
    payload: upload.payload,
  });

  assert.equal(response.statusCode, 201, response.body);
  const project = response.json();
  assert.equal(project.title, 'Legacy Canonical Restore');

  const restored = await db.get(
    `SELECT chapter.summary, scene.visual_prompt,
            coverage_shot.visual_prompt AS coverage_prompt
     FROM chapter
     INNER JOIN scene ON scene.chapter_id = chapter.id
     INNER JOIN coverage_group ON coverage_group.source_scene_id = scene.id
     INNER JOIN coverage_shot ON coverage_shot.coverage_group_id = coverage_group.id
     WHERE chapter.project_id = ?`,
    project.id
  );
  assert.equal(restored.summary, 'Summary');
  assert.equal(restored.visual_prompt, 'Wide shot');
  assert.equal(restored.coverage_prompt, 'Close shot');

  await app.close();
});

test('legacy import endpoint uses canonical input error status', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [
    { default: Fastify },
    { default: multipart },
    { projectRoutes },
  ] = await Promise.all([
    import('fastify'),
    import('@fastify/multipart'),
    import('./projects'),
  ]);

  const app = Fastify();
  await app.register(multipart);
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.ready();

  const upload = await multipartPayload(
    'unsupported.pdf',
    'not a supported project file',
    'application/pdf'
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/import',
    headers: upload.headers,
    payload: upload.payload,
  });

  assert.equal(response.statusCode, 415, response.body);
  assert.match(response.json().detail, /Only \.txt/);

  await app.close();
});
