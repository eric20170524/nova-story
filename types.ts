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
  generation_params?: GenerationParams;
}
