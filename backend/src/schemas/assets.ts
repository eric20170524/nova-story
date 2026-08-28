import { z } from 'zod';

export const ImageOutputSpecSchema = z.object({
  aspect_ratio: z.enum(['3:4', '4:3', '1:1', 'auto']).optional(),
  resolution: z.enum(['draft', 'standard', 'high']).optional(),
  orientation_policy: z.enum(['fixed', 'auto_by_shot']).optional(),
}).optional();

export const GenerationParamsSchema = z.object({
  cfg: z.number().positive().optional(),
  steps: z.number().int().positive().optional(),
  sampler_name: z.string().min(1).optional(),
  scheduler: z.string().min(1).optional(),
  width: z.number().int().min(256).max(4096).optional(),
  height: z.number().int().min(256).max(4096).optional(),
  output_spec: ImageOutputSpecSchema,
}).passthrough().refine(
  (value) => (value.width == null) === (value.height == null),
  { message: 'width and height must be provided together' }
).refine(
  (value) => {
    if (value.width == null || value.height == null) return true;
    const ratio = value.width / value.height;
    return [3 / 4, 4 / 3, 1].some((allowed) => Math.abs(ratio - allowed) <= 0.03);
  },
  { message: 'width and height must use a supported 3:4, 4:3, or 1:1 aspect ratio' }
).optional().nullable();

export const GenerateRequestSchema = z.object({
  workflow: z.record(z.string(), z.any()),
  scene_id: z.number().int(),
  mode: z.string().default('standard'),
  generation_params: GenerationParamsSchema,
  /** When true, fork a new scene version (copy text, clear image) then generate into it */
  new_version: z.boolean().optional().default(false)
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
