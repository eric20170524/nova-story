import path from 'path';
import type {
  NovelImportDraft,
  NovelImportUnmappedSection,
} from './types';

const CHINESE_NUMBER = '0-9零〇一二两三四五六七八九十百千万';
const NUMBERED_HEADING = new RegExp(
  `^第\\s*[${CHINESE_NUMBER}]+\\s*[章集幕回卷篇](?:\\s*[：:·.\\-—]\\s*\\S.*|\\s+\\S.*)?$`,
  'i'
);
const ENGLISH_HEADING = /^(?:Chapter|Episode|EP)\s*\d+(?:\s*[：:·.\-—]\s*\S.*|\s+\S.*)?$/i;
const SPECIAL_HEADING = /^(?:序章|楔子|引子|初章|终章|尾声|后记|番外(?:\s*[0-9零〇一二两三四五六七八九十百千]+)?)(?:\s*[：:·.\-—]\s*\S.*|\s+\S.*)?$/i;

interface MarkdownSection {
  heading: string;
  body: string;
  startLine: number;
}

const trimBlock = (value: string) => value.replace(/^\s+|\s+$/g, '');

const unwrapTitle = (value: string) => {
  const trimmed = value.trim();
  const wrapped = trimmed.match(/^《([^》]+)》$/);
  return (wrapped?.[1] || trimmed).trim();
};

const isChapterHeading = (value: string) => {
  const cleaned = value.trim();
  return NUMBERED_HEADING.test(cleaned)
    || ENGLISH_HEADING.test(cleaned)
    || SPECIAL_HEADING.test(cleaned);
};

const collectSections = (lines: string[], level: number): MarkdownSection[] => {
  const prefix = '#'.repeat(level);
  const headingPattern = new RegExp(`^${prefix}\\s+(.+?)\\s*$`);
  const deeperPrefix = '#'.repeat(level + 1);
  const sections: MarkdownSection[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith(deeperPrefix)) continue;
    const match = line.match(headingPattern);
    if (!match) continue;

    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]!;
      if (candidate.startsWith(deeperPrefix)) continue;
      if (headingPattern.test(candidate)) {
        end = cursor;
        break;
      }
    }

    sections.push({
      heading: match[1]!.trim(),
      body: trimBlock(lines.slice(index + 1, end).join('\n')),
      startLine: index,
    });
  }

  return sections;
};

const parseCreationInfo = (body: string) => {
  const settings: Record<string, unknown> = {};
  const importMetadata: Record<string, string> = {};

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim().replace(/^[-*+]\s*/, '');
    if (!line) continue;

    const separatorIndex = line.search(/[：:]/);
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || !value) continue;

    const normalizedKey = key.toLowerCase().replace(/[\s_-]+/g, '');

    if (['题材', '类型', 'genre'].includes(normalizedKey)) {
      settings.genre = value;
      const tags = value
        .split(/[\/／、,，|]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (tags.length > 0) settings.story_tags = tags;
      continue;
    }

    if (['风格', '文风', 'style'].includes(normalizedKey)) {
      settings.style = value;
      continue;
    }

    if (['主线', '主线剧情', '故事主线', 'mainplot'].includes(normalizedKey)) {
      settings.main_plot = value;
      continue;
    }

    if (['人物关系', '角色关系', 'characterrelations'].includes(normalizedKey)) {
      settings.character_relations = value;
      continue;
    }

    if (['视角', '叙事视角', 'pov'].includes(normalizedKey)) {
      settings.pov = value;
      continue;
    }

    if (['基调', '氛围', '语气', 'tone'].includes(normalizedKey)) {
      settings.tone = value;
      continue;
    }

    importMetadata[key] = value;
  }

  if (Object.keys(importMetadata).length > 0) {
    settings.import_metadata = importMetadata;
  }

  return settings;
};

const isSummaryHeading = (heading: string) =>
  ['章节概要', '章节概述', '章节摘要', '概要', '摘要', 'summary'].includes(
    heading.trim().toLowerCase()
  );

