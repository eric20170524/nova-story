import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentActionSchema,
  AgentOsDecisionSchema,
  AgentRouteSchema,
  needsConfirmation,
  normalizeAgentAction,
  normalizeAgentDecision,
  routeToActions,
  tryIntentShortcut,
} from './agent_os';

test('parses structure and skill actions', () => {
  const rename = AgentActionSchema.parse({
    op: 'RENAME_CHAPTER',
    chapterId: 'ch-1',
    newTitle: '决战',
  });
  assert.equal(rename.op, 'RENAME_CHAPTER');

  const skill = AgentActionSchema.parse({
    op: 'CINEMATIC_REWRITE',
    technique: 'sensory',
    instructions: 'more rain',
  });
  assert.equal(skill.op, 'CINEMATIC_REWRITE');
});

test('decision schema and confirmation flags', () => {
  const d = AgentOsDecisionSchema.parse({
    thought: 'rename',
    response: '将重命名章节',
    actions: [
      { op: 'RENAME_CHAPTER', chapterId: 'a', newTitle: 'B' },
      { op: 'ANSWER_QUESTION', answer: 'ok' },
    ],
  });
  assert.equal(d.actions.length, 2);
  assert.equal(needsConfirmation(d.actions), true);
  assert.equal(
    needsConfirmation([{ op: 'ANSWER_QUESTION' }]),
    false
  );
});

test('normalizeAgentAction flattens nested op.type from local LLM', () => {
  // Reproduce the exact failure from user rewrite test
  const nested = normalizeAgentAction({
    op: {
      type: 'CINEMATIC_REWRITE',
      technique: 'sensory',
      instructions: '增强视觉、听觉和触觉描写，使场景更具沉浸感。',
    },
  });
  assert.ok(nested);
  assert.equal(nested!.op, 'CINEMATIC_REWRITE');
  assert.equal(nested!.technique, 'sensory');
  assert.match(String(nested!.instructions), /视觉/);

  const parsed = AgentActionSchema.safeParse(nested);
  assert.equal(parsed.success, true);
});

test('normalizeAgentAction maps CONTENT alias and ADD_CONFLICT nested', () => {
  const draft = normalizeAgentAction({
    op: { type: 'CONTENT', instructions: '全文更真实性感' },
  });
  assert.ok(draft);
  assert.equal(draft!.op, 'DRAFT_CONTENT');
  assert.equal(draft!.instructions, '全文更真实性感');
  assert.equal(AgentActionSchema.safeParse(draft).success, true);

  const conflict = normalizeAgentAction({
    op: {
      type: 'ADD_CONFLICT',
      conflictType: 'extreme_pressure',
      intensity: 'high',
    },
  });
  assert.ok(conflict);
  assert.equal(conflict!.op, 'ADD_CONFLICT');
  assert.equal(AgentActionSchema.safeParse(conflict).success, true);
});

test('normalizeAgentDecision salvages multi-action rewrite plan', () => {
  const decision = normalizeAgentDecision({
    thought: '用户要求全文重写',
    response: '将第一章进行电影级重写',
    actions: [
      {
        op: {
          type: 'CINEMATIC_REWRITE',
          technique: 'sensory',
          instructions: '增强感官',
        },
      },
      {
        op: {
          type: 'ADD_CONFLICT',
          conflictType: 'extreme_pressure',
          intensity: 'high',
        },
      },
      {
        op: { type: 'CONTENT', instructions: '更真实和性感' },
      },
    ],
  });

  assert.equal(decision.actions.length, 3);
  const ops = decision.actions.map((a) => a.op);
  assert.deepEqual(ops, ['CINEMATIC_REWRITE', 'ADD_CONFLICT', 'DRAFT_CONTENT']);

  const full = AgentOsDecisionSchema.safeParse(decision);
  assert.equal(full.success, true);
  if (full.success) {
    assert.equal(needsConfirmation(full.data.actions), true);
  }
});

