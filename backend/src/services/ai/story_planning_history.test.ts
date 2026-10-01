import assert from 'node:assert/strict';
import test from 'node:test';

test('initial and extend planning prompts keep the supplied history', async () => {
  process.env.DATABASE_URL = ':memory:';
  const [{ db }, { StoryPlanService }, { StoryPlanningService }, { LLMService }] = await Promise.all([
    import('../../db/database'),
    import('../story_plan_service'),
    import('./story_planning_service'),
    import('../llm'),
  ]);
  const project = await db.run("INSERT INTO project (title, settings, user_id) VALUES ('History', '{}', 'local_admin')");
  const projectId = Number(project.lastID);
  await StoryPlanService.bootstrap(projectId);
  const view = await StoryPlanService.getView(projectId);
  const original = LLMService.generateStructuredWithRetry;
  let prompt = '';
  LLMService.generateStructuredWithRetry = async (text: string) => {
    prompt = text;
    return {
      chapters: [{ title: '约定章', summary: '遵守前文', targetWordCount: 2000 }],
    } as any;
  };
  try {
    await StoryPlanningService.generateChapters({
      projectId,
      requestKey: 'history-initial',
      expectedRevision: view.revision,
      message: '根据刚才讨论继续规划',
      history: [{ role: 'user', content: '主角不能获得超能力' }],
      mode: 'initial',
      batchSize: 1,
    });
    assert.match(prompt, /主角不能获得超能力/);
    assert.match(prompt, /历史：/);
    const extended = await StoryPlanService.getView(projectId);
    prompt = '';
    await StoryPlanningService.generateChapters({
      projectId,
      requestKey: 'history-extend',
      expectedRevision: extended.revision,
      message: '继续按约定追加',
      history: [{ role: 'assistant', content: '结局前不要揭示真名' }],
      mode: 'extend',
      batchSize: 1,
    });
    assert.match(prompt, /结局前不要揭示真名/);
    assert.match(prompt, /历史：/);
  } finally {
    LLMService.generateStructuredWithRetry = original;
  }
});
