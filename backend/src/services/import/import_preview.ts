import path from 'path';
import { decodeTextFile, parseTextProject } from '../text_import';
import { parseMarkdownNovel } from './markdown_import';
import { draftFromTextProject } from './project_import';
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

export class ProjectImportInputError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 415 = 400
  ) {
    super(message);
    this.name = 'ProjectImportInputError';
  }
}

const normalizeSettings = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Preview should not fail because an old project stored malformed settings.
    }
  }
  return {};
};

const previewFromDraft = (draft: NovelImportDraft): ProjectImportPreview => {
  const chapters = draft.chapters.map((chapter) => ({
    index: chapter.index,
    title: chapter.title,
    summary: chapter.summary,
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
      chapter_summaries: chapters.filter((chapter) => Boolean(chapter.summary?.trim())).length,
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
  jsonContent: Record<string, any>,
  filename: string
): ProjectImportPreview => {
  const ext = path.extname(filename).toLowerCase();
  const rawChapters = Array.isArray(jsonContent.screenplay?.chapters)
    ? jsonContent.screenplay.chapters
    : (Array.isArray(jsonContent.chapters) ? jsonContent.chapters : []);
  const rawCharacters = Array.isArray(jsonContent.character_center?.characters)
    ? jsonContent.character_center.characters
    : (Array.isArray(jsonContent.characters) ? jsonContent.characters : []);
  const directorData = jsonContent.director || {};
  const rawScenes = Array.isArray(directorData.scenes) ? directorData.scenes : [];
  const rawCoverageGroups = Array.isArray(directorData.coverage_groups)
    ? directorData.coverage_groups
    : [];
  const rawCoverageShots = Array.isArray(directorData.coverage_shots)
    ? directorData.coverage_shots
    : [];
  const rawGlossary = Array.isArray(jsonContent.glossary) ? jsonContent.glossary : [];

  const projectTitle = String(
    jsonContent.project?.title
      || jsonContent.title
      || path.basename(filename, ext)
      || 'Imported Project'
  );
  const projectDescription = jsonContent.project?.description
    ?? jsonContent.description
    ?? null;
  const settings = normalizeSettings(jsonContent.project?.settings);

  const chapters = rawChapters.map((chapter: any, index: number) => ({
    index: Number(chapter?.index ?? index + 1),
    title: String(chapter?.title || `Chapter ${index + 1}`),
    summary: typeof chapter?.summary === 'string' ? chapter.summary : undefined,
    has_content: typeof chapter?.content === 'string' && chapter.content.trim().length > 0,
    content_characters: typeof chapter?.content === 'string' ? chapter.content.length : 0,
  }));

  const warnings: string[] = [];
  if (chapters.length === 0) {
    warnings.push('The JSON project contains no chapters');
  }

  return {
    source: {
      filename,
      format: 'json',
    },
    mode: 'novastory-project',
    project: {
      title: projectTitle,
      description: typeof projectDescription === 'string' ? projectDescription : null,
      settings,
    },
    chapters,
    counts: {
      chapters: chapters.length,
      chapter_summaries: chapters.filter((chapter) => Boolean(chapter.summary?.trim())).length,
      chapter_contents: chapters.filter((chapter) => chapter.has_content).length,
      characters: rawCharacters.length,
      glossary: rawGlossary.length,
      scenes: rawScenes.length,
      coverage_groups: rawCoverageGroups.length,
      coverage_shots: rawCoverageShots.length,
    },
    warnings,
    unmapped_sections: [],
  };
};

export const buildProjectImportPreview = (
  data: Uint8Array,
  filename = ''
): ProjectImportPreview => {
  const ext = path.extname(filename).toLowerCase();
  const isMarkdownFile = ext === '.md' || ext === '.markdown';
  const isJsonFile = ext === '.json' || filename.toLowerCase().endsWith('.novastory.json');

  if (ext !== '.txt' && !isMarkdownFile && !isJsonFile) {
    throw new ProjectImportInputError(
      'Only .txt, .md / .markdown, or .json / .novastory.json files can be imported',
      415
    );
  }

  let rawText: string;
  try {
    rawText = decodeTextFile(data);
  } catch (error) {
    throw new ProjectImportInputError(
      error instanceof Error ? error.message : 'Could not decode the selected file'
    );
  }

  let jsonContent: Record<string, any> | null = null;
  if (isJsonFile || rawText.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        jsonContent = parsed as Record<string, any>;
      } else if (isJsonFile) {
        throw new Error('JSON root must be an object');
      }
    } catch (error) {
      if (isJsonFile) {
        throw new ProjectImportInputError(
          error instanceof Error
            ? `Could not parse the selected JSON file: ${error.message}`
            : 'Could not parse the selected JSON file'
        );
      }
    }
  }

  if (jsonContent) {
    return previewFromJson(jsonContent, filename);
  }

  try {
    const draft = isMarkdownFile
      ? parseMarkdownNovel(rawText, filename)
      : draftFromTextProject(parseTextProject(rawText, filename), filename);
    return previewFromDraft(draft);
  } catch (error) {
    throw new ProjectImportInputError(
      error instanceof Error ? error.message : 'Could not parse the selected file'
    );
  }
};
