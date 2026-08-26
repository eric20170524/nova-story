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

test('builds a non-persistent markdown preview', async () => {
  const preview = await buildProjectImportPreview(
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

test('previews the same restorable NovaStory JSON graph used by commit', async () => {
  const preview = await buildProjectImportPreview(
    Buffer.from(JSON.stringify({
      format: 'novastory-project',
      project: {
        title: 'JSON Project',
        description: 'desc',
        settings: { genre: 'fantasy' },
      },
      screenplay: {
        chapters: [{
          id: 'chapter-1',
          index: 1,
          title: 'Chapter 1',
          content: 'Body',
          summary: 'Summary',
        }],
      },
      character_center: {
        characters: [{ name: 'A' }],
      },
      director: {
        scenes: [{ id: 10, chapter_id: 'chapter-1' }],
        coverage_groups: [{ id: 20, source_scene_id: 10 }],
        coverage_shots: [
          { id: 30, coverage_group_id: 20 },
          { id: 31, coverage_group_id: 20 },
        ],
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
  assert.deepEqual(preview.warnings, []);
});

test('native JSON preview excludes orphan director nodes and explains why', async () => {
  const preview = await buildProjectImportPreview(
    Buffer.from(JSON.stringify({
      format: 'novastory-project',
      project: { title: 'Orphan Test', settings: [] },
      screenplay: {
        chapters: [{ id: 'chapter-1', title: 'Chapter 1' }],
      },
      director: {
        scenes: [
          { id: 10, chapter_id: 'chapter-1' },
          { id: 11, chapter_id: 'missing-chapter' },
        ],
        coverage_groups: [
          { id: 20, source_scene_id: 10 },
          { id: 21, source_scene_id: 11 },
        ],
        coverage_shots: [
          { coverage_group_id: 20 },
          { coverage_group_id: 21 },
        ],
      },
    }), 'utf8'),
    'orphan.novastory.json'
  );

  assert.equal(preview.counts.scenes, 1);
  assert.equal(preview.counts.coverage_groups, 1);
  assert.equal(preview.counts.coverage_shots, 1);
  assert.deepEqual(preview.project.settings, {});
  assert.ok(preview.warnings.some((warning) => /settings/i.test(warning)));
  assert.ok(preview.warnings.some((warning) => /missing chapter/i.test(warning)));
  assert.ok(preview.warnings.some((warning) => /missing scene/i.test(warning)));
  assert.ok(preview.warnings.some((warning) => /missing coverage group/i.test(warning)));
});

test('rejects duplicate native JSON ids before persistence', async () => {
  await assert.rejects(
    buildProjectImportPreview(
      Buffer.from(JSON.stringify({
        format: 'novastory-project',
        project: { title: 'Duplicate IDs' },
        screenplay: {
          chapters: [
            { id: 'same', title: 'One' },
            { id: 'same', title: 'Two' },
          ],
        },
      })),
      'duplicate.novastory.json'
    ),
    (error: unknown) => (
      error instanceof ProjectImportInputError
      && error.statusCode === 400
      && /Duplicate chapter id/.test(error.message)
    )
  );
});

test('rejects arbitrary JSON objects that are not project exports', async () => {
  await assert.rejects(
    buildProjectImportPreview(
      Buffer.from(JSON.stringify({ unrelated: true })),
      'unrelated.json'
    ),
    (error: unknown) => (
      error instanceof ProjectImportInputError
      && error.statusCode === 400
      && /does not look like/.test(error.message)
    )
  );
});

test('rejects unsupported file extensions before parsing', async () => {
  await assert.rejects(
    buildProjectImportPreview(Buffer.from('x'), 'novel.pdf'),
    (error: unknown) => (
      error instanceof ProjectImportInputError
      && error.statusCode === 415
    )
  );
});
