import path from 'path';
import { decodeTextFile, parseTextProject } from '../text_import';
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

export const parseProjectImportFile = (
  data: Uint8Array,
  filename = ''
): ParsedProjectImportFile => {
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

  if (isJsonFile || rawText.trim().startsWith('{')) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch (error) {
      if (isJsonFile) {
        throw new ProjectImportInputError(
          error instanceof Error
            ? `Could not parse the selected JSON file: ${error.message}`
            : 'Could not parse the selected JSON file'
        );
      }
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
        if (isJsonFile) {
          throw new ProjectImportInputError(
            error instanceof Error
              ? `Could not import the selected JSON project: ${error.message}`
              : 'Could not import the selected JSON project'
          );
        }
        // A .txt file that happens to start with "{" remains a text manuscript
        // unless it has a recognizable, valid project-export shape.
      }
    } else if (isJsonFile && parsedJson !== undefined) {
      throw new ProjectImportInputError('Could not import the selected JSON project: JSON root must be an object');
    }
  }

  try {
    return {
      kind: 'novel-draft',
      draft: isMarkdownFile
        ? parseMarkdownNovel(rawText, filename)
        : draftFromTextProject(parseTextProject(rawText, filename), filename),
    };
  } catch (error) {
    throw new ProjectImportInputError(
      error instanceof Error ? error.message : 'Could not parse the selected file'
    );
  }
};
