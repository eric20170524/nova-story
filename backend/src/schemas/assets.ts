import { z } from 'zod';

export const ImageOutputSpecSchema = z.object({
  aspect_ratio: z.enum(['16:9', '9:16', '1:1', 'auto']).optional(),
  resolution: z.enum(['draft', 'standard', 'high']).optional(),
  orientation_policy: z.enum(['fixed', 'auto_by_shot']).optional(),
}).optional();

export const GenerationParamsSchema = z.object({
  cfg: z.number().positive().optional(),
  steps: z.number().int().positive().optional(),
  seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
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
    return [1, 16 / 9, 9 / 16].some((allowed) => Math.abs(ratio - allowed) <= 0.04);
  },
  { message: 'width and height must use a supported aspect ratio (16:9, 9:16, or 1:1)' }
).optional().nullable();

export const GenerateRequestSchema = z.object({
  request_key: z.string().min(1).max(200).optional(),
  workflow: z.record(z.string(), z.any()),
  scene_id: z.number().int(),
  mode: z.string().default('standard'),
  generation_params: GenerationParamsSchema,
  /** When true, fork a new scene version (copy text, clear image) then generate into it */
  new_version: z.boolean().optional().default(false)
}).superRefine((value, context) => {
  const ratio = value.workflow.output_spec?.aspect_ratio;
  if (ratio != null && !['16:9', '9:16', '1:1', 'auto'].includes(ratio)) {
    context.addIssue({ code: 'custom', path: ['workflow', 'output_spec', 'aspect_ratio'], message: 'Unsupported image aspect ratio' });
  }
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
