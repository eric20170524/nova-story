// Opt-in local-model regression. All database writes stay in memory; no production candidates.
import '../src/test_setup';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createEmptyScriptDocument } from '../src/schemas/script';
import { auditFacts, runFactWorkflow, validateFactPayload, type WorkflowProgress } from '../src/services/storyboard_fact_workflow';
import type { AIProvider } from '../src/services/ai/base';

const endpoint = process.env.STORYBOARD_BENCHMARK_URL || 'http://127.0.0.1:11434';
const output = path.resolve(process.cwd(), process.cwd().endsWith('backend') ? '../local/verification/storyboard-workflow-regression-v3-20261009.json' : 'local/verification/storyboard-workflow-regression-v3-20261009.json');
const report: any = { started_at: new Date().toISOString(), cases: [], safety: 'Synthetic material, local inference, in-memory DB, no production timeline writes.' };
const save = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); };
const fixtures: Array<{ genre: string; location: string; actions: string[]; nextActions?: string[]; glossary: Record<string, string> }> = [
  { genre: '乡村', location: '谷仓', actions: ['木门半开且门外有三只白猫。', '两只红杯放在木门左侧。'], glossary: {} },
  { genre: '现代', location: '车站门口', actions: ['林舟用右手把蓝色信封递给陈岚。', '陈岚穿灰色外套。'], glossary: { 林舟: 'Lin Zhou', 陈岚: 'Chen Lan' } },
  { genre: '科幻', location: '无人空间站', actions: ['无人走廊里，红灯位于舱门左侧。', '舱门保持关闭，窗户半开。'], glossary: {} },
  { genre: '连续状态', location: '候车室', actions: ['青禾穿灰色外套。', '青禾握着蓝色雨伞。'], nextActions: ['青禾站在窗边。'], glossary: { 青禾: 'Qing He' } },
];
const adversarial = [
  { label: '同义门句遗漏动物', source: '木门半开且门外有三只白猫。', english: 'A half-open wooden door.' },
  { label: '原门句遗漏动物', source: '门扉半掩且门外有三只白猫。', english: 'A half-open door.' },
  { label: '无人场景新增人物', source: '阳光照亮无人站台。', english: 'Sunlight illuminates the empty platform. A woman stands there.' },
  { label: '数量', source: '三只白猫站在门外。', english: 'Two white cats stand outside the door.' },
  { label: '颜色和左右', source: '红灯位于舱门左侧。', english: 'A blue light is on the right side of the cabin door.' },
  { label: '否定', source: '灯笼没有接触门框。', english: 'The lantern touches the doorframe.' },
  { label: '换名后施受关系', source: '青禾把蓝色信封递给阿岚。', english: 'A Lan hands the blue envelope to Qing He.', glossary: { 青禾: 'Qing He', 阿岚: 'A Lan' } },
  { label: '身份', source: '陈岚穿灰色外套。', english: 'Lin Zhou wears a gray coat.', glossary: { 陈岚: 'Chen Lan', 林舟: 'Lin Zhou' } },
];

