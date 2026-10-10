import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../db/database';
import { createEmptyScriptDocument, type ScriptDocument } from '../schemas/script';
import { ScriptService } from './script_service';
import { StoryboardGenerationService } from './ai/storyboard_generation_service';
import type { AIProvider } from './ai/base';
import { actionBindingSource, entityRoster, needsBindingReview, textHash } from './entity_binding';
import { anchorSpans, evidencedContinuityStates, runFactWorkflow, scopedWardrobeLock, stateCheckKey, validateFactPayload, type WorkflowProgress } from './storyboard_fact_workflow';

const cast = [{ id: 1, name: '林岚' }, { id: 2, name: '陈月' }];
const glossary = { 林岚: 'Lin Lan', 陈月: 'Chen Yue' };
function document(texts: string[]): ScriptDocument {
  const doc = createEmptyScriptDocument('人物与状态核对回归');
  doc.locations = [{ id: 'room', name: '房间', description: '' }];
  doc.scenes = [{ id: 'scene', locationId: 'room', interiorExterior: 'interior', timeOfDay: 'day', characterIds: [], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: texts.map((text, i) => ({ id: `b${i}`, type: 'action', text })) }];
  return doc;
}
function confirmBinding(doc: ScriptDocument, sceneId: string, blockId: string, characters = cast) {
  const binding = actionBindingSource(doc, sceneId, blockId, entityRoster(characters)).automatic;
  for (const mention of binding.mentions.filter(m => !m.confirmed)) Object.assign(mention, { entity: entityRoster(characters)[1], authority: 'human', confirmed: true, status: 'resolved', visibility: 'visible' });
  const block = doc.scenes.find(s => s.id === sceneId)!.blocks.find(b => b.id === blockId)!;
  assert.equal(block.type, 'action');
  if (block.type === 'action') block.binding = binding;
  return binding;
}
function fixture(rejectCompiled = false) {
  const calls: any[] = [];
  const provider: AIProvider = {
    async generateStructured(prompt, schema) {
      const r = JSON.parse(prompt); calls.push(r);
      if (r.task === 'classify') return schema.parse({ items: r.sources.map((u: any) => ({ id: u.id, kind: 'visual' })) });
      if (r.task === 'atomicity') return schema.parse({ result: 'one_frame' });
      if (r.task === 'beat_relation') return schema.parse({ relation: 'sequential' });
      if (r.task === 'entity_binding') return schema.parse({ bindings: r.mentions.map((m: any) => ({ index: m.index, entity_id: 'character:2', status: 'resolved' })) });
      if (r.task === 'state') return schema.parse({ states: r.facts[0].text.includes('蓝色外套') ? [{ entity: '陈月', attribute: 'wardrobe', item: '外套', value: '蓝色外套', operation: 'set' }] : [] });
      if (r.task === 'plan') return schema.parse({ primary_by_slot: Object.fromEntries(r.slots.map((s: any) => [s.id, s.fact_ids[0] || null])) });
      if (r.task === 'translate') return schema.parse({ translations: r.facts.map((f: any) => ({ id: f.id, english: f.id === 'location' ? 'A room.' : f.id === 'interior_exterior' ? 'Indoors.' : f.id === 'time_of_day' ? 'Daytime.' : f.text.includes('蓝色外套') ? 'Chen Yue wears a blue coat.' : Object.entries(glossary).filter(([name]) => f.text.includes(name)).map(([, en]) => en).join(' and ') + ' raises a blue umbrella.' })) });
      if (r.task === 'audit') return schema.parse({ faithful: !(rejectCompiled && r.facts.some((fact: any) => String(fact.text).includes('蓝色外套'))) });
      throw new Error(`Unexpected task: ${r.task}`);
    },
    async generateText() { throw new Error('Unexpected text generation'); },
    async generateImage() { throw new Error('Unexpected image generation'); },
  };
  return { calls, provider };
}
const progress = (): WorkflowProgress => ({ input_hash: 'review', phase: 'queued', extracted: {}, plans: {}, shots: {}, metrics: [] });
function run(doc: ScriptDocument, mock: ReturnType<typeof fixture>, p = progress(), locks: any[] = []) {
  return runFactWorkflow({ doc, provider: mock.provider, progress: p, locks, scriptId: 1, revision: 1, model: 'review', characters: cast, glossary, instructions: '', persist: async () => {} });
}
async function scriptFixture(doc: ScriptDocument) {
  const project = await db.run("INSERT INTO project(title,settings) VALUES('核对回归','{}')");
  const characters = [];
  for (const c of cast) {
    const row = await db.run('INSERT INTO character(project_id,name,english_name) VALUES(?,?,?)', project.lastID, c.name, glossary[c.name as keyof typeof glossary]);
    characters.push({ id: Number(row.lastID), name: c.name });
  }
  const chapter = randomUUID();
  await db.run('INSERT INTO chapter(id,project_id,title,content,"index") VALUES(?,?,?,?,1)', chapter, project.lastID, '核对回归', '测试原文');
  const script = await ScriptService.createOrGetScript(chapter);
  return { script, doc, characters };
}

