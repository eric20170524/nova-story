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
]);

export const needsConfirmation = (actions: Array<{ op: string }>): boolean =>
  actions.some((a) => MUTATING_OPS.has(a.op));

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
