import assert from 'node:assert/strict';
import test from 'node:test';
import { usesStoryIdeation } from './agent_service';

test('ideation does not leave the story surface', () => {
  assert.equal(usesStoryIdeation({ conversation_mode: 'ideation', surface: 'story' }, null), true);
  assert.equal(usesStoryIdeation({ conversation_mode: 'ideation', surface: 'director' }, null), false);
  assert.equal(usesStoryIdeation({ conversation_mode: 'ideation', surface: 'characters' }, null), false);
  assert.equal(usesStoryIdeation({ conversation_mode: 'ideation', surface: 'settings' }, null), false);
  assert.equal(usesStoryIdeation({ conversation_mode: 'ideation', surface: 'script' }, null), false);
  assert.equal(usesStoryIdeation({ conversation_mode: 'command', surface: 'story' }, null), false);
  assert.equal(usesStoryIdeation({ conversation_mode: 'ideation', surface: 'story' }, 'PLAN_CHAPTERS'), false);
});

test('a chapter ordinal becomes the current plan id before revise generation', async () => {
  process.env.DATABASE_URL = ':memory:';
  const [{ db }, { StoryPlanService }, { StoryPlanningService }, { AgentService }] = await Promise.all([
    import('../../db/database'),
    import('../story_plan_service'),
    import('./story_planning_service'),
    import('./agent_service'),
  ]);
  const project = await db.run("INSERT INTO project (title, settings, user_id) VALUES ('Ordinal', '{}', 'local_admin')");
  const projectId = Number(project.lastID);
  const created = await StoryPlanService.bootstrap(projectId);
  await StoryPlanService.updateDocument(projectId, created.revision, {
    ...created.document,
    chapters: [
      { id: 'plan_a', title: '雨夜', summary: '相遇', targetWordCount: 2000, disposition: 'active' },
      { id: 'plan_b', title: '线索', summary: '反转', targetWordCount: 1800, disposition: 'active' },
    ],
  });

  const original = StoryPlanningService.generateChapters;
  const captured: Array<{ mode?: string; targetPlanIds?: string[] }> = [];
  StoryPlanningService.generateChapters = async (request: any) => {
    captured.push({ mode: request.mode, targetPlanIds: request.targetPlanIds });
    return { id: 'cand', state: 'pending' } as any;
  };
  try {
    const agent = new AgentService();
    const resolved = await agent.processRequest({
      message: '改写第一章规划，增加悬念',
      context: { project_id: projectId, surface: 'story', language: 'zh' },
      history: [],
    });
    assert.equal(resolved.actions[0]?.op, 'PLAN_CHAPTERS');
    assert.deepEqual(resolved.actions[0]?.targetPlanIds, ['plan_a']);
    assert.equal(captured[0]?.mode, 'revise');
    assert.deepEqual(captured[0]?.targetPlanIds, ['plan_a']);

    await agent.processRequest({
      message: '改写第一章规划，增加悬念',
      context: {
        project_id: projectId,
        surface: 'story',
        language: 'zh',
        planning: { mode: 'revise', targetPlanIds: ['plan_b'] },
      },
      history: [],
    });
    assert.deepEqual(captured[1]?.targetPlanIds, ['plan_b']);
  } finally {
    StoryPlanningService.generateChapters = original;
  }

  const missing = await new AgentService().processRequest({
    message: '改写第九十九章规划，增加悬念',
    context: { project_id: projectId, surface: 'story', language: 'zh' },
    history: [],
  });
  assert.equal(missing.results?.[0]?.data?.code, 'TARGET_SET_MISMATCH');
});
