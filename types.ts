// Projects
export interface Project {
  id: number;
  title: string;
  description?: string;
  settings?: string; // JSON string
  created_at?: string;
}

export interface ProjectExport {
  format: 'novastory-project';
  version: number;
  exported_at: string;
  project: Omit<Project, 'settings'> & {
    settings?: string | Record<string, any>;
    [key: string]: any;
  };
  screenplay: {
    chapters: Array<Chapter & Record<string, any>>;
  };
  character_center: {
    characters: Array<Character & Record<string, any>>;
  };
  director: {
    scenes: Array<Scene & Record<string, any>>;
    coverage_groups: Array<CoverageGroup & Record<string, any>>;
    coverage_shots: Array<CoverageShot & Record<string, any>>;
  };
  summary: {
    chapters: number;
    characters: number;
    scenes: number;
    coverage_groups: number;
    coverage_shots: number;
  };
}

// Characters
export interface CharacterVersionSummary {
  version: number;
  label?: string;
  description?: string | null;
  avatar_url?: string | null;
  turnaround_url?: string | null;
  face_url?: string | null;
  has_avatar?: boolean;
  has_turnaround?: boolean;
  model_type?: string;
  created_at?: string;
}

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
  /** Local Comfy family. `flux` kept only for reading legacy project data (maps to pony). */
  model_type?: 'pony' | 'sd15' | 'flux';
  /** Active look/content version (1-based) */
  active_version?: number;
  versions?: CharacterVersionSummary[];
}

// Chapters (Structure)
export interface Chapter {
  id: string; // UUID
  project_id: number;
  title: string;
  index: number;
  content: string;
  summary?: string | null;
  condensed_content?: string | null;
  status?: string;
}

export interface GlossaryItem {
  id: number;
  project_id: number;
  term: string;
  definition?: string | null;
  category?: string | null;
}

// Timeline & Director Mode
export interface SceneVersionSummary {
  version: number;
  label?: string;
  asset_status?: string;
  asset_url?: string | null;
  has_image?: boolean;
  created_at?: string;
}

export interface Scene {
  id: number | string;
  visual_prompt: string;
  negative_prompt?: string; // Added for finer control
  audio_prompt: string;
  dialogue: string;
  narration?: string;
  duration: number;
  shot_type?: string;
  camera_movement?: string;
  camera_angle?: string;
  asset_status?: 'idle' | 'generating' | 'completed' | 'failed';
  asset_url?: string; // URL to generated image
  task_id?: string; // ComfyUI task ID
  /** Active generation/content version (1-based) */
  active_version?: number;
  /** Available versions for A/B switching */
  versions?: SceneVersionSummary[];
}

export type StoryboardMode = 'narrative' | 'nine_shot_coverage';
export type AssetMode = 'single_image' | 'contact_sheet_3x3' | 'video_clip';

export type VideoProfile = 'narrative_clip' | 'character_loop';
export type VideoPreset = 'preview_480p_5s' | 'standard_720p_5s';
export type VideoTaskStage =
  | 'queued'
  | 'preflight'
  | 'vram_tuning'
  | 'vram_ready'
  | 'staging_refs'
  | 'model_loading'
  | 'generating'
  | 'collecting'
  | 'postprocessing'
  | 'qa_running'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type MediaAssetRole =
  | 'video_keyframe'
  | 'character_reference'
  | 'motion_reference'
  | 'raw_video'
  | 'loop_master'
  | 'narrative_final'
  | 'poster'
  | 'qa_report';

export interface MediaAsset {
  id: number;
  project_id: number;
  scene_id?: number | null;
  scene_version?: number | null;
  character_id?: number | null;
  parent_asset_id?: number | null;
  media_type: 'image' | 'video' | 'json';
  role: MediaAssetRole;
  profile?: VideoProfile | null;
  status: 'draft' | 'ready' | 'rejected' | 'archived';
  url: string;
  mime_type?: string;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  frame_count?: number | null;
  duration_ms?: number | null;
  sha256?: string;
  metadata_json?: string;
  created_at?: string;
}

