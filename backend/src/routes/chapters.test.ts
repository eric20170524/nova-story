import assert from 'node:assert/strict';
import test from 'node:test';

test('Chapter creation enforces strict finalization order and impact finalizes chapter', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [
    { default: Fastify },
    { db },
    { chapterRoutes },
    { WritingService },
    { LLMService },
  ] = await Promise.all([
    import('fastify'),
    import('../db/database'),
    import('./chapters'),
    import('../services/ai/writing_service'),
    import('../services/llm'),
  ]);

  const app = Fastify();
  await app.register(chapterRoutes, { prefix: '/api/chapters' });

  const project = await db.run(
    "INSERT INTO project (title, settings, user_id) VALUES ('Order Test', '{}', 'local_admin')"
  );
  const projectId = Number(project.lastID);

  // 1. First chapter can be created
  const res1 = await app.inject({
    method: 'POST',
    url: '/api/chapters/',
    payload: {
      id: 'ch-order-1',
      project_id: projectId,
      index: 1,
      title: '第1章 初入江湖',
      content: '李逍遥在余杭镇开客栈。',
    },
  });
  assert.equal(res1.statusCode, 201);
  const body1 = JSON.parse(res1.body);
  assert.equal(body1.status, 'draft');

  // 2. Creating second chapter while chapter 1 is draft fails with 400
  const res2Fail = await app.inject({
    method: 'POST',
    url: '/api/chapters/',
    payload: {
      id: 'ch-order-2',
      project_id: projectId,
      index: 2,
      title: '第2章 仙灵仙岛',
      content: '前往仙灵岛求药。',
    },
  });
  assert.equal(res2Fail.statusCode, 400);
  const errBody = JSON.parse(res2Fail.body);
  assert.match(errBody.detail, /尚未定稿/);

  // 3. Mock LLM for impact analysis and apply finalization on chapter 1
  const origGen = LLMService.generateStructuredWithRetry;
  LLMService.generateStructuredWithRetry = async <T>(_prompt: string, schema: any): Promise<T> => schema.parse({
    newOrUpdatedCharacters: [
      { name: '李逍遥', role: 'protagonist', description: '客栈小伙计' },
    ],
    newOrUpdatedGlossary: [
      { term: '余杭镇', definition: '江南水乡小镇' },
    ],
    chapterContinuity: {
      characterStates: [],
      events: ['李逍遥登场'],
      foreshadowing: [],
      characterRelations: [],
    },
  });

  try {
    const impactResult = await WritingService.analyzeChapterImpact(
      projectId,
      'ch-order-1',
      true
    );
    assert.equal(impactResult.applied, true);

    const chapter1After = await db.get('SELECT * FROM chapter WHERE id = ?', 'ch-order-1');
    assert.equal(chapter1After.status, 'completed');

    // 4. Now creating chapter 2 succeeds because chapter 1 is completed
    const res2Success = await app.inject({
      method: 'POST',
      url: '/api/chapters/',
      payload: {
        id: 'ch-order-2',
        project_id: projectId,
        index: 2,
        title: '第2章 仙灵仙岛',
        content: '前往仙灵岛求药。',
      },
    });
    assert.equal(res2Success.statusCode, 201);
    const body2 = JSON.parse(res2Success.body);
    assert.equal(body2.status, 'draft');
  } finally {
    LLMService.generateStructuredWithRetry = origGen;
  }
});
