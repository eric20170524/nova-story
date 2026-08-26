import assert from 'node:assert/strict';
import test from 'node:test';

const multipartPayload = async (
  url: string,
  filename: string,
  content: string
) => {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'application/json' }), filename);
  const request = new Request(`http://localhost${url}`, {
    method: 'POST',
    body: form,
  });
  return {
    headers: Object.fromEntries(request.headers.entries()),
    payload: Buffer.from(await request.arrayBuffer()),
  };
};

test('native JSON preview counts exactly the graph later committed', async () => {
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

  const backup = JSON.stringify({
    format: 'novastory-project',
    project: {
      title: 'Native Graph Parity',
      settings: [],
    },
    screenplay: {
      chapters: [{ id: 'chapter-1', title: 'Chapter 1', content: 'Body' }],
    },
    director: {
      scenes: [
        { id: 10, chapter_id: 'chapter-1', visual_prompt: 'Valid scene' },
        { id: 11, chapter_id: 'missing', visual_prompt: 'Orphan scene' },
      ],
      coverage_groups: [
        { id: 20, source_scene_id: 10 },
        { id: 21, source_scene_id: 11 },
      ],
      coverage_shots: [
        { coverage_group_id: 20, visual_prompt: 'Valid shot' },
        { coverage_group_id: 21, visual_prompt: 'Orphan shot' },
      ],
    },
  });

  const previewUpload = await multipartPayload(
    '/api/projects/import/preview',
    'graph.novastory.json',
    backup
  );
  const previewResponse = await app.inject({
    method: 'POST',
    url: '/api/projects/import/preview',
    headers: previewUpload.headers,
    payload: previewUpload.payload,
  });
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json();
  assert.equal(preview.counts.chapters, 1);
  assert.equal(preview.counts.scenes, 1);
  assert.equal(preview.counts.coverage_groups, 1);
  assert.equal(preview.counts.coverage_shots, 1);
  assert.ok(preview.warnings.length >= 4);

  const commitUpload = await multipartPayload(
    '/api/projects/import/commit',
    'graph.novastory.json',
    backup
  );
  const commitResponse = await app.inject({
    method: 'POST',
    url: '/api/projects/import/commit',
    headers: commitUpload.headers,
    payload: commitUpload.payload,
  });
  assert.equal(commitResponse.statusCode, 201, commitResponse.body);
  const project = commitResponse.json();

  const counts = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM chapter WHERE project_id = ?) AS chapters,
       (SELECT COUNT(*)
          FROM scene
          INNER JOIN chapter ON chapter.id = scene.chapter_id
         WHERE chapter.project_id = ?) AS scenes,
       (SELECT COUNT(*)
          FROM coverage_group
          INNER JOIN scene ON scene.id = coverage_group.source_scene_id
          INNER JOIN chapter ON chapter.id = scene.chapter_id
         WHERE chapter.project_id = ?) AS coverage_groups,
       (SELECT COUNT(*)
          FROM coverage_shot
          INNER JOIN coverage_group ON coverage_group.id = coverage_shot.coverage_group_id
          INNER JOIN scene ON scene.id = coverage_group.source_scene_id
          INNER JOIN chapter ON chapter.id = scene.chapter_id
         WHERE chapter.project_id = ?) AS coverage_shots`,
    project.id,
    project.id,
    project.id,
    project.id
  );

  assert.deepEqual(
    {
      chapters: counts.chapters,
      scenes: counts.scenes,
      coverage_groups: counts.coverage_groups,
      coverage_shots: counts.coverage_shots,
    },
    {
      chapters: preview.counts.chapters,
      scenes: preview.counts.scenes,
      coverage_groups: preview.counts.coverage_groups,
      coverage_shots: preview.counts.coverage_shots,
    }
  );

  const stored = await db.get('SELECT settings FROM project WHERE id = ?', project.id);
  assert.deepEqual(JSON.parse(stored.settings), {});

  await app.close();
});