export interface VideoQAReport {
  schema_version: number;
  task_id: string;
  profile: VideoProfile;
  technical_pass: boolean;
  technical_details: {
    codec: string;
    pixel_format: string;
    width: number;
    height: number;
    fps: number;
    frame_count: number;
    duration_s: number;
    has_audio: boolean;
  };
  continuity_scores: {
    appearance_error: number;
    motion_error: number;
    flicker_error: number;
    seam_cost: number;
    normalized_score: number;
  };
  quality_grade: 'pass' | 'manual_review' | 'reject';
  reasons: string[];
  evaluated_at: string;
}

export interface VideoTaskState {
  task_id: string;
  scene_id: number;
  status: 'queued' | 'processing' | 'completed' | 'rejected' | 'failed' | 'cancelled' | 'interrupted';
  stage?: VideoTaskStage;
  queue_position?: number;
  error?: string | null;
  output_url?: string | null;
  raw_video_url?: string | null;
  poster_url?: string | null;
  qa_report?: VideoQAReport | null;
  created_at?: string;
  updated_at?: string;
}

export interface VideoCapabilities {
  video_generation_enabled: boolean;
  ffmpeg_available: boolean;
  ffprobe_available: boolean;
  comfyui_online: boolean;
  h3_workflow_ready: boolean;
  gpu_available: boolean;
  gpu_name?: string | null;
  vram_free_bytes?: number | null;
  supported_presets: VideoPreset[];
  supported_profiles: VideoProfile[];
  missing_components: string[];
}

export interface VideoPreflightResponse {
  ready: boolean;
  profile: VideoProfile;
  preset: VideoPreset;
  compiled_spec?: any;
  blockers: string[];
  warnings: string[];
  estimated_duration_seconds: number;
}

export interface VideoGenerationRequest {
  scene_id: number;
  scene_version?: number;
  profile: VideoProfile;
  keyframe_asset_id?: number;
  character_reference_asset_ids?: number[];
  motion_reference_asset_id?: number;
  last_frame_asset_id?: number;
  prompt_override?: string;
  preset?: VideoPreset;
  seed?: number;
  run_loop_closer?: boolean;
}

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
  negative_prompt?: string;
  shot_spec?: string;
  shot_intent?: string;
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
  type?: string;
  status?: 'processing' | 'completed' | 'failed' | string;
  progress?: number;
  image_url?: string;
  error?: string;
  phase?: string;
  message?: string;
  message_zh?: string;
  skipped?: boolean;
  data?: Record<string, unknown>;
}

export interface GenerationParams {
  cfg?: number;
  steps?: number;
  sampler_name?: string;
  scheduler?: string;
  /** Low-level exact canvas override; width and height must be provided together. */
  width?: number;
  height?: number;
  output_spec?: ImageOutputSpec;
}

export interface ImageOutputSpec {
  aspect_ratio?: '3:4' | '4:3' | '1:1' | '16:9' | '9:16' | 'auto';
  resolution?: 'draft' | 'standard' | 'high';
  orientation_policy?: 'fixed' | 'auto_by_shot';
}

export interface GeneratePayload {
  prompt: string;
  negative_prompt?: string;
  style_preset?: string;
  mode?: string;
  /** @deprecated Prefer character_ref_url; kept for backward compatibility */
  ref_image_url?: string | null;
  /** Tier A/B: character / identity reference image */
  character_ref_url?: string | null;
  /** Tier B: composition / pose reference (ignored until ControlNet is wired) */
  composition_ref_url?: string | null;
  /** Tier A: appearance tags already merged into prompt (also re-applied server-side) */
  character_appearance_prompt?: string | null;
  character_appearance_snippets?: string[];
  /** Character LoRA filename when trained/ready */
  character_lora?: string | null;
  /** 'A' | future 'B' — documentation / logging only */
  reference_tier?: 'A' | 'B' | string;
  reference_model_type?: string;
  model_type?: string;
  gen_type?: string;
  denoise?: number;
  output_spec?: ImageOutputSpec;
  generation_params?: GenerationParams;
}
