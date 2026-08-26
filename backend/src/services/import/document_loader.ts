import path from 'node:path';
import mammoth from 'mammoth';
import { decodeTextFile } from '../text_import';

export type SemanticDocumentFormat = 'text' | 'markdown' | 'docx';

export interface LoadedSemanticDocument {
  format: SemanticDocumentFormat;
  content: string;
  warnings: string[];
}

const DOCX_MAX_BYTES = 10 * 1024 * 1024;

const decodeHtmlEntities = (value: string) => value.replace(
  /&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi,
  (_match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    if (normalized === 'nbsp') return ' ';
    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
    }
    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
    }
    return '';
  }
);

const htmlText = (fragment: string) => decodeHtmlEntities(
  fragment
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
).replace(/[ \t]+\n/g, '\n').trim();

/**
 * Mammoth emits intentionally simple semantic HTML. This converter only keeps
 * structure useful to NovaStory (headings, paragraphs, lists, simple tables)
 * and discards styling, links and images. We never render the source HTML.
 */
export const semanticHtmlToMarkdown = (html: string): string => {
  let value = String(html || '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/<img\b[^>]*>/gi, '');

  for (let level = 1; level <= 6; level += 1) {
    const pattern = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
    value = value.replace(pattern, (_match, inner: string) => {
      const text = htmlText(inner);
      return text ? `${'#'.repeat(level)} ${text}\n\n` : '';
    });
  }

  value = value
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, inner: string) => {
      const text = htmlText(inner);
      return text ? `- ${text}\n` : '';
    })
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_match, inner: string) => {
      const text = htmlText(inner);
      return text ? `${text}\n\n` : '';
    })
    .replace(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi, (_match, inner: string) => {
      const text = htmlText(inner);
      return text ? `${text} | ` : '';
    })
    .replace(/<\/tr>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeHtmlEntities(value)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const convertDocxToMarkdown = async (data: Uint8Array): Promise<LoadedSemanticDocument> => {
  if (data.byteLength === 0) {
    throw new Error('The selected DOCX file is empty');
  }
  if (data.byteLength > DOCX_MAX_BYTES) {
    throw new Error('DOCX files are limited to 10 MB');
  }

  const options: any = {
    includeDefaultStyleMap: true,
    externalFileAccess: false,
    styleMap: [
      "p[style-name='Title'] => h1:fresh",
      "p[style-name='标题'] => h1:fresh",
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
      "p[style-name='Heading 4'] => h4:fresh",
      "p[style-name='标题 1'] => h1:fresh",
      "p[style-name='标题 2'] => h2:fresh",
      "p[style-name='标题 3'] => h3:fresh",
      "p[style-name='标题 4'] => h4:fresh",
    ],
    // Images are intentionally ignored by the manuscript/reference importer.
    // Avoid reading image bytes into base64 HTML.
    convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
  };

  let result: { value: string; messages?: Array<{ type?: string; message?: string }> };
  try {
    result = await mammoth.convertToHtml({ buffer: Buffer.from(data) }, options);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Could not read the selected DOCX file: ${error.message}`
        : 'Could not read the selected DOCX file'
    );
  }

  const content = semanticHtmlToMarkdown(result.value);
  if (!content) {
    throw new Error('No readable text was found in the selected DOCX file');
  }

  const warnings = (result.messages || [])
    .map((message) => String(message.message || '').trim())
    .filter(Boolean)
    .map((message) => `DOCX: ${message}`);

  return { format: 'docx', content, warnings };
};

export const loadSemanticDocument = async (
  data: Uint8Array,
  filename = ''
): Promise<LoadedSemanticDocument> => {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.docx') {
    return convertDocxToMarkdown(data);
  }

  if (ext !== '.txt' && ext !== '.md' && ext !== '.markdown') {
    throw new Error('Only .txt, .md / .markdown, or .docx files are supported');
  }

  const decoded = decodeTextFile(data)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!decoded) {
    throw new Error('The selected file is empty');
  }

  return {
    format: ext === '.txt' ? 'text' : 'markdown',
    content: decoded,
    warnings: [],
  };
};