const isContentHeading = (heading: string) =>
  ['正文', '章节正文', 'content', 'text'].includes(heading.trim().toLowerCase());

const parseChapterBody = (
  chapterTitle: string,
  body: string,
  unmappedSections: NovelImportUnmappedSection[]
) => {
  const lines = body.split('\n');
  const h3Sections = collectSections(lines, 3);

  if (h3Sections.length === 0) {
    return { summary: undefined, content: trimBlock(body) };
  }

  const firstH3Line = h3Sections[0]!.startLine;
  const preamble = trimBlock(lines.slice(0, firstH3Line).join('\n'));
  let summary: string | undefined;
  let explicitContent: string | undefined;
  const fallbackContent: string[] = preamble ? [preamble] : [];

  for (const section of h3Sections) {
    if (isSummaryHeading(section.heading)) {
      if (!summary && section.body) summary = section.body;
      continue;
    }

    if (isContentHeading(section.heading)) {
      if (explicitContent === undefined) explicitContent = section.body;
      continue;
    }

    unmappedSections.push({
      heading: section.heading,
      content: section.body,
      scope: 'chapter',
      chapterTitle,
    });

    fallbackContent.push(
      trimBlock(`### ${section.heading}\n\n${section.body}`)
    );
  }

  const content = explicitContent !== undefined
    ? trimBlock(explicitContent)
    : trimBlock(fallbackContent.filter(Boolean).join('\n\n'));

  return { summary, content };
};

export const parseMarkdownNovel = (
  rawContent: string,
  filename = ''
): NovelImportDraft => {
  const normalized = rawContent
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();

  if (!normalized) {
    throw new Error('The selected file is empty');
  }

  const lines = normalized.split('\n');
  const fallbackTitle = path.basename(filename, path.extname(filename)).trim() || 'Imported Project';
  const h1 = lines.find((line) => /^#\s+\S/.test(line));
  const title = unwrapTitle(h1?.replace(/^#\s+/, '') || fallbackTitle).slice(0, 255);
  const h2Sections = collectSections(lines, 2);
  const projectSections = h2Sections.filter((section) => !isChapterHeading(section.heading));
  const chapterSections = h2Sections.filter((section) => isChapterHeading(section.heading));
  const unmappedSections: NovelImportUnmappedSection[] = [];
  const warnings: string[] = [];
  let description = '';
  const settings: Record<string, unknown> = {};

  for (const section of projectSections) {
    const heading = section.heading.trim().toLowerCase();

    if (['简介', '作品简介', '故事简介', '内容简介', 'description'].includes(heading)) {
      if (!description) description = section.body;
      continue;
    }

    if (['创作信息', '作品信息', '创作设定', '元信息', 'metadata'].includes(heading)) {
      Object.assign(settings, parseCreationInfo(section.body));
      continue;
    }

    unmappedSections.push({
      heading: section.heading,
      content: section.body,
      scope: 'project',
    });
  }

  const chapters = chapterSections.map((section, index) => {
    const parsedBody = parseChapterBody(section.heading, section.body, unmappedSections);
    if (!parsedBody.content) {
      warnings.push(`Chapter "${section.heading}" has no正文 content`);
    }
    return {
      index: index + 1,
      title: section.heading.slice(0, 255),
      summary: parsedBody.summary,
      content: parsedBody.content,
      status: 'draft',
    };
  });

  if (chapters.length === 0) {
    const contentLines = h1 ? lines.slice(lines.indexOf(h1) + 1) : lines;
    const content = trimBlock(contentLines.join('\n'));
    if (!content) {
      throw new Error('No chapter content was found in the selected file');
    }
    chapters.push({
      index: 1,
      title: '正文',
      content,
      status: 'draft',
    });
    warnings.push('No chapter headings were found; imported the Markdown document as one chapter');
  }

  return {
    source: {
      filename,
      format: 'markdown',
    },
    project: {
      title,
      description,
      settings,
    },
    chapters,
    characters: [],
    glossary: [],
    unmappedSections,
    warnings,
  };
};
