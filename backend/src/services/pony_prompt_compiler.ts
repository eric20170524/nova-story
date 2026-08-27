/**
 * compilePonyPrompt — pure contract → Pony positive tags.
 * Source: docs/best_practice_scene_visual_prompt.md §4–5
 * Quality score_* suffix is NOT included (generation_service only).
 */

import { mapShotTypeToIntent, type ShotIntent } from './shot_intent_quota';
import { sanitizeVisualPrompt } from './visual_prompt_sanitizer';

export type PonyContract = {
  shot_intent?: string | null;
  shot_type?: string | null;
  location: string;
  primary_action: string;
  primary_subject?: string | null;
  /** All on-screen character names/ids (primary is focus). */
  visible_subjects?: string[] | null;
  key_props?: string[] | null;
  subject_scale?: string | null;
  must_not?: string[] | null;
};

export type CharacterLockRef = {
  name?: string | null;
  aliases?: string[] | null;
  lock: string;
};

export type CompilePonyPromptResult = {
  visual_prompt: string;
  negative_extras: string[];
  shot_intent: ShotIntent;
};

const INTENT_CUE: Record<ShotIntent, string> = {
  insert: 'insert shot, macro, object focus',
  establish: 'establishing shot, wide environment',
  'wide-action': 'wide action shot',
  'medium-action': 'medium action shot',
  reaction: 'reaction shot, three-quarter view',
  'overhead-map': 'overhead shot, spatial map',
  payoff: 'payoff shot, single state change',
};

const normalizePart = (value: string): string => String(value || '').replace(/\s+/g, ' ').trim();

const resolveIntent = (contract: PonyContract): ShotIntent => {
  const explicit = normalizePart(String(contract.shot_intent || '')).toLowerCase();
  if (explicit && explicit in INTENT_CUE) return explicit as ShotIntent;
  return mapShotTypeToIntent(contract.shot_type, contract.primary_action);
};

const locationAnchors = (location: string, budget: number): string[] => {
  const raw = normalizePart(location);
  if (!raw) return [];
  const chunks = raw
    .split(/,|，| and /i)
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length <= budget) return chunks;
  return chunks.slice(0, budget);
};

const shouldIncludeCharacterLock = (contract: PonyContract): boolean => {
  const scale = normalizePart(String(contract.subject_scale || '')).toLowerCase();
  if (scale === 'absent') return false;
  const subject = normalizePart(String(contract.primary_subject || '')).toLowerCase();
  if (subject === 'none' || subject === 'paw-only') return false;
  return true;
};

const weightedFocus = (action: string, props: string[]): string => {
  const act = normalizePart(action);
  const prop = props[0] ? normalizePart(props[0]) : '';
  if (act && prop && !act.toLowerCase().includes(prop.toLowerCase().slice(0, 12))) {
    return `(${act} with ${prop}:1.35)`;
  }
  if (act) return `(${act}:1.35)`;
  if (prop) return `(${prop}:1.35)`;
  return '';
};

const normalizeLockRefs = (
  characterLock: string | CharacterLockRef[] | null | undefined
): CharacterLockRef[] => {
  if (!characterLock) return [];
  if (Array.isArray(characterLock)) {
    return characterLock
      .map((ref) => ({
        name: normalizePart(String(ref?.name || '')) || null,
        aliases: Array.isArray(ref?.aliases)
          ? ref.aliases.map((a) => normalizePart(String(a))).filter(Boolean)
          : [],
        lock: normalizePart(String(ref?.lock || '')),
      }))
      .filter((ref) => Boolean(ref.lock));
  }
  const lock = normalizePart(characterLock);
  return lock ? [{ name: null, aliases: [], lock }] : [];
};

const refMatchesNeedle = (ref: CharacterLockRef, needle: string): boolean => {
  const n = needle.toLowerCase();
  if (!n) return false;
  const name = String(ref.name || '').toLowerCase();
  if (name && (name === n || name.includes(n) || n.includes(name))) return true;
  for (const alias of ref.aliases || []) {
    const a = alias.toLowerCase();
    if (a && (a === n || a.includes(n) || n.includes(a))) return true;
  }
  // Subject string already embeds the lock phrase.
  if (ref.lock && n.includes(ref.lock.toLowerCase().slice(0, 24))) return true;
  return false;
};

