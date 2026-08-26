import { parseProjectImportFile } from './import_file';
import type { NovaStoryJsonImportProject } from './novastory_json_model';
import type { NovelImportDraft, NovelImportUnmappedSection } from './types';

export type ProjectImportPreviewFormat = 'text' | 'markdown' | 'json';

export interface ProjectImportPreviewChapter {
  index: number;
  title: string;
  summary?: string;
  has_content: boolean;
  content_characters: number;
}

export interface ProjectImportPreview {
  source: {
    filename: string;
    format: ProjectImportPreviewFormat;
  };
  mode: 'novel-draft' | 'novastory-project';
  project: {
    title: string;
    description?: string | null;
    settings: Record<string, unknown>;
  };
  chapters: ProjectImportPreviewChapter[];
  counts: {
    chapters: number;
    chapter_summaries: number;
    chapter_contents: number;
    characters: number;
    glossary: number;
    scenes: number;
    coverage_groups: number;
    coverage_shots: number;
  };
  warnings: string[];
  unmapped_sections: NovelImportUnmappedSection[];
}

const previewSummary = (value: string | null | undefined): string | undefined => {
  const summary = value?.trim();
  if (!summary) return undefined;
  return summary.length > 400 ? `${summary.slice(0, 400)}…` : summary;
};

const previewFromDraft = (draft: NovelImportDraft): ProjectImportPreview => {
  const chapters: ProjectImportPreviewChapter[] = draft.chapters.map((chapter) => ({
    index: chapter.index,
    title: chapter.title,
    summary: previewSummary(chapter.summary),
    has_content: Boolean(chapter.content.trim()),
    content_characters: chapter.content.length,
  }));

  return {
    source: {
      filename: draft.source.filename,
      format: draft.source.format,
    },
    mode: 'novel-draft',
    project: {
      title: draft.project.title,
      description: draft.project.description || null,
      settings: { ...(draft.project.settings || {}) },
    },
    chapters,
    counts: {
      chapters: chapters.length,
      chapter_summaries: chapters.filter((chapter) => Boolean(chapter.summary)).length,
      chapter_contents: chapters.filter((chapter) => chapter.has_content).length,
      characters: draft.characters.length,
      glossary: draft.glossary.length,
      scenes: 0,
      coverage_groups: 0,
      coverage_shots: 0,
    },
    warnings: [...draft.warnings],
    unmapped_sections: [...draft.unmappedSections],
  };
};

const previewFromJson = (
  project: NovaStoryJsonImportProject
): ProjectImportPreview => {
  const chapters: ProjectImportPreviewChapter[] = project.chapters.map((chapter) => ({
    index: chapter.index,
    title: chapter.title,
    summary: previewSummary(chapter.summary),
    has_content: Boolean(chapter.content?.trim()),
    content_characters: chapter.content?.length || 0,
  }));

  return {
    source: { ...project.source },
    mode: 'novastory-project',
    project: {
      title: project.project.title,
      description: project.project.description,
      settings: { ...project.project.settings },
    },
    chapters,
    counts: {
      chapters: chapters.length,
      chapter_summaries: chapters.filter((chapter) => Boolean(chapter.summary)).length,
      chapter_contents: chapters.filter((chapter) => chapter.has_content).length,
      characters: project.characters.length,
      glossary: 0,
      scenes: project.scenes.length,
      coverage_groups: project.coverageGroups.length,
      coverage_shots: project.coverageShots.length,
    },
    warnings: [...project.warnings],
    unmapped_sections: [],
  };
};

export const buildProjectImportPreview = (
  data: Uint8Array,
  filename = ''
): ProjectImportPreview => {
  const parsed = parseProjectImportFile(data, filename);
  return parsed.kind === 'novel-draft'
    ? previewFromDraft(parsed.draft)
    : previewFromJson(parsed.project);
};
