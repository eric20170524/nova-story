import assert from 'node:assert/strict';
import test from 'node:test';

test('story plan protects chapter order, adoption, and next-chapter retries', async () => {
  process.env.DATABASE_URL = ':memory:';
  const [{ db }, { StoryPlanService }, { PlanningError, hashChapterContent }] = await Promise.all([
    import('../db/database'),
    import('./story_plan_service'),
    import('../schemas/story_plan'),
  ]);

  const project = await db.run("INSERT INTO project (title, settings, user_id) VALUES ('Plan', '{}', 'local_admin')");
  const projectId = Number(project.lastID);

  const first = await StoryPlanService.createManualChapter({
    projectId,
    id: 'chapter-1',
    title: '第一章',
    content: '正文',
  });
  assert.equal(first.id, 'chapter-1');
  assert.equal(first.status, 'draft');
  assert.equal(Number(first.index), 1);

  await assert.rejects(
    () => StoryPlanService.createManualChapter({ projectId, id: 'chapter-2', title: '第二章' }),
    (error: any) => error instanceof PlanningError && error.code === 'PREVIOUS_CHAPTER_NOT_FINALIZED' && /尚未定稿/.test(error.message)
  );

  await db.run(
    'UPDATE chapter SET status = ?, finalized_content_hash = ? WHERE id = ?',
    'completed',
    hashChapterContent('正文'),
    'chapter-1'
  );

  const view = await StoryPlanService.getView(projectId);
  const extended = {
    ...view.document,
    chapters: [
      ...view.document.chapters,
      { id: 'future-1', title: '第二章', summary: '继续赶路', targetWordCount: 2000, disposition: 'active' as const },
    ],
  };
  const saved = await StoryPlanService.updateDocument(projectId, view.revision, extended);
  const request = {
    project_id: projectId,
    plan_entry_id: 'future-1',
    expected_revision: saved.revision,
    expected_last_chapter_id: 'chapter-1',
    request_key: 'next-1',
  };
  assert.equal(saved.next_entry_id, 'future-1');

  const created = await StoryPlanService.createNextChapter(request);
  assert.equal(created.reused, false);
  assert.equal(created.chapter.plan_entry_id, request.plan_entry_id);
  assert.equal(created.chapter.content, '');

  const replay = await StoryPlanService.createNextChapter(request);
  assert.equal(replay.chapter.id, created.chapter.id);
  assert.equal(replay.plan_revision, created.plan_revision);

  await assert.rejects(
    () => StoryPlanService.createNextChapter({ ...request, expected_revision: request.expected_revision + 9 }),
    (error: any) => error instanceof PlanningError && error.code === 'REQUEST_KEY_REUSED'
  );

  const plan = await StoryPlanService.getView(projectId);
  const candidateId = 'cand-1';
  await db.run(
    `INSERT INTO story_plan_change
      (id, project_id, kind, state, request_key, request_hash, base_revision, candidate_revision, before_json, after_json, patches_json, source_snapshot_json)
     VALUES (?, ?, 'chapters', 'pending', 'gen-1', 'hash', ?, 1, ?, ?, ?, ?)`,
    candidateId,
    projectId,
    plan.revision,
    JSON.stringify(plan.document),
    JSON.stringify(plan.document),
    JSON.stringify([{ id: 'chapters_batch', entity: 'plan', label: '追加', before: null, after: '新章' }]),
    JSON.stringify(await StoryPlanService.captureSource(projectId, plan.revision, []))
  );
  await assert.rejects(
    () => StoryPlanService.applyCandidate(projectId, candidateId, {
      expected_revision: plan.revision,
      expected_candidate_revision: 1,
      selected_patch_ids: [],
    }),
    (error: any) => error instanceof PlanningError && error.code === 'EMPTY_SELECTION'
  );
  const stillPending = await db.get('SELECT state FROM story_plan_change WHERE id = ?', candidateId);
  assert.equal(stillPending.state, 'pending');

  await StoryPlanService.retireLinkedChapter(projectId, created.chapter.id);
  await db.run('DELETE FROM chapter WHERE id = ?', created.chapter.id);
  const afterDelete = await StoryPlanService.getView(projectId);
  const retired = afterDelete.document.chapters.find((item) => item.id === request.plan_entry_id);
  assert.equal(retired?.disposition, 'retired');
  assert.notEqual(afterDelete.next_entry_id, request.plan_entry_id);
});
