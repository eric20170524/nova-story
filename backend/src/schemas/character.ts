import { z } from 'zod';

export const CharacterSchema = z.object({
  id: z.number().int(),
  project_id: z.number().int(),
  name: z.string(),
  role: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  visual_tags: z.union([z.string(), z.record(z.string(), z.any())]).nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  turnaround_url: z.string().nullable().optional(),
  face_url: z.string().nullable().optional(),
  model_type: z.string().default('pony')
});

export const CharacterCreateSchema = z.object({
  project_id: z.number().int(),
  name: z.string(),
  role: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  visual_tags: z.union([z.string(), z.record(z.string(), z.any())]).nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  turnaround_url: z.string().nullable().optional(),
  face_url: z.string().nullable().optional(),
  model_type: z.string().default('pony')
});

export const CharacterUpdateSchema = z.object({
  project_id: z.number().int().optional(),
  name: z.string().optional(),
  role: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  visual_tags: z.union([z.string(), z.record(z.string(), z.any())]).nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  turnaround_url: z.string().nullable().optional(),
  face_url: z.string().nullable().optional(),
  model_type: z.string().optional()
});

export type Character = z.infer<typeof CharacterSchema>;
export type CharacterCreate = z.infer<typeof CharacterCreateSchema>;
export type CharacterUpdate = z.infer<typeof CharacterUpdateSchema>;
