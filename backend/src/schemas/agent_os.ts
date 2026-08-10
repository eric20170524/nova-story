import { z } from 'zod';

/** Agent OS action ops (DreamWaver-aligned + Nova director tools). Flat chapters — no volume ops. */

export const CreativeOps = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('DRAFT_CONTENT'),
    instructions: z.string(),
    targetChapterId: z.string().optional(),
    targetWordCount: z.number().int().positive().optional(),
  }),
  z.object({
    op: z.literal('ANSWER_QUESTION'),
    answer: z.string(),
  }),
  z.object({
    op: z.literal('QUERY_DATABASE'),
    query: z.string(),
  }),
]);

export const StructureOps = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('UPDATE_CHAPTER_SUMMARY'),
    chapterId: z.string(),
    newSummary: z.string(),
  }),
  z.object({
    op: z.literal('RENAME_CHAPTER'),
    chapterId: z.string(),
    newTitle: z.string(),
  }),
  z.object({
    op: z.literal('DELETE_CHAPTER'),
    chapterId: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    op: z.literal('MOVE_CHAPTER'),
    chapterId: z.string(),
    positionIndex: z.number().int().min(0),
  }),
]);

export const ProjectMetaOps = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('UPDATE_PROJECT_META'),
    title: z.string().optional(),
    description: z.string().optional(),
    genre: z.string().optional(),
    style: z.string().optional(),
    main_plot: z.string().optional(),
    character_relations: z.string().optional(),
  }),
]);

export const SkillOps = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('CINEMATIC_REWRITE'),
    technique: z.enum(['montage', 'close_up', 'sensory']),
    instructions: z.string(),
    targetChapterId: z.string().optional(),
  }),
  z.object({
    op: z.literal('ADD_CONFLICT'),
    conflictType: z.enum(['variable_intrusion', 'extreme_pressure']),
    intensity: z.enum(['low', 'high']).optional(),
    instructions: z.string().optional(),
    targetChapterId: z.string().optional(),
  }),
  z.object({
    op: z.literal('REVERSE_PLOT'),
    reversalType: z.enum(['motive_switch', 'character_peel']),
    targetCharacter: z.string().optional(),
    instructions: z.string().optional(),
    targetChapterId: z.string().optional(),
  }),
]);

export const WorldOps = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('RUN_CONSISTENCY_CHECK'),
  }),
  z.object({
    op: z.literal('APPLY_CHAPTER_IMPACT'),
    chapterId: z.string().optional(),
  }),
]);

export const DirectorOps = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('GENERATE_TIMELINE'),
    chapterId: z.string().optional(),
    mode: z.string().optional(),
  }),
  z.object({
    op: z.literal('ANALYZE_CHAPTER'),
    chapterId: z.string().optional(),
  }),
  /** Read-only: extract characters + traits with evidence from chapter body. Does NOT write DB. */
  z.object({
    op: z.literal('ANALYZE_CHAPTER_CHARACTERS'),
    chapterId: z.string().optional(),
  }),
  z.object({
    op: z.literal('GET_CHARACTER'),
    name: z.string(),
  }),
  z.object({
    op: z.literal('UPDATE_CHARACTER'),
    name: z.string(),
    description: z.string().optional(),
    visual_tags: z.record(z.string(), z.any()).optional(),
  }),
]);

export const AgentActionSchema = z.union([
  CreativeOps,
  StructureOps,
  ProjectMetaOps,
  SkillOps,
  WorldOps,
  DirectorOps,
]);

export const AgentOsDecisionSchema = z.object({
  thought: z.string(),
  response: z.string().optional().default(''),
  actions: z.array(AgentActionSchema).default([]),
});

/**
 * Strict mini-schema for 8B local Planner (P0).
 * Only intent routing — no free-form nested actions.
 * Deterministic code maps this → full AgentAction[].
 */
export const AgentRouteIntentSchema = z.enum([
  'ANSWER_QUESTION',
  'DRAFT_CONTENT',
  'CINEMATIC_REWRITE',
  'ADD_CONFLICT',
  'REVERSE_PLOT',
  'RUN_CONSISTENCY_CHECK',
  'APPLY_CHAPTER_IMPACT',
  'GENERATE_TIMELINE',
  'ANALYZE_CHAPTER',
  'ANALYZE_CHAPTER_CHARACTERS',
  'QUERY_DATABASE',
  'RENAME_CHAPTER',
  'UPDATE_CHAPTER_SUMMARY',
  'DELETE_CHAPTER',
  'MOVE_CHAPTER',
  'UPDATE_PROJECT_META',
  'GET_CHARACTER',
  'UPDATE_CHARACTER',
]);