/**
 * Resolve which character locks belong on this shot.
 * - Prefer visible_subjects (+ primary as focus)
 * - Else match primary_subject to one ref
 * - Else if only one lock exists in the project, use it
 * - Never dump every lock when multiple exist and nothing matched
 */
export const resolveCharacterLocksForShot = (
  contract: PonyContract,
  characterLock: string | CharacterLockRef[] | null | undefined
): string[] => {
  const refs = normalizeLockRefs(characterLock);
  if (!refs.length) return [];

  const needles: string[] = [];
  for (const raw of contract.visible_subjects || []) {
    const n = normalizePart(String(raw));
    if (n) needles.push(n);
  }
  const primary = normalizePart(String(contract.primary_subject || ''));
  if (primary && primary.toLowerCase() !== 'none' && primary.toLowerCase() !== 'paw-only') {
    if (!needles.some((n) => n.toLowerCase() === primary.toLowerCase())) {
      needles.unshift(primary);
    }
  }

  if (needles.length) {
    const matched: string[] = [];
    const seen = new Set<string>();
    for (const needle of needles) {
      for (const ref of refs) {
        if (!refMatchesNeedle(ref, needle)) continue;
        const key = ref.lock.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        matched.push(ref.lock);
      }
    }
    if (matched.length) return matched;
    // primary_subject was a bare name with no matching lock — do not emit the name alone.
    return [];
  }

  if (refs.length === 1) return [refs[0]!.lock];
  return [];
};

/**
 * Compile CLIP-ordered Pony tags from a shot contract + character lock(s).
 * stylePreset is accepted for API stability; project style stays in generation suffix.
 */
export const compilePonyPrompt = (
  contract: PonyContract,
  characterLock: string | CharacterLockRef[] = '',
  _stylePreset?: string | null
): CompilePonyPromptResult => {
  const intent = resolveIntent(contract);
  const props = (contract.key_props || [])
    .map((p) => normalizePart(String(p)))
    .filter(Boolean)
    .slice(0, 2);
  const action = normalizePart(contract.primary_action);
  const anchors = locationAnchors(contract.location, Math.max(1, 3 - props.length));

  const parts: string[] = [];
  parts.push(INTENT_CUE[intent]);

  // Unique focus first (CLIP front window) — especially for insert.
  const focus = weightedFocus(action, props);
  if (focus) parts.push(focus);
  for (const prop of props) {
    if (!focus.toLowerCase().includes(prop.toLowerCase())) parts.push(prop);
  }

  for (const anchor of anchors) {
    const lower = anchor.toLowerCase();
    if (parts.some((p) => p.toLowerCase().includes(lower))) continue;
    if (intent === 'insert') {
      parts.push(`${anchor} in soft background`);
    } else {
      parts.push(anchor);
    }
  }

  if (shouldIncludeCharacterLock(contract)) {
    const locks = resolveCharacterLocksForShot(contract, characterLock);
    for (const lock of locks) parts.push(lock);
    const scale = normalizePart(String(contract.subject_scale || '')).toLowerCase();
    if (scale === 'small-15-20') {
      parts.push('subject occupies 15 to 20 percent of the frame, off-center');
    } else if (scale === 'medium-20-40') {
      parts.push('subject occupies 20 to 40 percent of the frame, off-center');
    } else if (scale === 'dominant') {
      parts.push('subject dominant in frame');
    }
  } else if (normalizePart(String(contract.primary_subject || '')).toLowerCase() === 'paw-only') {
    parts.push('paw only, no full body');
  }

  const compacted = parts
    .map((p) => normalizePart(p))
    .filter(Boolean)
    .filter((part, index, arr) => arr.findIndex((x) => x.toLowerCase() === part.toLowerCase()) === index);

  const sanitized = sanitizeVisualPrompt(compacted.join(', '));
  return {
    visual_prompt: sanitized.visual_prompt,
    negative_extras: sanitized.negative_extras,
    shot_intent: intent,
  };
};
