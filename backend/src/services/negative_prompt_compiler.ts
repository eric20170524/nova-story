/**
 * Compile per-shot negative_prompt from contract cues.
 * Source: docs/best_practice_scene_visual_prompt.md §7
 * Must not copy one static string across a whole chapter.
 */

import { type ShotIntent } from './shot_intent_quota';

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

const normalize = (value: string): string => String(value || '').replace(/\s+/g, ' ').trim();

/** Shot-type words and prompt words do not choose an intent. Quota stats still guess. */
const resolveExplicitIntent = (input: NegativeCompileInput): ShotIntent | null => {
  const explicit = normalize(String(input.shot_intent || '')).toLowerCase();
  if (explicit && explicit in SHOT_INVERSE) return explicit as ShotIntent;
  return null;
};

/** Identity comes only from an explicit mode. Auto does not scan the paragraph. */
export const inferIdentityMode = (input: NegativeCompileInput): ResolvedIdentityMode => {
  const mode = input.identity_mode || 'auto';
  if (mode === 'human' || mode === 'nonhuman' || mode === 'mixed' || mode === 'unknown') {
    return mode;
  }
  return 'unknown';
};

export const compileNegativePrompt = (input: NegativeCompileInput): string => {
  const intent = resolveExplicitIntent(input);
  const parts: string[] = [];

  const identity = inferIdentityMode(input);
  if (identity === 'nonhuman') {
    parts.push(...IDENTITY_LOCK_NONHUMAN);
  }

  if (intent) parts.push(...SHOT_INVERSE[intent]);

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
