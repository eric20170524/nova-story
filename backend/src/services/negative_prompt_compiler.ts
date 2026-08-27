/**
 * Compile per-shot negative_prompt from contract cues.
 * Source: docs/best_practice_scene_visual_prompt.md §7
 * Must not copy one static string across a whole chapter.
 */

import { mapShotTypeToIntent, type ShotIntent } from './shot_intent_quota';

export type IdentityMode = 'nonhuman' | 'human' | 'mixed' | 'unknown' | 'auto';

export type NegativeCompileInput = {
  shot_type?: string | null;
  shot_intent?: string | null;
  visual_prompt?: string | null;
  location?: string | null;
  key_props?: string[] | string | null;
  /** Optional character visual-lock text used only for identity inference. */
  character_lock?: string | null;
  /**
   * human: no human-family negatives
   * nonhuman: generic human/humanoid exclusions only (no wolf/fox/dog)
   * mixed: human+animal same frame — no identity lock
   * unknown/auto-with-no-cues: neutral — no identity lock
   */
  identity_mode?: IdentityMode;
};

export type ResolvedIdentityMode = 'nonhuman' | 'human' | 'mixed' | 'unknown';

const GLOBAL_QUALITY_NEGATIVE = [
  'bad anatomy',
  'extra limbs',
  'text',
  'watermark',
  'child',
  'loli',
  'shota',
];

/** Generic non-human lock: exclude humans only. Species typos belong in must_not / project. */
const IDENTITY_LOCK_NONHUMAN = [
  'human',
  'person',
  'man',
  'woman',
  'girl',
  'boy',
  'humanoid',
  '2animals',
  'duplicate animal',
];

const SHOT_INVERSE: Record<ShotIntent, string[]> = {
  insert: [
    'full body',
    'animal portrait',
    'landscape',
    'aerial',
    'satellite photo',
    'plain background',
    'studio backdrop',
  ],
  // Wide/establish: suppress studio close-ups, but do NOT add `simple background`
  // (AC: that token empties environment plates on this checkpoint).
  establish: [
    'close-up face',
    'studio portrait',
    'looking at viewer',
    'plain background',
  ],
  'wide-action': [
    'close-up face',
    'studio portrait',
    'looking at viewer',
    'plain background',
  ],
  reaction: [
    'front-facing studio portrait',
    'looking at viewer',
    'ID photo',
    'plain background',
  ],
  payoff: ['mecha', 'helmet', 'spaceship', 'satellite', 'abstract explosion'],
  'medium-action': ['studio portrait', 'looking at viewer', 'plain background'],
  'overhead-map': ['close-up face', 'facial close-up', 'studio portrait'],
};

const LOCATION_INVERSE_RULES: Array<{ match: RegExp; negatives: string[] }> = [
  {
    match: /\b(corridor|arcade|hallway|machine room|cockpit|cabin|interior|室内|长廊|机房|座舱)\b/i,
    negatives: ['mountains', 'real sky vista', 'farmland', 'satellite photo', 'outdoor nature'],
  },
  {
    match: /\b(cloud[- ]?(like|shaped)?\s*platform|candy-floss|spectator platform)\b/i,
    negatives: ['real clouds', 'mountains', 'aerial landscape'],
  },
  {
    match: /\b(plaza|square|establishing|welcome)\b/i,
    negatives: ['indoor studio', 'empty void'],
  },
];

const PROP_INVERSE_RULES: Array<{ match: RegExp; negatives: string[] }> = [
  {
    match: /\b(music box|gear|gears|core|mechanism|八音盒|齿轮|核心)\b/i,
    negatives: ['mecha', 'robot head', 'helmet', 'vehicle', 'spaceship'],
  },
  {
    match: /\b(miniature (park )?map|guide map|music-note button|button|导览|音符按钮)\b/i,
    negatives: ['full park aerial', 'extra panels', 'text captions'],
  },
  {
    match: /\b(ice pool|glass(?:-like)? (?:ice|water)|mirror pool|水池)\b/i,
    negatives: ['metal scales', 'snake skin', 'abstract texture close-up'],
  },
];

const NONHUMAN_CUE =
  /\b(creature|furry|quadruped|kitten|cat|paw|animal|fox|wolf|dog|小兽)\b/i;
const HUMAN_CUE = /\b(1girl|1boy|woman|man|girl|boy)\b/i;

const normalize = (value: string): string => String(value || '').replace(/\s+/g, ' ').trim();

const resolveIntent = (input: NegativeCompileInput): ShotIntent => {
  const explicit = normalize(String(input.shot_intent || '')).toLowerCase();
  if (explicit && explicit in SHOT_INVERSE) return explicit as ShotIntent;
  return mapShotTypeToIntent(input.shot_type, input.visual_prompt);
};

const propHaystack = (input: NegativeCompileInput): string => {
  const props = Array.isArray(input.key_props)
    ? input.key_props.join(' ')
    : String(input.key_props || '');
  return [input.visual_prompt, input.location, props, input.character_lock]
    .filter(Boolean)
    .join(' ');
};

/** Exported for call sites that want to resolve before compile. */
export const inferIdentityMode = (input: NegativeCompileInput): ResolvedIdentityMode => {
  const mode = input.identity_mode || 'auto';
  if (mode === 'human' || mode === 'nonhuman' || mode === 'mixed' || mode === 'unknown') {
    return mode;
  }
  // auto
  const hay = propHaystack(input).toLowerCase();
  const hasNonhuman = NONHUMAN_CUE.test(hay);
  const hasHuman = HUMAN_CUE.test(hay);
  if (hasNonhuman && hasHuman) return 'mixed';
  if (hasNonhuman) return 'nonhuman';
  if (hasHuman) return 'human';
  return 'unknown';
};

export const compileNegativePrompt = (input: NegativeCompileInput): string => {
  const intent = resolveIntent(input);
  const hay = propHaystack(input);
  const parts: string[] = [];

  const identity = inferIdentityMode(input);
  if (identity === 'nonhuman') {
    parts.push(...IDENTITY_LOCK_NONHUMAN);
  }

  parts.push(...(SHOT_INVERSE[intent] || []));

  for (const rule of LOCATION_INVERSE_RULES) {
    if (rule.match.test(hay) || rule.match.test(String(input.location || ''))) {
      parts.push(...rule.negatives);
    }
  }
  for (const rule of PROP_INVERSE_RULES) {
    if (rule.match.test(hay)) {
      parts.push(...rule.negatives);
    }
  }

  parts.push(...GLOBAL_QUALITY_NEGATIVE);

  // Deduplicate case-insensitively while preserving first-seen casing.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of parts) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(token);
  }
  return unique.join(', ');
};
