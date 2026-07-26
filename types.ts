// Projects
export interface Project {
  id: number;
  title: string;
  description?: string;
  settings?: string; // JSON string
  created_at?: string;
}

// Characters
export interface Character {
  id: number;
  project_id: number;
  name: string;
  role: string; // 'protagonist' | 'antagonist' | 'supporting'
  description: string;
  visual_tags: Record<string, any>; // Key-value pairs for ComfyUI or complex object
  avatar_url?: string;
  turnaround_url?: string;
  face_url?: string;
  model_type?: 'pony' | 'flux';
}

// Chapters (Structure)
export interface Chapter {
  id: string; // UUID
  project_id: number;
  title: string;
  index: number;
  content: string;
}

// Timeline & Director Mode
export interface Scene {
  id: number | string;
  visual_prompt: string;
  negative_prompt?: string; // Added for finer control
  audio_prompt: string;
  dialogue: string;
  duration: number;
  shot_type?: string;
  camera_movement?: string;
  camera_angle?: string;
  asset_status?: 'idle' | 'generating' | 'completed' | 'failed';
  asset_url?: string; // URL to generated image
  task_id?: string; // ComfyUI task ID
}

export type StoryboardMode = 'narrative' | 'nine_shot_coverage';
export type AssetMode = 'single_image' | 'contact_sheet_3x3';

export interface TimelineResponse {
  chapter_id: string;
  storyboard_mode?: StoryboardMode;
  timeline: Scene[];
}

export interface CoverageShot {
  id: number;
  coverage_group_id: number;
  slot: number;
  shot_size?: string;
  camera_angle?: string;
  camera_movement?: string;
  narrative_purpose?: string;
  visual_prompt?: string;
  asset_status?: 'idle' | 'generating' | 'completed' | 'failed';
  asset_url?: string;
  promoted_scene_id?: number;
}

export interface CoverageGroup {
  id: number;
  source_scene_id: number;
  version: number;
  status: string;
  shots: CoverageShot[];
}

// Workflows
export interface Workflow {
  id: number;
  name: string;
  description: string;
  content: Record<string, any>; // ComfyUI JSON
  is_active: boolean;
}

// Asset Generation
export interface AssetGenerationResponse {
  task_id: string;
  status: string;
}

export interface StreamMessage {
  status: 'processing' | 'completed' | 'failed';
  progress?: number;
  image_url?: string;
  error?: string;
}

export interface GenerationParams {
  cfg?: number;
  steps?: number;
  sampler_name?: string;
  scheduler?: string;
}

export interface GeneratePayload {
  prompt: string;
  negative_prompt?: string;
  style_preset?: string;
  mode?: string;
  ref_image_url?: string | null;
  reference_model_type?: string;
  generation_params?: GenerationParams;
}
