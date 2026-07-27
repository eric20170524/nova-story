import { z } from 'zod';

export const GenerateRequestSchema = z.object({
  workflow: z.record(z.any()),
  scene_id: z.number().int(),
  mode: z.string().default('standard'),
  generation_params: z.record(z.any()).optional().nullable()
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
