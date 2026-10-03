import type { ImageOutputSpec } from '../types';

/** Accept saved project data, including ratios written before the 16:9 contract. */
export const normalizeProjectOutputSpec = (raw: unknown): Required<ImageOutputSpec> => {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    aspect_ratio: value.aspect_ratio === '9:16' || value.aspect_ratio === '1:1'
      ? value.aspect_ratio : '16:9',
    resolution: value.resolution === 'draft' || value.resolution === 'high'
      ? value.resolution : 'standard',
    orientation_policy: value.orientation_policy === 'auto_by_shot' || value.aspect_ratio === 'auto'
      ? 'auto_by_shot' : 'fixed',
  };
};
