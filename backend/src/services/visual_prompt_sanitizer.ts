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

/**
 * §6.1 pattern tokens — delete if the whole token matches (or is dominated by)
 * non-visual sense / meta / psychology vocabulary.
 */
const NON_VISUAL_TOKEN_PATTERNS: RegExp[] = [
  /\b(sound|sounds|echo|echoes|creak|creaking|scraping sound|music playing)\b/i,
  /\b(scent|smell|aroma|fragrance|odour|odor)\b/i,
  /\b(loneliness|determination)\b/i,
  /\bemptiness in the heart\b/i,
  /\bmetallic ring echo\b/i,
  /\bring echo\b/i,
];

/** Visible music / melody props must survive sound scrubbing. */
const PRESERVE_DESPITE_SOUND = /\b(music[- ]?note|musical note|melody|tuning fork|music box|note button)\b/i;

type MetaphorRule = {
  /** Match against a single comma token (lowercased). */
  match: RegExp;
  replace: string;
  negative_extras: string[];
};

/** §6.2 metaphor → concrete visual + negative extras. */
const METAPHOR_RULES: MetaphorRule[] = [
  {
    match: /\bcloud[- ]like platforms?\b|\bcloud platforms?\b/i,
    replace:
      'hard candy-floss spectator platform shaped like a cloud, flat walkable floor, pastel park lighting',
    negative_extras: ['real clouds', 'mountains', 'blue sky vista', 'outdoor nature'],
  },
  {
    match: /\bpurple[- ]gold light spreading\b|\bwarm purple[- ]gold light spreading\b/i,
    replace: 'light traveling along engraved metal grooves / lamp bulbs lighting up',
    negative_extras: ['mecha', 'helmet', 'spaceship', 'energy explosion sky'],
  },
];

/** Unlisted X-like / as if → drop rhetoric, keep noun if present. */
const GENERIC_LIKE_PATTERN = /\b([\w][\w-]*)[- ]like\b/i;
const AS_IF_PATTERN = /\bas if\b[^.|,]*/i;

const isNonVisualToken = (token: string): boolean => {
  const lower = token.toLowerCase().trim();
  if (!lower) return true;
  if (NON_VISUAL_EXACT_TOKENS.has(lower)) return true;
  if (PRESERVE_DESPITE_SOUND.test(token)) return false;
  return NON_VISUAL_TOKEN_PATTERNS.some((pattern) => pattern.test(token));
};

const applyMetaphorToToken = (
  token: string
): { token: string | null; negatives: string[] } => {
  for (const rule of METAPHOR_RULES) {
    if (rule.match.test(token)) {
      return { token: rule.replace, negatives: [...rule.negative_extras] };
    }
  }

  // metallic ring echo: AC requires deletion (sound concept), not grounding.
  if (/\bmetallic ring echo\b/i.test(token) || /^metallic ring echo$/i.test(token.trim())) {
    return { token: null, negatives: ['abstract metal scales', 'macro texture only'] };
  }

  let next = token;
  if (AS_IF_PATTERN.test(next)) {
    next = next.replace(AS_IF_PATTERN, '').replace(/\s+/g, ' ').trim();
  }
  if (GENERIC_LIKE_PATTERN.test(next) && !/\bcloud[- ]like\b/i.test(next)) {
    // Drop "X-like" rhetoric; keep a bare noun when the token is mostly that phrase.
    next = next.replace(GENERIC_LIKE_PATTERN, '$1').replace(/\s+/g, ' ').trim();
  }
  if (!next) return { token: null, negatives: [] };
  return { token: next, negatives: [] };
};

/**
 * Sanitize a visual_prompt for storage / compile.
 * Deletes non-visual tokens, grounds listed metaphors, strips leftover quality/abstract banned words.
 */
export const sanitizeVisualPrompt = (input: string): SanitizeVisualPromptResult => {
  const negative_extras: string[] = [];
  const parts: string[] = [];

  for (const raw of normalize(input).split(',')) {
    let token = raw.trim();
    if (!token) continue;
    if (isNonVisualToken(token)) continue;

    const grounded = applyMetaphorToToken(token);
    if (grounded.negatives.length) {
      negative_extras.push(...grounded.negatives);
    }
    if (!grounded.token) continue;
    token = grounded.token;

    // Re-check after grounding / rewrite (replacement may be multi-token CSV).
    for (const piece of token.split(',').map((p) => p.trim()).filter(Boolean)) {
      if (isNonVisualToken(piece)) continue;
      parts.push(piece);
    }
  }

  return {
    visual_prompt: parts.join(', '),
    negative_extras: [...new Set(negative_extras.map((t) => t.trim()).filter(Boolean))],
  };
};
