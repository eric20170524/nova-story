import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { formatPrompt } from './ai/prompt_registry';
import {
  PROMPT_CHAR_BUDGET,
  STORY_BIBLE_HEADER,
  applyLegacyAuthorFields,
  buildMigrationSnapshot,
  collectCanonFacts,
  fitPromptToBudget,
  loadBibleParts,
  migrateStoryBible,
  patchProjectSettings,
  renderStoryBible,
  resolveCharacterId,
} from './story_bible';

process.env.DATABASE_URL = ':memory:';

test('settings patch keeps canon written after the page was opened', () => {
  const current = {
    genre: '旧',
    plot_direction: '走向',
    chapter_impact_entries: { chap: { main_plot: '新纪要', character_relations: '' } },
    story_bible_migration: { version: 1, status: 'complete' },
    story_bible_snapshot: { main_plot: '原文' },
    custom_key: 'keep',
  };
  const incoming = {
    genre: '新',
    plot_direction: '新走向',
    chapter_impact_entries: { chap: { main_plot: '旧纪要', character_relations: '' } },
    story_bible_migration: { version: 0 },
    story_bible_snapshot: { main_plot: '被覆盖' },
    custom_key: 'stale',
    image_generation: { model: 'pony' },
  };
  const next = patchProjectSettings(current, incoming);
  assert.equal(next.genre, '新');
  assert.equal(next.plot_direction, '新走向');
  assert.equal(next.chapter_impact_entries!.chap!.main_plot, '新纪要');
  assert.equal((next.story_bible_snapshot as { main_plot: string }).main_plot, '原文');
  assert.equal(next.custom_key, 'keep');
  assert.equal((next.story_bible_migration as { version: number }).version, 1);
});

test('legacy main_plot does not replace a saved direction or a finished migration', () => {
  const saved = applyLegacyAuthorFields({ plot_direction: '' }, { main_plot: '旧客户端' });
  assert.equal(saved.settings.plot_direction, '');
  assert.deepEqual(saved.ignored, ['main_plot']);
  const locked = applyLegacyAuthorFields(
    { story_bible_migration: { version: 1, status: 'complete' } },
    { main_plot: '旧客户端', character_relations: '旧关系' }
  );
  assert.equal(locked.settings.plot_direction, undefined);
  assert.equal(locked.settings.initial_relations, undefined);
});

test('edited canon residue is kept for review and is not treated as the author direction', () => {
  const snapshot = buildMigrationSnapshot({
    characters: [{ id: 4, name: '陆嘉静', role: 'main', description: '本章处于高潮；依据：正文', personality: null, growth_path: null }],
    mainPlot: '作者改过一个字的纪要',
    characterRelations: '关系残留',
    initialRelations: '',
    entries: { a: { main_plot: '完整自动块', character_relations: '完整关系块' } },
    blueprint: {
      mainPlot: '蓝图走向',
      initialRelations: '开篇',
      plannedRelations: '以后',
      characters: [{ name: '陆嘉静', role: 'protagonist', description: '宫主', personality: '克制', growthPath: '从镜底到契约' }],
    },
  });
  assert.equal(snapshot.suggestions.plotResidue, '作者改过一个字的纪要');
  assert.equal(snapshot.suggestions.plotDirection, '蓝图走向');
  assert.equal(snapshot.characters[0]!.description, '本章处于高潮；依据：正文');
  assert.equal(snapshot.suggestions.characters[0]!.role, 'protagonist');
  assert.equal(snapshot.suggestions.characters[0]!.impactLike, true);
});

