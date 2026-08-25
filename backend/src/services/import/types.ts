export type NovelImportSourceFormat = 'text' | 'markdown';

export type NovelImportCharacterRole = 'Protagonist' | 'Antagonist' | 'Supporting';

export interface NovelImportSource {
  filename: string;
  format: NovelImportSourceFormat;
}

export interface NovelImportProject {
  title: string;
  description?: string;
  settings: Record<string, unknown>;
}

export interface NovelImportChapter {
  index: number;
  title: string;
  summary?: string;
  content: string;
  status?: string;
}

export interface NovelImportCharacter {
  name: string;
  role: NovelImportCharacterRole;
  description: string;
}

export interface NovelImportGlossaryItem {
  term: string;
  definition?: string;
  category?: string;
}

export interface NovelImportUnmappedSection {
  heading: string;
  content: string;
  scope: 'project' | 'chapter';
  chapterTitle?: string;
}

/**
 * Canonical, deterministic representation produced by manuscript parsers.
 *
 * Parsers may extract only facts that are explicit in the source document.
 * AI inference belongs to a separate, user-confirmed enrichment step.
 */
export interface NovelImportDraft {
  source: NovelImportSource;
  project: NovelImportProject;
  chapters: NovelImportChapter[];
  characters: NovelImportCharacter[];
  glossary: NovelImportGlossaryItem[];
  unmappedSections: NovelImportUnmappedSection[];
  warnings: string[];
}
