import { z } from 'zod';

export const AgentContextSchema = z.object({
  project_id: z.number().int().optional().nullable(),
  chapter_id: z.string().optional().nullable(),
  scene_id: z.string().optional().nullable(),
  selected_text: z.string().optional().nullable(),
  language: z.string().default('zh').optional().nullable()
});

export const AgentRequestSchema = z.object({
  message: z.string(),
  context: AgentContextSchema,
  history: z.array(z.record(z.string())).default([])
});

export const ToolCallSchema = z.object({
  tool_name: z.string(),
  arguments: z.record(z.string(), z.any()),
  reason: z.string()
});

export const AgentResponseSchema = z.object({
  thought: z.string(),
  response: z.string(),
  action: ToolCallSchema.optional().nullable()
});

export const ToolResultSchema = z.object({
  tool_name: z.string(),
  result: z.any(),
  status: z.string().default('success')
});

export type AgentContext = z.infer<typeof AgentContextSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