test('normalizeAgentAction fills CINEMATIC_REWRITE defaults', () => {
  const a = normalizeAgentAction({ op: 'CINEMATIC_REWRITE' });
  assert.ok(a);
  assert.equal(a!.technique, 'sensory');
  assert.ok(a!.instructions);
  assert.equal(AgentActionSchema.safeParse(a).success, true);
});

test('strict AgentRouteSchema rejects nested actions', () => {
  const ok = AgentRouteSchema.safeParse({
    intent: 'ANALYZE_CHAPTER_CHARACTERS',
    chapterScope: 'current',
    focus: '提取角色性格',
  });
  assert.equal(ok.success, true);

  const bad = AgentRouteSchema.safeParse({
    intent: 'ANALYZE_CHAPTER_CHARACTERS',
    chapterScope: 'current',
    focus: 'x',
    actions: [{ op: { type: 'GET_CHARACTER' } }],
  });
  assert.equal(bad.success, false);
});

test('tryIntentShortcut maps character extract chip without write', () => {
  const r = tryIntentShortcut('请提取并分析当前章节出现的所有角色与性格特征');
  assert.ok(r);
  assert.equal(r!.intent, 'ANALYZE_CHAPTER_CHARACTERS');

  const write = tryIntentShortcut('本章已定稿，请提取新增角色与世界观术语并更新到设定库');
  assert.ok(write);
  assert.equal(write!.intent, 'APPLY_CHAPTER_IMPACT');

  const preferred = tryIntentShortcut('anything', 'ANALYZE_CHAPTER_CHARACTERS');
  assert.equal(preferred!.intent, 'ANALYZE_CHAPTER_CHARACTERS');
});

test('tryIntentShortcut respects write negation for character analysis', async () => {
  const { hasWriteNegation, hasExplicitWriteIntent, extractRenameTitle } =
    await import('./agent_os');

  assert.equal(hasWriteNegation('提取角色性格，只分析，不要写入角色库'), true);
  assert.equal(hasExplicitWriteIntent('提取角色性格，只分析，不要写入角色库'), false);

  const a = tryIntentShortcut('提取角色性格，只分析，不要写入角色库');
  assert.ok(a);
  assert.equal(a!.intent, 'ANALYZE_CHAPTER_CHARACTERS');

  const b = tryIntentShortcut('本章还没定稿，先分析一下出场人物性格');
  assert.ok(b);
  assert.equal(b!.intent, 'ANALYZE_CHAPTER_CHARACTERS');

  const c = tryIntentShortcut('还没定稿，不要更新世界观，只要角色梳理');
  assert.ok(c);
  assert.equal(c!.intent, 'ANALYZE_CHAPTER_CHARACTERS');

  // preferred_op APPLY forced but message forbids write → demote to analysis
  const d = tryIntentShortcut('不要写入角色库，只分析', 'APPLY_CHAPTER_IMPACT');
  assert.equal(d!.intent, 'ANALYZE_CHAPTER_CHARACTERS');
});

test('extractRenameTitle pulls title after 为', async () => {
  const { extractRenameTitle, cleanCharacterName } = await import('./agent_os');
  assert.equal(extractRenameTitle('请把本章重命名为决战前夕'), '决战前夕');
  assert.equal(extractRenameTitle('重命名为《血色黎明》'), '血色黎明');
  assert.equal(cleanCharacterName('【林凡】'), '林凡');

  const route = tryIntentShortcut('请把本章重命名为决战前夕');
  assert.ok(route);
  assert.equal(route!.intent, 'RENAME_CHAPTER');
  assert.equal(route!.focus, '决战前夕');

  const actions = routeToActions(route!, {
    chapterId: 'ch-1',
    userMessage: '请把本章重命名为决战前夕',
  });
  assert.equal(actions[0]?.op, 'RENAME_CHAPTER');
  assert.equal(actions[0]?.newTitle, '决战前夕');
});

test('routeToActions builds ANALYZE_CHAPTER_CHARACTERS without mutate', () => {
  const actions = routeToActions(
    { intent: 'ANALYZE_CHAPTER_CHARACTERS', chapterScope: 'current', focus: '' },
    { chapterId: 'ch-1', userMessage: '提取角色' }
  );
  assert.equal(actions[0]?.op, 'ANALYZE_CHAPTER_CHARACTERS');
  assert.equal(actions[0]?.chapterId, 'ch-1');
  assert.equal(needsConfirmation(actions as any), false);
  assert.equal(AgentActionSchema.safeParse(actions[0]).success, true);
});

