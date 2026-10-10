/**
 * Deterministic visual_prompt sanitizer.
 * Vocabulary encoded from docs/best_practice_scene_visual_prompt.md §6 only.
 * Do not duplicate this word list in prompts.ts.
 */

export type SanitizeVisualPromptResult = {
  visual_prompt: string;
  /** Extra negative tokens produced by metaphor grounding (caller merges). */
  negative_extras: string[];
};

const normalize = (value: string): string => String(value || '').replace(/\s+/g, ' ').trim();

/** §6.1 exact tokens — delete whole comma-separated token (case-insensitive). */
const NON_VISUAL_EXACT_TOKENS = new Set([
  'environmental storytelling',
  'narrative comic panel',
  'story action',
  'atmospheric depth',
  'cinematic storyboard',
  'narrative scene',
  'silent atmosphere',
  'storytelling',
  'comic panel',
  'story continuity',
  'dreamcore',
  'detailed dreamcore amusement park environment',
  'deep perspective',
  'score_9',
  'score_8_up',
  'score_7_up',
  'source_anime',
]);

const isEngineToken = (token: string): boolean => {
  const lower = token.toLowerCase().trim();
  if (!lower) return true;
  return NON_VISUAL_EXACT_TOKENS.has(lower);
};

/**
 * Drop engine and project-prefix tags. Sound, smell, psychology, and simile
 * wording stays in the sentence for video and for the still auditor.
 */
export const sanitizeVisualPrompt = (input: string): SanitizeVisualPromptResult => {
  const parts: string[] = [];

  for (const raw of normalize(input).split(',')) {
    const token = raw.trim();
    if (!token || isEngineToken(token)) continue;
    parts.push(token);
  }

  return {
    visual_prompt: parts.join(', '),
    negative_extras: [],
  };
};
