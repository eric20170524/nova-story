/**
 * Adjacent-shot uniqueness gate.
 * Rules: docs/best_practice_scene_visual_prompt.md §3.2
 * - adjacent uniqueness_key must differ when both present
 * - adjacent visual_prompt token Jaccard ≥ threshold → reject
 */

const DEFAULT_JACCARD_THRESHOLD = 0.65;

const normalize = (value: string): string => String(value || '').replace(/\s+/g, ' ').trim();

/** Lowercase alphanumeric tokens from a comma/space separated visual_prompt. */
export const tokenizeVisualPrompt = (prompt: string): string[] => {
  const raw = normalize(prompt).toLowerCase();
  if (!raw) return [];
  const tokens = raw
    .split(/[,]+/)
    .flatMap((part) => part.trim().split(/\s+/))
    .map((token) => token.replace(/^[^a-z0-9+(]+|[^a-z0-9+)]+$/gi, '').toLowerCase())
    .filter((token) => token.length >= 2);
  return tokens;
};

export const tokenJaccard = (a: string, b: string): number => {
  const setA = new Set(tokenizeVisualPrompt(a));
  const setB = new Set(tokenizeVisualPrompt(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

export type UniquenessShot = {
  visual_prompt: string;
  uniqueness_key?: string | null;
};

export type UniquenessViolation = {
  index: number;
  reason: 'jaccard' | 'uniqueness_key';
  score?: number;
  prev_key?: string;
  next_key?: string;
};

/**
 * Derive a coarse uniqueness key when shot_spec is absent:
 * first 8 distinctive tokens joined (stable enough for duplicate detection).
 */
export const deriveUniquenessKey = (visualPrompt: string): string => {
  const tokens = tokenizeVisualPrompt(visualPrompt).slice(0, 8);
  return tokens.join('|');
};

export const resolveUniquenessKey = (shot: UniquenessShot): string => {
  const explicit = normalize(String(shot.uniqueness_key || ''));
  if (explicit) return explicit.toLowerCase();
  return deriveUniquenessKey(shot.visual_prompt);
};

export const findAdjacentUniquenessViolation = (
  shots: UniquenessShot[],
  threshold: number = DEFAULT_JACCARD_THRESHOLD
): UniquenessViolation | null => {
  for (let i = 1; i < shots.length; i++) {
    const prev = shots[i - 1]!;
    const next = shots[i]!;
    const prevExplicit = normalize(String(prev.uniqueness_key || '')).toLowerCase();
    const nextExplicit = normalize(String(next.uniqueness_key || '')).toLowerCase();
    // Only enforce key equality when both shots carry an explicit contract key.
    if (prevExplicit && nextExplicit && prevExplicit === nextExplicit) {
      return {
        index: i,
        reason: 'uniqueness_key',
        prev_key: prevExplicit,
        next_key: nextExplicit,
      };
    }
    const score = tokenJaccard(prev.visual_prompt, next.visual_prompt);
    if (score >= threshold) {
      return {
        index: i,
        reason: 'jaccard',
        score,
        prev_key: prevExplicit || deriveUniquenessKey(prev.visual_prompt),
        next_key: nextExplicit || deriveUniquenessKey(next.visual_prompt),
      };
    }
  }
  return null;
};

export const assertChapterUniqueness = (
  shots: UniquenessShot[],
  threshold: number = DEFAULT_JACCARD_THRESHOLD
): { ok: true } | { ok: false; violation: UniquenessViolation } => {
  const violation = findAdjacentUniquenessViolation(shots, threshold);
  if (violation) return { ok: false, violation };
  return { ok: true };
};

export const formatUniquenessFailure = (violation: UniquenessViolation): string => {
  if (violation.reason === 'uniqueness_key') {
    return `Uniqueness gate failed at shot index ${violation.index}: identical uniqueness_key "${violation.next_key}"`;
  }
  const score = violation.score != null ? violation.score.toFixed(3) : '?';
  return `Uniqueness gate failed at shot index ${violation.index}: token Jaccard ${score} ≥ 0.65`;
};
