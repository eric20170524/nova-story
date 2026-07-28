import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTextProject } from './text_import';

test('extracts character declarations from the imported project preamble', () => {
  const parsed = parseTextProject([
    '《测试故事》',
    '人物：',
    '· 林舟：男主，沉着的剑客',
    '- 玄鸦：反派，潜伏在城中',
    '',
    '第一章：开端',
    '林舟走进城门。'
  ].join('\n'), 'story.txt');

  assert.deepEqual(parsed.characters, [
    {
      name: '林舟',
      role: 'Protagonist',
      description: '男主，沉着的剑客'
    },
    {
      name: '玄鸦',
      role: 'Antagonist',
      description: '反派，潜伏在城中'
    }
  ]);
});
