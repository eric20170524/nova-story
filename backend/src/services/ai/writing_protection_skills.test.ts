import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = ':memory:';

test('BE-A1: 超预算章/集的尾部哨兵不会因技能改写而丢失 (需分段或缩小选区)', async () => {
  const [{ db, initDb }, { AgentExecutor }, { LLMService }] = await Promise.all([
    import('../../db/database'),
    import('./agent_executor'),
    import('../llm'),
  ]);

  await initDb();

  const projectResult = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Budget Sentinel Test',
    'desc',
    JSON.stringify({
      genre: '悬疑',
      content_form: 'short_novel',
    }),
    'local_admin'
  );
  const projectId = Number(projectResult.lastID);
  const chapterId = `ch-overbudget-${Date.now()}`;

  // 4200 chars (> 3500 skill budget) with tail sentinel
  const baseText = '这是一段很长的章节正文用于测试超预算保护。'.repeat(180);
  const tailSentinel = '\n[TAIL_SENTINEL_SKILL_OVERBUDGET_EVENT_2026]';
  const longContent = baseText + tailSentinel;
  assert.ok(longContent.length > 3500, `Text must be > 3500, got ${longContent.length}`);

  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, ?, ?, ?, 'draft')`,
    chapterId,
    projectId,
    '超预算测试章',
    longContent,
    '本章概要'
  );

  // Attempt ADD_CONFLICT with apply: true
  const conflictResult = await AgentExecutor.executeAll(
    [
      {
        op: 'ADD_CONFLICT',
        conflictType: 'extreme_pressure',
        intensity: 'high',
        instructions: '增加生存危机，保留尾部事件',
        targetChapterId: chapterId,
      },
    ],
    { projectId, chapterId, apply: true }
  );

  assert.equal(conflictResult[0]?.status, 'error');
  assert.match(String(conflictResult[0]?.message), /需分段或缩小选区/);

  // DB content must be verbatim identical, tail sentinel must NOT disappear
  const afterConflict = await db.get('SELECT content FROM chapter WHERE id = ?', chapterId);
  assert.equal(afterConflict.content, longContent);
  assert.ok(afterConflict.content.includes(tailSentinel));

  // Attempt CINEMATIC_REWRITE with apply: true
  const cinematicResult = await AgentExecutor.executeAll(
    [
      {
        op: 'CINEMATIC_REWRITE',
        technique: 'sensory',
        instructions: '增强感官描写',
        targetChapterId: chapterId,
      },
    ],
    { projectId, chapterId, apply: true }
  );

  assert.equal(cinematicResult[0]?.status, 'error');
  assert.match(String(cinematicResult[0]?.message), /需分段或缩小选区/);

  const afterCinematic = await db.get('SELECT content FROM chapter WHERE id = ?', chapterId);
  assert.equal(afterCinematic.content, longContent);
  assert.ok(afterCinematic.content.includes(tailSentinel));

  // Attempt REVERSE_PLOT with apply: true
  const reversalResult = await AgentExecutor.executeAll(
    [
      {
        op: 'REVERSE_PLOT',
        reversalType: 'motive_switch',
        instructions: '反转动机',
        targetChapterId: chapterId,
      },
    ],
    { projectId, chapterId, apply: true }
  );

  assert.equal(reversalResult[0]?.status, 'error');
  assert.match(String(reversalResult[0]?.message), /需分段或缩小选区/);

  const afterReversal = await db.get('SELECT content FROM chapter WHERE id = ?', chapterId);
  assert.equal(afterReversal.content, longContent);
  assert.ok(afterReversal.content.includes(tailSentinel));
});

test('BE-A1: 全文重写超过 6000 字预算时拒绝覆盖并保留尾部哨兵', async () => {
  const [{ db, initDb }, { AgentExecutor }] = await Promise.all([
    import('../../db/database'),
    import('./agent_executor'),
  ]);

  await initDb();

  const projectResult = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Rewrite Budget Test',
    'desc',
    JSON.stringify({
      genre: '都市',
      content_form: 'short_novel',
    }),
    'local_admin'
  );
  const projectId = Number(projectResult.lastID);
  const chapterId = `ch-rewrite-overbudget-${Date.now()}`;

  // 6500 chars (> 6000 rewrite budget) with tail sentinel
  const baseText = '这是一段超长章节正文，用于验证全文重写不发生静默截断覆盖。'.repeat(210);
  const tailSentinel = '\n[TAIL_SENTINEL_REWRITE_OVERBUDGET_EVENT_2026]';
  const longContent = baseText + tailSentinel;
  assert.ok(longContent.length > 6000, `Text must be > 6000, got ${longContent.length}`);

  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, ?, ?, ?, 'draft')`,
    chapterId,
    projectId,
    '超长重写章',
    longContent,
    '测试概要'
  );

  const rewriteResult = await AgentExecutor.executeAll(
    [
      {
        op: 'DRAFT_CONTENT',
        instructions: '全文重写为小说体，删除所有画面动作指令',
        targetChapterId: chapterId,
      },
    ],
    { projectId, chapterId, apply: true }
  );

  assert.equal(rewriteResult[0]?.status, 'error');
  assert.match(String(rewriteResult[0]?.message), /需分段或缩小选区/);

  const afterRewrite = await db.get('SELECT content FROM chapter WHERE id = ?', chapterId);
  assert.equal(afterRewrite.content, longContent);
  assert.ok(afterRewrite.content.includes(tailSentinel));
});

