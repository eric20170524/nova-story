import { z } from 'zod';
import type { ProjectSettings } from '../project_settings';

/** Chapter-local facts, in narrative order. Each line includes its textual basis. */
export const ChapterContinuitySchema = z.object({
  characterStates: z.array(z.string()).default([]),
  events: z.array(z.string()).default([]),
  foreshadowing: z.array(z.string()).default([]),
  characterRelations: z.array(z.string()).default([]),
});

export type ChapterContinuity = z.infer<typeof ChapterContinuitySchema>;
export type ChapterImpactEntry = { main_plot: string; character_relations: string };
type Chapter = { id: string; title: string; index: number };

// Always append this contract, including when a project uses a legacy prompt override.
export const CHAPTER_CONTINUITY_INSTRUCTIONS = `定稿输出补充（与人物、术语一起返回，不能省略）：
JSON 顶层必须包含 "chapterContinuity": {
  "characterStates": ["角色名：本章结束时的状态、位置或目标变化；依据：正文行为/对话"],
  "events": ["时间/叙事先后：已发生的关键事件及结果；依据：正文"],
  "foreshadowing": ["线索：埋设/推进/已回收/未回收；依据：正文"],
  "characterRelations": ["角色A → 角色B：关系、阵营或情感变化；依据：正文行为/对话"]
}。
仅从本次正文提取事实，按叙事先后排列。既有主线和关系只供核对，不可把未来规划当作已发生事件。
未明确的时间、状态、关系必须保留不确定性，不得臆测。没有相关事实时返回空数组；不要返回全书设定的替代全文。`;

export function mergeChapterContinuity(parts: ChapterContinuity[]): ChapterContinuity {
  const result = ChapterContinuitySchema.parse({});
  for (const key of Object.keys(result) as Array<keyof ChapterContinuity>) {
    result[key] = [...new Set(parts.flatMap((part) => part[key]).map((line) => line.trim()).filter(Boolean))];
  }
  return result;
}

/** Store generated blocks separately so re-finalizing replaces this chapter only. */
export function mergeChapterImpactSettings(
  current: ProjectSettings,
  chapter: Chapter,
  chapters: Chapter[],
  continuity: ChapterContinuity
) {
  const facts = mergeChapterContinuity([continuity]);
  const ordered = [...chapters].sort((a, b) => a.index - b.index);
  const heading = `### 第${ordered.findIndex((c) => c.id === chapter.id) + 1}章 · ${chapter.title}`;
  const sections = [
    ['角色状态', facts.characterStates],
    ['事件（叙事顺序）', facts.events],
    ['伏笔（埋设 / 推进 / 回收）', facts.foreshadowing],
  ] as const;
  const plot = sections.filter(([, lines]) => lines.length)
    .map(([label, lines]) => `**${label}**\n${lines.map((line) => `- ${line}`).join('\n')}`).join('\n\n');
  const entry: ChapterImpactEntry = {
    main_plot: plot ? `${heading}\n\n${plot}` : '',
    character_relations: facts.characterRelations.length
      ? `${heading}\n\n${facts.characterRelations.map((line) => `- ${line}`).join('\n')}` : '',
  };
  const previous = current.chapter_impact_entries || {};
  const entries = { ...previous, [chapter.id]: entry };
  const settings = { ...current, chapter_impact_entries: entries };
  const changed = { main_plot: false, character_relations: false };

  for (const key of ['main_plot', 'character_relations'] as const) {
    const original = typeof current[key] === 'string' ? current[key] : '';
    let manual = original;
    // Remove only exact blocks produced by us; preserve author edits and other settings.
    for (const old of Object.values(previous)) {
      if (old?.[key]) manual = manual.replace(old[key], '');
    }
    const blocks = ordered
      .map((c) => entries[c.id]?.[key]).filter(Boolean);
    const merged = [manual.trim(), ...blocks].filter(Boolean).join('\n\n');
    // Leave untouched fields byte-for-byte intact when no blocks were changed.
    if (blocks.length || manual !== original) {
      settings[key] = merged;
      changed[key] = merged !== original;
    }
  }
  return { settings, entry, changed };
}
