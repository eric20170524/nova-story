/**
 * shot_type → shot_intent mapping and chapter quota gates.
 * Source: docs/best_practice_scene_visual_prompt.md §3.1–3.2
 */

import { SHOT_INTENTS, type ShotIntent } from '../schemas/shot_contract';

export { SHOT_INTENTS, type ShotIntent };

export type ShotQuotaInput = {
  shot_type?: string | null;
  shot_intent?: string | null;
  visual_prompt?: string | null;
};

export type ShotQuotaViolation = {
  reason:
    | 'wide_floor'
    | 'close_ceiling'
    | 'missing_insert'
    | 'homogenous_shot_type'
    | 'homogenous_intent';
  detail: string;
  counts: Record<ShotIntent, number>;
  total: number;
};

const normalize = (value: string): string => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Map legacy / free-text shot_type (+ optional prompt cues) onto shot_intent. */
export const mapShotTypeToIntent = (
  shotType?: string | null,
  visualPrompt?: string | null
): ShotIntent => {
  const type = normalize(String(shotType || ''));
  const prompt = normalize(String(visualPrompt || ''));

  if (/\b(insert|detail shot|macro|object close-up|prop close-up|ecu|extreme close-up)\b/.test(type)) {
    return 'insert';
  }
  if (/\b(overhead|bird'?s.?eye|top[- ]down|high angle overview)\b/.test(type)) {
    return 'overhead-map';
  }
  if (/\b(establishing|extreme long|els)\b/.test(type)) {
    return 'establish';
  }
  if (/\b(close-up|close up|mcu|medium close|reaction)\b/.test(type)) {
    return 'reaction';
  }
  if (/\b(payoff|climax)\b/.test(type)) {
    return 'payoff';
  }
  if (/\b(wide environmental|wide shot|long shot|full body|environmental action)\b/.test(type)) {
    return 'wide-action';
  }
  if (/\b(medium|mls|waist)\b/.test(type)) {
    return 'medium-action';
  }

  // Prompt cues when shot_type is missing / vague
  if (/\b(insert shot|macro|object focus|extreme detail of the specified prop)\b/.test(prompt)) {
    return 'insert';
  }
  if (/\b(establishing shot|extreme long)\b/.test(prompt)) {
    return 'establish';
  }
  if (/\b(overhead|bird'?s.?eye|top[- ]down map)\b/.test(prompt)) {
    return 'overhead-map';
  }
  if (/\b(payoff|core locks|groove|slot clicks)\b/.test(prompt)) {
    return 'payoff';
  }

  return 'medium-action';
};

export const resolveShotIntent = (shot: ShotQuotaInput): ShotIntent => {
  const explicit = normalize(String(shot.shot_intent || ''));
  if ((SHOT_INTENTS as readonly string[]).includes(explicit)) {
    return explicit as ShotIntent;
  }
  return mapShotTypeToIntent(shot.shot_type, shot.visual_prompt);
};

const emptyCounts = (): Record<ShotIntent, number> => ({
  establish: 0,
  'wide-action': 0,
  'medium-action': 0,
  insert: 0,
  reaction: 0,
  'overhead-map': 0,
  payoff: 0,
});

/**
 * Chapter quotas (generator-enforced):
 * - establish + wide-action ≥ 35%
 * - insert + reaction ≤ 20%
 * - ≥1 insert when hasKeyProps
 * - no single shot_type / intent ≥ 65% of the chapter (blocks all-Wide chapters)
 */
export const findChapterShotQuotaViolation = (
  shots: ShotQuotaInput[],
  options: { hasKeyProps?: boolean } = {}
): ShotQuotaViolation | null => {
  const total = shots.length;
  if (total === 0) return null;

  const counts = emptyCounts();
  const typeHistogram = new Map<string, number>();

  for (const shot of shots) {
    const intent = resolveShotIntent(shot);
    counts[intent] += 1;
    const typeKey = normalize(String(shot.shot_type || intent)) || intent;
    typeHistogram.set(typeKey, (typeHistogram.get(typeKey) || 0) + 1);
  }

  // Percentage quotas target full chapter boards; tiny 1–4 shot packs skip ratio floors.
  if (total < 5) {
    if (total >= 3) {
      for (const [typeKey, n] of typeHistogram) {
        if (n === total) {
          return {
            reason: 'homogenous_shot_type',
            detail: `all ${total} shots share shot_type/intent "${typeKey}"`,
            counts,
            total,
          };
        }
      }
    }
    return null;
  }

  const wideShare = (counts.establish + counts['wide-action']) / total;
  const closeShare = (counts.insert + counts.reaction) / total;

  if (wideShare < 0.35) {
    return {
      reason: 'wide_floor',
      detail: `establish+wide-action share ${(wideShare * 100).toFixed(1)}% < 35%`,
      counts,
      total,
    };
  }
  if (closeShare > 0.2) {
    return {
      reason: 'close_ceiling',
      detail: `insert+reaction share ${(closeShare * 100).toFixed(1)}% > 20%`,
      counts,
      total,
    };
  }
  if (options.hasKeyProps && counts.insert < 1) {
    return {
      reason: 'missing_insert',
      detail: 'chapter has key props but no insert shot',
      counts,
      total,
    };
  }

  for (const [typeKey, n] of typeHistogram) {
    if (n / total >= 0.65) {
      return {
        reason: 'homogenous_shot_type',
        detail: `shot_type/intent "${typeKey}" covers ${((n / total) * 100).toFixed(1)}% ≥ 65%`,
        counts,
        total,
      };
    }
  }

  for (const intent of SHOT_INTENTS) {
    if (counts[intent] / total >= 0.65) {
      return {
        reason: 'homogenous_intent',
        detail: `intent "${intent}" covers ${((counts[intent] / total) * 100).toFixed(1)}% ≥ 65%`,
        counts,
        total,
      };
    }
  }

  return null;
};

export const assertChapterShotQuota = (
  shots: ShotQuotaInput[],
  options: { hasKeyProps?: boolean } = {}
): { ok: true } | { ok: false; violation: ShotQuotaViolation } => {
  const violation = findChapterShotQuotaViolation(shots, options);
  if (violation) return { ok: false, violation };
  return { ok: true };
};

export const formatShotQuotaFailure = (violation: ShotQuotaViolation): string => {
  return `Shot quota gate failed (${violation.reason}): ${violation.detail}`;
};

/** Heuristic: chapter content mentions concrete interactable props. */
export const chapterLikelyHasKeyProps = (content: string): boolean => {
  const text = String(content || '');
  // Latin tokens use word boundaries; CJK prop nouns match as substrings.
  if (
    /\b(button|map|guide|music.?box|gear|core|lever|ticket|cup|switch|slot|groove|platform|carousel|lamp|pool|fragment)\b/i.test(
      text
    )
  ) {
    return true;
  }
  return /音符|按钮|导览|八音盒|齿轮|凹槽|路灯|木马|残片/.test(text);
};