export const AgentRouteSchema = z
  .object({
    intent: AgentRouteIntentSchema,
    /** Use active chapter from context when "current". */
    chapterScope: z.enum(['current', 'none']).default('current'),
    /** Short free text: rename target, character name, rewrite focus, etc. Max keeps JSON small. */
    focus: z.string().max(400).optional().default(''),
  })
  // Reject loose planner leftovers (actions/thought/response) instead of silent strip
  .strict();

export type AgentRoute = z.infer<typeof AgentRouteSchema>;
export type AgentRouteIntent = z.infer<typeof AgentRouteIntentSchema>;

/** Ops that mutate data or call expensive LLM — require Action Card confirmation. */
export const MUTATING_OPS = new Set([
  'DRAFT_CONTENT',
  'UPDATE_CHAPTER_SUMMARY',
  'RENAME_CHAPTER',
  'DELETE_CHAPTER',
  'MOVE_CHAPTER',
  'UPDATE_PROJECT_META',
  'CINEMATIC_REWRITE',
  'ADD_CONFLICT',
  'REVERSE_PLOT',
  'APPLY_CHAPTER_IMPACT',
  'GENERATE_TIMELINE',
  'UPDATE_CHARACTER',
  // ANALYZE_CHAPTER / ANALYZE_CHAPTER_CHARACTERS / ANSWER / QUERY / CONSISTENCY are read-only
]);

export const needsConfirmation = (actions: Array<{ op: string }>): boolean =>
  actions.some((a) => MUTATING_OPS.has(a.op));

/** Map strict route → executable action list (deterministic, no LLM). */
export function routeToActions(
  route: AgentRoute,
  ctx: { chapterId?: string | null; userMessage: string }
): Array<Record<string, any>> {
  const chapterId =
    route.chapterScope === 'current' ? ctx.chapterId || undefined : undefined;
  const focus = (route.focus || '').trim() || ctx.userMessage.trim();
  const msg = ctx.userMessage.trim();

  switch (route.intent) {
    case 'ANSWER_QUESTION':
      // Placeholder; free-text answer filled later if auto-executed path uses generateText
      return [{ op: 'ANSWER_QUESTION', answer: focus || msg || '（无问题内容）' }];
    case 'DRAFT_CONTENT':
      return [{
        op: 'DRAFT_CONTENT',
        instructions: focus || msg,
        targetChapterId: chapterId,
      }];
    case 'CINEMATIC_REWRITE':
      return [{
        op: 'CINEMATIC_REWRITE',
        technique: 'sensory',
        instructions: focus || msg || '电影感感官重写',
        targetChapterId: chapterId,
      }];
    case 'ADD_CONFLICT':
      return [{
        op: 'ADD_CONFLICT',
        conflictType: 'extreme_pressure',
        intensity: 'high',
        instructions: focus || msg,
        targetChapterId: chapterId,
      }];
    case 'REVERSE_PLOT':
      return [{
        op: 'REVERSE_PLOT',
        reversalType: 'motive_switch',
        instructions: focus || msg,
        targetChapterId: chapterId,
      }];
    case 'RUN_CONSISTENCY_CHECK':
      return [{ op: 'RUN_CONSISTENCY_CHECK' }];
    case 'APPLY_CHAPTER_IMPACT':
      return [{ op: 'APPLY_CHAPTER_IMPACT', chapterId }];
    case 'GENERATE_TIMELINE':
      return [{ op: 'GENERATE_TIMELINE', chapterId, mode: 'narrative' }];
    case 'ANALYZE_CHAPTER':
      return [{ op: 'ANALYZE_CHAPTER', chapterId }];
    case 'ANALYZE_CHAPTER_CHARACTERS':
      return [{ op: 'ANALYZE_CHAPTER_CHARACTERS', chapterId }];
    case 'QUERY_DATABASE':
      return [{ op: 'QUERY_DATABASE', query: focus || msg || 'list' }];
    case 'RENAME_CHAPTER': {
      if (!chapterId) return [{ op: 'ANSWER_QUESTION', answer: '请先选择要重命名的章节。' }];
      const newTitle = extractRenameTitle(focus) || extractRenameTitle(msg);
      if (!newTitle) {
        return [{
          op: 'ANSWER_QUESTION',
          answer: '请明确新标题，例如：「把本章重命名为决战前夕」。',
        }];
      }
      return [{ op: 'RENAME_CHAPTER', chapterId, newTitle }];
    }
    case 'UPDATE_CHAPTER_SUMMARY':
      if (!chapterId) return [{ op: 'ANSWER_QUESTION', answer: '请先选择章节。' }];
      return [{ op: 'UPDATE_CHAPTER_SUMMARY', chapterId, newSummary: focus || msg }];
    case 'DELETE_CHAPTER':
      if (!chapterId) return [{ op: 'ANSWER_QUESTION', answer: '请先选择要删除的章节。' }];
      return [{ op: 'DELETE_CHAPTER', chapterId, reason: focus || 'user request' }];
    case 'MOVE_CHAPTER':
      if (!chapterId) return [{ op: 'ANSWER_QUESTION', answer: '请先选择要移动的章节。' }];
      {
        const n = parseInt(focus.replace(/\D/g, ''), 10);
        return [{
          op: 'MOVE_CHAPTER',
          chapterId,
          positionIndex: Number.isFinite(n) ? Math.max(0, n) : 0,
        }];
      }
    case 'UPDATE_PROJECT_META':
      return [{
        op: 'UPDATE_PROJECT_META',
        main_plot: focus || undefined,
        style: undefined,
      }];
    case 'GET_CHARACTER': {
      const name = cleanCharacterName(focus || msg);
      if (!name) return [{ op: 'ANSWER_QUESTION', answer: '请提供角色名。' }];
      return [{ op: 'GET_CHARACTER', name }];
    }
    case 'UPDATE_CHARACTER': {
      const name = cleanCharacterName(focus.split(/[：:,，\s]/)[0] || focus);
      if (!name) return [{ op: 'ANSWER_QUESTION', answer: '请提供角色名。' }];
      return [{ op: 'UPDATE_CHARACTER', name, description: focus }];
    }
    default:
      return [{ op: 'ANSWER_QUESTION', answer: msg }];
  }
}