test('splitChapterIntoAnalysisChunks covers middle of long text', async () => {
  const {
    splitChapterIntoAnalysisChunks,
    mergeChapterCharacterAnalyses,
  } = await import('../services/ai/writing_service');

  const middleMark = '===MIDDLE_ONLY_CHARACTER_墨痕===\n墨痕在中段独白。';
  const long =
    'A'.repeat(4000)
    + '\n\n'
    + middleMark
    + '\n\n'
    + 'B'.repeat(4000);
  const chunks = splitChapterIntoAnalysisChunks(long, {
    maxChunkChars: 3500,
    maxChunks: 4,
  });
  assert.ok(chunks.length >= 2);
  const joined = chunks.join('\n');
  assert.match(joined, /MIDDLE_ONLY_CHARACTER_墨痕/);

  const merged = mergeChapterCharacterAnalyses([
    {
      characters: [
        {
          name: '阿卡丽',
          roleInChapter: '主角',
          traits: [{ trait: '勇猛', evidence: '冲锋', confidence: 0.9 }],
          relationships: [],
        },
      ],
    },
    {
      characters: [
        {
          name: '阿卡丽',
          roleInChapter: '主角',
          traits: [{ trait: '护短', evidence: '护友', confidence: 0.8 }],
          relationships: ['瑟拉'],
        },
        {
          name: '墨痕',
          roleInChapter: '配角',
          traits: [{ trait: '冷静', evidence: '中段独白', confidence: 0.85 }],
          relationships: [],
        },
      ],
    },
  ]);
  assert.equal(merged.characters.length, 2);
  const akali = merged.characters.find((c) => c.name === '阿卡丽');
  assert.ok(akali);
  assert.equal(akali!.traits.length, 2);
});

test('mergeImpactWithCharacterAnalysis keeps analysis cast and formats personality', async () => {
  const {
    mergeImpactWithCharacterAnalysis,
    formatPersonalityBlock,
    mergeCharacterDescription,
    stripPersonalitySections,
    mapRoleInChapterToRole,
  } = await import('../services/ai/writing_service');

  assert.equal(mapRoleInChapterToRole('主角/决斗者'), 'main');
  assert.equal(mapRoleInChapterToRole('观众（群体）'), 'minor');
  assert.equal(mapRoleInChapterToRole('对手', 'supporting'), 'supporting');

  const block = formatPersonalityBlock({
    traits: [
      { trait: '野性与力量', evidence: '豹尾扬起', confidence: 0.95 },
      { trait: '坚韧', evidence: '带伤攻击', confidence: 0.9 },
    ],
    motivation: '渴望胜利',
  });
  assert.match(block, /性格特征：/);
  assert.match(block, /野性与力量\(95%\)/);
  assert.match(block, /本章动机：渴望胜利/);

  const stripped = stripPersonalitySections(
    '角斗场统治者。\n\n性格特征：冷静\n本章动机：操控'
  );
  assert.equal(stripped, '角斗场统治者。');

  const remerged = mergeCharacterDescription(
    '旧传记\n\n性格特征：过时',
    '',
    formatPersonalityBlock({
      traits: [{ trait: '冷静', evidence: '数据流', confidence: 0.9 }],
    })
  );
  assert.match(remerged, /旧传记/);
  assert.match(remerged, /性格特征：冷静/);
  assert.doesNotMatch(remerged, /过时/);

  const impact = {
    newOrUpdatedCharacters: [
      {
        name: '比格',
        role: 'supporting',
        description: '角斗场的统治者，冷静而高傲。',
      },
      { name: '观众（群体）', role: 'minor', description: '狂热观众' },
    ],
    newOrUpdatedGlossary: [
      { term: '血脉觉醒', category: '能力体系', definition: '专属权能' },
    ],
  };
  const analysis = {
    characters: [
      {
        name: '阿卡丽',
        roleInChapter: '主角/决斗者',
        traits: [
          { trait: '野性与力量', evidence: '豹尾扬起', confidence: 0.95 },
        ],
        motivation: '胜利',
        relationships: [],
      },
      {
        name: '瑟拉',
        roleInChapter: '对手/决斗者',
        traits: [
          { trait: '妖媚与危险', evidence: '冷笑', confidence: 0.9 },
        ],
        relationships: [],
      },
      {
        name: '比格',
        roleInChapter: '裁判',
        traits: [
          { trait: '冷静与操控力', evidence: '绿色数据流', confidence: 0.9 },
        ],
        relationships: [],
      },
    ],
  };

  const merged = mergeImpactWithCharacterAnalysis(impact, analysis);
  assert.equal(merged.personalityMerged, true);
  assert.equal(merged.newOrUpdatedGlossary.length, 1);
  // impact-only crowd + 3 analysis names (比格 shared)
  assert.equal(merged.newOrUpdatedCharacters.length, 4);

  const akaliRow = merged.newOrUpdatedCharacters.find((c) => c.name === '阿卡丽');
  assert.ok(akaliRow);
  assert.equal(akaliRow!.role, 'main');
  assert.match(String(akaliRow!.description), /性格特征：/);
  assert.equal(akaliRow!.traits?.length, 1);

  const bigg = merged.newOrUpdatedCharacters.find((c) => c.name === '比格');
  assert.ok(bigg);
  assert.match(String(bigg!.description), /角斗场的统治者/);
  assert.match(String(bigg!.description), /冷静与操控力/);
});