test('rename keeps state and relations on the character id; aliases resolve once', () => {
  const cast = [
    { id: 4, name: '陆嘉静', aliases: ['宫主'] },
    { id: 5, name: '裴雨涵', aliases: [] },
  ];
  assert.equal(resolveCharacterId('宫主', cast), 4);
  assert.equal(resolveCharacterId('陆嘉静', [
    { id: 4, name: '陆嘉静', aliases: [] },
    { id: 8, name: '陆嘉静', aliases: [] },
  ]), null);
  const chapters = [
    { id: 'c1', title: '一', index: 0, finalized_content_hash: 'h1' },
    { id: 'c2', title: '二', index: 1, finalized_content_hash: 'h2' },
    { id: 'c3', title: '三', index: 2, finalized_content_hash: null },
  ];
  const facts = collectCanonFacts(chapters, {
    c1: {
      main_plot: '',
      character_relations: '',
      state_refs: [{ line: '旧名：初见', character_id: 4 }],
      relation_refs: [{ line: '旧名 → 裴雨涵：旧情', a_id: 4, b_id: 5 }],
    },
    c2: {
      main_plot: '',
      character_relations: '',
      state_refs: [{ line: '陆嘉静：定约', character_id: 4 }],
      relation_refs: [{ line: '陆嘉静 → 裴雨涵：契约', a_id: 4, b_id: 5 }],
    },
    c3: {
      main_plot: '',
      character_relations: '',
      state_refs: [{ line: '陆嘉静：失效章', character_id: 4 }],
      relation_refs: [],
    },
  }, cast);
  assert.equal(facts.states[0]!.line, '陆嘉静：定约');
  assert.equal(facts.relations[0]!.history.length, 2);
  const writing = collectCanonFacts(chapters, {
    c1: { main_plot: '', character_relations: '', state_refs: [{ line: '第一章独有', character_id: 4 }] },
    c2: { main_plot: '', character_relations: '', state_refs: [{ line: '第二章独有', character_id: 4 }] },
    c3: { main_plot: '', character_relations: '', state_refs: [{ line: '第三章独有', character_id: 4 }] },
  }, cast, 'c2');
  assert.deepEqual(writing.states.map((row) => row.line), ['第一章独有']);
});

test('migration snapshots once and does not refill cleared author fields', async () => {
  const { db, initDb } = await import('../db/database');
  await initDb();
  const project = await db.run(
    'INSERT INTO project (title, settings) VALUES (?, ?)',
    '迁移',
    JSON.stringify({
      main_plot: '### 第1章 · 初章\n\n**角色状态**\n- 陆嘉静：旧状态',
      character_relations: '',
      chapter_impact_entries: {
        chap: { main_plot: '### 第1章 · 初章\n\n**角色状态**\n- 陆嘉静：旧状态', character_relations: '' },
      },
    })
  );
  const projectId = Number(project.lastID);
  const chapterId = randomUUID();
  await db.run(
    'INSERT INTO chapter (id, project_id, "index", title, content, status, finalized_content_hash) VALUES (?, ?, 0, ?, ?, ?, ?)',
    chapterId, projectId, '初章', '正文', 'completed', 'hash'
  );
  await db.run(
    'INSERT INTO character (project_id, name, role, description) VALUES (?, ?, ?, ?)',
    projectId, '陆嘉静', 'main', '本章处于高潮；依据：正文'
  );
  await db.run(
    'INSERT INTO story_plan (project_id, revision, document_json) VALUES (?, 1, ?)',
    projectId,
    JSON.stringify({
      schemaVersion: 1,
      blueprint: {
        title: '迁移', genre: '', style: '', summary: '简介',
        mainPlot: '蓝图走向', initialRelations: '开篇', plannedRelations: '以后',
        characters: [{ name: '陆嘉静', role: 'protagonist', description: '宫主', personality: '克制', growthPath: '成长' }],
        glossary: [],
      },
      targetTotalWords: null, endingPolicy: 'develop', autoCreateNextChapter: false, chapters: [],
    })
  );
  const first = await migrateStoryBible(projectId);
  assert.equal(first.plot_direction, undefined);
  assert.equal((first.story_bible_snapshot as { characters: Array<{ description: string }> }).characters[0]!.description, '本章处于高潮；依据：正文');
  const character = await db.get('SELECT role, description, personality, growth_path FROM character WHERE project_id = ?', projectId);
  assert.equal(character.role, 'main');
  assert.equal(character.description, '本章处于高潮；依据：正文');
  assert.equal(character.personality, null);
  await db.run(
    'UPDATE project SET settings = ? WHERE id = ?',
    JSON.stringify({ ...first, plot_direction: '', personality_note: true }),
    projectId
  );
  await db.run('UPDATE character SET personality = ? WHERE project_id = ?', '', projectId);
  const second = await migrateStoryBible(projectId);
  assert.equal(second.plot_direction, '');
  assert.equal((await db.get('SELECT personality FROM character WHERE project_id = ?', projectId)).personality, '');
});

