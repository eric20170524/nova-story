import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executionAffectsEditorContent,
  selectAppliedSkillContent,
  shouldRefreshAfterExecution,
  shouldRetainPendingAgentActions,
  summarizeAgentExecution,
} from './agent_execution';

test('failed and missing results retain actions for retry', () => {
  const actions = ['rewrite'];
  for (const results of [[], [{ status: 'error' }]]) {
    const outcome = summarizeAgentExecution(actions, results);
    assert.equal(outcome.titleKey, 'agent.execute_fail');
    assert.equal(outcome.failed, true);
    assert.equal(outcome.successful.length, 0);
    assert.deepEqual(outcome.retryActions, actions);
  }
});

test('partial failure retries only failed writes', () => {
  const outcome = summarizeAgentExecution(['rename', 'rewrite', 'skip'], [
    { status: 'success' }, { status: 'error' }, { status: 'skipped' },
  ]);
  assert.equal(outcome.titleKey, 'agent.execute_partial');
  assert.deepEqual(outcome.retryActions, ['rewrite']);
});

test('successful and skipped batches have distinct outcomes', () => {
  for (const status of ['success', 'skipped']) {
    const outcome = summarizeAgentExecution(['rewrite'], [{ status }]);
    assert.equal(outcome.titleKey, status === 'success' ? 'agent.execute_done' : 'agent.execute_skipped');
    assert.equal(outcome.failed, false);
    assert.deepEqual(outcome.retryActions, []);
  }
});

test('pending actions stay on the same chapter and drop when the chapter changes', () => {
  const same = {
    pendingChapterId: 'chapter-a',
    currentChapterId: 'chapter-a',
    pendingSurface: 'story',
    currentSurface: 'story',
  };
  assert.equal(shouldRetainPendingAgentActions(same), true);
  assert.equal(shouldRetainPendingAgentActions({ ...same, currentChapterId: 'chapter-b' }), false);
  assert.equal(shouldRetainPendingAgentActions({ ...same, currentSurface: 'director' }), false);
});

test('applied skill text syncs only when the result chapter is the open editor chapter', () => {
  const results = [{
    status: 'success',
    op: 'CINEMATIC_REWRITE',
    data: { chapterId: 'chapter-a', content: 'rewritten', applied: true },
  }];
  assert.equal(selectAppliedSkillContent(results, 'chapter-a'), 'rewritten');
  assert.equal(selectAppliedSkillContent(results, 'chapter-b'), null);
  assert.equal(selectAppliedSkillContent(results, null), null);
  assert.equal(shouldRefreshAfterExecution(results, 'chapter-a'), true);
  assert.equal(shouldRefreshAfterExecution(results, 'chapter-b'), false);
});

test('creating the next chapter does not mark the open chapter body as changed', () => {
  assert.equal(executionAffectsEditorContent([
    { status: 'success', op: 'CREATE_NEXT_CHAPTER' },
  ]), false);
  assert.equal(executionAffectsEditorContent([
    { status: 'success', op: 'PLAN_STORY' },
    { status: 'success', op: 'ANSWER_QUESTION' },
  ]), false);
  assert.equal(executionAffectsEditorContent([
    { status: 'success', op: 'CREATE_NEXT_CHAPTER' },
    { status: 'success', op: 'DRAFT_CONTENT', data: { chapterId: 'chapter-a' } },
  ]), true);
  assert.equal(executionAffectsEditorContent([{ status: 'error', op: 'CREATE_NEXT_CHAPTER' }]), true);
});