/** True when user explicitly refuses write / finalize / persist. */
export function hasWriteNegation(message: string): boolean {
  const m = String(message || '');
  return (
    /不要\s*写入|别\s*写入|勿\s*写入|禁止\s*写入|不\s*要\s*入库|别\s*入库|不要\s*更新(角色|设定|世界观)|别\s*更新(角色|设定)|只\s*分析|仅\s*分析|只读|先\s*分析|还没\s*定稿|尚未\s*定稿|不要\s*定稿|别\s*定稿|不\s*写入\s*角色库|不要写进角色库|do\s*not\s*write|don't\s*write|read[\s-]*only|no\s*persist/i.test(
      m
    )
  );
}

/** True when user explicitly wants to persist world/characters. */
export function hasExplicitWriteIntent(message: string): boolean {
  const m = String(message || '');
  if (hasWriteNegation(m)) return false;
  return /已定稿|本章定稿|定稿[：:]|写入角色库|写入设定|入库|更新到设定|更新世界观|持久化|APPLY_CHAPTER_IMPACT/i.test(
    m
  );
}

/**
 * Extract new chapter title from natural language.
 * e.g. "请把本章重命名为决战前夕" → "决战前夕"
 */
export function extractRenameTitle(text: string): string | null {
  const s = String(text || '').trim();
  if (!s) return null;

  const patterns = [
    /重命名[为到至：:\s]+[《「『【\[]?([^》」』\]】\n]{1,80})/,
    /改名[为到至：:\s]+[《「『【\[]?([^》」』\]】\n]{1,80})/,
    /标题[改成改为为到至：:\s]+[《「『【\[]?([^》」』\]】\n]{1,80})/,
    /rename(?:\s+\w+)?\s+(?:to|as)\s+["'“]?([^"'”\n]{1,80})/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1]) {
      const title = cleanCharacterName(m[1].trim());
      if (title && title.length <= 80 && !/^请|把本|本章|当前/.test(title)) {
        return title;
      }
    }
  }

  // Bare short title only if message is almost just the title after a rename verb
  const stripped = s
    .replace(/^(请)?(帮我)?(把)?(当前)?(本章|这一章|章节)?/u, '')
    .replace(/重命名[为到至：:\s]*/u, '')
    .replace(/改名[为到至：:\s]*/u, '')
    .trim();
  if (stripped && stripped.length <= 40 && !/请|分析|提取|写入/.test(stripped)) {
    return cleanCharacterName(stripped);
  }
  return null;
}

