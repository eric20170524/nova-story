import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

test('chapter candidates keep existing entries and revise adoption updates the draft', async (t) => {
  process.env.DATABASE_URL = ':memory:';
  const [{ db }, { StoryPlanService }, { PlanningError }] = await Promise.all([
    import('../db/database'),
    import('./story_plan_service'),
    import('../schemas/story_plan'),
  ]);

  const project = await db.run("INSERT INTO project (title, settings, user_id) VALUES ('Review', '{}', 'local_admin')");
  const projectId = Number(project.lastID);
  await StoryPlanService.createManualChapter({
    projectId,
    id: 'chapter-1',
    title: '第一章',
    content: '原始正文',
  });

  const insertCandidate = async (
    id: string,
    mode: 'extend' | 'revise',
    afterChapters: unknown,
    patchId: string
  ) => {
    const plan = await StoryPlanService.getView(projectId);
    const patches = mode === 'revise'
      ? [{ id: patchId, entity: 'plan', label: '修订', before: '旧', after: '新' }]
      : [{ id: 'chapters_batch', entity: 'plan', label: '追加', before: null, after: '新章' }];
    await db.run(
      `INSERT INTO story_plan_change
        (id, project_id, kind, state, request_key, request_hash, request_payload_json, base_revision,
         candidate_revision, before_json, after_json, patches_json, source_snapshot_json)
       VALUES (?, ?, 'chapters', 'pending', ?, 'hash', ?, ?, 1, ?, ?, ?, ?)`,
      id,
      projectId,
      `key-${id}`,
      JSON.stringify({ mode }),
      plan.revision,
      JSON.stringify(plan.document),
      JSON.stringify({ ...plan.document, chapters: afterChapters }),
      JSON.stringify(patches),
      JSON.stringify(await StoryPlanService.captureSource(projectId, plan.revision, []))
    );
    return plan;
  };

  const opened = await StoryPlanService.getView(projectId);
  const linked = opened.document.chapters[0]!;
  await insertCandidate('empty-batch', 'extend', [], 'chapters_batch');
  await assert.rejects(
    () => StoryPlanService.applyCandidate(projectId, 'empty-batch', {
      expected_revision: opened.revision,
      expected_candidate_revision: 1,
      selected_patch_ids: ['chapters_batch'],
    }),
    (error: any) => error instanceof PlanningError && error.code === 'PLAN_ENTRY_REFERENCED'
  );
  await assert.rejects(
    () => StoryPlanService.editCandidate(projectId, 'empty-batch', 1, { ...opened.document, chapters: [] }),
    (error: any) => error instanceof PlanningError && error.code === 'PLAN_ENTRY_REFERENCED'
  );
  const untouched = await db.get('SELECT plan_entry_id, content FROM chapter WHERE id = ?', 'chapter-1');
  assert.equal(untouched.plan_entry_id, linked.id);
  assert.equal(untouched.content, '原始正文');
  const stillPending = await db.get('SELECT candidate_revision, state FROM story_plan_change WHERE id = ?', 'empty-batch');
  assert.equal(Number(stillPending.candidate_revision), 1);
  assert.equal(stillPending.state, 'pending');
  const planAfterReject = await StoryPlanService.getView(projectId);
  assert.equal(planAfterReject.document.chapters[0]?.id, linked.id);

  const added = {
    id: 'future-1',
    title: '新章',
    summary: '新的钩子',
    targetWordCount: 2200,
    disposition: 'active' as const,
  };
  const extendPlan = await insertCandidate('extend-batch', 'extend', [...planAfterReject.document.chapters, added], 'chapters_batch');
  const rewrittenExisting = planAfterReject.document.chapters.map((entry) => ({ ...entry, title: '被改掉' }));
  await assert.rejects(
    () => StoryPlanService.editCandidate(projectId, 'extend-batch', 1, {
      ...extendPlan.document,
      chapters: [...rewrittenExisting, added],
    }),
    (error: any) => error instanceof PlanningError && error.code === 'PLAN_ENTRY_REFERENCED'
  );
  const editedNew = { ...added, title: '新章已改', summary: '保留既有条目后的新钩子' };
  const edited = await StoryPlanService.editCandidate(projectId, 'extend-batch', 1, {
    ...extendPlan.document,
    chapters: [...planAfterReject.document.chapters, editedNew],
  });
  const applied = await StoryPlanService.applyCandidate(projectId, 'extend-batch', {
    expected_revision: extendPlan.revision,
    expected_candidate_revision: Number(edited.candidate_revision),
    selected_patch_ids: ['chapters_batch'],
  });
  const ids = applied.view.document.chapters.map((entry: { id: string }) => entry.id);
  assert.deepEqual(ids, [linked.id, 'future-1']);
  assert.equal(applied.view.document.chapters[0].title, linked.title);
  assert.equal(applied.view.document.chapters[1].title, '新章已改');
  const chapterAfterExtend = await db.get('SELECT plan_entry_id, content, title FROM chapter WHERE id = ?', 'chapter-1');
  assert.equal(chapterAfterExtend.plan_entry_id, linked.id);
  assert.equal(chapterAfterExtend.content, '原始正文');
  assert.equal(chapterAfterExtend.title, '第一章');

  const beforeRevise = await StoryPlanService.getView(projectId);
  const revisedEntry = {
    ...beforeRevise.document.chapters[0],
    title: '雨夜改题',
    summary: '新章纲',
    targetWordCount: 2400,
  };
  const revisePlan = await insertCandidate(
    'revise-batch',
    'revise',
    beforeRevise.document.chapters.map((entry) => entry.id === linked.id ? revisedEntry : entry),
    `chapter:${linked.id}`
  );
  await StoryPlanService.applyCandidate(projectId, 'revise-batch', {
    expected_revision: revisePlan.revision,
    expected_candidate_revision: 1,
    selected_patch_ids: [`chapter:${linked.id}`],
  });
  const chapterAfterRevise = await db.get(
    'SELECT title, summary, target_word_count, content, plan_entry_id FROM chapter WHERE id = ?',
    'chapter-1'
  );
  assert.equal(chapterAfterRevise.title, '雨夜改题');
  assert.equal(chapterAfterRevise.summary, '新章纲');
  assert.equal(Number(chapterAfterRevise.target_word_count), 2400);
  assert.equal(chapterAfterRevise.content, '原始正文');
  assert.equal(chapterAfterRevise.plan_entry_id, linked.id);
  const adoptedPlan = await StoryPlanService.getView(projectId);
  const editor = { title: chapterAfterRevise.title, summary: chapterAfterRevise.summary, content: chapterAfterRevise.content };
  const { chapterRoutes } = await import('../routes/chapters');
  const app = Fastify();
  await app.register(chapterRoutes, { prefix: '/chapters' });
  t.after(() => app.close());
  const save = await app.inject({ method: 'PATCH', url: '/chapters/chapter-1', payload: editor });
  assert.equal(save.statusCode, 200, save.body);
  assert.equal(save.json().summary, '新章纲');
  const synced = await StoryPlanService.getView(projectId);
  assert.equal(synced.revision, adoptedPlan.revision, 'saving after adoption must not revise the outline again');
  const syncedEntry = synced.document.chapters.find((entry) => entry.id === linked.id);
  assert.equal(syncedEntry?.title, '雨夜改题');
  assert.equal(syncedEntry?.summary, '新章纲');
  assert.equal(syncedEntry?.targetWordCount, 2400);

  await db.run('UPDATE chapter SET status = ? WHERE id = ?', 'completed', 'chapter-1');
  const lockedPlan = await StoryPlanService.getView(projectId);
  await insertCandidate(
    'revise-final',
    'revise',
    lockedPlan.document.chapters.map((entry) => entry.id === linked.id ? { ...entry, summary: '不该写上定稿章' } : entry),
    `chapter:${linked.id}`
  );
  await assert.rejects(
    () => StoryPlanService.applyCandidate(projectId, 'revise-final', {
      expected_revision: lockedPlan.revision,
      expected_candidate_revision: 1,
      selected_patch_ids: [`chapter:${linked.id}`],
    }),
    (error: any) => error instanceof PlanningError && error.code === 'TARGET_FINALIZED'
  );
  const finalized = await db.get('SELECT summary, content, status FROM chapter WHERE id = ?', 'chapter-1');
  assert.equal(finalized.summary, '新章纲');
  assert.equal(finalized.content, '原始正文');
  assert.equal(finalized.status, 'completed');
});
