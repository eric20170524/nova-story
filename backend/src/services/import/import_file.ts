import path from 'path';
import { decodeTextFile, parseTextProject } from '../text_import';
import { loadSemanticDocument } from './document_loader';
import { parseMarkdownNovel } from './markdown_import';
import {
  normalizeNovaStoryJsonProject,
  type NovaStoryJsonImportProject,
} from './novastory_json_model';
import { draftFromTextProject } from './text_adapter';
import type { NovelImportDraft } from './types';

export class ProjectImportInputError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 415 = 400
  ) {
    super(message);
    this.name = 'ProjectImportInputError';
  }
}

export type ParsedProjectImportFile =
  | {
      kind: 'novel-draft';
      draft: NovelImportDraft;
    }
  | {
      kind: 'novastory-project';
      project: NovaStoryJsonImportProject;
    };

const normalizeJsonProject = (
  rawText: string,
  filename: string,
  strictJson: boolean
): ParsedProjectImportFile | null => {
  let parsedJson: unknown = undefined;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (error) {
    if (strictJson) {
      throw new ProjectImportInputError(
        error instanceof Error
          ? `Could not parse the selected JSON file: ${error.message}`
          : 'Could not parse the selected JSON file'
      );
    }
    return null;
  }

  if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
    try {
      return {
        kind: 'novastory-project',
        project: normalizeNovaStoryJsonProject(
          parsedJson as Record<string, any>,
          filename
        ),
      };
    } catch (error) {
      if (strictJson) {
        throw new ProjectImportInputError(
          error instanceof Error
            ? `Could not import the selected JSON project: ${error.message}`
            : 'Could not import the selected JSON project'
        );
      }
      return null;
    }
  }

  if (strictJson) {
    throw new ProjectImportInputError(
      'Could not import the selected JSON project: JSON root must be an object'
    );
  }
  return null;
};

export const parseProjectImportFile = async (
  data: Uint8Array,
  filename = ''
): Promise<ParsedProjectImportFile> => {
  const ext = path.extname(filename).toLowerCase();
  const isJsonFile = ext === '.json' || filename.toLowerCase().endsWith('.novastory.json');
  const isDocxFile = ext === '.docx';
  const isTextLikeFile = ext === '.txt' || ext === '.md' || ext === '.markdown';

  if (!isJsonFile && !isDocxFile && !isTextLikeFile) {
    throw new ProjectImportInputError(
      'Only .txt, .md / .markdown, .docx, or .json / .novastory.json files can be imported',
      415
    );
  }

  if (isJsonFile) {
    let rawText: string;
    try {
      rawText = decodeTextFile(data);
    } catch (error) {
      throw new ProjectImportInputError(
        error instanceof Error ? error.message : 'Could not decode the selected JSON file'
      );
    }
    return normalizeJsonProject(rawText, filename, true)!;
  }

  let loaded;
  try {
    loaded = await loadSemanticDocument(data, filename);
  } catch (error) {
    throw new ProjectImportInputError(
      error instanceof Error ? error.message : 'Could not read the selected file'
    );
  }

  // Preserve the legacy convenience where a .txt file containing a native JSON
  // project can still restore that project. DOCX/Markdown remain manuscript-only.
  if (loaded.format === 'text' && loaded.content.trim().startsWith('{')) {
    const parsedJson = normalizeJsonProject(loaded.content, filename, false);
    if (parsedJson) return parsedJson;
  }

  try {
    if (loaded.format === 'text') {
      return {
        kind: 'novel-draft',
        draft: draftFromTextProject(
          parseTextProject(loaded.content, filename),
          filename
        ),
      };
    }

    const draft = parseMarkdownNovel(loaded.content, filename);
    if (loaded.format === 'docx') {
      draft.source = { filename, format: 'docx' };
      draft.warnings = [...loaded.warnings, ...draft.warnings];
    }
    return { kind: 'novel-draft', draft };
  } catch (error) {
    throw new ProjectImportInputError(
      error instanceof Error ? error.message : 'Could not parse the selected file'
    );
  }
};
