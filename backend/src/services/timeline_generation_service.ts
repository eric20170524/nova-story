import { db } from '../db/database';
import { flattenVisualTagMap, formatVisualLockTokens } from './reference_generation_policy';
import type { CharacterLockRef } from './pony_prompt_compiler';

const parseCharacterTags = (raw: unknown): any => {
  try { return typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {}; }
  catch { return {}; }
};

export async function buildCharacterLockRefsForChapter(projectId: number, chapterId: string): Promise<CharacterLockRef[]> {
  const characters = await db.all('SELECT * FROM character WHERE project_id = ?', projectId);
  if (!characters?.length) return [];
  return characters.map((c: any) => {
    const tags = parseCharacterTags(c.visual_tags);
    const values = flattenVisualTagMap(tags, { chapterId });
    const stableKeys = ['species', 'hair', 'face_features', 'distinguishing_mark', 'build', 'clothing', 'accessories'];
    const compact = stableKeys.map(key => String(values[key] || '').trim().slice(0, 130)).filter(Boolean);
    const lock = compact.length ? compact.join(', ') : formatVisualLockTokens(tags, { chapterId });
    if (!lock || /^\(none/i.test(lock)) return null;
    const aliases = Array.isArray(tags?.aliases) ? tags.aliases.map((a: unknown) => String(a || '').trim()).filter(Boolean) : [];
    return { name: String(c.name || '').trim() || null, aliases, lock } satisfies CharacterLockRef;
  }).filter(Boolean) as CharacterLockRef[];
}

export async function buildCharacterProfilesForChapter(projectId: number, chapterId: string): Promise<string> {
  const characters = await db.all('SELECT * FROM character WHERE project_id = ?', projectId);
  if (!characters?.length) return '';
  return characters.map((c: any) => {
    const lock = formatVisualLockTokens(parseCharacterTags(c.visual_tags), { chapterId });
    return `- Name: ${c.name}\n  Visual Lock: ${lock || '(none — do not invent appearance tags)'}`;
  }).join('\n');
}

export const TIMELINE_DIRECT_WRITE_DISABLED = '章节正文直写时间线已停用，请先确认分场剧本，再生成、核对并采纳分镜候选。';
export class TimelineDirectWriteDisabledError extends Error {
  readonly statusCode = 410;
  constructor() { super(TIMELINE_DIRECT_WRITE_DISABLED); }
}

/** Compatibility entry point: every caller is stopped before inference or timeline writes. */
export async function generateAndReplaceNarrativeTimeline(_options: {
  chapterId: string; projectId: number; content: string; mode?: string;
}): Promise<{ chapter_id: string; storyboard_mode: string; timeline: any[]; count: number }> {
  throw new TimelineDirectWriteDisabledError();
}
