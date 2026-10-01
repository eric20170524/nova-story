import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { ChapterContinuitySchema, mergeChapterImpactSettings } from './chapter_impact_settings';
import type { ChapterImpactResult } from './writing_service';

process.env.DATABASE_URL = ':memory:';

const facts = () => ({
  characterStates: ['阿岚：重伤，留在北城；依据：受伤后无法离开。'],
  events: ['夜晚：阿岚夺回星钥；依据：从守卫手中取回钥匙。'],
  foreshadowing: ['星钥裂纹：埋设，未回收；依据：钥匙出现神秘裂纹。'],
  characterRelations: ['阿岚 → 林川：由敌对转为盟友；依据：共同保护星钥。'],
});

async function fixture(content = '阿岚夺回星钥后重伤，林川留下照顾她。钥匙上出现裂纹。') {
  const { db } = await import('../../db/database');
  const settings = {
    main_plot: '作者主线：寻找失落王国。',
    character_relations: '既有关系：林川与守卫是兄弟。',
    tone: '冷峻',
    image_generation: { model: 'pony', style: 'ink' },
    agent_prompts_override: { analysis_impact: '旧版提取提示\n章节：{{chapterTitle}}\n正文：{{content}}' },
  };
  const project = await db.run('INSERT INTO project (title, settings) VALUES (?, ?)', '定稿测试', JSON.stringify(settings));
  const projectId = Number(project.lastID);
  const chapterId = randomUUID();
  await db.run('INSERT INTO chapter (id, project_id, "index", title, content) VALUES (?, ?, 0, ?, ?)', chapterId, projectId, '星钥', content);
  return { db, projectId, chapterId, settings };
}

async function mockAnalysis(t: test.TestContext, continuity = facts()) {
  const { LLMService } = await import('../llm');
  const { WritingService } = await import('./writing_service');
  const payload = {
    newOrUpdatedCharacters: [{ name: '阿岚', description: '北城守卫。[状态：重伤]', visual_tags: { hair: 'black hair' } }],
    newOrUpdatedGlossary: [{ term: '星钥', definition: '开启王国遗迹的钥匙。' }],
    chapterContinuity: continuity,
  };
  const generate = t.mock.method(LLMService, 'generateStructuredWithRetry', async (_prompt: string, schema: any) => schema.parse(payload));
  t.mock.method(WritingService, 'analyzeChapterCharacters', async () => ({ characters: [{
    name: '阿岚', roleInChapter: '主角', motivation: '保护钥匙', relationships: [],
    traits: [{ trait: '坚韧', evidence: '负伤后仍然夺回钥匙', confidence: 0.9 }],
  }] }));
  return { WritingService, LLMService, payload, generate };
}

