import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectImportInputError } from './import_file';
import { buildProjectImportPreview } from './import_preview';

const MARKDOWN = [
  '# 失声的梦核游乐园',
  '',
  '## 简介',
  '',
  '一只小动物误入停摆的梦核游乐场。',
  '',
  '## 创作信息',
  '',
  '- 题材：梦核幻想 / 小动物视角 / 治愈系探索',
  '',
  '## 第 1 章 停摆的迎宾广场',
  '',
  '### 章节概要',
  '',
  '主角确认游乐场陷入非自然静止。',
  '',
  '### 正文',
  '',
  '耳朵敏锐地抖了抖。',
].join('\n');

test('builds a non-persistent markdown preview', () => {
  const preview = buildProjectImportPreview(
    Buffer.from(MARKDOWN, 'utf8'),
    '失声的梦核游乐园.md'
  );

  assert.equal(preview.mode, 'novel-draft');
  assert.equal(preview.source.format, 'markdown');
  assert.equal(preview.project.title, '失声的梦核游乐园');
  assert.equal(preview.counts.chapters, 1);
  assert.equal(preview.counts.chapter_summaries, 1);
  assert.equal(preview.counts.chapter_contents, 1);
  assert.equal(preview.counts.characters, 0);
  assert.equal(preview.chapters[0]!.title, '第 1 章 停摆的迎宾广场');
  assert.equal(preview.chapters[0]!.has_content, true);
  assert.deepEqual(preview.project.settings.story_tags, [
    '梦核幻想',
    '小动物视角',
    '治愈系探索',
  ]);
});

test('previews NovaStory JSON without flattening director data into a novel draft', () => {
  const preview = buildProjectImportPreview(
    Buffer.from(JSON.stringify({
      format: 'novastory-project',
      project: {
        title: 'JSON Project',
        description: 'desc',
        settings: { genre: 'fantasy' },
      },
      screenplay: {
        chapters: [{ index: 1, title: 'Chapter 1', content: 'Body', summary: 'Summary' }],
      },
      character_center: {
        characters: [{ name: 'A' }],
      },
      director: {
        scenes: [{ id: 1 }],
        coverage_groups: [{ id: 1 }],
        coverage_shots: [{ id: 1 }, { id: 2 }],
      },
    }), 'utf8'),
    'project.novastory.json'
  );

  assert.equal(preview.mode, 'novastory-project');
  assert.equal(preview.source.format, 'json');
  assert.equal(preview.project.title, 'JSON Project');
  assert.equal(preview.counts.chapters, 1);
  assert.equal(preview.counts.characters, 1);
  assert.equal(preview.counts.scenes, 1);
  assert.equal(preview.counts.coverage_groups, 1);
  assert.equal(preview.counts.coverage_shots, 2);
});

test('rejects unsupported file extensions before parsing', () => {
  assert.throws(
    () => buildProjectImportPreview(Buffer.from('x'), 'novel.pdf'),
    (error: unknown) => (
      error instanceof ProjectImportInputError
      && error.statusCode === 415
    )
  );
});
