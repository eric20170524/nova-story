/**
 * Vite only rewrites a direct import.meta.glob() call.
 * Node tests have no import.meta.env, so they return before that call.
 */
export function loadAdvancedStyleModules(): Record<string, { ADVANCED_VISUAL_STYLES?: unknown[] }> {
  if (typeof import.meta.env === 'undefined') {
    return {};
  }
  return import.meta.glob('./local/advanced_visual_styles.ts', { eager: true });
}