test('BE-A1: 三类技能 Prompt 均包含用户指令、下一章边界、作品形态和已采纳设定', async () => {
  const [{ db, initDb }, { WritingService }, { LLMService }] = await Promise.all([
    import('../../db/database'),
    import('./writing_service'),
    import('../llm'),
  ]);

  await initDb();

  const projectResult = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Prompt Inspection Project',
    '测试项目描述',
    JSON.stringify({
      genre: '科幻悬疑',
      style: '硬核现实',
      main_plot: '探索废弃空间站的秘密核心',
      content_form: 'short_drama',
    }),
    'local_admin'
  );
  const projectId = Number(projectResult.lastID);
  const ch1Id = `ch1-${Date.now()}`;
  const ch2Id = `ch2-${Date.now()}`;

  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, '第一集：登舰', '主角踏入气闸舱，听到金属挤压的回声。', '登上空间站', 'draft')`,
    ch1Id,
    projectId
  );
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 2, '第二集：暗流', '', '在反应堆区域遭遇未知的仿生机械体。', 'draft')`,
    ch2Id,
    projectId
  );

  let capturedPrompt = '';
  const originalGetProvider = LLMService.getProvider;
  (LLMService as any).getProvider = () => ({
    generateText: async (prompt: string) => {
      capturedPrompt = prompt;
      return '生成改写正文片段';
    },
  });

  try {
    // 1. CINEMATIC_REWRITE
    await WritingService.executeSkill({
      projectId,
      chapterId: ch1Id,
      skill: {
        op: 'CINEMATIC_REWRITE',
        technique: 'sensory',
        instructions: '强化气闸舱内外气压差与呼吸声',
      },
    });
    assert.match(capturedPrompt, /强化气闸舱内外气压差与呼吸声/);
    assert.match(capturedPrompt, /NEGATIVE CONSTRAINTS/);
    assert.match(capturedPrompt, /在反应堆区域遭遇未知的仿生机械体/);
    assert.match(capturedPrompt, /短篇小说/);
    assert.match(capturedPrompt, /探索废弃空间站的秘密核心/);

    // 2. ADD_CONFLICT
    capturedPrompt = '';
    await WritingService.executeSkill({
      projectId,
      chapterId: ch1Id,
      skill: {
        op: 'ADD_CONFLICT',
        conflictType: 'extreme_pressure',
        intensity: 'high',
        instructions: '氧气阀门被锁死，必须在两分钟内解锁',
      },
    });
    assert.match(capturedPrompt, /氧气阀门被锁死，必须在两分钟内解锁/);
    assert.match(capturedPrompt, /NEGATIVE CONSTRAINTS/);
    assert.match(capturedPrompt, /在反应堆区域遭遇未知的仿生机械体/);
    assert.match(capturedPrompt, /短篇小说/);
    assert.match(capturedPrompt, /探索废弃空间站的秘密核心/);

    // 3. REVERSE_PLOT
    capturedPrompt = '';
    await WritingService.executeSkill({
      projectId,
      chapterId: ch1Id,
      skill: {
        op: 'REVERSE_PLOT',
        reversalType: 'motive_switch',
        targetCharacter: 'AI导航员',
        instructions: 'AI导航员引导主角并非救援而是封锁',
      },
    });
    assert.match(capturedPrompt, /AI导航员引导主角并非救援而是封锁/);
    assert.match(capturedPrompt, /NEGATIVE CONSTRAINTS/);
    assert.match(capturedPrompt, /在反应堆区域遭遇未知的仿生机械体/);
    assert.match(capturedPrompt, /短篇小说/);
    assert.match(capturedPrompt, /探索废弃空间站的秘密核心/);
  } finally {
    (LLMService as any).getProvider = originalGetProvider;
  }
});

