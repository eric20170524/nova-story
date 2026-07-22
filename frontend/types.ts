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

export interface TimelineResponse {
  chapter_id: string;
  timeline: Scene[];
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
