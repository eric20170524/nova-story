import { z } from 'zod';

export const GenerateRequestSchema = z.object({
  workflow: z.record(z.string(), z.any()),
  scene_id: z.number().int(),
  mode: z.string().default('standard'),
  generation_params: z.record(z.string(), z.any()).optional().nullable(),
  /** When true, fork a new scene version (copy text, clear image) then generate into it */
  new_version: z.boolean().optional().default(false)
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