test('final prompt keeps the story bible inside the total budget and omits later chapters', async () => {
  const { db, initDb } = await import('../db/database');
  await initDb();
  const project = await db.run('INSERT INTO project (title, settings) VALUES (?, ?)', '提示', '{}');
  const projectId = Number(project.lastID);
  const character = await db.run(
    'INSERT INTO character (project_id, name, role, description, personality, growth_path) VALUES (?, ?, ?, ?, ?, ?)',
    projectId, '林格', 'protagonist', '深灰色风衣', '冷静', '走向反抗'
  );
  const characterId = Number(character.lastID);
  const chapterIds = [randomUUID(), randomUUID(), randomUUID()];
  for (let index = 0; index < 3; index += 1) {
    await db.run(
      'INSERT INTO chapter (id, project_id, "index", title, content, status, finalized_content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
      chapterIds[index], projectId, index, `第${index + 1}章`, '正文', 'completed', `h${index}`
    );
  }
  const entry = (line: string) => ({
    main_plot: '',
    character_relations: '',
    state_refs: [{ line, character_id: characterId }],
  });
  await db.run('UPDATE project SET settings = ? WHERE id = ?', JSON.stringify({
    plot_direction: '作者走向独有句',
    initial_relations: '开篇',
    planned_relations: '以后',
    chapter_impact_entries: {
      [chapterIds[0]!]: entry('第一章独有状态'),
      [chapterIds[1]!]: entry('第二章独有状态'),
      [chapterIds[2]!]: entry('第三章独有状态'),
    },
    story_bible_migration: { version: 1, status: 'complete' },
  }), projectId);
  const parts = await loadBibleParts(projectId, chapterIds[1]);
  const rendered = renderStoryBible(parts);
  assert.match(rendered, /作者走向独有句/);
  assert.match(rendered, /第一章独有状态/);
  assert.doesNotMatch(rendered, /第二章独有状态|第三章独有状态/);
  const stuffed = fitPromptToBudget({
    template: '覆盖模板没有主线\n{{memoryPrompt}}\n{{glossary}}\n{{existingContent}}\n{{instructions}}',
    variables: { instructions: '写下去', creativeConstraints: '' },
    bible: {
      ...parts,
      direction: '作者走向独有句'.repeat(40),
      characters: Array.from({ length: 8 }, (_, index) => ({
        id: index + 1,
        name: index === 0 ? '林格' : `配角${index}`,
        role: index === 0 ? 'protagonist' : 'supporting',
        personality: '性格'.repeat(40),
        appearance: '外貌'.repeat(40),
        growth: '成长'.repeat(40),
        state: '状态'.repeat(20),
      })),
    },
    oldSummaries: '梗概'.repeat(500),
    recentCondensed: '浓缩'.repeat(500),
    supplemental: '资料'.repeat(800),
    glossary: '术语'.repeat(400),
    recentFullText: '前文'.repeat(800),
    lastScene: '结尾',
    existingContent: '正文'.repeat(800),
    existingFloor: 800,
  }, (template, variables) => formatPrompt(template, variables));
  assert.match(stuffed.prompt, new RegExp(STORY_BIBLE_HEADER));
  assert.match(stuffed.prompt, /作者走向独有句/);
  assert.match(stuffed.prompt, /林格/);
  assert.ok(stuffed.prompt.length <= PROMPT_CHAR_BUDGET);
});

test('project save ignores a stale canon payload', async () => {
  const { db, initDb } = await import('../db/database');
  await initDb();
  const { projectRoutes } = await import('../routes/projects');
  const project = await db.run('INSERT INTO project (title, settings, user_id) VALUES (?, ?, ?)', '保存', JSON.stringify({
    image_generation: { model: 'pony', workflow_id: null, style: 'ink', output_spec: { aspect_ratio: '16:9', resolution: 'standard', orientation_policy: 'fixed' }, nsfw_mode: 'inherit' },
    chapter_impact_entries: { chap: { main_plot: '最新纪要', character_relations: '' } },
    plot_direction: '已保存走向',
  }), 'local_admin');
  const app = Fastify();
  await app.register(projectRoutes, { prefix: '/api/projects' });
  const response = await app.inject({
    method: 'PUT',
    url: `/api/projects/${project.lastID}`,
    payload: {
      settings: JSON.stringify({
        image_generation: { model: 'pony', workflow_id: null, style: 'ink', output_spec: { aspect_ratio: '16:9', resolution: 'standard', orientation_policy: 'fixed' }, nsfw_mode: 'inherit' },
        chapter_impact_entries: { chap: { main_plot: '页面打开时的旧纪要', character_relations: '' } },
        plot_direction: '页面上的走向',
        genre: '仙侠',
      }),
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const stored = JSON.parse((await db.get('SELECT settings FROM project WHERE id = ?', project.lastID)).settings);
  assert.equal(stored.chapter_impact_entries.chap.main_plot, '最新纪要');
  assert.equal(stored.plot_direction, '页面上的走向');
  assert.equal(stored.genre, '仙侠');
  await app.close();
});
