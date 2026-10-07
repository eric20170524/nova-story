import { z } from 'zod';

export const VoiceIdSchema = z.union([
  z.string(),
  z.null()
]).optional().transform((val) => {
  if (val === undefined) return undefined;
  if (val === null || val === '') return null;
  return val;
}).pipe(
  z.union([
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),
    z.null()
  ]).optional()
);

export const CharacterSchema = z.object({
  id: z.number().int(),
  project_id: z.number().int(),
  name: z.string(),
  role: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  personality: z.string().nullable().optional(),
  growth_path: z.string().nullable().optional(),
  visual_tags: z.union([z.string(), z.record(z.string(), z.any())]).nullable().optional(),
  voice_id: z.string().nullable().optional(),
  voice_label: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  turnaround_url: z.string().nullable().optional(),
  face_url: z.string().nullable().optional(),
});

export const CharacterCreateSchema = z.object({
  project_id: z.number().int(),
  name: z.string(),
  role: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  personality: z.string().nullable().optional(),
  growth_path: z.string().nullable().optional(),
  visual_tags: z.union([z.string(), z.record(z.string(), z.any())]).nullable().optional(),
  voice_id: VoiceIdSchema,
  voice_label: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  turnaround_url: z.string().nullable().optional(),
  face_url: z.string().nullable().optional(),
});

export const CharacterUpdateSchema = z.object({
  project_id: z.number().int().optional(),
  name: z.string().optional(),
  role: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  personality: z.string().nullable().optional(),
  growth_path: z.string().nullable().optional(),
  visual_tags: z.union([z.string(), z.record(z.string(), z.any())]).nullable().optional(),
  voice_id: VoiceIdSchema,
  voice_label: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  turnaround_url: z.string().nullable().optional(),
  face_url: z.string().nullable().optional(),
});

export type Character = z.infer<typeof CharacterSchema>;
export type CharacterCreate = z.infer<typeof CharacterCreateSchema>;
export type CharacterUpdate = z.infer<typeof CharacterUpdateSchema>;
