import type { ParsedTextProject } from '../text_import';
import type { NovelImportDraft } from './types';

export const draftFromTextProject = (
  parsed: ParsedTextProject,
  filename = ''
): NovelImportDraft => ({
  source: {
    filename,
    format: 'text',
  },
  project: {
    title: parsed.title,
    description: parsed.description,
    settings: {},
  },
  chapters: parsed.chapters.map((chapter, index) => ({
    index: index + 1,
    title: chapter.title,
    content: chapter.content,
    status: 'draft',
  })),
  characters: parsed.characters.map((character) => ({ ...character })),
  glossary: [],
  unmappedSections: [],
  warnings: [],
});
