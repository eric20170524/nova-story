import { z } from 'zod';

export const ChapterSchema = z.object({
  id: z.string(), // UUID
  project_id: z.number().int(),
  index: z.number().int(),
  title: z.string(),
  content: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  condensed_content: z.string().nullable().optional(),
  status: z.string().default('draft')
});

export const SceneSchema = z.object({
  id: z.number().int(),
  chapter_id: z.string(),
  index: z.number().int(),
  visual_prompt: z.string().nullable().optional(),
  audio_prompt: z.string().nullable().optional(),
  dialogue: z.string().nullable().optional(),
  duration: z.number().default(3.0),
  shot_type: z.string().nullable().optional(),
  camera_movement: z.string().nullable().optional(),
  camera_angle: z.string().nullable().optional(),
  negative_prompt: z.string().nullable().optional(),
  asset_status: z.string().default('idle'),
  task_id: z.string().nullable().optional(),
  asset_url: z.string().nullable().optional()
});

export const CoverageGroupSchema = z.object({
  id: z.number().int(),
  source_scene_id: z.number().int(),
  version: z.number().int().default(1),
  status: z.string().default('completed'),
  created_at: z.string().or(z.date())
});

export const CoverageShotSchema = z.object({
  id: z.number().int(),
  coverage_group_id: z.number().int(),
  slot: z.number().int(),
  shot_size: z.string().nullable().optional(),
  camera_angle: z.string().nullable().optional(),
  camera_movement: z.string().nullable().optional(),
  narrative_purpose: z.string().nullable().optional(),
  visual_prompt: z.string().nullable().optional(),
  asset_status: z.string().default('idle'),
  task_id: z.string().nullable().optional(),
  asset_url: z.string().nullable().optional(),
  promoted_scene_id: z.number().int().nullable().optional()
});

export type Chapter = z.infer<typeof ChapterSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type CoverageGroup = z.infer<typeof CoverageGroupSchema>;
export type CoverageShot = z.infer<typeof CoverageShotSchema>;