test('前文依赖变化撤销旧人物确认，未变化可复用', async t => {
  await t.test('保存撤销跨块旧确认，确认剧本拒绝继续', async () => {
    const doc = document(['林岚离开。陈月留在房间。', '她举起蓝伞。']);
    const f = await scriptFixture(doc);
    confirmBinding(doc, 'scene', 'b1', f.characters);
    await ScriptService.saveManualScript({ scriptId: f.script.id, expectedRevision: f.script.revision, document: doc });
    const confirmed = await ScriptService.confirmScript({ scriptId: f.script.id, expectedRevision: f.script.revision + 1 });
    const changed = structuredClone(confirmed.document);
    changed.scenes[0]!.blocks[0]!.text = '陈月离开。林岚留在房间。';
    const saved = await ScriptService.saveManualScript({ scriptId: f.script.id, expectedRevision: confirmed.revision, document: changed });
    const savedBlock = saved.document.scenes[0]!.blocks[1]!;
    assert.equal(savedBlock.type, 'action');
    assert.equal(needsBindingReview(savedBlock.type === 'action' ? savedBlock.binding : undefined), true);
    await assert.rejects(() => ScriptService.confirmScript({ scriptId: f.script.id, expectedRevision: saved.revision }), /人物绑定待核对/);
  });
  await t.test('同块与跨场的旧任务绑定也不能换哈希复用', async () => {
    for (const crossScene of [false, true]) {
      const doc = document(crossScene ? ['林岚离开。陈月留在房间。'] : ['林岚离开。陈月留在房间。她举起蓝伞。']);
      if (crossScene) doc.scenes.push({ ...structuredClone(doc.scenes[0]!), id: 'next', blocks: [{ id: 'after', type: 'action', text: '她举起蓝伞。' }] });
      confirmBinding(doc, crossScene ? 'next' : 'scene', crossScene ? 'after' : 'b0');
      const mock = fixture(); const p = progress();
      await run(doc, mock, p);
      assert.equal(mock.calls.filter(c => c.task === 'entity_binding').length, 0);
      const block = doc.scenes[0]!.blocks[0]!;
      block.text = block.text.replace('林岚离开。陈月留在房间。', '陈月离开。林岚留在房间。');
      await assert.rejects(() => run(doc, mock, p), /人物绑定待核对/);
      const fact = p.facts!.find(f => f.text.includes('她举起'))!;
      assert.equal(needsBindingReview(fact.binding), true);
    }
  });
});

