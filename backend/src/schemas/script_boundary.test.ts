import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = ':memory:';

test('S0 - Contract: ScriptDocument Schema validation, confirmation rules, and serialization', async () => {
  const {
    ScriptDocumentSchema,
    createEmptyScriptDocument,
    validateScriptForConfirmation,
    computeSourceContentHash,
    computeSourceContextHash,
    serializeScriptToMarkdown,
  } = await import('./script');

  // 1. Empty draft document
  const emptyDoc = createEmptyScriptDocument('第1集：龙王降临', { targetDurationSec: 120 });
  const parsedEmpty = ScriptDocumentSchema.safeParse(emptyDoc);
  assert.ok(parsedEmpty.success, 'Empty draft document must be valid ScriptDocument');
  assert.equal(parsedEmpty.data.title, '第1集：龙王降临');
  assert.equal(parsedEmpty.data.scenes.length, 0);

  // Outline-only document cannot be confirmed or handed over to director
  const emptyConfirmCheck = validateScriptForConfirmation(parsedEmpty.data);
  assert.equal(emptyConfirmCheck.valid, false);
  assert.match(emptyConfirmCheck.errors[0] || '', /剧本正文至少需要包含一场戏/);

  // 2. Full structured document with scenes, actions, dialogues, voiceovers
  const fullDoc = {
    schemaVersion: 1,
    title: '第1集：决战前夕',
    targetDurationSec: 120,
    outline: {
      logline: '退隐兵王为救养女重出江湖，击溃黑龙会前哨。',
      mustKeepEvents: [
        { id: 'ev_1', text: '主角收到养女求救信物', sourceParagraphIds: ['p_1', 'p_2'] },
        { id: 'ev_2', text: '主角击退黑龙会探子并夺回信物', sourceParagraphIds: ['p_3'] },
      ],
      beats: [
        { id: 'beat_1', purpose: '开场危机与信物出现', eventIds: ['ev_1'] },
        { id: 'beat_2', purpose: '正面交锋与夺取情报', eventIds: ['ev_2'] },
      ],
      endingHook: '信物背后刻着黑龙会总舵密令。',
    },
    locations: [
      { id: 'loc_bar', name: '破败小酒馆', description: '昏暗灯光，空气中弥漫着廉价威士忌和烟草味' },
      { id: 'loc_alley', name: '雨夜后巷', description: '积水坑倒映霓虹灯，垃圾箱堆积' },
    ],
    props: [
      { id: 'prop_locket', name: '银色怀表信物', description: '表面有弹痕刮擦的怀表' },
    ],
    scenes: [
      {
        id: 'sc_1',
        beatIds: ['beat_1'],
        eventIds: ['ev_1'],
        sourceParagraphIds: ['p_1', 'p_2'],
        locationId: 'loc_bar',
        interiorExterior: 'interior' as const,
        timeOfDay: 'night',
        characterIds: [101, 102],
        propIds: ['prop_locket'],
        blocks: [
          { id: 'b_101', type: 'action' as const, text: '林天擦拭着酒杯，手指忽然停顿。' },
          { id: 'b_102', type: 'dialogue' as const, characterId: 102, text: '林哥，外面有人送来这个。', delivery: '神色慌张' },
          { id: 'b_103', type: 'sound' as const, text: '怀表重重砸在吧台上的脆响' },
          { id: 'b_104', type: 'dialogue' as const, characterId: 101, text: '谁送来的？', delivery: '压抑怒火' },
        ],
        estimatedDurationSec: 45,
      },
      {
        id: 'sc_2',
        beatIds: ['beat_2'],
        eventIds: ['ev_2'],
        sourceParagraphIds: ['p_3'],
        locationId: 'loc_alley',
        interiorExterior: 'exterior' as const,
        timeOfDay: 'night',
        characterIds: [101, 103],
        propIds: [],
        blocks: [
          { id: 'b_201', type: 'action' as const, text: '黑衣杀手拔出短刀，雨水沿着刀刃滴落。' },
          { id: 'b_202', type: 'voiceover' as const, characterId: 101, text: '三年前我饶过他们一次，但这次他们踩了底线。' },
          { id: 'b_203', type: 'dialogue' as const, characterId: 103, text: '把怀表交出来，留你全尸！' },
          { id: 'b_204', type: 'action' as const, text: '林天瞬身向前，反手擒拿扣碎对方手腕。' },
        ],
        estimatedDurationSec: 55,
      },
    ],
  };

  const parseResult = ScriptDocumentSchema.safeParse(fullDoc);
  assert.ok(parseResult.success, 'Full valid ScriptDocument must pass validation');

  // Confirmation validation must pass
  const confirmCheck = validateScriptForConfirmation(parseResult.data);
  assert.equal(confirmCheck.valid, true, 'Valid structured document must pass confirmation check');
  assert.equal(confirmCheck.errors.length, 0);

  // 3. Validation failure: Scene with only sound blocks
  const soundOnlyDoc = JSON.parse(JSON.stringify(fullDoc));
  soundOnlyDoc.scenes[1].blocks = [{ id: 'b_sound_only', type: 'sound', text: '雷声轰鸣' }];
  const soundOnlyCheck = validateScriptForConfirmation(soundOnlyDoc);
  assert.equal(soundOnlyCheck.valid, false);
  assert.ok(soundOnlyCheck.errors.some((e: string) => e.includes('不能单独由音效 (sound) 充当整场戏')));

  // 4. Validation failure: Duplicate scene IDs
  const duplicateSceneDoc = JSON.parse(JSON.stringify(fullDoc));
  duplicateSceneDoc.scenes[1].id = duplicateSceneDoc.scenes[0].id;
  const dupSceneCheck = validateScriptForConfirmation(duplicateSceneDoc);
  assert.equal(dupSceneCheck.valid, false);
  assert.ok(dupSceneCheck.errors.some((e: string) => e.includes('重复出现')));

  // 5. Validation failure: Duplicate block IDs
  const duplicateBlockDoc = JSON.parse(JSON.stringify(fullDoc));
  duplicateBlockDoc.scenes[1].blocks[0].id = duplicateBlockDoc.scenes[0].blocks[0].id;
  const dupBlockCheck = validateScriptForConfirmation(duplicateBlockDoc);
  assert.equal(dupBlockCheck.valid, false);
  assert.ok(dupBlockCheck.errors.some((e: string) => e.includes('重复出现')));

  // 5.1 SC02 Reference Validation: characterId=999999, empty cast, nonexistent location
  const invalidRefDoc = {
    schemaVersion: 1,
    title: '无效引用测试',
    targetDurationSec: 120,
    outline: { logline: '', mustKeepEvents: [], beats: [], endingHook: '' },
    locations: [{ id: 'loc_real', name: '真实地点', description: '' }],
    props: [],
    scenes: [
      {
        id: 'sc_invalid_ref',
        beatIds: [],
        eventIds: [],
        sourceParagraphIds: [],
        locationId: 'loc_nonexistent',
        interiorExterior: 'interior' as const,
        timeOfDay: 'day',
        characterIds: [], // Empty cast!
        propIds: [],
        blocks: [
          {
            id: 'b_dia_invalid',
            type: 'dialogue' as const,
            characterId: 999999, // Unknown character, not in cast!
            text: '有人在吗？',
          },
        ],
      },
    ],
  };

  // Schema must reject this invalid document
  const schemaParse = ScriptDocumentSchema.safeParse(invalidRefDoc);
  assert.equal(schemaParse.success, false, 'Schema must reject unreferenced location and dialogue character not in cast');

  // Confirmation validation must reject this invalid document with detailed reference errors
  const confirmRefCheck = validateScriptForConfirmation(invalidRefDoc as any, {
    validProjectCharacterIds: new Set([101, 102]), // 999999 does not belong to project
  });
  assert.equal(confirmRefCheck.valid, false);
  assert.ok(confirmRefCheck.errors.some((e: string) => e.includes('未在剧本地点列表 (locations) 中声明')));
  assert.ok(confirmRefCheck.errors.some((e: string) => e.includes('未包含在当前场出场角色名单 (characterIds) 中')));
  assert.ok(confirmRefCheck.errors.some((e: string) => e.includes('不属于当前项目角色中心')));

  // 6. Deterministic Hashing
  const hash1 = computeSourceContentHash('第1章正文内容\n第二行。');
  const hash2 = computeSourceContentHash('第1章正文内容\r\n第二行。  ');
  assert.equal(hash1, hash2, 'Content hash must normalize line endings and trim spaces');

  const contextHash1 = computeSourceContextHash({
    characters: [{ name: '林天', role: 'main' }, { name: '老周', role: 'supporting' }],
    glossary: [{ term: '黑龙会', definition: '犯罪组织' }],
    bible: { genre: '都市战神', style: '冷硬' },
  });
  const contextHash2 = computeSourceContextHash({
    characters: [{ name: '老周', role: 'supporting' }, { name: '林天', role: 'main' }],
    glossary: [{ term: '黑龙会', definition: '犯罪组织' }],
    bible: { genre: '都市战神', style: '冷硬' },
  });
  assert.equal(contextHash1, contextHash2, 'Context hash must be order-independent for characters');

  // 7. Markdown Serialization
  const charMap = new Map<number, string>([
    [101, '林天'],
    [102, '老周'],
    [103, '黑衣杀手'],
  ]);
  const markdown = serializeScriptToMarkdown(parseResult.data, {
    status: 'confirmed',
    chapterTitle: '第1章：血色归途',
    characterNameMap: charMap,
  });

  assert.ok(markdown.includes('# 第1集：决战前夕'));
  assert.ok(markdown.includes('**状态**：已确认'));
  assert.ok(markdown.includes('### 第 1 场：破败小酒馆 · 内景 · night'));
  assert.ok(markdown.includes('**老周**（神色慌张）：林哥，外面有人送来这个。'));
  assert.ok(markdown.includes('【画外音·林天】三年前我饶过他们一次'));
  assert.ok(markdown.includes('【动作】林天擦拭着酒杯'));
  assert.ok(markdown.includes('【音效】怀表重重砸在吧台上的脆响'));
});

