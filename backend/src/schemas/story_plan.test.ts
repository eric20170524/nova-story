import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPlanningBudget,
  emptyStoryPlan,
  extractExplicitSummary,
  hashApplySelection,
  orderPlanEntries,
  parseOrdinalToken,
  planningWordBudget,
  resolvePlanOrdinal,
  selectNextPlanEntry,
  upcomingPlanSummary,
} from './story_plan';

test('empty plan allows a missing word target', () => {
  const plan = emptyStoryPlan();
  assert.equal(plan.targetTotalWords, null);
  assert.equal(plan.autoCreateNextChapter, false);
  assert.deepEqual(plan.chapters, []);
});

test('next plan entry follows the last linked entry and skips retired rows', () => {
  const entries = [
    { id: 'a', title: 'A', summary: 'one', targetWordCount: 2000, disposition: 'active' as const },
    { id: 'b', title: 'B', summary: 'two', targetWordCount: 2000, disposition: 'retired' as const },
    { id: 'c', title: 'C', summary: 'three', targetWordCount: 2000, disposition: 'active' as const },
  ];
  assert.equal(selectNextPlanEntry(entries, new Set(['a']))?.id, 'c');
  assert.equal(selectNextPlanEntry(entries, new Set())?.id, 'a');
});

test('plan order keeps linked chapters ahead of future entries', () => {
  const entries = [
    { id: 'future', title: 'Future', summary: 'later', targetWordCount: 2000, disposition: 'active' as const },
    { id: 'linked', title: 'Linked', summary: 'now', targetWordCount: 2000, disposition: 'active' as const },
    { id: 'old', title: 'Old', summary: 'gone', targetWordCount: 2000, disposition: 'retired' as const },
  ];
  const ordered = orderPlanEntries(entries, [{ plan_entry_id: 'linked', index: 2 }]);
  assert.deepEqual(ordered.map((entry) => entry.id), ['linked', 'future', 'old']);
});

test('word budget does not count a linked entry twice and ignores a missing target', () => {
  const document = emptyStoryPlan();
  document.chapters = [
    { id: 'linked', title: 'One', summary: 's', targetWordCount: 3000, disposition: 'active' },
    { id: 'future', title: 'Two', summary: 's', targetWordCount: 2000, disposition: 'active' },
  ];
  const budget = planningWordBudget(
    [{ content: '你好世界', status: 'draft', plan_entry_id: 'linked', target_word_count: 1000 }],
    document.chapters
  );
  assert.equal(budget.written, 4);
  assert.equal(budget.reserved, 1000 + 2000);
  assert.doesNotThrow(() => assertPlanningBudget(document, []));
  document.targetTotalWords = 50000;
  document.chapters = [
    { id: 'future', title: 'Two', summary: 's', targetWordCount: 10000, disposition: 'active' },
  ];
  assert.throws(() => assertPlanningBudget(document, [
    { content: '', status: 'draft', target_word_count: 10000 },
    { content: '', status: 'draft', target_word_count: 10000 },
    { content: '', status: 'draft', target_word_count: 10000 },
    { content: '', status: 'draft', target_word_count: 10000 },
    { content: '', status: 'draft', target_word_count: 10000 },
    { content: '', status: 'draft', target_word_count: 10000 },
  ]), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'PLAN_BUDGET_EXCEEDED');
});

test('ordinals follow active plan order and explicit summaries stay intact', () => {
  assert.equal(parseOrdinalToken('十二'), 12);
  const entries = [
    { id: 'a', title: 'A', summary: 's', targetWordCount: 2000, disposition: 'active' as const },
    { id: 'b', title: 'B', summary: 's', targetWordCount: 2000, disposition: 'retired' as const },
    { id: 'c', title: 'C', summary: 's', targetWordCount: 2000, disposition: 'active' as const },
  ];
  assert.equal(resolvePlanOrdinal(entries, '改写第二章规划'), 'c');
  assert.equal(extractExplicitSummary('把章纲改为 雨夜决战，主角失去剑'), '雨夜决战，主角失去剑');
});

test('apply hash ignores later document edits and a real next chapter wins over the plan', () => {
  const first = hashApplySelection('c1', 2, 1, ['b', 'a']);
  const same = hashApplySelection('c1', 2, 1, ['a', 'b', 'a']);
  assert.equal(first, same);
  const document = emptyStoryPlan();
  document.chapters = [
    { id: 'a', title: 'A', summary: 'plan', targetWordCount: 2000, disposition: 'active' },
    { id: 'b', title: 'B', summary: 'future', targetWordCount: 2000, disposition: 'active' },
  ];
  assert.equal(upcomingPlanSummary(document, [{ id: 'ch-a', plan_entry_id: 'a' }, { id: 'ch-b', plan_entry_id: 'b' }], 'ch-a'), null);
  assert.equal(upcomingPlanSummary(document, [{ id: 'ch-a', plan_entry_id: 'a' }], 'ch-a'), 'future');
});