test('人物核对和人工补状态互不混淆', async t => {
  for (const manualState of [false, true]) await t.test(manualState ? '人工补回跨块服装状态' : '人物核对保留未抽取状态', async () => {
    const doc = document(['陈月穿蓝色外套。', '她举起蓝伞。', '陈月坐下。']);
    const f = await scriptFixture(doc);
    // Simulate an existing confirmed script created before the binding gate.
    await db.run("UPDATE chapter_script SET document_json=?,status='confirmed' WHERE id=?", JSON.stringify(doc), f.script.id);
    const mock = fixture(); const p = progress();
    await assert.rejects(() => run(doc, mock, p), /人物绑定待核对/);
    assert.equal(mock.calls.filter(c => c.task === 'state').length, 0);
    const spans = structuredClone(p.facts!);
    const pronoun = spans.find(f => f.text.startsWith('她'))!;
    Object.assign(pronoun.binding!.mentions[0]!, { entity: entityRoster(f.characters)[1], confirmed: true, status: 'resolved', visibility: 'visible' });
    // Workflow uses the fixture roster while the endpoint validates real project IDs.
    for (const fact of spans) for (const mention of fact.binding?.mentions || []) {
      if (mention.entity) mention.entity = entityRoster(f.characters).find(e => e.name === mention.entity!.name)!;
    }
    if (manualState) spans[0]!.states = [{ entity: '陈月', attribute: 'wardrobe', item: '外套', value: '蓝色外套' }];
    p.request = { request_key: 'review', expected_revision: f.script.revision, instructions: '' };
    const taskId = randomUUID();
    await db.run("INSERT INTO generation_task(task_id,scene_id,kind,status,progress_json) VALUES(?,?,'storyboard','failed',?)", taskId, -f.script.id, JSON.stringify(p));
    const reviewed = await StoryboardGenerationService.reviewTaskFacts(f.script.id, taskId, { expected_input_hash: p.input_hash, spans });
    assert.equal(Boolean(reviewed.progress.state_checks[stateCheckKey(reviewed.progress.facts[2])]), false);
    const result = await runFactWorkflow({ doc, provider: mock.provider, progress: reviewed.progress, locks: [], scriptId: f.script.id, revision: f.script.revision, model: 'review', characters: f.characters, glossary, instructions: '', persist: async () => {} });
    assert.ok(mock.calls.filter(c => c.task === 'state').length >= 2);
    assert.ok(JSON.parse(result.shots.at(-1)!.shot_spec).continuity_states.some((s: any) => s.entity === '陈月' && s.value === '蓝色外套'));
  });
});

test('跨块已确认绑定证明状态归属，值和衣物仍须原句证据', async () => {
  const doc = document(['陈月留在房间。', '她穿蓝色外套。', '陈月坐下。']);
  const binding = confirmBinding(doc, 'scene', 'b1');
  const state = { entity: '陈月', attribute: 'wardrobe', item: '外套', value: '蓝色外套' };
  const span = { text: '她穿蓝色外套。', kind: 'visual' as const, beat: 1, states: [state], binding };
  assert.equal(anchorSpans('scene', 'b1', span.text, { spans: [span] })[0]!.states.length, 1);
  for (const invalid of [{ ...state, value: '红色外套' }, { ...state, value: '蓝色外套；' }, { ...state, item: '围巾' }, { ...state, entity: '林岚' }]) {
    assert.throws(() => anchorSpans('scene', 'b1', span.text, { spans: [{ ...span, states: [invalid] }] }), /原文证据/);
  }
  const unconfirmed = structuredClone(binding); unconfirmed.mentions[0]!.confirmed = false;
  assert.throws(() => anchorSpans('scene', 'b1', span.text, { spans: [{ ...span, binding: unconfirmed }] }), /原文证据/);
  assert.equal(evidencedContinuityStates('林岚穿红外套。', [{ ...state, value: '红外套' }], '', ['陈月', '林岚']).rejected.length, 1);
  const result = await run(doc, fixture());
  assert.deepEqual(result.contract.facts.find(f => f.text.startsWith('她'))!.states.map(s => s.value), ['蓝色外套']);
  assert.ok(JSON.parse(result.shots.at(-1)!.shot_spec).continuity_states.some((s: any) => s.value === '蓝色外套'));
  const stale = structuredClone(result.contract); stale.facts.find(f => f.text.startsWith('她'))!.binding!.context_hash = textHash('old context');
  // Recompute the source hash so the independent context check must reject the stale confirmation.
  const { factSourceHash } = await import('./storyboard_fact_workflow');
  stale.source_hash = factSourceHash(doc, stale.facts, stale.entities);
  assert.throws(() => validateFactPayload(doc, { fact_contract: stale } as any), /前文版本/);
  const legacy = structuredClone(result.contract); legacy.policy = 'storyboard-facts-3';
  assert.throws(() => validateFactPayload(doc, { fact_contract: legacy } as any), /旧事实契约/);
});