test('S0 / SC12: Agent routing and execution boundary isolation between novel story and screenplay', async () => {
  const [
    { db, initDb },
    { AgentExecutor, resolveScriptSceneTarget },
    { resolveAgentRoute },
    { tryIntentShortcut, routeToActions },
  ] = await Promise.all([
    import('../db/database'),
    import('../services/ai/agent_executor'),
    import('../services/ai/agent_route'),
    import('./agent_os'),
  ]);

  await initDb();

  // Create Project A
  const projectAResult = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Project A (Main)',
    'desc',
    JSON.stringify({ genre: '悬疑', content_form: 'short_novel' }),
    'local_admin'
  );
  const projectAId = Number(projectAResult.lastID);
  const chAId = `ch-a-${Date.now()}`;
  const initialStoryContentA = '这是项目A的第一章小说正文。绝不能被剧本改写覆盖。';
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, '第一章：迷局', ?, '概要A', 'draft')`,
    chAId,
    projectAId,
    initialStoryContentA
  );

  // Create Project B
  const projectBResult = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Project B (Foreign)',
    'desc',
    JSON.stringify({ genre: '科幻', content_form: 'short_novel' }),
    'local_admin'
  );
  const projectBId = Number(projectBResult.lastID);
  const chBId = `ch-b-${Date.now()}`;
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, '第一章：异星', '这是项目B的正文。', '概要B', 'draft')`,
    chBId,
    projectBId
  );

  // 1. Test Router under surface=script (routeHint='script'):
  // A "改写第2场" or "改写这一场" or "改写" intent MUST route to REWRITE_SCRIPT_SCENE, NOT CINEMATIC_REWRITE or DRAFT_CONTENT!
  const routeScriptRewrite = await resolveAgentRoute({
    userMessage: '改写第2场，增强动作冲突',
    chapterId: chAId,
    routeHint: 'script',
  });
  assert.ok(routeScriptRewrite, 'Route must resolve');
  assert.equal(routeScriptRewrite.route.intent, 'REWRITE_SCRIPT_SCENE');
  assert.equal(routeScriptRewrite.route.focus, '第2场');
  const rewriteActions = routeToActions(routeScriptRewrite.route, {
    chapterId: chAId,
    userMessage: '改写第2场，增强动作冲突',
  });
  assert.equal(rewriteActions[0]?.scriptSceneId, undefined);
  assert.equal(tryIntentShortcut('优化一下钩子', null, 'script'), null);
  assert.equal(
    resolveScriptSceneTarget(
      [{ id: 'sc_a' }, { id: 'sc_b' }],
      { actionSceneId: '第2场', instructions: '改写第2场', contextSceneId: 'sc_a' }
    ),
    'sc_b'
  );
  assert.equal(
    resolveScriptSceneTarget(
      [{ id: 'sc_a' }, { id: 'sc_b' }],
      {
        instructions: '改写当前选定分场的动作与对白，不影响其他分场',
        contextSceneId: 'sc_b',
      }
    ),
    'sc_b'
  );
  assert.equal(
    resolveScriptSceneTarget(
      [{ id: 'sc_a' }],
      { actionSceneId: '优化一下钩子', instructions: '优化一下钩子', contextSceneId: 'sc_a' }
    ),
    null
  );

  const routeScriptOutline = await resolveAgentRoute({
    userMessage: '生成本章短剧改编提纲',
    chapterId: chAId,
    routeHint: 'script',
  });
  assert.ok(routeScriptOutline);
  assert.equal(routeScriptOutline.route.intent, 'GENERATE_SCRIPT_OUTLINE');

  const routeScriptGenerate = await resolveAgentRoute({
    userMessage: '生成完整分场短剧剧本',
    chapterId: chAId,
    routeHint: 'script',
  });
  assert.ok(routeScriptGenerate);
  assert.equal(routeScriptGenerate.route.intent, 'GENERATE_SCRIPT');

  // 2. Test Router under surface=story (routeHint='story'):
  // "改写" on story surface routes to CINEMATIC_REWRITE
  const routeStoryRewrite = await resolveAgentRoute({
    userMessage: '电影化感官改写本章',
    chapterId: chAId,
    routeHint: 'story',
  });
  assert.ok(routeStoryRewrite);
  assert.equal(routeStoryRewrite.route.intent, 'CINEMATIC_REWRITE');

  // 3. SC12: AgentExecutor guard: If surface === 'script', calling novel rewrite skills (CINEMATIC_REWRITE / DRAFT_CONTENT) is REJECTED
  const blockedSkillResult = await AgentExecutor.executeAll(
    [
      {
        op: 'CINEMATIC_REWRITE',
        technique: 'sensory',
        instructions: '测试非法调用小说技能',
        targetChapterId: chAId,
      },
    ],
    { projectId: projectAId, chapterId: chAId, surface: 'script', apply: true }
  );
  assert.equal(blockedSkillResult[0]?.status, 'error');
  assert.match(String(blockedSkillResult[0]?.message), /在剧本页面禁止直接调用小说正文技能覆盖章节/);

  const blockedDraftResult = await AgentExecutor.executeAll(
    [
      {
        op: 'DRAFT_CONTENT',
        instructions: '全文重写为小说体',
        targetChapterId: chAId,
      },
    ],
    { projectId: projectAId, chapterId: chAId, surface: 'script', apply: true }
  );
  assert.equal(blockedDraftResult[0]?.status, 'error');
  assert.match(String(blockedDraftResult[0]?.message), /在剧本页面禁止直接调用小说正文重写或续写/);

  // Novel chapter body in DB MUST remain completely unchanged (SC01)
  const afterBlockedCheck = await db.get('SELECT content FROM chapter WHERE id = ?', chAId);
  assert.equal(afterBlockedCheck.content, initialStoryContentA, 'Novel chapter content must remain 100% unchanged');

  // 4. SC12: Cross-project reference rejection
  // Project A attempting to execute an action targeting Chapter B (belongs to Project B)
  const crossProjectResult = await AgentExecutor.executeAll(
    [
      {
        op: 'CINEMATIC_REWRITE',
        technique: 'sensory',
        instructions: '跨项目篡改',
        targetChapterId: chBId, // Belongs to Project B!
      },
    ],
    { projectId: projectAId, chapterId: chAId, surface: 'story', apply: true }
  );
  assert.equal(crossProjectResult[0]?.status, 'error');
  assert.match(String(crossProjectResult[0]?.message), /Cross-project chapter reference rejected/);

  // Also check DRAFT_CONTENT cross project
  const crossProjectDraft = await AgentExecutor.executeAll(
    [
      {
        op: 'DRAFT_CONTENT',
        instructions: '跨项目续写',
        targetChapterId: chBId,
      },
    ],
    { projectId: projectAId, chapterId: chAId, surface: 'story', apply: true }
  );
  assert.equal(crossProjectDraft[0]?.status, 'error');
  assert.match(String(crossProjectDraft[0]?.message), /Cross-project chapter reference rejected/);

  // Verify Chapter B content remains completely untouched
  const chapterBRow = await db.get('SELECT content FROM chapter WHERE id = ?', chBId);
  assert.equal(chapterBRow.content, '这是项目B的正文。');

  // 5. SC12: Protection when executeAgentActions context.surface is undefined but action has surface='script' (P1-2 fix)
  const leftoverScriptActionSkill = await AgentExecutor.executeAll(
    [
      {
        op: 'CINEMATIC_REWRITE',
        technique: 'sensory',
        instructions: '遗留动作试图覆盖小说正文',
        targetChapterId: chAId,
        surface: 'script', // Action planned on script page!
      },
    ],
    // Simulating context where surface is undefined or user switched to story page
    { projectId: projectAId, chapterId: chAId, surface: undefined, apply: true }
  );
  assert.equal(leftoverScriptActionSkill[0]?.status, 'error');
  assert.match(String(leftoverScriptActionSkill[0]?.message), /在剧本页面禁止直接调用小说正文技能覆盖章节/);

  const leftoverScriptActionDraft = await AgentExecutor.executeAll(
    [
      {
        op: 'DRAFT_CONTENT',
        instructions: '遗留草稿动作试图覆盖小说正文',
        targetChapterId: chAId,
        surface: 'script',
      },
    ],
    { projectId: projectAId, chapterId: chAId, surface: undefined, apply: true }
  );
  assert.equal(leftoverScriptActionDraft[0]?.status, 'error');
  assert.match(String(leftoverScriptActionDraft[0]?.message), /在剧本页面禁止直接调用小说正文重写或续写/);

  // 6. Script Agent Ops in S2 invoke ScriptGenerationService (creates pending candidates without touching novel prose)
  const mockOutlineProvider = {
    name: 'mock',
    generate: async () => '',
    generateStructured: async () => ({
      logline: '边界测试提纲',
      mustKeepEvents: [{ id: 'e1', text: '事' }],
      beats: [{ id: 'b1', purpose: '节拍', eventIds: ['e1'] }],
      endingHook: '钩子',
    }),
  } as any;

  const scriptOpsResult = await AgentExecutor.executeAll(
    [
      { op: 'GENERATE_SCRIPT_OUTLINE', chapterId: chAId, instructions: '生成提纲' },
    ],
    { projectId: projectAId, chapterId: chAId, surface: 'script', apply: true, provider: mockOutlineProvider }
  );
  assert.equal(scriptOpsResult[0]?.status, 'success');
  assert.match(String(scriptOpsResult[0]?.message), /已生成短剧改编提纲候选/);

  // Verify novel prose was completely untouched
  const finalChA = (await db.get('SELECT content FROM chapter WHERE id = ?', chAId)) as any;
  assert.equal(finalChA.content, '这是项目A的第一章小说正文。绝不能被剧本改写覆盖。');
});