async function main() {
  const props = await (await fetch(`${endpoint}/props`, { signal: AbortSignal.timeout(5000) })).json() as any;
  const slots = await (await fetch(`${endpoint}/slots`, { signal: AbortSignal.timeout(5000) })).json() as any[];
  if (slots.some(s => s.is_processing)) throw new Error('Local model busy; benchmark not submitted');
  report.runtime = { model_path: props.model_path, slots: props.total_slots, context: props.default_generation_settings?.n_ctx }; save();
  for (const fixture of fixtures) for (const seed of [41, 97]) {
    const doc = createEmptyScriptDocument(fixture.genre);
    doc.locations = [{ id: 'location', name: fixture.location, description: '' }];
    doc.scenes = [{ id: 'current_scene', beatIds: [], eventIds: [], sourceParagraphIds: [], locationId: 'location', interiorExterior: 'interior', timeOfDay: 'day', characterIds: [], propIds: [], blocks: fixture.actions.map((text, index) => ({ id: `source_${index}`, type: 'action', text })) }];
    if (fixture.nextActions) doc.scenes.push({ ...doc.scenes[0]!, id: 'next_scene', blocks: fixture.nextActions.map((text, index) => ({ id: `next_${index}`, type: 'action', text })) });
    const row: any = { genre: fixture.genre, seed, requests: [], source: doc, start: Date.now() }; report.cases.push(row); save();
    const provider: AIProvider = {
      async generateStructured(prompt, schema, system, options) {
        const start = Date.now();
        const response = await fetch(`${endpoint}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(180000), body: JSON.stringify({
          model: 'novastory-qwen3.5:9b', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
          temperature: options?.temperature ?? 0.1, seed, max_tokens: options?.maxTokens ?? 768, reasoning_effort: 'none',
          response_format: { type: 'json_schema', json_schema: { name: 'StoryboardTask', strict: true, schema: z.toJSONSchema(schema) } },
        }) });
        const body = await response.json() as any;
        row.requests.push({ input: JSON.parse(prompt), output: body.choices?.[0]?.message?.content, finish_reason: body.choices?.[0]?.finish_reason, usage: body.usage, elapsed_ms: Date.now() - start }); save();
        if (!response.ok || body.choices?.[0]?.finish_reason !== 'stop') throw new Error(`HTTP ${response.status}, finish=${body.choices?.[0]?.finish_reason}`);
        return schema.parse(JSON.parse(body.choices[0].message.content));
      },
      async generateText() { throw new Error('Unexpected free-text call'); }, async generateImage() { throw new Error('Unexpected image call'); },
    };
    const progress: WorkflowProgress = { input_hash: 'isolated', phase: 'queued', extracted: {}, plans: {}, shots: {}, metrics: [] };
    try {
      const result = await runFactWorkflow({ doc, scriptId: 1, revision: 1, provider, model: `local-seed-${seed}`, locks: [], glossary: fixture.glossary, characters: Object.keys(fixture.glossary).map((name, index) => ({ id: index + 1, name })), instructions: '', progress, persist: async () => { row.progress = progress; save(); } });
      validateFactPayload(doc, { schemaVersion: 3, fact_contract: result.contract, scriptId: 1, scriptRevision: 1, chapterId: 'isolated', shots: result.shots, totalDuration: result.shots.reduce((n, s) => n + s.duration, 0), estimatedScriptDuration: 0, coverageReport: { coveredSceneIds: [], totalScenes: 1, coveredBlockIds: [], totalAudibleBlocks: 0, coveredMustKeepEventIds: [], totalMustKeepEvents: 0 } });
      if (fixture.nextActions) {
        const inherited = result.shots.filter(s => s.script_scene_id === 'next_scene').flatMap(s => JSON.parse(s.shot_spec).continuity_states || []);
        if (!['wardrobe', 'holding'].every(attribute => inherited.some(s => s.entity === '青禾' && s.attribute === attribute))) throw new Error('Explicit wardrobe/holding continuity not preserved');
      }
      row.result = result; row.passed = true;
    } catch (error: any) { row.passed = false; row.error = error.message; }
    row.elapsed_ms = Date.now() - row.start; save();
    console.log(JSON.stringify({ genre: row.genre, seed, passed: row.passed, requests: row.requests.length, error: row.error, elapsed_ms: row.elapsed_ms }));
  }
  report.audit_cases = [];
  for (const fixture of adversarial) for (const seed of [41, 97]) {
    const row: any = { ...fixture, seed }; report.audit_cases.push(row);
    const provider: AIProvider = { async generateStructured(prompt, schema, system, options) {
      const start = Date.now();
      const response = await fetch(`${endpoint}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(180000), body: JSON.stringify({ model: 'novastory-qwen3.5:9b', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], temperature: 0.1, seed, max_tokens: options?.maxTokens || 64, reasoning_effort: 'none', response_format: { type: 'json_schema', json_schema: { name: 'Audit', strict: true, schema: z.toJSONSchema(schema) } } }) });
      const body = await response.json() as any;
      row.input = JSON.parse(prompt); row.output = body.choices?.[0]?.message?.content; row.usage = body.usage; row.finish_reason = body.choices?.[0]?.finish_reason; row.elapsed_ms = Date.now() - start; save();
      if (!response.ok || row.finish_reason !== 'stop') throw new Error(`HTTP ${response.status}, finish=${row.finish_reason}`);
      return schema.parse(JSON.parse(row.output));
    }, async generateText() { throw new Error('Unexpected free-text call'); }, async generateImage() { throw new Error('Unexpected image call'); } };
    try { await auditFacts(provider, [{ id: 'source', text: fixture.source }], fixture.english, { glossary: fixture.glossary || {} }); row.rejected = false; }
    catch (error: any) { row.error = error.message; row.rejected = /译文待核对/.test(error.message); }
    console.log(JSON.stringify({ label: row.label, seed, rejected: row.rejected, error: row.error })); save();
  }
  report.completed_at = new Date().toISOString(); save();
  process.exitCode = report.cases.every((c: any) => c.passed) && report.audit_cases.every((c: any) => c.rejected) ? 0 : 1;
}
void main().catch(error => { report.error = error.message; save(); console.error(error.message); process.exitCode = 1; });