test('BE-A1: 模型空响应或抛出异常时 DB 正文逐字不变', async () => {
  const [{ db, initDb }, { AgentExecutor }, { LLMService }] = await Promise.all([
    import('../../db/database'),
    import('./agent_executor'),
    import('../llm'),
  ]);

  await initDb();

  const projectResult = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Empty Response Protection Test',
    'desc',
    JSON.stringify({ genre: '悬疑', content_form: 'short_novel' }),
    'local_admin'
  );
  const projectId = Number(projectResult.lastID);
  const chapterId = `ch-empty-${Date.now()}`;
  const originalContent = '原始正文第 1 段。\n原始正文第 2 段。\n[DO_NOT_ERASE_THIS]';

  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, '测试章', ?, '本章概要', 'draft')`,
    chapterId,
    projectId,
    originalContent
  );

  const originalGetProvider = LLMService.getProvider;

  // Case 1: Model returns empty text
  (LLMService as any).getProvider = () => ({
    generateText: async () => '   <think>only thinking</think>   ',
  });

  try {
    const resSkill = await AgentExecutor.executeAll(
      [
        {
          op: 'ADD_CONFLICT',
          conflictType: 'extreme_pressure',
          instructions: '测试空输出',
          targetChapterId: chapterId,
        },
      ],
      { projectId, chapterId, apply: true }
    );
    assert.equal(resSkill[0]?.status, 'error');

    let row = await db.get('SELECT content FROM chapter WHERE id = ?', chapterId);
    assert.equal(row.content, originalContent);

    const resDraft = await AgentExecutor.executeAll(
      [
        {
          op: 'DRAFT_CONTENT',
          instructions: '全文重写测试空输出',
          targetChapterId: chapterId,
        },
      ],
      { projectId, chapterId, apply: true }
    );
    assert.equal(resDraft[0]?.status, 'error');

    row = await db.get('SELECT content FROM chapter WHERE id = ?', chapterId);
    assert.equal(row.content, originalContent);
  } finally {
    (LLMService as any).getProvider = originalGetProvider;
  }

  // Case 2: Model throws an exception (network failure / timeout)
  (LLMService as any).getProvider = () => ({
    generateText: async () => {
      throw new Error('Connection refused / timeout');
    },
  });

  try {
    const resFail = await AgentExecutor.executeAll(
      [
        {
          op: 'CINEMATIC_REWRITE',
          technique: 'sensory',
          instructions: '测试异常',
          targetChapterId: chapterId,
        },
      ],
      { projectId, chapterId, apply: true }
    );
    assert.equal(resFail[0]?.status, 'error');

    const row = await db.get('SELECT content FROM chapter WHERE id = ?', chapterId);
    assert.equal(row.content, originalContent);
  } finally {
    (LLMService as any).getProvider = originalGetProvider;
  }
});

test('BE-A1: 正文生成成功但元数据生成抛错时 DB 正文及浓缩摘要保持逐字不变', async () => {
  const [
    { default: Fastify },
    { db, initDb },
    { AgentExecutor },
    { WritingService },
    { LLMService },
    { creativeRoutes },
  ] = await Promise.all([
    import('fastify'),
    import('../../db/database'),
    import('./agent_executor'),
    import('./writing_service'),
    import('../llm'),
    import('../../routes/creative'),
  ]);

  await initDb();

  const projectResult = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Metadata Failure Protection Test',
    'desc',
    JSON.stringify({ genre: '科幻', content_form: 'short_novel' }),
    'local_admin'
  );
  const projectId = Number(projectResult.lastID);
  const chapterId = `ch-meta-fail-${Date.now()}`;
  const originalContent = '第一段原有正文内容。\n第二段原有正文内容。\n[VERBATIM_ORIGINAL_CONTENT_SAFEGUARD]';
  const originalCondensed = '原有初始浓缩摘要';

  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, condensed_content, status)
     VALUES (?, ?, 1, '元数据保护章', ?, '本章概要', ?, 'draft')`,
    chapterId,
    projectId,
    originalContent,
    originalCondensed
  );

  const originalGetProvider = LLMService.getProvider;
  const originalGenerateCondensed = WritingService.generateCondensedForContent;

  // Mock text generation to SUCCEED
  (LLMService as any).getProvider = () => ({
    generateText: async () => '【新生成的章节扩写正文片段，如果写库就违背原则】',
  });

  // Mock metadata generation to FAIL (throw Error)
  WritingService.generateCondensedForContent = async () => {
    throw new Error('LLM structured metadata parse failed / network timeout');
  };

  try {
    // 1. Test AgentExecutor DRAFT_CONTENT with apply: true
    const agentResult = await AgentExecutor.executeAll(
      [
        {
          op: 'DRAFT_CONTENT',
          instructions: '扩写本章',
          targetChapterId: chapterId,
        },
      ],
      { projectId, chapterId, apply: true }
    );

    assert.equal(agentResult[0]?.status, 'error');
    assert.match(String(agentResult[0]?.message), /LLM structured metadata parse failed/);

    // Verify DB content and condensed_content are completely unchanged
    let row = await db.get('SELECT content, condensed_content FROM chapter WHERE id = ?', chapterId);
    assert.equal(row.content, originalContent, 'DB content must remain verbatim unchanged when metadata generation fails');
    assert.equal(row.condensed_content, originalCondensed, 'condensed_content must remain unchanged');

    // 2. Test Fastify /api/agent/draft route with apply: true
    const app = Fastify();
    await app.register(creativeRoutes, { prefix: '/api/agent' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent/draft',
      payload: {
        project_id: projectId,
        chapter_id: chapterId,
        instructions: '路由续写测试',
        apply: true,
      },
    });

    assert.equal(response.statusCode, 500);

    // Verify DB content and condensed_content are still completely unchanged
    row = await db.get('SELECT content, condensed_content FROM chapter WHERE id = ?', chapterId);
    assert.equal(row.content, originalContent, 'DB content must remain verbatim unchanged after route failure');
    assert.equal(row.condensed_content, originalCondensed);

    await app.close();
  } finally {
    (LLMService as any).getProvider = originalGetProvider;
    WritingService.generateCondensedForContent = originalGenerateCondensed;
  }
});

