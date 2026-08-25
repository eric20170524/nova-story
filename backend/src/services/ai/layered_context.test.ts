import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLayeredContext, buildProjectStructure } from './layered_context';

test('buildProjectStructure lists flat chapters', () => {
  const s = buildProjectStructure([
    { id: 'a', title: '开篇', index: 0, status: 'draft', summary: '危机' },
    { id: 'b', title: '反击', index: 1, status: 'completed' },
  ]);
  assert.match(s, /开篇/);
  assert.match(s, /反击/);
  assert.match(s, /\[a\]/);
});

test('buildLayeredContext layers memory and next-chapter summary', () => {
  const chapters = [
    {
      id: 'c0',
      title: 'Ch0',
      index: 0,
      content: 'A'.repeat(600),
      summary: 's0',
      status: 'completed',
    },
    {
      id: 'c1',
      title: 'Ch1',
      index: 1,
      content: 'B'.repeat(200),
      condensed_content: 'cond1',
      summary: 's1',
      status: 'completed',
    },
    {
      id: 'c2',
      title: 'Ch2',
      index: 2,
      content: '',
      summary: 'next hook',
      status: 'draft',
    },
  ];

  const ctx = buildLayeredContext({
    chapters,
    activeChapterId: 'c1',
    bible: {
      title: 'Test',
      genre: 'xianxia',
      main_plot: 'revenge',
      story_tags: ['梦核幻想', '小动物视角'],
      pov: '第三人称限知',
      tone: '治愈、轻微诡异',
    },
    characters: [{ name: 'Hero', role: 'protagonist' }],
    glossary: [{ term: '灵根', definition: '天赋' }],
  });

  assert.ok(ctx);
  assert.ok(ctx!.lastScene.length > 0);
  assert.equal(ctx!.nextChapterSummary, 'next hook');
  assert.match(ctx!.worldBible, /Test/);
  assert.match(ctx!.worldBible, /Hero/);
  assert.match(ctx!.worldBible, /灵根/);
  assert.match(ctx!.worldBible, /Story tags: 梦核幻想, 小动物视角/);
  assert.match(ctx!.worldBible, /POV: 第三人称限知/);
  assert.match(ctx!.worldBible, /Tone: 治愈、轻微诡异/);
  assert.match(ctx!.projectStructure, /Ch1/);
});

test('buildLayeredContext caps narrative metadata instead of expanding context indefinitely', () => {
  const ctx = buildLayeredContext({
    chapters: [{ id: 'x', title: 'X', index: 0 }],
    activeChapterId: 'x',
    bible: {
      title: 'T',
      story_tags: Array.from({ length: 20 }, (_, index) => `tag-${index}-${'x'.repeat(30)}`),
      pov: 'P'.repeat(300),
      tone: 'T'.repeat(300),
    },
    characters: [],
    glossary: [],
  });

  assert.ok(ctx);
  const tagLine = ctx!.worldBible.split('\n').find((line) => line.startsWith('Story tags:')) || '';
  const povLine = ctx!.worldBible.split('\n').find((line) => line.startsWith('POV:')) || '';
  const toneLine = ctx!.worldBible.split('\n').find((line) => line.startsWith('Tone:')) || '';
  assert.ok(tagLine.length <= 'Story tags: '.length + 163);
  assert.ok(povLine.length <= 'POV: '.length + 123);
  assert.ok(toneLine.length <= 'Tone: '.length + 123);
});

test('buildLayeredContext returns null for unknown chapter', () => {
  const ctx = buildLayeredContext({
    chapters: [{ id: 'x', title: 'X', index: 0 }],
    activeChapterId: 'missing',
    bible: { title: 'T' },
    characters: [],
    glossary: [],
  });
  assert.equal(ctx, null);
});
