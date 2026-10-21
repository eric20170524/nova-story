import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AIProvider } from './ai/base';
import { createEmptyScriptDocument } from '../schemas/script';
import { runFactWorkflow, type WorkflowProgress } from './storyboard_fact_workflow';
import { NETWORK_RETRY_LIMIT, newWorkflowInferenceBudget, workflowBudgetProvider, WorkflowTransportError } from './workflow_inference_budget';
import { z } from 'zod';

const provider = (generateStructured: AIProvider['generateStructured']): AIProvider => ({ generateStructured, async generateText() { throw new Error('unexpected'); }, async generateImage() { throw new Error('unexpected'); } });
test('CT09 one shared transport allowance, reservation before inference, and raw trace', async () => {
  const budget = newWorkflowInferenceBudget(); let calls = 0; let reservations = 0;
  const wrapped = workflowBudgetProvider(provider(async (_prompt, schema, _system, options) => {
    assert.equal(options?.transportRetries, 0);
    assert.equal(budget.calls.at(-1)?.attempt_state, 'reserved');
    assert.ok(reservations >= calls + 1);
    calls++;
    if (calls !== 2) throw Object.assign(new Error('network'), { code: 'ECONNRESET' });
    options?.onInference?.({ model: 'test', elapsed_ms: 2, response: { ok: true }, usage: { total_tokens: 9 } });
    return schema.parse({ ok: true });
  }), budget, async () => { reservations = budget.calls.length; }, () => 'child', () => 'initial');
  await wrapped.generateStructured('{"task":"first"}', z.object({ ok: z.boolean() }));
  await assert.rejects(() => wrapped.generateStructured('{"task":"second"}', z.object({ ok: z.boolean() })), WorkflowTransportError);
  assert.equal(calls, 2 + NETWORK_RETRY_LIMIT); assert.equal(budget.network_retries, NETWORK_RETRY_LIMIT); assert.equal(budget.semantic_repairs, 0);
  assert.deepEqual(budget.calls.map(call => call.kind), ['initial', 'network_retry', 'initial', ...Array(NETWORK_RETRY_LIMIT - 1).fill('network_retry')]);
  assert.deepEqual(budget.calls[1]?.usage, { total_tokens: 9 });
});
test('a terminated socket is a transport retry, not a semantic failure', async () => {
  const budget = newWorkflowInferenceBudget();
  let calls = 0;
  const wrapped = workflowBudgetProvider(provider(async (_prompt, schema, _system, options) => {
    calls++;
    if (calls === 1) throw new TypeError('terminated');
    options?.onInference?.({ model: 'test', elapsed_ms: 1, response: { ok: true } });
    return schema.parse({ ok: true });
  }), budget, async () => {}, () => 'child', () => 'initial');
  await wrapped.generateStructured('{"task":"socket"}', z.object({ ok: z.boolean() }));
  assert.equal(calls, 2);
  assert.equal(budget.network_retries, 1);
  assert.equal(budget.semantic_repairs, 0);
  assert.equal(budget.calls[1]?.kind, 'network_retry');
});

function input(failTranslate = false) {
  const doc = createEmptyScriptDocument('budget');
  doc.locations = [{ id: 'room', name: '房间', description: '' }];
  doc.scenes = [{ id: 'scene', locationId: 'room', interiorExterior: 'interior', timeOfDay: 'day', characterIds: [], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: [{ id: 'action', type: 'action', text: '房间里有一张桌子。' }] }];
  const progress: WorkflowProgress = { input_hash: 'budget', phase: 'queued', extracted: {}, plans: {}, shots: {}, metrics: [] };
  let classified = 0; const calls: any[] = [];
  const mock = provider(async (prompt, schema) => {
    const r = JSON.parse(prompt); calls.push(r);
    if (r.task === 'classify') { if (!classified++) throw new Error('classify format'); return schema.parse({ items: r.sources.map((s: any) => ({ id: s.id, kind: 'visual' })) }); }
    if (r.task === 'atomicity') return schema.parse({ result: 'one_frame' });
    if (r.task === 'plan') { if (!failTranslate) throw new Error('plan format'); return schema.parse({ primary_by_slot: Object.fromEntries(r.slots.map((s: any) => [s.id, s.fact_ids[0] || null])) }); }
    if (r.task === 'translate') throw new Error('translation format');
    throw new Error(`unexpected ${r.task}`);
  });
  return { calls, progress, workflow: { doc, scriptId: failTranslate ? 91902 : 91901, revision: 1, provider: mock, model: 'budget', locks: [], glossary: {}, instructions: '', reuse: { forceRegenerate: true }, progress, persist: async () => {} } };
}
test('CT09 old full workflow does not reset semantic allowance at a later stage or on resume', async () => {
  const f = input();
  await assert.rejects(() => runFactWorkflow(f.workflow), /plan format/);
  assert.equal(f.progress.inference_budget?.semantic_repairs, 1);
  assert.equal(f.calls.filter(r => r.task === 'classify').length, 2);
  assert.equal(f.calls.filter(r => r.task === 'plan').length, 1);
  const saved = JSON.parse(JSON.stringify(f.progress));
  saved.inference_budget.calls.push({ stage: 'old', task: 'plan', prompt_hash: 'unknown', kind: 'initial', attempt_state: 'reserved', elapsed_ms: 0 });
  await assert.rejects(() => runFactWorkflow({ ...f.workflow, progress: saved }), /plan format/);
  assert.equal(f.calls.filter(r => r.task === 'classify').length, 2);
  assert.equal(f.calls.filter(r => r.task === 'plan').length, 2);
  assert.equal(saved.inference_budget.semantic_repairs, 1);
  assert.equal(saved.inference_budget.calls.find((call: any) => call.stage === 'old').attempt_state, 'interrupted_unknown');
});
test('CT09 translation split cannot acquire another repair after source repair', async () => {
  const f = input(true);
  await assert.rejects(() => runFactWorkflow(f.workflow), /translation format/);
  assert.equal(f.calls.filter(r => r.task === 'translate').length, 1);
  assert.equal(f.progress.inference_budget?.semantic_repairs, 1);
  assert.ok(f.progress.inference_budget?.batches.some(batch => batch.stage.startsWith('translate:')));
  assert.equal(f.progress.inference_budget?.batches.filter(batch => batch.reason === 'repair_split').length, 0);
});
