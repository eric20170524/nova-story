import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AIProvider } from './ai/base';
import { CONTINUITY_EVAL_FIXTURES } from '../test_fixtures/continuity_eval';
import { continuityEvaluationTask } from '../test_fixtures/continuity_eval_task';
import { extractContinuitySuggestions } from './continuity_suggestions';
import { confirmContinuityChange } from './continuity_confirmation';

test('CT10–CT12 all 36 frozen category inputs preserve physical identities, exact evidence, no-change and human confirmation boundary', async t => {
  for (const fixture of CONTINUITY_EVAL_FIXTURES) for (const sourceCase of fixture.cases) await t.test(`${fixture.id}/${sourceCase.id}`, async () => {
    let seen: any;
    const provider: AIProvider = { async generateStructured(prompt, schema) {
      seen = JSON.parse(prompt);
      return schema.parse({ changes: sourceCase.expected.map(expected => ({ ...expected, ...(expected.operation === 'transfer' ? { completion: 'completed' } : {}), source_id: seen.sources[0].source_id, quote: seen.sources[0].text })), pending: sourceCase.pending ? [{ code: 'ambiguous_entity', entity_ids: ['lin', 'chen'], source_id: seen.sources[0].source_id, quote: seen.sources[0].text }] : [] });
    }, async generateText() { throw new Error('unexpected'); }, async generateImage() { throw new Error('unexpected'); } };
    const task = continuityEvaluationTask(fixture, sourceCase, provider, 41);
    const before = JSON.stringify(task.prior_state);
    const result = await extractContinuitySuggestions(task);
    assert.equal(JSON.stringify(task.prior_state), before);
    assert.equal(result.proposals.length, sourceCase.expected.length);
    assert.equal(result.automatic_accepted, 0);
    assert.equal(result.budget.calls.length, 1);
    assert.equal(seen.expected, undefined); assert.equal(seen.optional, undefined);
    for (const [index, proposal] of result.proposals.entries()) {
      assert.equal(proposal.entity_id, sourceCase.expected[index]!.entity_id);
      assert.equal(proposal.attribute_id, sourceCase.expected[index]!.attribute_id);
      assert.equal(proposal.value, sourceCase.expected[index]!.value);
      assert.equal(confirmContinuityChange(proposal, task.context).status, 'pending_review');
    }
    if (sourceCase.pending) assert.deepEqual(result.pending[0].entity_ids, ['lin', 'chen']);
  });
});
test('CT11 incomplete handover and unsupported joint holder retain all raw evidence without accepting ownership or damage changes', async () => {
  const fixture = CONTINUITY_EVAL_FIXTURES.find(f => f.id === 'E05')!;
  const sourceCase = fixture.cases[1]!;
  const provider: AIProvider = { async generateStructured(prompt, schema) {
    const input = JSON.parse(prompt);
    return schema.parse({ changes: [{ entity_id: 'u1', attribute_id: 'holder', operation: 'transfer', value: 'chen', from: 'lin', completion: 'offered', source_id: input.sources[0].source_id, quote: input.sources[0].text }, { entity_id: 'u1', attribute_id: 'holder', operation: 'assign', value: ['lin', 'chen'], source_id: input.sources[0].source_id, quote: input.sources[0].text }], pending: [] });
  }, async generateText() { throw new Error('unexpected'); }, async generateImage() { throw new Error('unexpected'); } };
  const result = await extractContinuitySuggestions(continuityEvaluationTask(fixture, sourceCase, provider, 41));
  assert.equal(result.proposals.length, 0); assert.equal(result.pending.length, 2);
  assert.equal(result.pending[0].raw.completion, 'offered'); assert.deepEqual(result.pending[1].raw.value, ['lin', 'chen']);
  assert.ok(result.pending.every(item => item.evidence[0].evidence_quote === sourceCase.source));
});
