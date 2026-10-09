// Opt-in real local-model check. Synthetic text only; no database or timeline writes.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AIProvider } from '../src/services/ai/base';
import { bindEntities, boundVisibleEntities, entityRoster, needsBindingReview, proposeBindings } from '../src/services/entity_binding';

const endpoint = (process.env.STORYBOARD_BENCHMARK_URL || 'http://127.0.0.1:11434').replace(/\/$/u, '');
const output = path.resolve(__dirname, '../../local/verification/pronoun-binding-regression-20261009.json');
const roster = entityRoster([{ id: 1, name: '林岚' }, { id: 2, name: '陈月' }]);
const report: any = { started_at: new Date().toISOString(), endpoint, status: 'starting', cases: [], safety: 'Synthetic references only; no DB writes; model proposals never confirmed.' };
const save = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); };
const fixtures = [
  { label: '林岚离场', context: '林岚和陈月站在房间里。林岚离开，陈月留在房间。', text: '她举起蓝伞。', expected: 'character:2' },
  { label: '陈月离场', context: '林岚和陈月站在房间里。陈月离开，林岚留在房间。', text: '她举起蓝伞。', expected: 'character:1' },
  { label: '真正歧义', context: '林岚看着陈月。', text: '她笑了。', expected: null },
];

async function main() {
  save();
  const propsResponse = await fetch(`${endpoint}/props`, { signal: AbortSignal.timeout(5000) });
  if (!propsResponse.ok) throw new Error(`props HTTP ${propsResponse.status}`);
  const props = await propsResponse.json() as any;
  const slots = await (await fetch(`${endpoint}/slots`, { signal: AbortSignal.timeout(5000) })).json() as any[];
  if (!/9b/iu.test(props.model_path || '')) throw new Error('当前本地模型不是要求验收的 9B，未提交测试');
  if (slots.some(s => s.is_processing)) throw new Error('本地模型忙，未提交测试');
  report.runtime = { model_path: props.model_path, slots: props.total_slots, context: props.default_generation_settings?.n_ctx };
  report.status = 'running'; save();
  for (const seed of [41, 97]) for (const fixture of fixtures) {
    const row: any = { ...fixture, seed, requests: [] }; report.cases.push(row); save();
    const provider: AIProvider = {
      async generateText() { throw new Error('Unexpected text task'); }, async generateImage() { throw new Error('Unexpected image task'); },
      async generateStructured(prompt, schema, system, options) {
        const start = Date.now();
        const response = await fetch(`${endpoint}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(180000), body: JSON.stringify({
          model: 'novastory-qwen3.5:9b', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], temperature: options?.temperature ?? 0.1, seed,
          max_tokens: options?.maxTokens ?? 256, reasoning_effort: 'none', response_format: { type: 'json_schema', json_schema: { name: 'EntityBinding', strict: true, schema: z.toJSONSchema(schema) } },
        }) });
        const body = await response.json() as any;
        row.requests.push({ input: JSON.parse(prompt), system, output: body.choices?.[0]?.message?.content, usage: body.usage, finish_reason: body.choices?.[0]?.finish_reason, elapsed_ms: Date.now() - start }); save();
        if (!response.ok || body.choices?.[0]?.finish_reason !== 'stop') throw new Error(`HTTP ${response.status}, finish=${body.choices?.[0]?.finish_reason}`);
        const parsed = JSON.parse(body.choices[0].message.content);
        row.raw_status_id_consistent = parsed.bindings.every((binding: any) => binding.status === 'resolved' ? binding.entity_id !== null : binding.entity_id === null);
        return schema.parse(parsed);
      },
    };
    try {
      const proposed = await proposeBindings(provider, bindEntities(fixture.text, roster), fixture.text, fixture.context, roster, { location: '房间', interior_exterior: 'interior', time_of_day: 'day' });
      row.binding = proposed;
      const mention = proposed.mentions[0]!;
      row.passed = (fixture.expected ? mention.status === 'resolved' && mention.entity?.id === fixture.expected : mention.status === 'ambiguous' && mention.entity === null)
        && needsBindingReview(proposed) && boundVisibleEntities(proposed).length === 0 && !mention.confirmed;
    } catch (error: any) { row.passed = false; row.error = error.message; }
    save();
  }
  report.single_subject = ['林岚解开外衣。她把里衣褪到腰间。', '林岚解开外衣。里衣褪到腰间。'].map(text => ({ text, binding: bindEntities(text, roster), passed: !needsBindingReview(bindEntities(text, roster)) }));
  report.status = [...report.cases, ...report.single_subject].every((row: any) => row.passed) ? 'passed' : 'failed';
  report.completed_at = new Date().toISOString(); save(); process.exitCode = report.status === 'passed' ? 0 : 1;
}
void main().catch(error => { report.status = report.cases.length ? 'failed' : 'blocked'; report.error = error.message; report.error_code = error.cause?.code; report.completed_at = new Date().toISOString(); save(); console.error(JSON.stringify({ status: report.status, error: report.error, code: report.error_code })); process.exitCode = 1; });
