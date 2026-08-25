import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkdownNovel } from './markdown_import';

const buildDreamcoreStructure = () => {
  const chapters = Array.from({ length: 10 }, (_, index) => {
    const number = index + 1;
    return [
      `## 第 ${number} 章 测试章节 ${number}`,
      '',
      '### 章节概要',
      '',
      `这是第 ${number} 章概要。`,
      '',
      '### 正文',
      '',
      `这是第 ${number} 章正文。`,
    ].join('\n');
  }).join('\n\n');

  return [
    '# 失声的梦核游乐园',
    '',
    '## 简介',
    '',
    '作品以一只小动物的视角展开。',
    '',
    '## 创作信息',
    '',
    '- 题材：梦核幻想 / 小动物视角 / 治愈系探索',
    '- 目标读者：全年龄',
    '',
    chapters,
  ].join('\n');
};

test('parses structured Markdown novel into a canonical draft', () => {
  const parsed = parseMarkdownNovel(
    buildDreamcoreStructure(),
    '失声的梦核游乐园.md'
  );

  assert.equal(parsed.project.title, '失声的梦核游乐园');
  assert.equal(parsed.project.description, '作品以一只小动物的视角展开。');
  assert.equal(
    parsed.project.settings.genre,
    '梦核幻想 / 小动物视角 / 治愈系探索'
  );
  assert.deepEqual(parsed.project.settings.story_tags, [
    '梦核幻想',
    '小动物视角',
    '治愈系探索',
  ]);
  assert.deepEqual(parsed.project.settings.import_metadata, {
    目标读者: '全年龄',
  });

  assert.equal(parsed.chapters.length, 10);
  assert.equal(parsed.chapters[0]!.title, '第 1 章 测试章节 1');
  assert.equal(parsed.chapters[0]!.summary, '这是第 1 章概要。');
  assert.equal(parsed.chapters[0]!.content, '这是第 1 章正文。');
  assert.ok(!parsed.chapters[0]!.content.includes('### 章节概要'));
  assert.ok(!parsed.chapters[0]!.content.includes('### 正文'));
  assert.equal(parsed.characters.length, 0);
  assert.equal(parsed.unmappedSections.length, 0);
});

test('preserves unknown chapter subsections instead of silently dropping them', () => {
  const parsed = parseMarkdownNovel(
    [
      '# 测试小说',
      '',
      '## 第一章：开始',
      '',
      '### 章节概要',
      '概要',
      '',
      '### 正文',
      '正文',
      '',
      '### 作者备注',
      '不要丢失这段信息。',
    ].join('\n'),
    'test.md'
  );

  assert.equal(parsed.chapters[0]!.content, '正文');
  assert.deepEqual(parsed.unmappedSections, [
    {
      heading: '作者备注',
      content: '不要丢失这段信息。',
      scope: 'chapter',
      chapterTitle: '第一章：开始',
    },
  ]);
});

test('keeps chapter preamble before an explicit content section', () => {
  const parsed = parseMarkdownNovel(
    [
      '# 测试小说',
      '',
      '## 第一章：开始',
      '',
      '这一段在结构化小节之前，也不能被丢弃。',
      '',
      '### 章节概要',
      '概要',
      '',
      '### 正文',
      '正式正文。',
    ].join('\n'),
    'test.md'
  );

  assert.equal(
    parsed.chapters[0]!.content,
    '这一段在结构化小节之前，也不能被丢弃。\n\n正式正文。'
  );
});

test('preserves non-chapter h2 sections even when they appear after chapters', () => {
  const parsed = parseMarkdownNovel(
    [
      '# 测试小说',
      '',
      '## 第一章：开始',
      '',
      '正文。',
      '',
      '## 附加说明',
      '',
      '这是章后补充资料。',
    ].join('\n'),
    'test.md'
  );

  assert.deepEqual(parsed.unmappedSections, [
    {
      heading: '附加说明',
      content: '这是章后补充资料。',
      scope: 'project',
    },
  ]);
});

test('falls back to a single chapter when Markdown has no chapter headings', () => {
  const parsed = parseMarkdownNovel(
    '# 单篇故事\n\n只有一段正文。',
    'single.md'
  );

  assert.equal(parsed.project.title, '单篇故事');
  assert.equal(parsed.chapters.length, 1);
  assert.equal(parsed.chapters[0]!.title, '正文');
  assert.equal(parsed.chapters[0]!.content, '只有一段正文。');
  assert.equal(parsed.warnings.length, 1);
});
