import assert from 'node:assert/strict';
import test from 'node:test';
import { chapterEditorFields, isChapterEditorDirty, reconcileChapterEditorFields } from './chapterEditorState';
import type { Chapter } from '../../types';

const chapter: Chapter = { id: 'draft', project_id: 1, index: 1, title: '旧标题', summary: '旧章纲', content: '正文' };

test('adopted outlines refresh clean editor fields and the next save keeps the adopted summary', () => {
  const baseline = chapterEditorFields(chapter);
  const adopted = { ...chapter, title: '采纳标题', summary: '采纳章纲' };
  const editor = reconcileChapterEditorFields(baseline, baseline, chapterEditorFields(adopted));
  assert.equal(editor.title, '采纳标题');
  assert.equal(editor.summary, '采纳章纲');
  assert.equal(isChapterEditorDirty(adopted, editor), false);
  const bodyEdit = { ...editor, content: '保存新正文' };
  assert.equal(isChapterEditorDirty(adopted, bodyEdit), true);
  assert.equal(bodyEdit.summary, '采纳章纲');
});

test('a title-only edit is dirty and survives next-chapter reloads', () => {
  const baseline = chapterEditorFields(chapter);
  const local = { ...baseline, title: '未保存标题' };
  assert.equal(isChapterEditorDirty(chapter, local), true);
  const fresh = { ...chapter, status: 'completed' };
  assert.deepEqual(reconcileChapterEditorFields(baseline, local, chapterEditorFields(fresh)), local);
  const saved = { ...fresh, ...local };
  assert.equal(isChapterEditorDirty(saved, local), false);
});

test('agent summary updates pull clean outlines and forced body rewrites preserve unsaved outline fields', () => {
  const baseline = chapterEditorFields(chapter);
  const fresh = { ...chapter, title: '助手标题', summary: '助手章纲', content: '助手正文' };
  assert.deepEqual(reconcileChapterEditorFields(baseline, baseline, chapterEditorFields(fresh), true), chapterEditorFields(fresh));
  const local = { title: '本地标题', summary: '本地章纲', content: '本地正文' };
  assert.deepEqual(reconcileChapterEditorFields(baseline, local, chapterEditorFields(fresh), true), {
    ...local, content: fresh.content,
  });
  assert.deepEqual(reconcileChapterEditorFields(baseline, local, chapterEditorFields(fresh)), local);
});

test('repeated refreshes retain local fields against the latest server baseline', () => {
  const baseline = chapterEditorFields(chapter);
  const local = { ...baseline, summary: '未保存章纲' };
  const first = { ...chapter, title: '服务器标题 1', summary: '服务器章纲 1' };
  const merged = reconcileChapterEditorFields(baseline, local, chapterEditorFields(first));
  const second = { ...first, title: '服务器标题 2', summary: '服务器章纲 2' };
  const refreshed = reconcileChapterEditorFields(chapterEditorFields(first), merged, chapterEditorFields(second));
  assert.equal(refreshed.title, second.title);
  assert.equal(refreshed.summary, local.summary);
  assert.equal(isChapterEditorDirty(second, refreshed), true);
});

test('save responses keep typing made while the request was in flight', () => {
  const submitted = { title: '提交标题', summary: '提交摘要', content: '提交正文' };
  const newer = { ...submitted, title: '继续输入标题', content: '继续输入正文' };
  const normalized = { ...submitted, summary: '服务端返回摘要' };
  assert.deepEqual(reconcileChapterEditorFields(submitted, newer, normalized), {
    ...newer, summary: normalized.summary,
  });
});
