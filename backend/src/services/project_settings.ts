/**
 * Project-level visual / NSFW settings stored in project.settings JSON.
 *
 * nsfw_mode:
 *   - inherit (default): use system advanced.nsfw_enabled
 *   - on / off: force for this project (storyboards + image gen)
 */

export type ProjectNsfwMode = 'inherit' | 'on' | 'off';

export interface ProjectSettings {
  default_style?: string;
  nsfw_mode?: ProjectNsfwMode;
  /** @deprecated prefer nsfw_mode; still honored when nsfw_mode is absent */
  nsfw_enabled?: boolean;
  storyboard_by?: string;
  [key: string]: unknown;
}

export const parseProjectSettings = (raw: unknown): ProjectSettings => {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as ProjectSettings) };
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as ProjectSettings;
      }
    } catch {
      /* ignore */
    }
  }
  return {};
};

export const normalizeNsfwMode = (settings: ProjectSettings): ProjectNsfwMode => {
  if (settings.nsfw_mode === 'on' || settings.nsfw_mode === 'off' || settings.nsfw_mode === 'inherit') {
    return settings.nsfw_mode;
  }
  if (typeof settings.nsfw_enabled === 'boolean') {
    return settings.nsfw_enabled ? 'on' : 'off';
  }
  return 'inherit';
};

/**
 * Resolve whether NSFW policy is active for this generation/storyboard request.
 * Priority: explicit request override → project nsfw_mode → system advanced.nsfw_enabled
 */
export const resolveEffectiveNsfw = (options: {
  systemNsfwEnabled: boolean;
  projectSettings?: ProjectSettings | null;
  requestOverride?: boolean | null;
}): boolean => {
  if (typeof options.requestOverride === 'boolean') {
    return options.requestOverride;
  }
  const mode = normalizeNsfwMode(options.projectSettings || {});
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return Boolean(options.systemNsfwEnabled);
};

export const serializeProjectSettings = (settings: ProjectSettings): string =>
  JSON.stringify(settings);
