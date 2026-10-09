import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = ':memory:';

test('isFullChapterRewriteIntent detects rewrite vs append', async () => {
  const { isFullChapterRewriteIntent } = await import('./agent_executor');
  assert.equal(
    isFullChapterRewriteIntent('正文中的 画面、动作指令等不像是小说写法，请重写'),
    true
  );
  assert.equal(isFullChapterRewriteIntent('全文重写，更真实和性感些'), true);
  assert.equal(isFullChapterRewriteIntent('继续写本章，加强张力'), false);
  assert.equal(isFullChapterRewriteIntent('续写 300 字'), false);
});

test('AgentExecutor structure ops: rename, move, delete with project guard', async () => {
  const { db } = await import('../../db/database');
  const { AgentExecutor } = await import('./agent_executor');

  const project = await db.run(
    "INSERT INTO project (title, settings, user_id) VALUES ('Exec', '{}', 'local')"
  );
  const projectId = Number(project.lastID);
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, status)
     VALUES ('ch-a', ?, 0, 'Alpha', 'text a', 'draft')`,
    projectId
  );
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, status)
     VALUES ('ch-b', ?, 1, 'Beta', 'text b', 'draft')`,
    projectId
  );

  const other = await db.run(
    "INSERT INTO project (title, settings, user_id) VALUES ('Other', '{}', 'local')"
  );
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, status)
     VALUES ('ch-x', ?, 0, 'Foreign', 'x', 'draft')`,
    other.lastID
  );

  const rename = await AgentExecutor.executeAll(
    [{ op: 'RENAME_CHAPTER', chapterId: 'ch-a', newTitle: 'Alpha Renamed' }],
    { projectId, apply: true }
  );
  assert.equal(rename[0]?.status, 'success');
  const renamed = await db.get('SELECT title FROM chapter WHERE id = ?', 'ch-a');
  assert.equal(renamed.title, 'Alpha Renamed');

  const bad = await AgentExecutor.executeAll(
    [{ op: 'RENAME_CHAPTER', chapterId: 'ch-x', newTitle: 'Hacked' }],
    { projectId, apply: true }
  );
  assert.equal(bad[0]?.status, 'error');

  const move = await AgentExecutor.executeAll(
    [{ op: 'MOVE_CHAPTER', chapterId: 'ch-a', positionIndex: 1 }],
    { projectId, apply: true }
  );
  assert.equal(move[0]?.status, 'success');
  const a = await db.get('SELECT "index" AS idx FROM chapter WHERE id = ?', 'ch-a');
  const b = await db.get('SELECT "index" AS idx FROM chapter WHERE id = ?', 'ch-b');
  assert.equal(a.idx, 1);
  assert.equal(b.idx, 0);

  const del = await AgentExecutor.executeAll(
    [{ op: 'DELETE_CHAPTER', chapterId: 'ch-b', reason: 'test' }],
    { projectId, apply: true }
  );
  assert.equal(del[0]?.status, 'success');
  const gone = await db.get('SELECT id FROM chapter WHERE id = ?', 'ch-b');
  assert.equal(gone, undefined);
});

test('AgentExecutor batch continues after error (non-atomic)', async () => {
  const { db } = await import('../../db/database');
  const { AgentExecutor } = await import('./agent_executor');

  const project = await db.run(
    "INSERT INTO project (title, settings, user_id) VALUES ('Batch', '{}', 'local')"
  );
  const projectId = Number(project.lastID);
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, status)
     VALUES ('batch-1', ?, 0, 'One', '', 'draft')`,
    projectId
  );

  const results = await AgentExecutor.executeAll(
    [
      { op: 'RENAME_CHAPTER', chapterId: 'missing', newTitle: 'Nope' },
      { op: 'RENAME_CHAPTER', chapterId: 'batch-1', newTitle: 'Still Works' },
    ],
    { projectId, apply: true }
  );
  assert.equal(results[0]?.status, 'error');
  assert.equal(results[1]?.status, 'success');
  const row = await db.get('SELECT title FROM chapter WHERE id = ?', 'batch-1');
  assert.equal(row.title, 'Still Works');
});

test('正文直写 API 服务和 Agent 均停用，原时间线不变且不调用模型', async () => {
  const { db } = await import('../../db/database');
  const { LLMService } = await import('../llm');
  const { generateAndReplaceNarrativeTimeline } = await import(
    '../timeline_generation_service'
  );

  const project = await db.run(
    "INSERT INTO project (title, settings, user_id) VALUES ('TL', '{}', 'local')"
  );
  const projectId = Number(project.lastID);
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, status)
     VALUES ('tl-ch', ?, 0, 'Scene Ch', 'Hero fights.', 'draft')`,
    projectId
  );
  await db.run(
    `INSERT INTO scene (chapter_id, "index", visual_prompt, asset_status)
     VALUES ('tl-ch', 1, 'old', 'idle')`
  );

  const prev = LLMService.generateTimeline;
  let calls = 0;
  LLMService.generateTimeline = async () => { calls++; throw new Error('直写不应调用模型'); };

  try {
    await assert.rejects(() => generateAndReplaceNarrativeTimeline({
      chapterId: 'tl-ch',
      projectId,
      content: 'Hero fights.',
    }), (error: any) => error.statusCode === 410 && /直写时间线已停用/.test(error.message));
    const scenes = await db.all(
      'SELECT id, visual_prompt FROM scene WHERE chapter_id = ? ORDER BY "index"',
      'tl-ch'
    );
    assert.equal(scenes.length, 1);
    assert.equal(scenes[0].visual_prompt, 'old');

    // Agent path uses the same service
    const { AgentExecutor } = await import('./agent_executor');
    const exec = await AgentExecutor.executeAll(
      [{ op: 'GENERATE_TIMELINE', chapterId: 'tl-ch' }],
      { projectId, chapterId: 'tl-ch', apply: true }
    );
    assert.equal(exec[0]?.status, 'error');
    const after = await db.all(
      'SELECT visual_prompt FROM scene WHERE chapter_id = ?',
      'tl-ch'
    );
    assert.equal(after.length, 1);
    assert.equal(after[0].visual_prompt, 'old');
    assert.equal(calls, 0);
  } finally {
    LLMService.generateTimeline = prev;
  }
});
