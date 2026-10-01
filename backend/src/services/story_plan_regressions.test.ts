import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = ':memory:';

test('plan updates budget the new draft target, reject a stale title, and serialize the same create', async (t) => {
  const [{ db }, { StoryPlanService }, { StoryPlanningService }, { PlanningError, hashChapterContent }, { LLMService }] = await Promise.all([
    import('../db/database'),
    import('./story_plan_service'),
    import('./ai/story_planning_service'),
    import('../schemas/story_plan'),
    import('./llm'),
  ]);

  const project = await db.run(
    "INSERT INTO project (title, description, settings, user_id) VALUES ('旧书名', '旧简介', '{}', 'local_admin')"
  );
  const projectId = Number(project.lastID);
  await StoryPlanService.createManualChapter({
    projectId,
    id: 'chapter-budget',
    title: '第一章',
    content: '',
  });
  await assert.rejects(
    () => StoryPlanService.createManualChapter({ projectId, id: 'chapter-blocked', title: '第二章' }),
    (error: any) => error instanceof PlanningError
      && error.code === 'PREVIOUS_CHAPTER_NOT_FINALIZED'
      && /尚未定稿/.test(error.message)
      && !/正文哈希/.test(error.message)
  );
  await db.run("UPDATE chapter SET status = 'completed' WHERE id = ?", 'chapter-budget');
  await assert.rejects(
    () => StoryPlanService.createManualChapter({ projectId, id: 'chapter-legacy', title: '第二章' }),
    (error: any) => error instanceof PlanningError
      && error.code === 'PREVIOUS_CHAPTER_NOT_FINALIZED'
      && /正文哈希出现之前/.test(error.message)
  );
  await db.run(
    'UPDATE chapter SET finalized_content_hash = ? WHERE id = ?',
    'not-the-body',
    'chapter-budget'
  );
  await assert.rejects(
    () => StoryPlanService.createManualChapter({ projectId, id: 'chapter-drift', title: '第二章' }),
    (error: any) => error instanceof PlanningError && /正文已变化/.test(error.message)
  );
  await db.run(
    'UPDATE chapter SET finalized_content_hash = ? WHERE id = ?',
    hashChapterContent(''),
    'chapter-budget'
  );
  await db.run(
    "UPDATE chapter SET status = 'draft', finalized_content_hash = NULL WHERE id = ?",
    'chapter-budget'
  );

  const view = await StoryPlanService.getView(projectId);
  const linked = view.document.chapters[0]!;
  const futures = [10000, 10000, 10000, 10000, 5000].map((targetWordCount, index) => ({
    id: `future-${index}`,
    title: `后续${index}`,
    summary: '后续',
    targetWordCount,
    disposition: 'active' as const,
  }));
  const priced = await StoryPlanService.updateDocument(projectId, view.revision, {
    ...view.document,
    targetTotalWords: 50000,
    chapters: [{ ...linked, targetWordCount: 2000 }, ...futures],
  });
  assert.equal(priced.budget.reserved, 47000);
  await assert.rejects(
    () => StoryPlanService.updateDocument(projectId, priced.revision, {
      ...priced.document,
      chapters: priced.document.chapters.map((entry) => (
        entry.id === linked.id ? { ...entry, targetWordCount: 10000 } : entry
      )),
    }),
    (error: any) => error instanceof PlanningError && error.code === 'PLAN_BUDGET_EXCEEDED'
  );
  const kept = await db.get('SELECT target_word_count FROM chapter WHERE id = ?', 'chapter-budget');
  assert.equal(Number(kept.target_word_count), 2000);
  const unchanged = await StoryPlanService.getView(projectId);
  assert.equal(unchanged.revision, priced.revision);
  assert.equal(unchanged.budget.reserved, 47000);
  await db.run(
    "UPDATE chapter SET status = 'completed', finalized_content_hash = ? WHERE id = ?",
    hashChapterContent(''),
    'chapter-budget'
  );

  const source = await StoryPlanService.captureSource(projectId, unchanged.revision, []);
  assert.equal(source.fingerprint.projectTitle, '旧书名');
  assert.equal(source.fingerprint.projectDescription, '旧简介');
  await db.run("UPDATE project SET title = '新书名', description = '新简介' WHERE id = ?", projectId);
  await db.run(
    `INSERT INTO story_plan_change
      (id, project_id, kind, state, request_key, request_hash, base_revision, candidate_revision,
       before_json, after_json, patches_json, source_snapshot_json)
     VALUES ('title-cand', ?, 'blueprint', 'pending', 'title-key', 'hash', ?, 1, ?, ?, ?, ?)`,
    projectId,
    unchanged.revision,
    JSON.stringify(unchanged.document),
    JSON.stringify(unchanged.document),
    JSON.stringify([{ id: 'project.title', entity: 'project', label: '书名', before: '旧书名', after: '候选书名' }]),
    JSON.stringify(source)
  );
  await assert.rejects(
    () => StoryPlanService.applyCandidate(projectId, 'title-cand', {
      expected_revision: unchanged.revision,
      expected_candidate_revision: 1,
      selected_patch_ids: ['project.title'],
    }),
    (error: any) => error instanceof PlanningError && error.code === 'SOURCE_CHANGED'
  );
  const title = await db.get('SELECT title, description FROM project WHERE id = ?', projectId);
  assert.equal(title.title, '新书名');
  assert.equal(title.description, '新简介');

  const ready = await StoryPlanService.getView(projectId);
  const nextRequest = {
    project_id: projectId,
    plan_entry_id: 'future-0',
    expected_revision: ready.revision,
    expected_last_chapter_id: 'chapter-budget',
    request_key: 'parallel-next',
  };
  const [first, second] = await Promise.all([
    StoryPlanService.createNextChapter(nextRequest),
    StoryPlanService.createNextChapter(nextRequest),
  ]);
  assert.equal(first.chapter.id, second.chapter.id);
  assert.equal((await db.get('SELECT count(*) AS n FROM chapter WHERE project_id = ?', projectId)).n, 2);

  t.mock.method(LLMService, 'generateStructuredWithRetry', async () => ({
    chapters: [{ title: '扩展章', summary: '继续', targetWordCount: 2000 }],
  }));
  const beforeGenerate = await StoryPlanService.getView(projectId);
  const generated = await StoryPlanningService.generateChapters({
    projectId,
    requestKey: 'downgrade-initial',
    expectedRevision: beforeGenerate.revision,
    message: '初始化规划',
    mode: 'initial',
    batchSize: 1,
  });
  assert.equal(generated.state, 'pending');
  const payload = JSON.parse(String((await db.get(
    'SELECT request_payload_json FROM story_plan_change WHERE request_key = ?',
    'downgrade-initial'
  )).request_payload_json));
  assert.equal(payload.mode, 'extend');
});
