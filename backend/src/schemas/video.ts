import { z } from 'zod';

export const VideoProfileSchema = z.enum(['narrative_clip', 'character_loop']);
export type VideoProfile = z.infer<typeof VideoProfileSchema>;

export const VideoPresetSchema = z.enum(['preview_480p_5s', 'standard_720p_5s']);
export type VideoPreset = z.infer<typeof VideoPresetSchema>;

export const VideoWorkflowIdSchema = z.enum([
  'minimax_h3_hongchao_a2a_12gb',
  'minimax_h3_ref2va_official_12gb',
  'minimax_h3_fl2va_official_12gb'
]);
export type VideoWorkflowId = z.infer<typeof VideoWorkflowIdSchema>;
export const DEFAULT_VIDEO_WORKFLOW_ID: VideoWorkflowId = 'minimax_h3_hongchao_a2a_12gb';

export const VideoTaskStageSchema = z.enum([
  'queued',
  'preflight',
  'vram_tuning',
  'vram_ready',
  'staging_refs',
  'model_loading',
  'generating',
  'collecting',
  'postprocessing',
  'qa_running',
  'review_required',
  'completed',
  'rejected',
  'failed',
  'cancelled',
  'interrupted'
]);
export type VideoTaskStage = z.infer<typeof VideoTaskStageSchema>;

export const MediaAssetRoleSchema = z.enum([
  'video_keyframe',
  'character_reference',
  'motion_reference',
  'raw_video',
  'loop_master',
  'narrative_final',
  'poster',
  'qa_report'
]);
export type MediaAssetRole = z.infer<typeof MediaAssetRoleSchema>;

export const MediaAssetStatusSchema = z.enum(['draft', 'review_required', 'ready', 'rejected', 'archived']);
export type MediaAssetStatus = z.infer<typeof MediaAssetStatusSchema>;

export const MediaAssetSchema = z.object({
  id: z.number().int().optional(),
  project_id: z.number().int(),
  scene_id: z.number().int().nullable().optional(),
  scene_version: z.number().int().nullable().optional(),
  character_id: z.number().int().nullable().optional(),
  parent_asset_id: z.number().int().nullable().optional(),
  media_type: z.enum(['image', 'video', 'json']),
  role: MediaAssetRoleSchema,
  profile: VideoProfileSchema.nullable().optional(),
  status: MediaAssetStatusSchema.default('ready'),
  url: z.string().min(1),
  mime_type: z.string().optional(),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  fps: z.number().nullable().optional(),
  frame_count: z.number().int().nullable().optional(),
  duration_ms: z.number().int().nullable().optional(),
  sha256: z.string().optional(),
  metadata_json: z.string().optional(),
  created_at: z.string().optional()
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

const VideoRequestBaseSchema = z.object({
  scene_id: z.number().int().positive(),
  scene_version: z.number().int().positive().default(1),
  profile: VideoProfileSchema.default('narrative_clip'),
  workflow_id: VideoWorkflowIdSchema.default(DEFAULT_VIDEO_WORKFLOW_ID),
  keyframe_asset_id: z.number().int().nonnegative().optional().default(0),
  character_reference_asset_ids: z.array(z.number().int().positive()).max(3).optional().default([]),
  motion_reference_asset_id: z.number().int().positive().optional(),
  last_frame_asset_id: z.number().int().positive().optional(),
  prompt_override: z.string().optional(),
  preset: VideoPresetSchema.default('preview_480p_5s'),
  seed: z.number().int().optional(),
  run_loop_closer: z.boolean().default(true)
});

const refineVideoStrategy = (data: z.infer<typeof VideoRequestBaseSchema>, ctx: z.RefinementCtx) => {
  const isFl2va = data.workflow_id === 'minimax_h3_fl2va_official_12gb';
  const isRef2va = data.workflow_id === 'minimax_h3_ref2va_official_12gb';

  if (isRef2va && data.last_frame_asset_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Official Ref2VA does not provide a hard last-frame boundary; use FL2VA or the experimental Hybrid workflow.',
      path: ['last_frame_asset_id']
    });
  }

  if (isFl2va) {
    if ((data.character_reference_asset_ids || []).length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Official FL2VA does not consume character_reference_asset_ids; use Ref2VA/Hybrid for identity references.',
        path: ['character_reference_asset_ids']
      });
    }
    if (data.motion_reference_asset_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Official FL2VA does not consume motion_reference_asset_id; use Ref2VA/Hybrid for motion references.',
        path: ['motion_reference_asset_id']
      });
    }
    return;
  }

  // Ref2VA and the experimental Hybrid preserve the existing character-loop
  // contract: identity references + exactly one motion reference.
  if (data.profile === 'character_loop') {
    if (!data.motion_reference_asset_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'character_loop with Ref2VA/Hybrid requires exactly 1 motion_reference_asset_id',
        path: ['motion_reference_asset_id']
      });
    }
    if (!data.character_reference_asset_ids || data.character_reference_asset_ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'character_loop with Ref2VA/Hybrid requires 1 to 3 character_reference_asset_ids',
        path: ['character_reference_asset_ids']
      });
    }
  }
};

