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

    // 5. Chapter video status endpoint returns assembled/playlist metadata
    const sceneRes = await db.run(
      `INSERT INTO scene (chapter_id, "index", visual_prompt, audio_prompt, dialogue, narration, duration, asset_status, asset_url, active_version)
       VALUES (?, 1, '云海玉阶', '', '嘉静，你还好吗？', '', 8, 'completed', '/static/frame-1.png', 1)`,
      'ch-order-1'
    );
    const sceneId = Number(sceneRes.lastID);
    await db.run(
      `INSERT INTO media_asset (project_id, scene_id, scene_version, media_type, role, status, url, duration_ms)
       VALUES (?, ?, 1, 'video', 'narrative_final', 'ready', '/static/shot-1.mp4', 8000)`,
      projectId,
      sceneId
    );
    const videoRes = await app.inject({
      method: 'GET',
      url: '/api/chapters/ch-order-1/video',
    });
    assert.equal(videoRes.statusCode, 200);
    const videoBody = JSON.parse(videoRes.body);
    assert.equal(videoBody.chapter_id, 'ch-order-1');
    assert.equal(videoBody.shots_summary.total_shots, 1);
    assert.equal(videoBody.shots_summary.ready_video_shots, 1);
    assert.equal(videoBody.shots_summary.all_ready, true);
    assert.equal(videoBody.shot_playlist.length, 1);
    assert.equal(videoBody.shot_playlist[0].video_url, '/static/shot-1.mp4');
  } finally {
    LLMService.generateStructuredWithRetry = origGen;
  }
});
