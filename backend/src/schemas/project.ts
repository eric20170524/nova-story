import { z } from 'zod';

export const ProjectSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().nullable().optional(),
  created_at: z.string().or(z.date()),
  updated_at: z.string().or(z.date()).nullable().optional(),
  user_id: z.string().nullable().optional(),
  settings: z.string().nullable().optional() // JSON string
});

export const ProjectCreateSchema = z.object({
  title: z.string(),
  description: z.string().nullable().optional(),
  settings: z.string().nullable().optional()
});

export const ProjectUpdateSchema = z.object({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  settings: z.string().nullable().optional()
});

export type Project = z.infer<typeof ProjectSchema>;
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;