export const VideoPreflightRequestSchema = VideoRequestBaseSchema.superRefine(refineVideoStrategy);
export type VideoPreflightRequest = z.infer<typeof VideoPreflightRequestSchema>;

export const VideoGenerationRequestSchema = VideoRequestBaseSchema.superRefine(refineVideoStrategy);
export type VideoGenerationRequest = z.infer<typeof VideoGenerationRequestSchema>;

export const VideoSpecOutputContractSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frames: z.number().int().positive(),
  fps: z.number().positive(),
  is_loop: z.boolean()
});

export const VideoSpecSchema = z.object({
  profile: VideoProfileSchema,
  preset: VideoPresetSchema,
  workflow_id: VideoWorkflowIdSchema.default(DEFAULT_VIDEO_WORKFLOW_ID),
  subject_identity: z.string(),
  primary_action: z.string(),
  camera_motion: z.string(),
  environment_motion: z.string().optional(),
  temporal_arc: z.string(),
  negative_motion: z.string(),
  output_contract: VideoSpecOutputContractSchema,
  positive_prompt: z.string(),
  negative_prompt: z.string()
});
export type VideoSpec = z.infer<typeof VideoSpecSchema>;

export const VideoQAReportSchema = z.object({
  schema_version: z.number().int().default(1),
  task_id: z.string(),
  profile: VideoProfileSchema,
  technical_pass: z.boolean(),
  technical_details: z.object({
    codec: z.string(),
    pixel_format: z.string(),
    width: z.number(),
    height: z.number(),
    fps: z.number(),
    frame_count: z.number(),
    duration_s: z.number(),
    has_audio: z.boolean()
  }),
  continuity_scores: z.object({
    appearance_error: z.number(),
    motion_error: z.number(),
    flicker_error: z.number(),
    seam_cost: z.number(),
    normalized_score: z.number()
  }),
  quality_grade: z.enum(['pass', 'manual_review', 'reject']),
  reasons: z.array(z.string()),
  evaluated_at: z.string()
});
export type VideoQAReport = z.infer<typeof VideoQAReportSchema>;

export const VideoTaskResponseSchema = z.object({
  task_id: z.string(),
  scene_id: z.number().int(),
  status: z.enum(['queued', 'processing', 'review_required', 'completed', 'rejected', 'failed', 'cancelled', 'interrupted']),
  stage: VideoTaskStageSchema.optional(),
  queue_position: z.number().int().optional(),
  error: z.string().nullable().optional(),
  output_url: z.string().nullable().optional(),
  raw_video_url: z.string().nullable().optional(),
  poster_url: z.string().nullable().optional(),
  qa_report_url: z.string().nullable().optional(),
  qa_report: VideoQAReportSchema.nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional()
});
export type VideoTaskResponse = z.infer<typeof VideoTaskResponseSchema>;

export const VideoCapabilitiesSchema = z.object({
  video_generation_enabled: z.boolean(),
  ffmpeg_available: z.boolean(),
  ffprobe_available: z.boolean(),
  comfyui_online: z.boolean(),
  h3_workflow_ready: z.boolean(),
  gpu_available: z.boolean(),
  gpu_name: z.string().nullable(),
  vram_free_bytes: z.number().nullable(),
  supported_presets: z.array(VideoPresetSchema),
  supported_profiles: z.array(VideoProfileSchema),
  missing_components: z.array(z.string())
});
export type VideoCapabilities = z.infer<typeof VideoCapabilitiesSchema>;

export const VideoPreflightResponseSchema = z.object({
  ready: z.boolean(),
  profile: VideoProfileSchema,
  preset: VideoPresetSchema,
  compiled_spec: VideoSpecSchema.optional(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  estimated_duration_seconds: z.number()
});
export type VideoPreflightResponse = z.infer<typeof VideoPreflightResponseSchema>;

export const VideoPromoteRequestSchema = z.object({
  asset_id: z.number().int().positive()
});

export const VideoReprocessRequestSchema = z.object({
  asset_id: z.number().int().positive(),
  run_loop_closer: z.boolean().default(true)
});