test('finalization previews without writes; API and agent persist both settings and replace repeated chapter entries', async (t) => {
  const { db, projectId, chapterId, settings } = await fixture();
  const { payload, generate } = await mockAnalysis(t);
  const { creativeRoutes } = await import('../../routes/creative');
  const app = Fastify();
  await app.register(creativeRoutes, { prefix: '/agent' });
  t.after(() => app.close());
  const preview = await app.inject({ method: 'POST', url: '/agent/impact', payload: { project_id: projectId, chapter_id: chapterId, apply: false } });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().applied, false);
  assert.match(preview.json().mainPlotEntry, /角色状态[\s\S]*重伤[\s\S]*事件[\s\S]*夺回星钥[\s\S]*伏笔[\s\S]*裂纹/);
  assert.match(preview.json().characterRelationsEntry, /由敌对转为盟友/);
  assert.deepEqual(JSON.parse((await db.get('SELECT settings FROM project WHERE id = ?', projectId)).settings), settings);
  assert.equal((await db.get('SELECT count(*) AS count FROM character WHERE project_id = ?', projectId)).count, 0);
  assert.equal((await db.get('SELECT count(*) AS count FROM glossary WHERE project_id = ?', projectId)).count, 0);
  // Legacy project prompt overrides still receive the new required output contract.
  assert.match(generate.mock.calls[0]!.arguments[0], /旧版提取提示[\s\S]*chapterContinuity[\s\S]*characterRelations/);

  const { AgentExecutor } = await import('./agent_executor');
  const run = () => AgentExecutor.executeAll([{ op: 'APPLY_CHAPTER_IMPACT', chapterId }], { projectId, apply: true });
  const first = (await run())[0];
  assert.ok(first);
  const firstData = first.data as ChapterImpactResult;
  assert.equal(first.status, 'success');
  assert.equal(firstData.applied, true);
  assert.equal(firstData.mainPlotChanged, true);
  assert.equal(firstData.characterRelationsChanged, true);
  assert.match(first.message || '', /timeline→main_plot.*relationships→character_relations/);
  const stored = JSON.parse((await db.get('SELECT settings FROM project WHERE id = ?', projectId)).settings);
  assert.match(stored.main_plot, /作者主线.*[\s\S]*角色状态[\s\S]*伏笔/);
  assert.match(stored.character_relations, /既有关系[\s\S]*由敌对转为盟友/);
  assert.deepEqual(stored.image_generation, settings.image_generation);
  assert.equal(stored.tone, settings.tone);
  const character = await db.get('SELECT description, visual_tags FROM character WHERE project_id = ?', projectId);
  assert.match(character.description, /状态：重伤[\s\S]*性格特征：坚韧/);
  assert.equal(JSON.parse(character.visual_tags).hair, 'black hair');
  assert.equal((await db.get('SELECT term FROM glossary WHERE project_id = ?', projectId)).term, '星钥');

  const repeated = (await run())[0];
  assert.ok(repeated);
  const repeatedData = repeated.data as ChapterImpactResult;
  assert.equal(repeatedData.mainPlotChanged, false);
  assert.equal(repeatedData.characterRelationsChanged, false);
  assert.deepEqual(JSON.parse((await db.get('SELECT settings FROM project WHERE id = ?', projectId)).settings), stored);
  payload.chapterContinuity.characterStates = ['阿岚：伤势痊愈；依据：正文确认完全恢复。'];
  payload.chapterContinuity.characterRelations = ['阿岚 → 林川：结盟破裂；依据：林川带走星钥。'];
  const updated = await app.inject({ method: 'POST', url: '/agent/impact', payload: { project_id: projectId, chapter_id: chapterId } });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().applied, true);
  const revised = JSON.parse((await db.get('SELECT settings FROM project WHERE id = ?', projectId)).settings);
  assert.match(revised.main_plot, /作者主线[\s\S]*伤势痊愈/);
  assert.doesNotMatch(revised.main_plot, /重伤/);
  assert.doesNotMatch(revised.character_relations, /由敌对转为盟友/);
  assert.match(revised.character_relations, /既有关系[\s\S]*结盟破裂/);
  assert.equal((revised.main_plot.match(/### 第1章/g) || []).length, 1);
});

test('finalizing identical content retries automatic next chapter after a post-commit plan conflict', async (t) => {
  const { db, projectId, chapterId } = await fixture();
  const { WritingService } = await mockAnalysis(t);
  const { StoryPlanService } = await import('../story_plan_service');
  await StoryPlanService.bootstrap(projectId);
  const view = await StoryPlanService.getView(projectId);
  await StoryPlanService.updateDocument(projectId, view.revision, {
    ...view.document, autoCreateNextChapter: true,
    chapters: [...view.document.chapters, {
      id: 'auto-impact-next', title: '下一章', summary: '处理裂纹', targetWordCount: 2000, disposition: 'active',
    }],
  });
  const originalConsume = StoryPlanService.consumePendingAutoNext;
  let edited = false;
  t.mock.method(StoryPlanService, 'consumePendingAutoNext', async (id: number, currentChapterId: string) => {
    if (!edited) {
      edited = true;
      const current = await StoryPlanService.getView(id);
      await StoryPlanService.updateDocument(id, current.revision, {
        ...current.document,
        chapters: current.document.chapters.map((entry) => entry.id === 'auto-impact-next'
          ? { ...entry, title: '下一章更新', summary: '改为追踪裂纹来源' } : entry),
      });
    }
    return originalConsume.call(StoryPlanService, id, currentChapterId);
  });
  const first = await WritingService.analyzeChapterImpact(projectId, chapterId, true);
  assert.equal(first.applied, true);
  assert.equal(first.autoNext?.status, 'failed');
  assert.equal((first.autoNext as any).code, 'PLAN_CONFLICT');
  const finalized = await db.get('SELECT content, finalized_content_hash, status FROM chapter WHERE id = ?', chapterId);
  assert.equal(finalized.status, 'completed');
  assert.ok(finalized.finalized_content_hash);
  const second = await WritingService.analyzeChapterImpact(projectId, chapterId, true);
  assert.equal(second.applied, true);
  assert.equal(second.autoNext?.status, 'created');
  assert.equal((second.autoNext as any).result.chapter.summary, '改为追踪裂纹来源');
  const repeated = await WritingService.analyzeChapterImpact(projectId, chapterId, true);
  assert.equal(repeated.autoNext, null);
  assert.equal((await db.get('SELECT count(*) AS n FROM chapter WHERE project_id = ?', projectId)).n, 2);
  assert.equal((await db.get('SELECT content FROM chapter WHERE id = ?', chapterId)).content, finalized.content);
  const receipts = await db.all('SELECT state FROM story_plan_change WHERE project_id = ? AND kind = ?', projectId, 'next_chapter');
  assert.deepEqual(receipts, [{ state: 'applied' }]);
});

test('plot and relationship entries stay in chapter order, preserve author text, and remove revised-away facts', () => {
  const chapters = [{ id: 'first', index: 0, title: '初遇' }, { id: 'second', index: 1, title: '星钥' }];
  const base = { main_plot: '手工主线', character_relations: '手工关系', tone: '保留' };
  const second = mergeChapterImpactSettings(base, chapters[1]!, chapters, facts());
  const first = mergeChapterImpactSettings(second.settings, chapters[0]!, chapters, { ...facts(), events: ['初遇事件'] });
  assert.ok(first.settings.main_plot!.indexOf('第1章') < first.settings.main_plot!.indexOf('第2章'));
  assert.ok(first.settings.character_relations!.indexOf('第1章') < first.settings.character_relations!.indexOf('第2章'));
  const cleared = mergeChapterImpactSettings(first.settings, chapters[1]!, chapters, ChapterContinuitySchema.parse({}));
  assert.match(cleared.settings.main_plot!, /手工主线[\s\S]*初遇事件/);
  assert.doesNotMatch(cleared.settings.main_plot!, /第2章|夺回星钥/);
  assert.doesNotMatch(cleared.settings.character_relations!, /第2章/);
  assert.equal(cleared.settings.tone, '保留');
});

test('long chapter impact includes the ending beyond the former 5000-character cutoff', async (t) => {
  const content = Array.from({ length: 12 }, (_, i) => `${i}：${'旅途中的平静记录。'.repeat(65)}`).join('\n\n') + '\n\n终章信号：林川背叛，星钥伏笔回收。';
  const { projectId, chapterId } = await fixture(content);
  const { WritingService, generate, payload } = await mockAnalysis(t);
  generate.mock.mockImplementation(async (prompt: string, schema: any) => schema.parse({
    ...payload,
    chapterContinuity: { ...ChapterContinuitySchema.parse({}), events: [prompt.includes('终章信号') ? '林川背叛' : '旅途继续'], foreshadowing: prompt.includes('终章信号') ? ['星钥：已回收'] : [] },
  }));
  const result = await WritingService.analyzeChapterImpact(projectId, chapterId, false);
  assert.ok(generate.mock.calls.length > 1);
  assert.equal(generate.mock.calls.filter((call) => call.arguments[0].includes('终章信号')).length, 1);
  for (const paragraph of content.split('\n\n')) {
    assert.ok(generate.mock.calls.some((call) => call.arguments[0].includes(paragraph)));
  }
  assert.deepEqual(result.chapterContinuity.events, ['旅途继续', '林川背叛']);
  assert.match(result.mainPlotEntry!, /已回收/);
});

test('generation failure is an error, never a successful partial library update', async (t) => {
  const { db, projectId, chapterId, settings } = await fixture();
  const { WritingService, generate } = await mockAnalysis(t);
  generate.mock.mockImplementation(async () => null);
  await assert.rejects(WritingService.analyzeChapterImpact(projectId, chapterId), /analysis failed/);
  assert.deepEqual(JSON.parse((await db.get('SELECT settings FROM project WHERE id = ?', projectId)).settings), settings);
  assert.equal((await db.get('SELECT count(*) AS count FROM character WHERE project_id = ?', projectId)).count, 0);
});

test('database failure rolls back characters, glossary, and settings together', async (t) => {
  const { db, projectId, chapterId, settings } = await fixture();
  const { WritingService } = await mockAnalysis(t);
  await db.exec(`CREATE TEMP TRIGGER reject_impact_settings BEFORE UPDATE OF settings ON project
    WHEN NEW.id = ${projectId} BEGIN SELECT RAISE(ABORT, 'settings write rejected'); END;`);
  t.after(() => db.exec('DROP TRIGGER reject_impact_settings'));
  await assert.rejects(WritingService.analyzeChapterImpact(projectId, chapterId), /settings write rejected/);
  assert.equal((await db.get('SELECT count(*) AS count FROM character WHERE project_id = ?', projectId)).count, 0);
  assert.equal((await db.get('SELECT count(*) AS count FROM glossary WHERE project_id = ?', projectId)).count, 0);
  assert.deepEqual(JSON.parse((await db.get('SELECT settings FROM project WHERE id = ?', projectId)).settings), settings);
});

test('rejects stale or empty chapters and keeps settings edits made during analysis', async (t) => {
  const { db, projectId, chapterId, settings } = await fixture();
  const { WritingService, generate, payload } = await mockAnalysis(t);
  generate.mock.mockImplementation(async (_prompt: string, schema: any) => {
    await db.run('UPDATE chapter SET content = ? WHERE id = ?', '新修订正文', chapterId);
    return schema.parse(payload);
  });
  await assert.rejects(WritingService.analyzeChapterImpact(projectId, chapterId), /changed during/);
  assert.equal((await db.get('SELECT count(*) AS count FROM character WHERE project_id = ?', projectId)).count, 0);
  generate.mock.mockImplementation(async (_prompt: string, schema: any) => {
    await db.run('UPDATE project SET settings = ? WHERE id = ?', JSON.stringify({ ...settings, tone: '新风格', main_plot: '分析期间手工修改' }), projectId);
    return schema.parse(payload);
  });
  await WritingService.analyzeChapterImpact(projectId, chapterId);
  const latest = JSON.parse((await db.get('SELECT settings FROM project WHERE id = ?', projectId)).settings);
  assert.equal(latest.tone, '新风格');
  assert.match(latest.main_plot, /^分析期间手工修改/);
  await db.run('UPDATE chapter SET content = ? WHERE id = ?', '   ', chapterId);
  await assert.rejects(WritingService.analyzeChapterImpact(projectId, chapterId), /content is empty/);
});
