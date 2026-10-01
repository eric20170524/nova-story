import type { Chapter } from '../../types';

export type ChapterEditorFields = { title: string; summary: string; content: string };

export function chapterEditorFields(chapter: Pick<Chapter, 'title' | 'summary' | 'content'>): ChapterEditorFields {
  return { title: chapter.title || '', summary: chapter.summary || '', content: chapter.content || '' };
}

/** Pull clean fields from the server while keeping edits made since the last server baseline. */
export function reconcileChapterEditorFields(
  baseline: ChapterEditorFields,
  local: ChapterEditorFields,
  fresh: ChapterEditorFields,
  forceContent = false
): ChapterEditorFields {
  return {
    title: local.title === baseline.title ? fresh.title : local.title,
    summary: local.summary === baseline.summary ? fresh.summary : local.summary,
    content: forceContent || local.content === baseline.content ? fresh.content : local.content,
  };
}

export function isChapterEditorDirty(chapter: Chapter | null, local: ChapterEditorFields): boolean {
  if (!chapter) return false;
  const baseline = chapterEditorFields(chapter);
  return local.title !== baseline.title || local.summary !== baseline.summary || local.content !== baseline.content;
}
