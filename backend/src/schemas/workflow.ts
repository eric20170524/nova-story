import { z } from 'zod';

export const WorkflowSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable().optional(),
  // In SQLite, JSON might be stored as string or object depending on driver handling,
  // we will accept both and let the service layer handle parsing if needed.
  content: z.union([z.string(), z.record(z.string(), z.any())]),
  is_active: z.boolean().default(true).or(z.number().transform(v => v === 1))
});

export const WorkflowCreateSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  content: z.union([z.string(), z.record(z.string(), z.any())]),
  is_active: z.boolean().default(true)
});

export const WorkflowUpdateSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  content: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
  is_active: z.boolean().optional()
});

export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowCreate = z.infer<typeof WorkflowCreateSchema>;
export type WorkflowUpdate = z.infer<typeof WorkflowUpdateSchema>;
