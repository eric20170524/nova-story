import assert from 'node:assert/strict';
import test from 'node:test';

test('imported story tags, POV, and tone reach the layered writing context', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [{ db, initDb }, { WritingService }] = await Promise.all([
    import('../../db/database'),
    import('./writing_service'),
  ]);

  await initDb();

  const projectResult = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Context Import Test',
    'desc',
    JSON.stringify({
      genre: '梦核幻想',
      story_tags: ['梦核幻想', '小动物视角', '治愈系探索'],
      pov: '第三人称限知',
      tone: '温柔、轻微诡异',
    }),
    'local_admin'
  );
  const projectId = Number(projectResult.lastID);
  const chapterId = `context-meta-${Date.now()}`;

  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, ?, ?, ?, 'draft')`,
    chapterId,
    projectId,
    '第一章',
    '',
    '开篇概要'
  );

  const bundle = await WritingService.loadBundleForAgent(projectId, chapterId);

  assert.deepEqual(bundle.bible.story_tags, [
    '梦核幻想',
    '小动物视角',
    '治愈系探索',
  ]);
  assert.equal(bundle.bible.pov, '第三人称限知');
  assert.equal(bundle.bible.tone, '温柔、轻微诡异');
  assert.ok(bundle.layered);
  assert.match(bundle.layered!.worldBible, /Story tags: 梦核幻想, 小动物视角, 治愈系探索/);
  assert.match(bundle.layered!.worldBible, /POV: 第三人称限知/);
  assert.match(bundle.layered!.worldBible, /Tone: 温柔、轻微诡异/);
});

test('chapter generation keeps creative constraints even when prior-chapter memory exists', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [{ db, initDb }, { WritingService }, { LLMService }] = await Promise.all([
    import('../../db/database'),
    import('./writing_service'),
    import('../llm'),
  ]);

  await initDb();

  const projectResult = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Prompt Constraint Test',
    'desc',
    JSON.stringify({
      genre: '梦核幻想',
      story_tags: ['小动物视角', '治愈系探索'],
      pov: '第三人称限知',
      tone: '温柔、轻微诡异',
    }),
    'local_admin'
  );
  const projectId = Number(projectResult.lastID);
  const previousId = `context-prev-${Date.now()}`;
  const activeId = `context-active-${Date.now()}`;

  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, ?, ?, ?, 'completed')`,
    previousId,
    projectId,
    '第一章',
    '前一章留下了清晰的连续剧情记忆。',
    '前章概要'
  );
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 2, ?, ?, ?, 'draft')`,
    activeId,
    projectId,
    '第二章',
    '',
    '继续探索游乐园'
  );

  let capturedPrompt = '';
  const originalGetProvider = LLMService.getProvider;
  (LLMService as any).getProvider = () => ({
    generateText: async (prompt: string) => {
      capturedPrompt = prompt;
      return '生成正文';
    },
  });

  try {
    const result = await WritingService.generateChapterDraft({
      projectId,
      chapterId: activeId,
      instructions: '继续推进剧情',
      generateMetadata: false,
    });
    assert.equal(result.content, '生成正文');
  } finally {
    (LLMService as any).getProvider = originalGetProvider;
  }

  assert.match(capturedPrompt, /\[创作约束\]/);
  assert.match(capturedPrompt, /Story tags: 小动物视角, 治愈系探索/);
  assert.match(capturedPrompt, /POV: 第三人称限知/);
  assert.match(capturedPrompt, /Tone: 温柔、轻微诡异/);
  assert.match(capturedPrompt, /\[紧邻前文\]/);
  assert.match(capturedPrompt, /前一章留下了清晰的连续剧情记忆/);
});
