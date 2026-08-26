import path from 'node:path';
import { createHash } from 'node:crypto';
import { db } from '../db/database';
import { decodeTextFile } from './text_import';

export const PROJECT_DOCUMENT_TYPES = [
  'outline',
  'worldbuilding',
  'character_notes',
  'reference',
  'other',
] as const;

export type ProjectDocumentType = typeof PROJECT_DOCUMENT_TYPES[number];
export type ProjectDocumentFormat = 'text' | 'markdown';

export class ProjectDocumentInputError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 415 = 400
  ) {
    super(message);
    this.name = 'ProjectDocumentInputError';
  }
}

export interface ParsedProjectDocument {
  source: {
    filename: string;
    format: ProjectDocumentFormat;
    mime_type?: string | null;
  };
  title: string;
  content: string;
  checksum: string;
  content_characters: number;
  line_count: number;
  heading_count: number;
}

export interface ProjectDocumentContextRow {
  id: number;
  name: string;
  document_type: ProjectDocumentType;
  content: string;
}

const normalizeText = (value: string) => value
  .replace(/^\uFEFF/, '')
  .replace(/\r\n?/g, '\n')
  .trim();

const inferTitle = (content: string, filename: string, format: ProjectDocumentFormat) => {
  if (format === 'markdown') {
    const h1 = content.split('\n').find((line) => /^#\s+\S/.test(line));
    if (h1) return h1.replace(/^#\s+/, '').trim().slice(0, 255);
  }
  return (path.basename(filename, path.extname(filename)).trim() || 'Supplemental document')
    .slice(0, 255);
};

export const parseProjectDocument = (
  data: Uint8Array,
  filename = '',
  mimeType?: string | null
): ParsedProjectDocument => {
  const ext = path.extname(filename).toLowerCase();
  const format: ProjectDocumentFormat | null = ext === '.txt'
    ? 'text'
    : (ext === '.md' || ext === '.markdown')
      ? 'markdown'
      : null;

  if (!format) {
    throw new ProjectDocumentInputError(
      'Only .txt, .md, or .markdown files can be added as supplemental documents',
      415
    );
  }

  let decoded: string;
  try {
    decoded = decodeTextFile(data);
  } catch (error) {
    throw new ProjectDocumentInputError(
      error instanceof Error ? error.message : 'Could not decode the selected document'
    );
  }

  const content = normalizeText(decoded);
  if (!content) {
    throw new ProjectDocumentInputError('The selected document is empty');
  }

  return {
    source: {
      filename,
      format,
      mime_type: mimeType || null,
    },
    title: inferTitle(content, filename, format),
    content,
    checksum: createHash('sha256').update(content, 'utf8').digest('hex'),
    content_characters: content.length,
    line_count: content.split('\n').length,
    heading_count: format === 'markdown'
      ? content.split('\n').filter((line) => /^#{1,6}\s+\S/.test(line)).length
      : 0,
  };
};

export const findDuplicateProjectDocument = async (
  projectId: number,
  checksum: string
) => db.get(
  `SELECT id, name, document_type, source_filename, source_format, mime_type,
          checksum, metadata_json, context_enabled, created_at, updated_at
   FROM project_document
   WHERE project_id = ? AND checksum = ?
   LIMIT 1`,
  projectId,
  checksum
);

export const previewProjectDocument = async (options: {
  projectId: number;
  data: Uint8Array;
  filename: string;
  mimeType?: string | null;
  documentType: ProjectDocumentType;
}) => {
  const project = await db.get('SELECT id, title FROM project WHERE id = ?', options.projectId);
  if (!project) {
    throw new ProjectDocumentInputError('Project not found', 404);
  }

  const parsed = parseProjectDocument(options.data, options.filename, options.mimeType);
  const duplicate = await findDuplicateProjectDocument(options.projectId, parsed.checksum);

  return {
    project: { id: project.id, title: project.title },
    document_type: options.documentType,
    source: parsed.source,
    title: parsed.title,
    checksum: parsed.checksum,
    content_characters: parsed.content_characters,
    line_count: parsed.line_count,
    heading_count: parsed.heading_count,
    duplicate_document: duplicate || null,
    impact: {
      modifies_chapters: false,
      modifies_story_bible: false,
      ai_context_enabled: false,
    },
  };
};

export const createProjectDocument = async (options: {
  projectId: number;
  data: Uint8Array;
  filename: string;
  mimeType?: string | null;
  documentType: ProjectDocumentType;
  name?: string | null;
}) => {
  const project = await db.get('SELECT id FROM project WHERE id = ?', options.projectId);
  if (!project) {
    throw new ProjectDocumentInputError('Project not found', 404);
  }

  const parsed = parseProjectDocument(options.data, options.filename, options.mimeType);
  const duplicate = await findDuplicateProjectDocument(options.projectId, parsed.checksum);
  if (duplicate) {
    throw new ProjectDocumentInputError(
      `This document already exists in the project as "${duplicate.name}"`,
      409
    );
  }

  const metadata = {
    content_characters: parsed.content_characters,
    line_count: parsed.line_count,
    heading_count: parsed.heading_count,
  };

  let result;
  try {
    result = await db.run(
      `INSERT INTO project_document (
         project_id, name, document_type, source_filename, source_format,
         mime_type, content, checksum, metadata_json, context_enabled,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      options.projectId,
      (options.name?.trim() || parsed.title).slice(0, 255),
      options.documentType,
      parsed.source.filename,
      parsed.source.format,
      parsed.source.mime_type || null,
      parsed.content,
      parsed.checksum,
      JSON.stringify(metadata)
    );
  } catch (error) {
    const racedDuplicate = await findDuplicateProjectDocument(options.projectId, parsed.checksum);
    if (racedDuplicate) {
      throw new ProjectDocumentInputError(
        `This document already exists in the project as "${racedDuplicate.name}"`,
        409
      );
    }
    throw error;
  }

  return db.get(
    `SELECT id, project_id, name, document_type, source_filename, source_format,
            mime_type, checksum, metadata_json, context_enabled, created_at, updated_at
     FROM project_document WHERE id = ?`,
    result.lastID
  );
};

export const listProjectDocuments = async (projectId: number) => {
  const project = await db.get('SELECT id FROM project WHERE id = ?', projectId);
  if (!project) {
    throw new ProjectDocumentInputError('Project not found', 404);
  }
  return db.all(
    `SELECT id, project_id, name, document_type, source_filename, source_format,
            mime_type, checksum, metadata_json, context_enabled, created_at, updated_at
     FROM project_document
     WHERE project_id = ?
     ORDER BY created_at DESC, id DESC`,
    projectId
  );
};

export const updateProjectDocumentContext = async (
  projectId: number,
  documentId: number,
  enabled: boolean
) => {
  const existing = await db.get(
    'SELECT id FROM project_document WHERE id = ? AND project_id = ?',
    documentId,
    projectId
  );
  if (!existing) {
    throw new ProjectDocumentInputError('Supplemental document not found', 404);
  }
  await db.run(
    `UPDATE project_document
     SET context_enabled = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    enabled ? 1 : 0,
    documentId
  );
  return db.get(
    `SELECT id, project_id, name, document_type, source_filename, source_format,
            mime_type, checksum, metadata_json, context_enabled, created_at, updated_at
     FROM project_document WHERE id = ?`,
    documentId
  );
};

export const deleteProjectDocument = async (projectId: number, documentId: number) => {
  const existing = await db.get(
    `SELECT id, project_id, name, document_type, source_filename, source_format,
            mime_type, checksum, metadata_json, context_enabled, created_at, updated_at
     FROM project_document WHERE id = ? AND project_id = ?`,
    documentId,
    projectId
  );
  if (!existing) {
    throw new ProjectDocumentInputError('Supplemental document not found', 404);
  }
  await db.run('DELETE FROM project_document WHERE id = ?', documentId);
  return existing;
};

const CONTEXT_TYPE_LABELS: Record<ProjectDocumentType, string> = {
  outline: 'Outline',
  worldbuilding: 'Worldbuilding',
  character_notes: 'Character notes',
  reference: 'Reference',
  other: 'Other',
};

const CONTEXT_PER_DOCUMENT_CAP: Record<ProjectDocumentType, number> = {
  outline: 700,
  worldbuilding: 600,
  character_notes: 550,
  reference: 400,
  other: 300,
};

export const buildProjectDocumentContext = (
  rows: ProjectDocumentContextRow[],
  totalCap = 1600
): string => {
  if (!rows.length || totalCap <= 0) return '';
  const parts: string[] = [];
  let used = 0;

  for (const row of rows.slice(0, 8)) {
    const header = `[${CONTEXT_TYPE_LABELS[row.document_type]} · ${row.name}]`;
    const remaining = totalCap - used - header.length - 1;
    if (remaining <= 0) break;
    const perDocCap = Math.min(CONTEXT_PER_DOCUMENT_CAP[row.document_type], remaining);
    const source = String(row.content || '').trim();
    if (!source) continue;
    const body = source.length > perDocCap
      ? `${source.slice(0, Math.max(0, perDocCap - 3))}...`
      : source;
    const part = `${header}\n${body}`;
    parts.push(part);
    used += part.length + 2;
    if (used >= totalCap) break;
  }

  return parts.join('\n\n').slice(0, totalCap);
};

export const loadEnabledProjectDocumentContext = async (
  projectId: number,
  totalCap = 1600
): Promise<string> => {
  const rows = await db.all(
    `SELECT id, name, document_type, content
     FROM project_document
     WHERE project_id = ? AND context_enabled = 1
     ORDER BY CASE document_type
       WHEN 'outline' THEN 1
       WHEN 'worldbuilding' THEN 2
       WHEN 'character_notes' THEN 3
       WHEN 'reference' THEN 4
       ELSE 5
     END, updated_at DESC, id DESC
     LIMIT 8`,
    projectId
  ) as ProjectDocumentContextRow[];
  return buildProjectDocumentContext(rows, totalCap);
};
