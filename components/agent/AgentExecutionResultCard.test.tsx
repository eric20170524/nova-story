import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../../LanguageContext';
import { AgentExecutionResultCard } from './AgentExecutionResultCard';

function renderResult(op: string, status: string, data?: any) {
  return renderToStaticMarkup(
    <LanguageProvider>
      <AgentExecutionResultCard
        results={[{ op, status, message: 'HTTP 524', data }]}
        onApplyContent={() => { throw new Error('must not apply during render'); }}
      />
    </LanguageProvider>
  );
}

test('failed operations never render success reports or content apply controls', () => {
  for (const op of ['CINEMATIC_REWRITE', 'ADD_CONFLICT', 'REVERSE_PLOT', 'RUN_CONSISTENCY_CHECK', 'APPLY_CHAPTER_IMPACT', 'RENAME_CHAPTER']) {
    // Even stale payload data must not bypass the failed status.
    const html = renderResult(op, 'error', { content: 'partial', applied: true });
    assert.match(html, /执行失败/);
    assert.match(html, /HTTP 524/);
    assert.match(html, /role="alert"/);
    assert.doesNotMatch(html, /改写完成|已直接写入|未发现明显设定冲突|partial|<button/);
  }
});

test('skipped rewrite is not presented as completed', () => {
  const html = renderResult('CINEMATIC_REWRITE', 'skipped');
  assert.match(html, /已跳过/);
  assert.doesNotMatch(html, /改写完成|<button/);
});

test('successful rewrite distinguishes preview from persisted body', () => {
  assert.match(renderResult('CINEMATIC_REWRITE', 'success', { content: '正文', applied: false }), /改写完成/);
  assert.match(renderResult('CINEMATIC_REWRITE', 'success', { content: '正文', applied: true }), /已直接写入/);
});

test('finalization reports plot timeline and relationships even with no character or glossary delta', () => {
  const html = renderResult('APPLY_CHAPTER_IMPACT', 'success', {
    newOrUpdatedCharacters: [], newOrUpdatedGlossary: [], applied: true,
    mainPlotChanged: true, characterRelationsChanged: true,
    mainPlotEntry: '角色状态：负伤；事件：夺回钥匙；伏笔：裂纹未回收',
    characterRelationsEntry: '阿岚与林川结盟',
  });
  assert.match(html, /主线剧情[\s\S]*角色状态：负伤[\s\S]*人物关系[\s\S]*阿岚与林川结盟/);
  assert.match(html, /已更新设定/);
  assert.doesNotMatch(html, /本章未检测到/);
});

test('finalization preview never claims to have written settings or character traits', () => {
  const html = renderResult('APPLY_CHAPTER_IMPACT', 'success', {
    applied: false, mainPlotChanged: true, mainPlotEntry: '事件：夺回钥匙',
    characterRelationsChanged: true, characterRelationsEntry: '结盟',
    personalityMerged: true, visualTagsMerged: true,
  });
  assert.match(html, /预览，未写入/);
  assert.match(html, /尚未写入角色库/);
  assert.doesNotMatch(html, /已更新设定|已将性格特征合并写入|已将视觉特征合并写入/);
});

test('finalization exposes automatic next-chapter failures without hiding the completed finalization', () => {
  const html = renderResult('APPLY_CHAPTER_IMPACT', 'success', {
    applied: true,
    autoNext: { status: 'failed', code: 'PLAN_CONFLICT', message: '规划已被其他操作更新' },
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /章节已定稿，但自动创建下一章失败/);
  assert.match(html, /规划已被其他操作更新/);
  assert.match(html, /再次定稿重试/);
  assert.doesNotMatch(html, /执行失败/);
  const created = renderResult('APPLY_CHAPTER_IMPACT', 'success', { applied: true, autoNext: { status: 'created' } });
  assert.match(created, /下一章已创建/);
  assert.doesNotMatch(created, /role="alert"/);
  const preview = renderResult('APPLY_CHAPTER_IMPACT', 'success', { applied: false, autoNext: { status: 'failed' } });
  assert.doesNotMatch(preview, /自动创建下一章失败/);
});
