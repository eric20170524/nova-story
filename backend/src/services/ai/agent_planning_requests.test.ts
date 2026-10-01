import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = ':memory:';

test('repeated agent planning uses independent keys and replays only usable candidates as success', async (t) => {
  const [{ db }, { AgentExecutor }, { LLMService }, { StoryPlanService }] = await Promise.all([
    import('../../db/database'), import('./agent_executor'), import('../llm'), import('../story_plan_service'),
  ]);
  const project = await db.run("INSERT INTO project (title, settings) VALUES ('Requests', '{}')");
  const projectId = Number(project.lastID);
  t.mock.method(LLMService, 'generateStructuredWithRetry', async (prompt: string) => prompt.includes('只返回设定 JSON')
    ? { title: '设定', summary: '新的世界', mainPlot: '冒险' }
    : { chapters: [{ title: '第一章', summary: '出发', targetWordCount: 2000 }] });

  for (const op of ['PLAN_STORY', 'PLAN_CHAPTERS'] as const) {
    const run = (history: any[] = [], requestKey?: string) => AgentExecutor.executeAll([
      { op, instructions: '按约定继续规划', history, requestKey, mode: 'extend', batchSize: 1 },
    ], { projectId, apply: false });
    const first = (await run())[0]!;
    const second = (await run([{ role: 'user', content: '主角不能获得超能力' }]))[0]!;
    const third = (await run([{ role: 'user', content: '主角不能获得超能力' }]))[0]!;
    assert.equal(first.status, 'success', first.message);
    assert.equal(second.status, 'success', second.message);
    assert.equal(third.status, 'success', third.message);
    const ids = [first, second, third].map((result) => (result.data as any).candidate_id);
    assert.equal(new Set(ids).size, 3);

    const key = `explicit-${op}`;
    const explicit = (await run([], key))[0]!;
    const replay = (await run([], key))[0]!;
    assert.equal(replay.status, 'success');
    assert.equal((replay.data as any).candidate_id, (explicit.data as any).candidate_id);
    assert.equal((await run([{ role: 'user', content: '不同历史' }], key))[0]!.status, 'error');

    for (const state of ['generating', 'stale', 'failed', 'rejected', 'applied']) {
      await db.run('UPDATE story_plan_change SET state = ?, error_code = ? WHERE project_id = ? AND request_key = ?',
        state, state === 'failed' ? 'INTERRUPTED' : null, projectId, key);
      const result = (await run([], key))[0]!;
      assert.equal(result.status, 'error', `${op}: ${state} is not a generated candidate`);
      assert.doesNotMatch(result.message || '', /已生成.*候选/);
      if (state === 'generating') {
        await StoryPlanService.markInterruptedGenerations();
        assert.equal((await run([], key))[0]!.status, 'error');
      }
    }
    assert.equal((await run())[0]!.status, 'success');
  }
});
