/** Project-owned image generation defaults. Legacy keys are migrated once in the database. */
export type ProjectImageModel = 'pony' | 'sd15' | 'redcraft_krea2';
export type ProjectNsfwMode = 'inherit' | 'on' | 'off';
export const PROJECT_VIDEO_WORKFLOW_IDS = [
  'grok_imagine_browser',
  'minimax_h3_ref2va_official_12gb',
  'minimax_h3_fl2va_official_12gb',
  'minimax_h3_multiframe_official_12gb',
  'minimax_h3_hongchao_a2a_12gb',
] as const;
export type ProjectVideoWorkflowId = typeof PROJECT_VIDEO_WORKFLOW_IDS[number];

export interface ProjectImageSettings {
  model: ProjectImageModel;
  workflow_id: number | null;
  style: string;
  output_spec: {
    aspect_ratio: '16:9' | '9:16' | '1:1';
    resolution: 'draft' | 'standard' | 'high';
    orientation_policy: 'fixed' | 'auto_by_shot';
  };
  nsfw_mode: ProjectNsfwMode;
}

export interface ProjectVideoSettings {
  /** Null means the shot's references choose Ref2VA, FL2VA, or Multi-Frame. */
  workflow_id: ProjectVideoWorkflowId | null;
}

export interface ProjectSettings {
  image_generation?: ProjectImageSettings;
  video_generation?: ProjectVideoSettings;
  storyboard_by?: string;
  genre?: string;
  style?: string;
  main_plot?: string;
  character_relations?: string;
  chapter_impact_entries?: Record<string, { main_plot: string; character_relations: string }>;
  story_tags?: string[];
  pov?: string;
  tone?: string;
  import_metadata?: Record<string, unknown>;
  import_info?: {
    source?: { filename?: string; format?: string };
    warnings?: string[];
    unmapped_sections?: unknown[];
  };
  agent_prompts_override?: Record<string, string>;
  [key: string]: unknown;
}

export const DEFAULT_PROJECT_IMAGE_SETTINGS: ProjectImageSettings = {
  model: 'pony',
  workflow_id: null,
  style: 'xianxia_immortal',
  output_spec: { aspect_ratio: '16:9', resolution: 'standard', orientation_policy: 'fixed' },
  nsfw_mode: 'inherit',
};

export const parseProjectSettings = (raw: unknown): ProjectSettings => {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as ProjectSettings) };
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ProjectSettings;
    } catch { /* Invalid settings use project defaults. */ }
  }
  return {};
};

/** Normalize only the current image_generation contract. */
export const getProjectImageSettings = (settings: ProjectSettings | null | undefined): ProjectImageSettings => {
  const raw = settings?.image_generation;
  const output = raw?.output_spec;
  return {
    model: raw?.model === 'sd15' || raw?.model === 'redcraft_krea2' ? raw.model : 'pony',
    workflow_id: Number.isSafeInteger(raw?.workflow_id) && Number(raw?.workflow_id) > 0
      ? Number(raw?.workflow_id) : null,
    style: typeof raw?.style === 'string' && raw.style.trim() ? raw.style : DEFAULT_PROJECT_IMAGE_SETTINGS.style,
    output_spec: {
      aspect_ratio: output?.aspect_ratio === '1:1'
        || output?.aspect_ratio === '16:9' || output?.aspect_ratio === '9:16'
        ? output.aspect_ratio : '16:9',
      resolution: output?.resolution === 'draft' || output?.resolution === 'high' ? output.resolution : 'standard',
      orientation_policy: output?.orientation_policy === 'auto_by_shot' ? 'auto_by_shot' : 'fixed',
    },
    nsfw_mode: raw?.nsfw_mode === 'on' || raw?.nsfw_mode === 'off' ? raw.nsfw_mode : 'inherit',
  };
};

export const getProjectVideoSettings = (settings: ProjectSettings | null | undefined): ProjectVideoSettings => {
  const raw = settings?.video_generation?.workflow_id;
  const workflow_id = typeof raw === 'string' && (PROJECT_VIDEO_WORKFLOW_IDS as readonly string[]).includes(raw)
    ? raw as ProjectVideoWorkflowId
    : null;
  return { workflow_id };
};

export const canonicalProjectSettings = (raw: unknown): ProjectSettings => {
  const settings = parseProjectSettings(raw);
  const canonical: ProjectSettings = {
    ...settings,
    image_generation: getProjectImageSettings(settings),
    video_generation: getProjectVideoSettings(settings),
  };
  for (const key of ['default_style', 'default_model_type', 'default_workflow_id', 'output_spec', 'nsfw_mode', 'nsfw_enabled']) {
    delete canonical[key];
  }
  return canonical;
};

export const resolveEffectiveNsfw = (options: {
  systemNsfwEnabled: boolean;
  projectSettings?: ProjectSettings | null;
}): boolean => {
  const mode = getProjectImageSettings(options.projectSettings).nsfw_mode;
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return Boolean(options.systemNsfwEnabled);
};

export const serializeProjectSettings = (settings: ProjectSettings): string => JSON.stringify(settings);
