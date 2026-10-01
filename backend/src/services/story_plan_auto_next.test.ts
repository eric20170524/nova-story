import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = ':memory:';

test('auto next retries terminal receipts with current planning parameters and stays idempotent', async () => {
  const [{ db }, { StoryPlanService }, { hashChapterContent }] = await Promise.all([
    import('../db/database'), import('./story_plan_service'), import('../schemas/story_plan'),
  ]);
  for (const state of ['failed', 'stale', 'rejected']) {
    const project = await db.run("INSERT INTO project (title, settings) VALUES ('Auto retry', '{}')");
    const projectId = Number(project.lastID);
    const chapterId = `auto-${state}`;
    await StoryPlanService.createManualChapter({ projectId, id: chapterId, title: '第一章', content: '同一正文' });
    await db.run('UPDATE chapter SET status = ?, finalized_content_hash = ? WHERE id = ?',
      'completed', hashChapterContent('同一正文'), chapterId);
    const view = await StoryPlanService.getView(projectId);
    await StoryPlanService.updateDocument(projectId, view.revision, {
      ...view.document, autoCreateNextChapter: true,
      chapters: [...view.document.chapters, {
        id: `next-${state}`, title: '第二章', summary: '后续', targetWordCount: 2000, disposition: 'active',
      }],
    });
    const register = async () => {
      await db.exec('BEGIN IMMEDIATE');
      try {
        await StoryPlanService.registerAutoNextInOpenTransaction(projectId, chapterId);
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    };
    await register();
    const original = await db.get('SELECT * FROM story_plan_change WHERE project_id = ?', projectId);
    await register();
    assert.equal((await db.get('SELECT count(*) AS n FROM story_plan_change WHERE project_id = ?', projectId)).n, 1);
    // A plan edit in the finalize/consume window must yield an observable conflict.
    const beforeEdit = await StoryPlanService.getView(projectId);
    const edited = await StoryPlanService.updateDocument(projectId, beforeEdit.revision, {
      ...beforeEdit.document,
      chapters: beforeEdit.document.chapters.map((entry) => entry.id === `next-${state}`
        ? { ...entry, title: '第二章更新', summary: '修改后的后续' } : entry),
    });
    const conflict = await StoryPlanService.consumePendingAutoNext(projectId, chapterId);
    assert.equal(conflict?.status, 'failed');
    assert.equal((conflict as any).code, 'PLAN_CONFLICT');
    await db.run('UPDATE story_plan_change SET state = ? WHERE id = ?', state, original.id);
    await register();
    const retried = await db.get('SELECT * FROM story_plan_change WHERE id = ?', original.id);
    assert.equal(retried.state, 'pending');
    assert.equal(retried.base_revision, edited.revision);
    assert.notEqual(retried.request_hash, original.request_hash);
    assert.equal(retried.error_code, null);
    const result = await StoryPlanService.consumePendingAutoNext(projectId, chapterId);
    assert.equal(result?.status, 'created');
    assert.equal((result as any).result.chapter.title, '第二章更新');
    const applied = await db.get('SELECT * FROM story_plan_change WHERE id = ?', original.id);
    assert.equal(applied.state, 'applied');
    await register();
    assert.equal(await StoryPlanService.consumePendingAutoNext(projectId, chapterId), null);
    const replay = await StoryPlanService.createNextChapter(JSON.parse(applied.request_payload_json));
    assert.equal(replay.chapter.id, (result as any).result.chapter.id);
    assert.equal((await db.get('SELECT count(*) AS n FROM chapter WHERE project_id = ?', projectId)).n, 2);
  }
});