test('normalize and merge visual_tags preserve assets and base_model', async () => {
  const {
    normalizeVisualTags,
    mergeVisualTagsDocument,
    mergeImpactWithCharacterAnalysis,
  } = await import('../services/ai/writing_service');

  const flat = normalizeVisualTags({
    hair: 'silver long hair',
    eyes: 'golden eyes',
    assets: 'should-skip',
    empty: '',
    nested: { x: 1 },
  });
  assert.equal(flat.hair, 'silver long hair');
  assert.equal(flat.eyes, 'golden eyes');
  assert.equal(flat.assets, undefined);

  const mergedDoc = mergeVisualTagsDocument(
    {
      model_type: 'pony',
      assets: { lora_ready: true, lora_name: 'akali' },
      base_model: { tags: { hair: 'black', clothing: 'armor' } },
      variants: [{ id: 'v1_default', name: 'Default', tags: { hair: 'black' } }],
    },
    { hair: 'leopard-print hair', tail: 'beast tail raised' }
  ) as any;

  assert.equal(mergedDoc.assets.lora_ready, true);
  assert.equal(mergedDoc.model_type, 'pony');
  assert.equal(mergedDoc.base_model.tags.hair, 'leopard-print hair');
  assert.equal(mergedDoc.base_model.tags.clothing, 'armor');
  assert.equal(mergedDoc.base_model.tags.tail, 'beast tail raised');
  assert.equal(mergedDoc.hair, 'leopard-print hair');
  assert.equal(mergedDoc.variants[0].tags.hair, 'leopard-print hair');

  const withVisual = mergeImpactWithCharacterAnalysis(
    {
      newOrUpdatedCharacters: [
        {
          name: '阿卡丽',
          role: 'main',
          description: '兽人圣女',
          visual_tags: {
            hair: 'wild hair',
            eyes: 'golden eyes',
            clothing: 'battle skirt',
          },
        },
      ],
      newOrUpdatedGlossary: [],
    },
    {
      characters: [
        {
          name: '阿卡丽',
          roleInChapter: '主角',
          traits: [{ trait: '野性', evidence: '冲刺', confidence: 0.9 }],
          relationships: [],
        },
      ],
    }
  );
  assert.equal(withVisual.visualTagsMerged, true);
  const row = withVisual.newOrUpdatedCharacters[0];
  assert.equal(row!.visual_tags?.eyes, 'golden eyes');
  assert.match(String(row!.description), /性格特征/);
});
