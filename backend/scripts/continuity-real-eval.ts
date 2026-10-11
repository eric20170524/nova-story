import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { OpenAIProvider } from '../src/services/ai/openai_provider';
import { extractContinuitySuggestions, LogicalContinuityBudget, CONTINUITY_SUGGESTION_BUDGET, continuitySuggestionPolicyFingerprint } from '../src/services/continuity_suggestions';
import { CONTINUITY_EVAL_FIXTURES, CONTINUITY_EVAL_SEEDS } from '../src/test_fixtures/continuity_eval';
import { continuityEvaluationTask } from '../src/test_fixtures/continuity_eval_task';

async function main() {
  const output = path.resolve(__dirname, '../../local/verification/continuity-ct14', continuitySuggestionPolicyFingerprint.slice(0, 16));
  await fs.mkdir(output, { recursive: true });
  const labels = await fs.readFile(path.resolve(__dirname, '../src/test_fixtures/continuity/eval-labels-v1.json'));
  const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '../src/test_fixtures/continuity/eval-manifest-v1.json'), 'utf8'));
  const labels_sha256 = createHash('sha256').update(labels).digest('hex');
  if (labels_sha256 !== manifest.labels_sha256) throw new Error('Frozen labels changed');
  const model = 'novastory-qwen3.5:9b', base_url = 'http://127.0.0.1:11434/v1';
  const models = await (await fetch(`${base_url}/models`, { signal: AbortSignal.timeout(10000) })).json() as any;
  if (!models.data?.some((row: any) => row.id === model)) throw new Error('The configured real 9B model is unavailable');
  const provider = new OpenAIProvider('ollama', model, base_url, { isOllama: true, timeoutMs: 90000 });
  const weightsPath = 'D:/ProgramData/NovaStory/models/Huihui-Qwen3.5-9B-abliterated.Q4_K_M.gguf';
  const weightsHash = createHash('sha256'); for await (const chunk of createReadStream(weightsPath)) weightsHash.update(chunk);
  const weights_sha256 = weightsHash.digest('hex');
  const model_fingerprint = createHash('sha256').update(JSON.stringify([model, models.data.map((row: any) => ({ id: row.id, meta: row.meta, owned_by: row.owned_by })), weights_sha256])).digest('hex');
  const metadata = { run_kind: 'real_local_model', policy_fingerprint: continuitySuggestionPolicyFingerprint, labels_sha256, model, models, base_url, weights: 'Huihui-Qwen3.5-9B-abliterated.Q4_K_M.gguf', weights_sha256, model_fingerprint, quantization: 'Q4_K_M', context_capacity: 16384, temperature: 0.1, budgets: CONTINUITY_SUGGESTION_BUDGET, started_at: new Date().toISOString(), automatic_acceptance_enabled: false };
  await fs.writeFile(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
  const results: any[] = [];
  const subset = process.argv.includes('--critical');
  const selected = subset ? CONTINUITY_EVAL_FIXTURES.filter(f => ['E02', 'E05', 'E09', 'E12'].includes(f.id)) : CONTINUITY_EVAL_FIXTURES;
  const adjudicate = (result: any, sourceCase: typeof CONTINUITY_EVAL_FIXTURES[number]['cases'][number]) => {
    const project = (change: any) => ({ entity_id: change.entity_id, attribute_id: change.attribute_id, operation: change.operation, value: change.value, ...(change.operation === 'transfer' ? { from: change.precondition?.value } : {}) });
    const normalized = result.proposals.map(project);
    const same = (a: any, b: any) => ['entity_id', 'attribute_id', 'operation', 'value', 'from'].every(key => a[key] === b[key]);
    const missing = sourceCase.expected.filter(expected => !normalized.some((actual: any) => same(actual, expected)));
    const unexpected = normalized.filter((actual: any) => ![...sourceCase.expected, ...(sourceCase.optional || [])].some(expected => same(actual, expected)));
    const unexpectedPending = result.pending.filter((pending: any) => !(sourceCase.pending && pending.code === 'ambiguous_entity'));
    const acceptable = result.raw.length > 0 && !missing.length && !unexpected.length && !unexpectedPending.length && (!sourceCase.pending || result.pending.some((pending: any) => pending.code === 'ambiguous_entity'));
    return { normalized, adjudication: { version: 2, method: 'comparison_to_pre_frozen_human_labels', missing, unexpected, unexpected_pending: unexpectedPending, acceptable, false_block: !sourceCase.pending && unexpectedPending.length > 0, expected_changes: sourceCase.expected.length, human_confirmations: 0 } };
  };
  for (const fixture of selected) for (const sourceCase of fixture.cases) for (const seed of subset ? [41] : CONTINUITY_EVAL_SEEDS) {
    const id = `${fixture.id}-${sourceCase.id}-${seed}`, filename = path.join(output, `${id}.json`);
    let existing: any;
    try { existing = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { /* First run. */ }
    if (existing?.labels_sha256 === labels_sha256 && existing?.model_fingerprint === model_fingerprint && existing?.completed) { existing = { ...existing, ...adjudicate(existing.result, sourceCase) }; await fs.writeFile(filename, JSON.stringify(existing, null, 2)); results.push(existing); continue; }
    const task = continuityEvaluationTask(fixture, sourceCase, provider, seed);
    task.model_fingerprint = model_fingerprint;
    const checkpoint_hash = createHash('sha256').update(JSON.stringify([fixture.entities, fixture.prior, sourceCase.source, sourceCase.prior_context || '', seed, model_fingerprint, continuitySuggestionPolicyFingerprint])).digest('hex');
    const checkpointPath = path.join(output, `${id}.checkpoint.json`);
    let previous: any; try { previous = JSON.parse(await fs.readFile(checkpointPath, 'utf8')); } catch { /* First attempt. */ }
    if (previous?.checkpoint_hash === checkpoint_hash) {
      task.budget = Object.assign(new LogicalContinuityBudget(), previous.budget);
      for (const call of task.budget!.calls) if (call.attempt_state === 'reserved') call.attempt_state = 'interrupted_unknown';
      task.reuse = previous.reuse;
    }
    task.checkpoint = async state => { await fs.writeFile(checkpointPath, JSON.stringify({ checkpoint_hash, ...state }, null, 2)); };
    const result = await extractContinuitySuggestions(task);
    const record = { id, labels_sha256, model, model_fingerprint, completed: true, source: sourceCase.source, preceding_context: sourceCase.prior_context || '', seed, result, ...adjudicate(result, sourceCase), recorded_at: new Date().toISOString() };
    await fs.writeFile(filename, JSON.stringify(record, null, 2)); results.push(record);
    process.stdout.write(`${id}: ${record.adjudication.acceptable ? 'acceptable' : 'review'}; calls=${result.budget.calls.length}; ms=${result.elapsed_ms}\n`);
  }
  const grouped = selected.map(fixture => {
    const rows = results.filter(row => row.id.startsWith(`${fixture.id}-`));
    const required = fixture.cases.reduce((n, row) => n + row.expected.length, 0) * (subset ? 1 : 2);
    const missing = rows.reduce((n, row) => n + row.adjudication.missing.length, 0);
    return { category: fixture.id, logical_tasks: rows.length, acceptable: rows.filter(row => row.adjudication.acceptable).length, required_changes: required, recovered_changes: required - missing, recall: required ? (required - missing) / required : null, unexpected_changes: rows.reduce((n, row) => n + row.adjudication.unexpected.length, 0), false_blocks: rows.filter(row => row.adjudication.false_block).length, pending_tasks: rows.filter(row => row.result.status === 'pending_review').length, actual_inference_calls: rows.reduce((n, row) => n + row.result.budget.calls.length, 0), supported_as_suggestion: rows.some(row => !row.id.includes('-negative-') && row.adjudication.acceptable) };
  });
  await fs.writeFile(path.join(output, subset ? 'critical-summary.json' : 'summary.json'), JSON.stringify({ ...metadata, finished_at: new Date().toISOString(), logical_tasks: results.length, actual_inference_calls: results.reduce((n, row) => n + row.result.budget.calls.length, 0), automatic_accepted: 0, automatic_error_rate: null, human_confirmation_rate: null, grouped }, null, 2));
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