/** Strip book-title marks / brackets from character names or short titles. */
export function cleanCharacterName(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^[【\[（(「『《“"‘']+/u, '')
    .replace(/[】\]）)」』》”"’']+$/u, '')
    .replace(/[】\]）)」』》”"’'].*$/u, '')
    .trim();
}

/**
 * Keyword / chip shortcuts — skip LLM planner for high-confidence Chinese intents.
 * preferredOp from UI chips takes absolute priority when valid.
 */
export function tryIntentShortcut(
  message: string,
  preferredOp?: string | null
): AgentRoute | null {
  if (preferredOp && AgentRouteIntentSchema.safeParse(preferredOp).success) {
    // preferred_op still respects explicit write negation for impact
    if (
      preferredOp === 'APPLY_CHAPTER_IMPACT'
      && hasWriteNegation(message)
    ) {
      return {
        intent: 'ANALYZE_CHAPTER_CHARACTERS',
        chapterScope: 'current',
        focus: message.slice(0, 400),
      };
    }
    return {
      intent: preferredOp as AgentRouteIntent,
      chapterScope: preferredOp === 'RUN_CONSISTENCY_CHECK' ? 'none' : 'current',
      focus:
        preferredOp === 'RENAME_CHAPTER'
          ? (extractRenameTitle(message) || message.slice(0, 400))
          : message.slice(0, 400),
    };
  }

  const m = String(message || '').trim();
  if (!m) return null;

  const writeNegated = hasWriteNegation(m);
  const wantsWrite = hasExplicitWriteIntent(m);

  // Read-only character / personality analysis (explicit or when write is negated)
  if (
    /角色|人物|出场/.test(m)
    && /性格|特征|分析|提取|梳理/.test(m)
  ) {
    // "提取…只分析不要写入" → always read-only
    if (writeNegated || !wantsWrite) {
      return {
        intent: 'ANALYZE_CHAPTER_CHARACTERS',
        chapterScope: 'current',
        focus: m.slice(0, 400),
      };
    }
  }

  // Persist world / characters — only with explicit write intent AND no negation
  if (wantsWrite && !writeNegated) {
    return { intent: 'APPLY_CHAPTER_IMPACT', chapterScope: 'current', focus: m.slice(0, 400) };
  }

  // Bare "术语/世界观" without 定稿 and without 角色分析 → do not force write
  if (
    !writeNegated
    && /更新世界观|写入设定库|提取.*术语并更新/i.test(m)
    && !/只|不要|别|尚未|还没/.test(m)
  ) {
    return { intent: 'APPLY_CHAPTER_IMPACT', chapterScope: 'current', focus: m.slice(0, 400) };
  }

  if (/逻辑体检|一致性|设定冲突|前后矛盾/.test(m)) {
    return { intent: 'RUN_CONSISTENCY_CHECK', chapterScope: 'none', focus: m.slice(0, 400) };
  }

  if (/全文重写|小说写法|去掉.*画面|动作指令|电影化|感官重写|CINEMATIC/i.test(m)) {
    if (/冲突|crisis|pressure/i.test(m) && !/重写|改写/.test(m)) {
      return { intent: 'ADD_CONFLICT', chapterScope: 'current', focus: m.slice(0, 400) };
    }
    return { intent: 'CINEMATIC_REWRITE', chapterScope: 'current', focus: m.slice(0, 400) };
  }

  if (/注入冲突|增加冲突|ADD_CONFLICT/i.test(m)) {
    return { intent: 'ADD_CONFLICT', chapterScope: 'current', focus: m.slice(0, 400) };
  }

  if (/反转|REVERSE_PLOT/i.test(m)) {
    return { intent: 'REVERSE_PLOT', chapterScope: 'current', focus: m.slice(0, 400) };
  }

  if (/分镜|时间线|timeline|storyboard/i.test(m)) {
    return { intent: 'GENERATE_TIMELINE', chapterScope: 'current', focus: m.slice(0, 400) };
  }

  if (/续写|继续写|DRAFT_CONTENT/i.test(m) && !/重写|改写/.test(m)) {
    return { intent: 'DRAFT_CONTENT', chapterScope: 'current', focus: m.slice(0, 400) };
  }

  if (/剧情.*分析|新实体|ANALYZE_CHAPTER/i.test(m) && !/性格|角色特征/.test(m)) {
    return { intent: 'ANALYZE_CHAPTER', chapterScope: 'current', focus: m.slice(0, 400) };
  }

  if (/重命名|改名/.test(m)) {
    const title = extractRenameTitle(m);
    // Only shortcut when title is reliably extracted; else fall through to LLM route
    if (title) {
      return {
        intent: 'RENAME_CHAPTER',
        chapterScope: 'current',
        focus: title,
      };
    }
    return null;
  }

  return null;
}

/**
 * Local LLMs often emit nested/aliased action shapes, e.g.
 *   { "op": { "type": "CINEMATIC_REWRITE", "technique": "sensory", "instructions": "..." } }
 * or { "type": "CONTENT", "instructions": "..." }
 * Normalize to flat { op: "CINEMATIC_REWRITE", ... } before Zod validation.
 */
const OP_ALIASES: Record<string, string> = {
  CONTENT: 'DRAFT_CONTENT',
  WRITE: 'DRAFT_CONTENT',
  DRAFT: 'DRAFT_CONTENT',
  REWRITE: 'CINEMATIC_REWRITE',
  FULL_REWRITE: 'CINEMATIC_REWRITE',
  CINEMATIC: 'CINEMATIC_REWRITE',
  MOVIE_REWRITE: 'CINEMATIC_REWRITE',
  CONFLICT: 'ADD_CONFLICT',
  ADD_TENSION: 'ADD_CONFLICT',
  REVERSAL: 'REVERSE_PLOT',
  PLOT_REVERSE: 'REVERSE_PLOT',
  RENAME: 'RENAME_CHAPTER',
  MOVE: 'MOVE_CHAPTER',
  DELETE: 'DELETE_CHAPTER',
  SUMMARY: 'UPDATE_CHAPTER_SUMMARY',
  PROJECT_META: 'UPDATE_PROJECT_META',
  UPDATE_META: 'UPDATE_PROJECT_META',
  CONSISTENCY: 'RUN_CONSISTENCY_CHECK',
  CONSISTENCY_CHECK: 'RUN_CONSISTENCY_CHECK',
  IMPACT: 'APPLY_CHAPTER_IMPACT',
  TIMELINE: 'GENERATE_TIMELINE',
  STORYBOARD: 'GENERATE_TIMELINE',
  ANALYZE: 'ANALYZE_CHAPTER',
  ANALYZE_CHAPTER_CHARACTERS: 'ANALYZE_CHAPTER_CHARACTERS',
  EXTRACT_CHARACTERS: 'ANALYZE_CHAPTER_CHARACTERS',
  CHARACTER_ANALYSIS: 'ANALYZE_CHAPTER_CHARACTERS',
  ANSWER: 'ANSWER_QUESTION',
  QUERY: 'QUERY_DATABASE',
};

function resolveOpName(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase().replace(/[\s-]+/g, '_');
  return OP_ALIASES[upper] || upper;
}

/** Flatten one messy LLM action into a schema-friendly object, or null if unusable. */
export function normalizeAgentAction(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, any>;

  let opName: string | null = null;
  let fields: Record<string, any> = { ...input };

  if (typeof input.op === 'string') {
    opName = resolveOpName(input.op);
    delete fields.op;
  } else if (input.op && typeof input.op === 'object' && !Array.isArray(input.op)) {
    // { op: { type: "X", technique, instructions } }
    const nested = input.op as Record<string, any>;
    opName = resolveOpName(nested.type || nested.op || nested.name || nested.tool_name);
    fields = { ...nested, ...input };
    delete fields.op;
    delete fields.type;
    delete fields.name;
    delete fields.tool_name;
  } else if (typeof input.type === 'string') {
    opName = resolveOpName(input.type);
    delete fields.type;
  } else if (typeof input.tool_name === 'string') {
    opName = resolveOpName(input.tool_name);
    delete fields.tool_name;
    if (input.arguments && typeof input.arguments === 'object') {
      fields = { ...fields, ...input.arguments };
      delete fields.arguments;
    }
  } else if (typeof input.name === 'string' && !input.op) {
    // Only treat as op when it looks like an op constant (ALL_CAPS / known alias)
    const candidate = resolveOpName(input.name);
    if (candidate && (/^[A-Z][A-Z0-9_]+$/.test(candidate) || OP_ALIASES[input.name.toUpperCase()])) {
      opName = candidate;
      delete fields.name;
    }
  }

  if (!opName) return null;

  const action: Record<string, any> = { op: opName, ...fields };

  // Drop empty optional noise
  for (const key of Object.keys(action)) {
    if (action[key] === undefined || action[key] === null || action[key] === '') {
      if (key !== 'op') delete action[key];
    }
  }

  // Soft defaults so local models don't drop required skill fields
  if (action.op === 'CINEMATIC_REWRITE') {
    if (!action.technique || !['montage', 'close_up', 'sensory'].includes(String(action.technique))) {
      action.technique = 'sensory';
    }
    if (!action.instructions) {
      action.instructions = 'Rewrite the full chapter with stronger sensory detail and character presence.';
    }
  }
  if (action.op === 'ADD_CONFLICT') {
    if (
      !action.conflictType
      || !['variable_intrusion', 'extreme_pressure'].includes(String(action.conflictType))
    ) {
      action.conflictType = 'extreme_pressure';
    }
    if (action.intensity && !['low', 'high'].includes(String(action.intensity))) {
      delete action.intensity;
    }
  }
  if (action.op === 'REVERSE_PLOT') {
    if (
      !action.reversalType
      || !['motive_switch', 'character_peel'].includes(String(action.reversalType))
    ) {
      action.reversalType = 'motive_switch';
    }
  }
  if (action.op === 'DRAFT_CONTENT' && !action.instructions) {
    action.instructions = 'Rewrite or continue the chapter as the user requested.';
  }
  if (action.op === 'ANSWER_QUESTION' && !action.answer) {
    action.answer = String(input.answer || input.response || input.message || '').trim() || '（无内容）';
  }
  if (action.op === 'QUERY_DATABASE' && !action.query) {
    action.query = String(input.query || input.question || '').trim() || 'list chapters';
  }
  if (action.op === 'GET_CHARACTER' && !action.name) {
    return null;
  }
  if (action.op === 'UPDATE_CHARACTER' && !action.name) {
    return null;
  }
  if (action.op === 'RENAME_CHAPTER' && (!action.chapterId || !action.newTitle)) {
    // Allow incomplete rename through only if both present later; drop if unusable
    if (!action.newTitle) return null;
  }

  return action;
}

/** Normalize a decision object: flatten each action, drop invalids. */
export function normalizeAgentDecision(raw: any): {
  thought: string;
  response: string;
  actions: Record<string, any>[];
} {
  if (!raw || typeof raw !== 'object') {
    return { thought: '', response: '', actions: [] };
  }
  const actionsIn = Array.isArray(raw.actions) ? raw.actions : [];
  const actions = actionsIn
    .map((a: unknown) => normalizeAgentAction(a))
    .filter((a: Record<string, any> | null): a is Record<string, any> => Boolean(a));

  return {
    thought: String(raw.thought || ''),
    response: String(raw.response || ''),
    actions,
  };
}

export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentOsDecision = z.infer<typeof AgentOsDecisionSchema>;

export const AgentExecuteRequestSchema = z.object({
  project_id: z.number().int(),
  chapter_id: z.string().optional().nullable(),
  language: z.string().optional().nullable(),
  actions: z.array(z.record(z.string(), z.any())).min(1),
  apply: z.boolean().default(true),
});

export const AgentExecuteResultSchema = z.object({
  results: z.array(
    z.object({
      op: z.string(),
      status: z.enum(['success', 'error', 'skipped']),
      message: z.string().optional(),
      data: z.any().optional(),
    })
  ),
});

export type AgentExecuteRequest = z.infer<typeof AgentExecuteRequestSchema>;
export type AgentExecuteResult = z.infer<typeof AgentExecuteResultSchema>;
