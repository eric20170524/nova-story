import path from 'path';
import { TextDecoder } from 'util';

export interface ImportedChapter {
  title: string;
  content: string;
}

export interface ImportedCharacter {
  name: string;
  role: 'Protagonist' | 'Antagonist' | 'Supporting';
  description: string;
}

export interface ParsedTextProject {
  title: string;
  description: string;
  chapters: ImportedChapter[];
  characters: ImportedCharacter[];
}

interface ChapterHeading {
  title: string;
  projectTitle?: string;
}

const CHINESE_NUMBER = '0-9零〇一二两三四五六七八九十百千万';
const NUMBERED_HEADING = new RegExp(
  `^第\\s*[${CHINESE_NUMBER}]+\\s*[章集幕回卷篇](?:\\s*[：:·.\\-—]\\s*\\S.*|\\s+\\S.*)?$`,
  'i'
);
const ENGLISH_HEADING = /^(?:Chapter|Episode|EP)\s*\d+(?:\s*[：:·.\-—]\s*\S.*|\s+\S.*)?$/i;
const SPECIAL_HEADING = /^(?:序章|楔子|引子|初章|终章|尾声|后记|番外(?:\s*[0-9零〇一二两三四五六七八九十百千]+)?)(?:\s*[：:·.\-—]\s*\S.*|\s+\S.*)?$/i;
const DECORATION_LINE = /^[=\-*#~_—–]{3,}$/;

const cleanHeadingLine = (line: string) => line
  .trim()
  .replace(/^#{1,6}\s*/, '')
  .replace(/^\*{1,2}(.+)\*{1,2}$/, '$1')
  .trim();

const isChapterTitle = (value: string) => (
  NUMBERED_HEADING.test(value)
  || ENGLISH_HEADING.test(value)
  || SPECIAL_HEADING.test(value)
);

const parseChapterHeading = (line: string): ChapterHeading | null => {
  const cleaned = cleanHeadingLine(line);
  if (!cleaned || DECORATION_LINE.test(cleaned)) {
    return null;
  }

  const wrapped = cleaned.match(/^《([^》]+)》$/);
  if (wrapped) {
    const inner = wrapped[1]!.trim();
    const separatorIndex = Math.max(inner.lastIndexOf('·'), inner.lastIndexOf('：'), inner.lastIndexOf(':'));

    if (separatorIndex > 0) {
      const projectTitle = inner.slice(0, separatorIndex).trim();
      const chapterTitle = inner.slice(separatorIndex + 1).trim();
      if (projectTitle && isChapterTitle(chapterTitle)) {
        return { title: chapterTitle, projectTitle };
      }
    }

    if (isChapterTitle(inner)) {
      return { title: inner };
    }

    return null;
  }

  const bookThenChapter = cleaned.match(/^《([^》]+)》\s*(.+)$/);
  if (bookThenChapter && isChapterTitle(bookThenChapter[2]!.trim())) {
    return {
      title: bookThenChapter[2]!.trim(),
      projectTitle: bookThenChapter[1]!.trim()
    };
  }

  return isChapterTitle(cleaned) ? { title: cleaned } : null;
};

const trimDecorationLines = (lines: string[]) => {
  let start = 0;
  let end = lines.length;

  while (start < end && (!lines[start]!.trim() || DECORATION_LINE.test(lines[start]!.trim()))) {
    start += 1;
  }
  while (end > start && (!lines[end - 1]!.trim() || DECORATION_LINE.test(lines[end - 1]!.trim()))) {
    end -= 1;
  }

  return lines.slice(start, end).join('\n').trim();
};

const titleFromPreamble = (lines: string[]) => {
  const firstContentIndex = lines.findIndex((line) => {
    const cleaned = cleanHeadingLine(line);
    return cleaned && !DECORATION_LINE.test(cleaned);
  });

  if (firstContentIndex < 0) {
    return { title: '', description: '' };
  }

  const firstLine = cleanHeadingLine(lines[firstContentIndex]!);
  const wrappedTitle = firstLine.match(/^《([^》]+)》$/);
  const title = (wrappedTitle?.[1] || firstLine).trim();
  const description = trimDecorationLines(lines.slice(firstContentIndex + 1));

  return { title, description };
};

const charactersFromPreamble = (lines: string[]): ImportedCharacter[] => {
  const characters: ImportedCharacter[] = [];
  const names = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!/^[·*+-]\s*\S/.test(trimmed)) continue;

    const content = trimmed.replace(/^[·*+-]\s*/, '');
    const separatorIndex = content.search(/[：:]/);
    if (separatorIndex <= 0) continue;

    const name = content.slice(0, separatorIndex).trim();
    const description = content.slice(separatorIndex + 1).trim();
    if (!name || !description || names.has(name.toLowerCase())) continue;

    const roleText = `${name} ${description}`.toLowerCase();
    const role = /男主|女主|主角|protagonist/.test(roleText)
      ? 'Protagonist'
      : /反派|敌|督军|监军|伪神|antagonist/.test(roleText)
        ? 'Antagonist'
        : 'Supporting';
    names.add(name.toLowerCase());
    characters.push({ name, role, description });
  }

  return characters;
};

export const decodeTextFile = (data: Uint8Array) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, '');
  } catch {
    try {
      return new TextDecoder('gb18030', { fatal: true }).decode(data);
    } catch {
      throw new Error('The text file must use UTF-8, GBK, or GB18030 encoding');
    }
  }
};

export const parseTextProject = (rawContent: string, filename = ''): ParsedTextProject => {
  const normalized = rawContent
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();

  if (!normalized) {
    throw new Error('The selected file is empty');
  }

  const lines = normalized.split('\n');
  const headings: Array<{ lineIndex: number; heading: ChapterHeading }> = [];

  lines.forEach((line, lineIndex) => {
    const heading = parseChapterHeading(line);
    if (heading) {
      headings.push({ lineIndex, heading });
    }
  });

  const fallbackTitle = path.basename(filename, path.extname(filename)).trim() || 'Imported Project';

  if (headings.length === 0) {
    const preamble = titleFromPreamble(lines);
    const titleLineLooksExplicit = /^《[^》]+》$/.test(cleanHeadingLine(lines[0] || ''));
    const content = titleLineLooksExplicit ? trimDecorationLines(lines.slice(1)) : normalized;

    return {
      title: (titleLineLooksExplicit ? preamble.title : fallbackTitle).slice(0, 255),
      description: '',
      chapters: [{
        title: '正文',
        content: content || normalized
      }],
      characters: []
    };
  }

  const firstHeadingIndex = headings[0]!.lineIndex;
  const preamble = titleFromPreamble(lines.slice(0, firstHeadingIndex));
  const characters = charactersFromPreamble(lines.slice(0, firstHeadingIndex));
  const inferredProjectTitle = headings.find(({ heading }) => heading.projectTitle)?.heading.projectTitle;
  const chapters: ImportedChapter[] = [];

  headings.forEach(({ lineIndex, heading }, index) => {
    const nextHeadingIndex = headings[index + 1]?.lineIndex ?? lines.length;
    const content = trimDecorationLines(lines.slice(lineIndex + 1, nextHeadingIndex));
    if (content) {
      chapters.push({
        title: heading.title.slice(0, 255),
        content
      });
    }
  });

  if (chapters.length === 0) {
    throw new Error('No chapter content was found in the selected file');
  }

  return {
    title: (preamble.title || inferredProjectTitle || fallbackTitle).slice(0, 255),
    description: preamble.description,
    chapters,
    characters
  };
};