test('BE-C5/S0: 故事创作正文提示词职责收口为小说叙述体，禁止将短剧剧本分镜标签混入 chapter.content', async () => {
  const [{ db, initDb }, { WritingService }, { AgentExecutor }, { LLMService }] =
    await Promise.all([
      import('../../db/database'),
      import('./writing_service'),
      import('./agent_executor'),
      import('../llm'),
    ]);

  await initDb();

  // 1. Create project with content_form = 'short_drama'
  const dramaProject = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Drama Project Boundary Test',
    '短剧测试',
    JSON.stringify({
      genre: '都市战神',
      style: '爽快节奏',
      content_form: 'short_drama',
    }),
    'local_admin'
  );
  const dramaProjectId = Number(dramaProject.lastID);
  const dramaChapterId = `ch-drama-${Date.now()}`;
  const initialDramaContent = '林天阔步走出舷梯，目光如刀。';
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, '第一集：龙王回归', ?, '回归', 'draft')`,
    dramaChapterId,
    dramaProjectId,
    initialDramaContent
  );

  // 2. Create project with content_form = 'short_novel'
  const novelProject = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Novel Project Boundary Test',
    '短篇小说测试',
    JSON.stringify({
      genre: '悬疑推理解谜',
      style: '冷硬现实',
      content_form: 'short_novel',
    }),
    'local_admin'
  );
  const novelProjectId = Number(novelProject.lastID);
  const novelChapterId = `ch-novel-${Date.now()}`;
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, '第一章：雨夜访客', '雨水顺着房檐滴在青石板上。', '访客', 'draft')`,
    novelChapterId,
    novelProjectId
  );

  let capturedPrompt = '';
  const originalGetProvider = LLMService.getProvider;
  (LLMService as any).getProvider = () => ({
    generateText: async (prompt: string) => {
      capturedPrompt = prompt;
      return '测试生成正文内容';
    },
  });

  try {
    // 1. Check dramaProject generateChapterDraft:
    // Even if content_form === 'short_drama', story chapter draft MUST be novel narrative prose,
    // not short drama screenplay format (short drama screenplay is isolated in Track 5 ScriptDocument).
    await WritingService.generateChapterDraft({
      projectId: dramaProjectId,
      chapterId: dramaChapterId,
      instructions: '撰写集首冲突',
      mode: 'rewrite',
    });

    assert.match(capturedPrompt, /短篇小说（小说叙述与对话）/);
    assert.match(capturedPrompt, /小说叙述体规范/);
    assert.match(capturedPrompt, /禁止输出【场景】【画面】【动作指令】【视觉特效】等分镜\/剧本标签/);

    // 2. Check dramaProject AgentExecutor rewrite:
    capturedPrompt = '';
    await AgentExecutor.executeAll(
      [
        {
          op: 'DRAFT_CONTENT',
          instructions: '全文重写为规范正文',
          targetChapterId: dramaChapterId,
        },
      ],
      { projectId: dramaProjectId, chapterId: dramaChapterId, apply: false }
    );
    assert.match(capturedPrompt, /【强制格式】输出完整小说正文：禁止保留【场景】【画面】【动作指令】【视觉特效】等分镜\/剧本标签/);

    // 3. Check novelProject generateChapterDraft:
    capturedPrompt = '';
    await WritingService.generateChapterDraft({
      projectId: novelProjectId,
      chapterId: novelChapterId,
      instructions: '重写雨夜描写',
      mode: 'rewrite',
    });

    assert.match(capturedPrompt, /短篇小说（小说叙述与对话）/);
    assert.match(capturedPrompt, /小说叙述体规范/);
    assert.match(capturedPrompt, /禁止输出【场景】【画面】【动作指令】【视觉特效】等分镜\/剧本标签/);

    // 4. Check existing content in short_drama project is not corrupted
    const dramaRow = await db.get('SELECT content FROM chapter WHERE id = ?', dramaChapterId);
    assert.equal(dramaRow.content, initialDramaContent);
  } finally {
    (LLMService as any).getProvider = originalGetProvider;
  }
});