test('实际状态核对接口接受跨块补回状态与删除错误状态，不再重复抽取', async () => {
  for (const keepWardrobe of [true, false]) {
    const source = keepWardrobe ? '她穿蓝色外套。' : '她举起蓝伞。';
    const doc = document(['陈月留在房间。', source, '陈月坐下。']);
    const f = await scriptFixture(doc);
    confirmBinding(doc, 'scene', 'b1', f.characters);
    await db.run("UPDATE chapter_script SET document_json=?,status='confirmed' WHERE id=?", JSON.stringify(doc), f.script.id);
    const mock = fixture(); let sourceCalls = 0;
    const provider: AIProvider = { ...mock.provider, async generateStructured(prompt, schema, system, options) {
      const request = JSON.parse(prompt);
      if (request.task === 'state' && request.facts[0].text === source) {
        sourceCalls++;
        return schema.parse({ states: [{ entity: '陈月', attribute: keepWardrobe ? 'wardrobe' : 'holding', value: keepWardrobe ? '红色外套' : '红杯', item: keepWardrobe ? '外套' : '杯' }] });
      }
      return mock.provider.generateStructured(prompt, schema, system, options);
    } };
    const p = progress();
    const workflowInput = { doc, provider, progress: p, locks: [], scriptId: f.script.id, revision: f.script.revision, model: 'review', characters: f.characters, glossary, instructions: '', persist: async () => {} };
    await assert.rejects(() => runFactWorkflow(workflowInput), /连续状态归属待核对/);
    const failedFact = p.facts!.find(fact => fact.text === source)!;
    assert.ok(p.state_review_pending?.includes(failedFact.id));
    p.request = { request_key: 'state-review', expected_revision: f.script.revision, instructions: '' };
    const taskId = randomUUID();
    await db.run("INSERT INTO generation_task(task_id,scene_id,kind,status,progress_json) VALUES(?,?,'storyboard','failed',?)", taskId, -f.script.id, JSON.stringify(p));
    const spans = structuredClone(p.facts!);
    spans.find(fact => fact.id === failedFact.id)!.states = keepWardrobe ? [{ entity: '陈月', attribute: 'wardrobe', item: '外套', value: '蓝色外套' }] : [];
    const reviewed = await StoryboardGenerationService.reviewTaskFacts(f.script.id, taskId, { expected_input_hash: p.input_hash, spans });
    const before = sourceCalls;
    const result = await runFactWorkflow({ ...workflowInput, progress: reviewed.progress });
    assert.equal(sourceCalls, before);
    const states = result.contract.facts.find(fact => fact.id === failedFact.id)!.states;
    assert.deepEqual(states.map(state => state.value), keepWardrobe ? ['蓝色外套'] : []);
    if (keepWardrobe) assert.ok(JSON.parse(result.shots.at(-1)!.shot_spec).continuity_states.some((state: any) => state.value === '蓝色外套'));
  }
});

test('服装变化留在镜头事实，外观锁原文保留，最终提示词通过后才缓存', async () => {
  const doc = document(['陈月穿蓝色外套。']);
  const mock = fixture();
  const result = await run(doc, mock, progress(), [{ name: '陈月', lock: 'red coat, white scarf, black hair' }]);
  assert.equal(result.shots[0]!.visual_prompt, '');
  const spec = JSON.parse(result.shots[0]!.shot_spec);
  assert.match(spec.primary_action, /蓝色外套/);
  const coatAudit = mock.calls.find(c => c.task === 'audit' && c.facts.some((fact: any) => String(fact.text).includes('蓝色外套')));
  assert.ok(coatAudit);
  assert.match(coatAudit.english, /blue coat/);
  assert.equal(coatAudit.facts.length, 1);
  assert.equal(scopedWardrobeLock('陈月', 'red coat, white scarf, black hair', result.contract.facts), 'red coat, white scarf, black hair');
  assert.equal(scopedWardrobeLock('林岚', 'red coat, black hair', result.contract.facts), 'red coat, black hair');
  const failed = progress();
  const before = (await db.get("SELECT COUNT(*) AS n FROM generation_task WHERE kind='storyboard_audit'")).n;
  await assert.rejects(() => run(doc, fixture(true), failed), /译文待核对/);
  assert.deepEqual(failed.shots, {});
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM generation_task WHERE kind='storyboard_audit'")).n, before);
});
