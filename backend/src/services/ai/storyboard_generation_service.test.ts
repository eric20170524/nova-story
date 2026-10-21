import '../../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/database';
import { ScriptService } from '../script_service';
import { StoryboardGenerationService } from './storyboard_generation_service';
import { createEmptyScriptDocument, StoryboardCandidatePayloadSchema, type ScriptDocument } from '../../schemas/script';
import { SettingsManager } from '../../core/settings_manager';
import { LLMService } from '../llm';
import type { AIProvider } from './base';
import { CHAPTER_SHOT_LIMIT, anchorSpans, allocateBudgets, assignFactSlots, auditFacts, continuityEvidenceRepair, directionPlace, directionPlaceProblem, directionPlaceSettled, evidencedContinuityStates, groupAdjacentClauseFragments, groupShotCounts, hash, promptContainsTranslation, verbatimActionSplit, validatePlan, validateFactSources, continuityAfter, serialWorkflow, stabilizeFactBeats, visualPlanGroups, runFactWorkflow, type WorkflowProgress } from '../storyboard_fact_workflow';
import { compileNegativePrompt } from '../negative_prompt_compiler';
import { sanitizeVisualPrompt } from '../visual_prompt_sanitizer';

function document(sceneCount = 1, actions = 1): ScriptDocument {
  const doc = createEmptyScriptDocument('可追溯分镜');
  doc.locations = [{ id: 'harbor', name: '无人港口', description: '' }];
  doc.scenes = Array.from({ length: sceneCount }, (_, s) => ({
    id: `harbor_${s}`, beatIds: [], eventIds: [], sourceParagraphIds: [], locationId: 'harbor', interiorExterior: 'exterior', timeOfDay: 'day', characterIds: [], propIds: [],
    blocks: [{ id: `action_${s}`, type: 'action' as const, text: Array.from({ length: actions }, (_, a) => `第${s + 1}场的第${a + 1}盏红灯亮起。`).join('') },
      { id: `voice_${s}`, type: 'voiceover' as const, characterId: null, text: '灯亮了。' }, { id: `sound_${s}`, type: 'sound' as const, text: '钟声' }],
  }));
  return doc;
}
function providerFixture() {
  const calls: any[] = []; let fail = ''; let reject = false;
  const provider: AIProvider = {
    async generateStructured(prompt, schema) {
      const r = JSON.parse(prompt); calls.push(r);
      if (r.task === 'classify') return schema.parse({ items: r.sources.map((u: any) => ({ id: u.id, kind: 'visual' })) });
      if (r.task === 'state') return schema.parse({ states: [] });
      if (r.task === 'present') return schema.parse({ names: (r.known || []).filter((name: string) => (r.facts || []).some((fact: any) => String(fact.text).includes(name))) });
      if (r.task === 'lock_fit') return schema.parse({ drop: [] });
      if (r.task === 'repair_fact') return schema.parse({ spans: [{ text: r.text, kind: 'visual' }] });
      if (r.task === 'repair_kind') return schema.parse({ kind: 'visual' });
      if (r.task === 'beat_relation') return schema.parse({ relation: 'sequential' });
      if (r.task === 'atomicity') return schema.parse({ result: 'one_frame' });
      if (r.task === 'split_actions') return schema.parse({ spans: [{ text: r.source }] });
      if (r.task === 'plan') {
        return schema.parse({ primary_by_slot: Object.fromEntries(r.slots.map((slot: any) => [slot.id, slot.fact_ids[0] || null])) });
      }
      if (r.task === 'translate') {
        if (fail && r.facts.some((f: any) => f.text.includes(fail))) throw new Error('temporary translation failure');
        return schema.parse({ translations: r.facts.map((f: any) => ({ id: f.id, english: f.id === 'location' ? 'An empty harbor.' : `${Object.entries(r.glossary || {}).filter(([name]) => f.text.includes(name)).map(([, english]) => english).join(' ')} A red lamp shines. Source ${f.id}.` })) });
      }
      if (r.task === 'audit') return schema.parse({ faithful: !reject });
      throw new Error(`Unexpected task ${r.task}`);
    },
    async generateText() { throw new Error('Unexpected free text generation'); }, async generateImage() { throw new Error('Unexpected image generation'); },
  };
  return { provider, calls, failScene: (s: string) => { fail = s; }, reject: (value: boolean) => { reject = value; } };
}
async function confirmed(doc: ScriptDocument, characters: string[] = []) {
  await db.exec('DELETE FROM generation_task; DELETE FROM coverage_shot; DELETE FROM coverage_group; DELETE FROM scene_version; DELETE FROM scene; DELETE FROM script_change; DELETE FROM chapter_script; DELETE FROM chapter; DELETE FROM character; DELETE FROM project;');
  const project = await db.run("INSERT INTO project(title, settings) VALUES('通用验收','{}')");
  const chapterId = `chapter_${randomUUID()}`;
  await db.run('INSERT INTO chapter(id,project_id,title,content,"index") VALUES(?,?,?,?,1)', chapterId, project.lastID, '验收章', '独立来源文本');
  for (const name of characters) await db.run('INSERT INTO character(project_id,name,english_name) VALUES(?,?,?)', project.lastID, name, ({ 青禾: 'Qing He', 林岚: 'Lin Lan', 陈月: 'Chen Yue', 阿岚: 'A Lan', 裴雨涵: 'Pei Yuhan', 陆嘉静: 'Lu Jiajing' } as Record<string, string>)[name]!);
  const draft = await ScriptService.createOrGetScript(chapterId);
  await ScriptService.saveManualScript({ scriptId: draft.id, expectedRevision: draft.revision, document: doc });
  const script = await ScriptService.confirmScript({ scriptId: draft.id, expectedRevision: draft.revision + 1 });
  return { script, chapterId, params: { scriptId: script.id, expectedRevision: script.revision, requestKey: 'workflow' } };
}

test('来源与预算不依赖场号、作品词典和同义措辞', async t => {
  await t.test('单块四动作分为四节拍；块引用不能伪装完整事实覆盖', () => {
    const doc = document(1, 4); const scene = doc.scenes[0]!; const block = scene.blocks[0]!;
    const facts = anchorSpans(scene.id, block.id, block.text, { spans: block.text.match(/[^。]+。/gu)!.map((text, beat) => ({ text, beat, kind: 'visual', states: [] })) });
    validateFactSources(doc, facts); assert.equal(allocateBudgets(doc, facts)[0]!.minimum, 4);
    validatePlan(facts, facts.map(f => ({ fact_ids: [f.id], primary_fact_id: f.id })), 4);
    assert.throws(() => validatePlan(facts, [{ fact_ids: facts.map(f => f.id), primary_fact_id: facts[0]!.id }], 1), /独立叙事节拍/);
    assert.throws(() => validatePlan(facts, [{ fact_ids: [facts[0]!.id], primary_fact_id: facts[0]!.id }], 1), /遗漏视觉事实/);
    assert.throws(() => validateFactSources(doc, [{ ...facts[0]!, start: 1 }, ...facts.slice(1)]), /偏移/);
    assert.throws(() => validateFactSources(doc, [...facts, ...facts]), /ID 重复/);
  });
  await t.test('同一节拍的互斥状态占用后续空镜，不能并进同一镜头', () => {
    const fact = (id: string, beat: number, value?: string): ReturnType<typeof anchorSpans>[number] => ({
      id, scene_id: 'sc', block_id: 'b', start: 0, end: 1, text: id, kind: 'visual', beat,
      states: value ? [{ entity: '裴雨涵', attribute: 'holding', item: '手中物', value }] : [],
    });
    const collar = fact('collar', 0, '衣领');
    const pull = fact('pull', 0);
    const arm = fact('arm', 0, '臂膀');
    const slots = assignFactSlots([collar, pull, arm], 2);
    assert.deepEqual(slots.map(group => group.map(item => item.id)), [['collar', 'pull'], ['arm']]);
    validatePlan([collar, pull, arm], slots.map(group => ({ fact_ids: group.map(item => item.id), primary_fact_id: group[0]?.id || null })), 2);
    const open = fact('open', 0, '门');
    const stay = fact('stay', 0, '门');
    assert.deepEqual(assignFactSlots([open, stay], 2).map(group => group.map(item => item.id)), [['open', 'stay'], []]);
    const next = fact('next', 1, '窗');
    assert.deepEqual(assignFactSlots([open, next], 2).map(group => group.map(item => item.id)), [['open'], ['next']]);
    assert.throws(() => assignFactSlots([collar, arm], 1), /同镜互斥状态需要 2 镜/);
    const doc = document(1, 1);
    const sceneId = doc.scenes[0]!.id;
    const row = (id: string, beat: number, value?: string) => ({
      id, scene_id: sceneId, block_id: 'b', start: 0, end: 1, text: '短句。', kind: 'visual' as const, beat,
      states: value ? [{ entity: '裴雨涵', attribute: 'expression', value }] : [],
    });
    const chapter = [row('a', 0, '笑'), row('b', 0, '挑衅而诱惑的笑容'), row('c', 1), row('d', 2), row('e', 3), row('f', 4)];
    const budget = allocateBudgets(doc, chapter, 26);
    assert.equal(budget[0]!.minimum, 6);
    assert.deepEqual(groupShotCounts(visualPlanGroups(chapter), budget[0]!.minimum), [5, 1]);
    assert.throws(() => allocateBudgets(doc, chapter, 5), /最少需要 6 镜/);
    const candidateShot = { index: 1, script_scene_id: 's', shot_spec: '{}' };
    const candidateBase = { schemaVersion: 3 as const, scriptId: 1, scriptRevision: 1, chapterId: 'c', coverageReport: { coveredSceneIds: [], totalScenes: 1, coveredBlockIds: [], totalAudibleBlocks: 0, coveredMustKeepEventIds: [], totalMustKeepEvents: 0 } };
    assert.equal(StoryboardCandidatePayloadSchema.safeParse({ ...candidateBase, shots: Array.from({ length: CHAPTER_SHOT_LIMIT }, (_, index) => ({ ...candidateShot, index: index + 1 })) }).success, true);
    assert.equal(StoryboardCandidatePayloadSchema.safeParse({ ...candidateBase, shots: Array.from({ length: CHAPTER_SHOT_LIMIT + 1 }, (_, index) => ({ ...candidateShot, index: index + 1 })) }).success, false);
    assert.equal(directionPlace('朝清暮宫的方向走来，'), '清暮宫');
    assert.equal(directionPlace('朝玉楼方向笑了，'), null);
    assert.match(directionPlaceProblem('朝清暮宫的方向走来，', 'Walk towards the direction of Mu Gong,') || '', /整词保留/);
    assert.match(directionPlaceProblem('朝清暮宫的方向走来，', 'Zhao Qing walks toward the direction of the evening palace.') || '', /新人名/);
    assert.equal(directionPlaceProblem('朝清暮宫的方向走来，', 'walking toward the direction of Qingmu Palace,'), null);
    assert.equal(directionPlaceSettled('朝清暮宫的方向走来，', 'Walk towards the direction of Qingmu Palace.'), true);
    assert.equal(directionPlaceSettled('朝清暮宫的方向走来，', 'Walk towards the direction of Qingmu Palace and draws a sword.'), false);
  });
  await t.test('完整的朝向地名不再交给模型否定', async () => {
    let called = 0;
    const provider = {
      async generateStructured() { called += 1; return { faithful: false }; },
      async generateText() { throw new Error('no text'); },
      async generateImage() { throw new Error('no image'); },
    };
    await auditFacts(provider, [{ id: 'f', text: '朝清暮宫的方向走来，' }], 'Walk towards the direction of Qingmu Palace.');
    assert.equal(called, 0);
  });
  await t.test('完整分区、重复片段偏移、非视觉分类与状态证据', () => {
    assert.throws(() => anchorSpans('s', 'b', '门半开且三只白猫站在门外', { spans: [{ text: '门半开', kind: 'visual', beat: 0, states: [] }] }), /尾部遗漏/);
    const repeated = anchorSpans('s', 'b', '红灯。红灯。', { spans: [{ text: '红灯。', kind: 'visual', beat: 0, states: [] }, { text: '红灯。', kind: 'visual', beat: 1, states: [] }] });
    assert.deepEqual(repeated.map(f => f.start), [0, 3]);
    const facts = anchorSpans('s', 'b', '三只猫站在门外；钟声；她心想回家', { spans: [
      { text: '三只猫站在门外', kind: 'visual', beat: 0, states: [] }, { text: '钟声', kind: 'audio', beat: 0, states: [] }, { text: '她心想回家', kind: 'internal', beat: 0, states: [] },
    ] });
    assert.deepEqual(facts.map(f => f.kind), ['visual', 'audio', 'internal']);
    const span = { text: '阿岚持红杯', kind: 'visual' as const, beat: 0, states: [{ entity: '阿岚', attribute: '持物', value: '红杯' }] };
    const stateFacts = anchorSpans('s', 'b', span.text, { spans: [span] });
    assert.equal(continuityAfter([], stateFacts).length, 0);
    const held = { ...stateFacts[0]!, states: [{ entity: '阿岚', attribute: 'holding', value: '红杯' }] };
    assert.equal(continuityAfter([], [held])[0]!.fact_id, held.id);
    span.states[0]!.value = '蓝杯'; assert.throws(() => anchorSpans('s', 'b', span.text, { spans: [span] }), /缺少原文证据/);
    const text = '裴雨涵在陆嘉静身下微微战栗，';
    const split = evidencedContinuityStates(text, [
      { entity: '裴雨涵', attribute: 'position', value: '陆嘉静身下' },
      { entity: '裴雨涵', attribute: 'holding', value: '无' },
    ]);
    assert.deepEqual(split.accepted.map(state => state.value), ['陆嘉静身下']);
    assert.match(continuityEvidenceRepair(text, split.rejected), /无/);
    assert.match(continuityEvidenceRepair(text, split.rejected), /裴雨涵在陆嘉静身下微微战栗/);
    const block = '青禾解开外衣。里衣褪到腰间。';
    const lowered = [{ entity: '青禾', attribute: 'wardrobe', value: '里衣褪到腰间' }];
    assert.throws(() => anchorSpans('s', 'b', block, { spans: [
      { text: '青禾解开外衣。', kind: 'visual', beat: 0, states: [{ entity: '青禾', attribute: 'wardrobe', value: '解开外衣' }] },
      { text: '里衣褪到腰间。', kind: 'visual', beat: 1, states: lowered },
    ] }), /原文证据/);
    assert.equal(evidencedContinuityStates('里衣褪到腰间。', lowered, '青禾解开外衣。').accepted.length, 0);
    assert.equal(evidencedContinuityStates('里衣褪到腰间。', lowered, '青禾解开外衣。', ['青禾']).accepted.length, 1);
    assert.equal(evidencedContinuityStates('她把里衣褪到腰间。', lowered).rejected.length, 1);
    assert.throws(() => anchorSpans('s', 'b', block, { spans: [{ text: '青禾解开外衣。', kind: 'visual', beat: 0, states: [{ entity: '后文的人', attribute: 'wardrobe', value: '解开外衣' }] }] }), /原文证据/);
  });
  await t.test('容错门禁：支持首部过渡词/标点容差与段间连接词容差，无需一字不差硬性强求', () => {
    // 1. 首部过渡词/叙述助词（如“只见”）不抛出 b@0 错误
    const leadingFiller = '只见裴语涵赤足走来。';
    const f1 = anchorSpans('s', 'b', leadingFiller, { spans: [{ text: '裴语涵赤足走来。', kind: 'visual', beat: 0, states: [] }] });
    assert.equal(f1.length, 1);
    assert.equal(f1[0]!.text, '裴语涵赤足走来。');

    // 2. 标点和引号微调容差
    const punctTolerant = '“裴语涵赤足走来。”';
    const f2 = anchorSpans('s', 'b', punctTolerant, { spans: [{ text: '裴语涵赤足走来。', kind: 'visual', beat: 0, states: [] }] });
    assert.equal(f2.length, 1);

    // 3. 段间过渡词容差（如“，只见她”）
    const middleFiller = '裴语涵走来，只见她举起红杯。';
    const f3 = anchorSpans('s', 'b', middleFiller, { spans: [
      { text: '裴语涵走来', kind: 'visual', beat: 0, states: [] },
      { text: '她举起红杯。', kind: 'visual', beat: 1, states: [] },
    ] });
    assert.equal(f3.length, 2);
    assert.equal(f3[0]!.beat, 0);
    assert.equal(f3[1]!.beat, 1);
    assert.throws(() => anchorSpans('s', 'b', '陈月走进房间举起蓝伞看着窗外的雨。', { spans: [{ text: '看着窗外的雨。', kind: 'visual', beat: 0, states: [] }] }), /来源片段遗漏/);
    const quoted = anchorSpans('s', 'b', '陈月走进房间，只见举起蓝伞。', { spans: [{ text: '陈月走进房间只见举起蓝伞', kind: 'visual', beat: 0, states: [] }] });
    assert.equal(quoted[0]!.text, '陈月走进房间，只见举起蓝伞');
  });
  await t.test('对白引号后的动作不把整段算成一条超长语音', () => {
    const doc = document();
    const scene = doc.scenes[0]!;
    scene.blocks = [
      ...scene.blocks,
      { id: 'line', type: 'dialogue' as const, characterId: 1, text: `“短句。”${'陆嘉静凑到耳边。'.repeat(8)}` },
    ];
    const facts = anchorSpans(scene.id, scene.blocks[0]!.id, scene.blocks[0]!.text, { spans: [{ text: scene.blocks[0]!.text, beat: 0, kind: 'visual', states: [] }] });
    const budget = allocateBudgets(doc, facts);
    assert.ok(budget[0]!.minimum <= 20);
    scene.blocks[scene.blocks.length - 1]!.text = `“${'这句对白本身就已经长到放不进一个镜头。'.repeat(4)}”`;
    assert.throws(() => allocateBudgets(doc, facts), /声音预算冲突/);
  });
  await t.test('同一来源里偏高的非视觉节拍降到后面的可见时刻', () => {
    const source = '钟声响起。阿岚仍站在原地。';
    const spans = [
      { text: '钟声响起。', kind: 'audio' as const, beat: 6, states: [] },
      { text: '阿岚仍站在原地。', kind: 'visual' as const, beat: 5, states: [] },
    ];
    assert.throws(() => anchorSpans('s', 'b', source, { spans }), /事实节拍乱序/);
    const healed = stabilizeFactBeats(spans.map(span => ({ ...span, scene_id: 's', block_id: 'b' })));
    assert.deepEqual(anchorSpans('s', 'b', source, { spans: healed }).map(fact => fact.beat), [5, 5]);
    const mixed = stabilizeFactBeats([
      { scene_id: 's', block_id: 'b', text: '开门。', beat: 0 },
      { scene_id: 's', block_id: 'b', text: '钟声。', beat: 2 },
      { scene_id: 's', block_id: 'b', text: '站着。', beat: 1 },
    ]);
    assert.deepEqual(mixed.map(span => span.beat), [0, 1, 1]);
    const reversed = stabilizeFactBeats([
      { scene_id: 's', block_id: 'b', start: 3, beat: 1 },
      { scene_id: 's', block_id: 'b', start: 0, beat: 4 },
    ]);
    assert.deepEqual(reversed.map(span => span.beat), [1, 1]);
  });
  await t.test('最低预算与声音时长冲突', () => {
    const doc = document(12, 2);
    const facts = doc.scenes.flatMap(s => anchorSpans(s.id, s.blocks[0]!.id, s.blocks[0]!.text, { spans: s.blocks[0]!.text.match(/[^。]+。/gu)!.map((text, beat) => ({ text, beat, kind: 'visual', states: [] })) }));
    assert.throws(() => allocateBudgets(doc, facts), /最少需要 24 镜/);
    doc.scenes[0]!.estimatedDurationSec = 0.5; assert.throws(() => allocateBudgets(doc, facts), /声音时长冲突/);
  });
  await t.test('引号里的逗号被拆开后，整句译文仍算进入画面提示', () => {
    const prompt = sanitizeVisualPrompt("Suddenly laughed lightly: 'Next year's spring tide,', Nangong Xue rested her head on Lu Jiajing's arm.").visual_prompt;
    assert.equal(promptContainsTranslation(prompt, "Suddenly laughed lightly: 'Next year's spring tide,'"), true);
    assert.equal(promptContainsTranslation(prompt, 'Clouds outside the window churn like boiling water.'), false);
  });
});

test('CT05 candidate fingerprint rejects continuity changes during generation and before chapter adoption', async () => {
  const { script, params } = await confirmed(document());
  const fixture = providerFixture();
  const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...params, provider: fixture.provider });
  await db.run("INSERT INTO continuity_ledger(script_id,project_id,revision,context_json,changes_json,overlays_json) VALUES(?,?,1,'{}','[]','[]')", script.id, script.projectId);
  await assert.rejects(StoryboardGenerationService.applyStoryboardCandidate({ scriptId: script.id, changeId: candidate.id, expectedRevision: script.revision }), (error: any) => error.code === 'CONTINUITY_STALE');
  assert.equal((await db.get('SELECT COUNT(*) n FROM scene WHERE chapter_id=?', script.chapterId)).n, 0);
  const second = providerFixture(); let changed = false;
  const original = second.provider.generateStructured.bind(second.provider);
  second.provider.generateStructured = async (prompt, schema) => {
    if (!changed) { changed = true; await db.run('UPDATE continuity_ledger SET revision=2 WHERE script_id=?', script.id); }
    return original(prompt, schema);
  };
  await assert.rejects(StoryboardGenerationService.generateStoryboardCandidate({ ...params, requestKey: 'changed-during-generation', forceRegenerate: true, provider: second.provider }), (error: any) => error.code === 'CONTINUITY_STALE');
  assert.equal((await db.get("SELECT COUNT(*) n FROM script_change WHERE script_id=? AND request_key='changed-during-generation'", script.id)).n, 0);
});

test('new storyboard requests reuse verified steps, source edits only recompute affected scenes, explicit alternatives infer again', async () => {
  const doc = document(2);
  const f = await confirmed(doc);
  const model = providerFixture();
  const first = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: model.provider });
  const before = model.calls.length;
  const repeated = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, requestKey: 'same-input-new-request', provider: model.provider });
  assert.equal(model.calls.length, before);
  assert.deepEqual(JSON.parse(repeated.after_json).shots, JSON.parse(first.after_json).shots);
  await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, requestKey: 'explicit-alternative', forceRegenerate: true, provider: model.provider });
  assert.ok(model.calls.length > before);

  const changed = structuredClone(doc);
  changed.scenes[0]!.blocks[0]!.text = '第一场换成蓝灯亮起。';
  const saved = await ScriptService.saveManualScript({ scriptId: f.script.id, expectedRevision: f.script.revision, document: changed });
  const current = await ScriptService.confirmScript({ scriptId: f.script.id, expectedRevision: saved.revision });
  const editsBefore = model.calls.length;
  await StoryboardGenerationService.generateStoryboardCandidate({ scriptId: current.id, expectedRevision: current.revision, requestKey: 'edited-source', provider: model.provider });
  const calls = model.calls.slice(editsBefore);
  assert.ok(calls.some(call => call.task === 'classify' && call.sources.some((source: any) => source.text.includes('蓝灯'))));
  assert.ok(!calls.some(call => call.task === 'classify' && call.sources.some((source: any) => source.text.includes('第2场'))));
  assert.ok(!calls.some(call => call.task === 'translate' && call.facts.some((fact: any) => fact.text.includes('第2场'))));
});

test('逐场生成、持久化恢复与采纳闭环', async t => {
  t.mock.method(SettingsManager, 'loadSettings', () => ({ llm: { model: 'workflow-test' } }));
  for (const count of [1, 9, 12]) await t.test(`${count}场按本场规划，未改内容的采纳复用审核`, async st => {
    const f = await confirmed(document(count)); const m = providerFixture();
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider });
    const payload = StoryboardCandidatePayloadSchema.parse(JSON.parse(candidate.after_json));
    assert.equal(payload.schemaVersion, 3); assert.equal(payload.shots.length, count);
    for (const call of m.calls.filter(c => c.task === 'plan')) { assert.ok(call.facts.every((fact: any) => fact.scene_id === call.scene_id)); assert.equal(call.slots.length, 1); }
    assert.equal(payload.shots[0]!.narration, '灯亮了。'); assert.equal(payload.shots[0]!.audio_prompt, '钟声');
    assert.equal(hash(payload), hash(JSON.parse(candidate.after_json)));
    st.mock.method(LLMService, 'getLocalProvider', () => { throw new Error('Unchanged adoption must reuse server audit'); });
    const adopted = await StoryboardGenerationService.applyStoryboardCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision });
    assert.equal(adopted.count, count);
    const replay = await StoryboardGenerationService.applyStoryboardCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision });
    assert.deepEqual(replay.scene_ids, adopted.scene_ids);
  });
  await t.test('长场按完整节拍分组，同块可拆八镜', async () => {
    const f = await confirmed(document(1, 8)); const m = providerFixture();
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider });
    const payload = JSON.parse(candidate.after_json); assert.equal(payload.shots.length, 8);
    assert.equal(new Set(payload.shots.flatMap((s: any) => s.block_ids.filter((id: string) => id.startsWith('action')))).size, 1);
    assert.equal(m.calls.filter(c => c.task === 'plan').length, 2);
    assert.ok(m.calls.filter(c => c.task === 'plan').every(c => new Set(c.facts.map((fact: any) => fact.beat)).size <= 4));
  });
  await t.test('末场失败保留前场，同键恢复只翻译失败镜，并发合流', async () => {
    const f = await confirmed(document(3)); const m = providerFixture(); m.failScene('第3场');
    await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider }), /temporary translation failure/);
    const task = await StoryboardGenerationService.getTask(f.script.id, StoryboardGenerationService.taskId(f.script.id, f.params.requestKey));
    assert.equal(task.status, 'failed'); assert.equal(Object.keys(task.progress.shots).length, 2); assert.equal((await db.get('SELECT COUNT(*) AS n FROM scene')).n, 0);
    const before = m.calls.length; m.failScene('');
    const [one, two] = await Promise.all([1, 2].map(() => StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider })));
    assert.ok(one && two); assert.equal(one.id, two.id); const resumed = m.calls.slice(before);
    assert.equal(resumed.filter(c => c.task === 'extract' || c.task === 'plan').length, 0); assert.equal(resumed.filter(c => c.task === 'translate').length, 1);
    await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, instructions: '不同指令', provider: m.provider }), /同一请求键/);
  });
  for (const status of ['failed', 'interrupted']) await t.test(`${status}恢复在返回任务编号前持久化排队状态`, async () => {
    const f = await confirmed(document(3)); const m = providerFixture(); m.failScene('第3场');
    await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider }), /temporary/);
    const taskId = StoryboardGenerationService.taskId(f.script.id, f.params.requestKey);
    await db.run('UPDATE generation_task SET status=? WHERE task_id=?', status, taskId);
    const previous = await StoryboardGenerationService.getTask(f.script.id, taskId);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const running = new Promise<void>(resolve => { entered = resolve; });
    const blocker = serialWorkflow(`queue-block-${status}`, async () => { entered(); await gate; });
    await running;
    const before = m.calls.length; m.failScene('');
    let acknowledge!: (attempt: number | undefined) => void;
    const acknowledged = new Promise<number | undefined>(resolve => { acknowledge = resolve; });
    const work = StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider, onReserved: acknowledge });
    try {
      const attempt = await Promise.race([acknowledged, work.then(() => { throw new Error('Worker bypassed the queue'); })]);
      const queued = await StoryboardGenerationService.getTask(f.script.id, taskId);
      assert.equal(queued.status, 'queued'); assert.equal(queued.progress.phase, 'queued');
      assert.equal(queued.error, null); assert.equal(queued.progress.error, undefined);
      assert.equal(attempt, previous.progress.attempt + 1);
      assert.deepEqual(queued.progress.shots, previous.progress.shots);
      assert.equal(m.calls.length, before);
      let duplicateAttempt: number | undefined;
      const duplicate = StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider, onReserved: value => { duplicateAttempt = value; } });
      release(); await blocker;
      const [one, two] = await Promise.all([work, duplicate]);
      assert.equal(one.id, two.id); assert.equal(duplicateAttempt, attempt);
      assert.equal(m.calls.slice(before).filter(c => c.task === 'translate').length, 1);
    } finally { release(); await blocker; await work.catch(() => {}); }
  });
  for (const name of ['信号灯', '警示灯']) await t.test(`声明的${name}没有逐字可见证据时，五镜生成与采纳不强制特写`, async st => {
    const doc = document(5); doc.props = [{ id: 'lamp', name, description: '' }];
    doc.scenes.forEach(scene => { scene.propIds = ['lamp']; });
    const f = await confirmed(doc); const m = providerFixture();
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider });
    const payload = JSON.parse(candidate.after_json);
    assert.ok(payload.shots.every((shot: any) => JSON.parse(shot.shot_spec).shot_intent !== 'insert'));
    StoryboardGenerationService.validatePayload(payload, f.script);
    st.mock.method(LLMService, 'getLocalProvider', () => { throw new Error('Unchanged adoption must reuse audit'); });
    assert.equal((await StoryboardGenerationService.applyStoryboardCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision })).count, 5);
  });
  await t.test('可见道具必须有特写，移除后错误指出分场与道具', async () => {
    const doc = document(5); doc.props = [{ id: 'lamp', name: '红灯', description: '' }];
    doc.scenes[0]!.propIds = ['lamp'];
    const f = await confirmed(doc); const m = providerFixture();
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider });
    const payload = JSON.parse(candidate.after_json);
    const shot = payload.shots.find((s: any) => JSON.parse(s.shot_spec).shot_intent === 'insert');
    assert.ok(shot);
    const spec = JSON.parse(shot.shot_spec); spec.shot_intent = 'medium-action'; spec.shot_type = 'Medium Shot';
    shot.shot_type = spec.shot_type; shot.shot_spec = JSON.stringify(spec);
    shot.negative_prompt = compileNegativePrompt({ ...spec, visual_prompt: shot.visual_prompt, identity_mode: 'auto' });
    assert.throws(() => StoryboardGenerationService.validatePayload(payload, f.script), /harbor_0\/红灯/);
  });
  await t.test('篡改和候选编辑不能借用旧审核，失败不写时间线', async st => {
    const f = await confirmed(document()); const m = providerFixture(); st.mock.method(LLMService, 'getLocalProvider', () => m.provider as any);
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider });
    const payload = JSON.parse(candidate.after_json); payload.shots[0].visual_prompt = 'A new visitor carries blue cats.'; m.reject(true);
    payload.shots[0].negative_prompt = compileNegativePrompt({ ...JSON.parse(payload.shots[0].shot_spec), visual_prompt: payload.shots[0].visual_prompt, identity_mode: 'auto' });
    await assert.rejects(() => ScriptService.updatePendingCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision, afterJson: JSON.stringify(payload) }), /待核对/);
    assert.equal((await db.get('SELECT after_json FROM script_change WHERE id=?', candidate.id)).after_json, candidate.after_json);
    await db.run('UPDATE script_change SET after_json=? WHERE id=?', JSON.stringify(payload), candidate.id);
    await assert.rejects(() => StoryboardGenerationService.applyStoryboardCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision }), /待核对/);
    payload.fact_contract.facts[0].kind = 'internal'; await db.run('UPDATE script_change SET after_json=? WHERE id=?', JSON.stringify(payload), candidate.id);
    await assert.rejects(() => StoryboardGenerationService.applyStoryboardCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision }), /事实|契约|预算/);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM scene')).n, 0);
  });
  await t.test('超预算停在翻译之前，混合事实由文本模型修好后再生成候选', async () => {
    const f = await confirmed(document(12, 3)); const m = providerFixture();
    await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider }), /预算冲突/);
    assert.equal(m.calls.filter(c => c.task === 'plan' || c.task === 'translate').length, 0);
    const next = await confirmed(document());
    const mixed: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const r = JSON.parse(prompt);
      if (r.task === 'classify') return schema.parse({ items: r.sources.map((u: any) => ({ id: u.id, kind: 'mixed' })) });
      if (r.task === 'repair_fact') return schema.parse({ spans: [{ text: r.text, kind: 'visual' }] });
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...next.params, provider: mixed });
    assert.equal(candidate.state, 'pending');
    assert.equal((await StoryboardGenerationService.getTask(next.script.id, StoryboardGenerationService.taskId(next.script.id, next.params.requestKey))).progress.phase, 'completed');
    const facts = JSON.parse(candidate.after_json).fact_contract.facts;
    assert.equal(facts.find((fact: any) => fact.text.includes('红灯')).kind, 'visual');
    assert.equal(facts.filter((fact: any) => fact.kind === 'mixed' || fact.kind === 'uncertain').length, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM scene')).n, 0);
    const broken = await confirmed(document());
    let kinds = 0;
    const fallback: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const r = JSON.parse(prompt);
      if (r.task === 'classify') return schema.parse({ items: r.sources.map((u: any) => ({ id: u.id, kind: 'uncertain' })) });
      if (r.task === 'repair_fact') return schema.parse({ spans: [{ text: '改写了原文', kind: 'visual' }] });
      if (r.task === 'repair_kind') { kinds += 1; return schema.parse({ kind: 'visual' }); }
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...broken.params, provider: fallback }), /来源片段/);
    assert.equal(kinds, 0, 'CT09 forbids an additional kind repair after the one semantic attempt');
    const rejectedTask = await StoryboardGenerationService.getTask(broken.script.id, StoryboardGenerationService.taskId(broken.script.id, broken.params.requestKey));
    assert.equal(rejectedTask.progress.inference_budget.semantic_repairs, 1);
    assert.equal(rejectedTask.progress.phase, 'needs_review');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM scene')).n, 0);
    const fragments = [
      { text: '收紧', beat: 0, start: 0, end: 2, block_id: 'b', scene_id: 'sc' },
      { text: '双臂，', beat: 0, start: 2, end: 5, block_id: 'b', scene_id: 'sc' },
      { text: '她抬头。', beat: 0, start: 6, end: 10, block_id: 'b', scene_id: 'sc' },
      { text: '阿岚打开门', beat: 1, start: 10, end: 15, block_id: 'b', scene_id: 'sc' },
      { text: '并走到屋外。', beat: 1, start: 15, end: 21, block_id: 'b', scene_id: 'sc' },
    ];
    assert.deepEqual(groupAdjacentClauseFragments(fragments), [[0, 1], [2], [3], [4]]);
    const cut = await confirmed(document());
    const cutter: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const r = JSON.parse(prompt);
      if (r.task === 'classify') return schema.parse({ items: r.sources.map((u: any) => ({ id: u.id, kind: 'mixed' })) });
      if (r.task === 'repair_fact') return schema.parse({ spans: [{ text: '第1场的第1盏', kind: 'visual' }, { text: '红灯亮起。', kind: 'visual' }] });
      if (r.task === 'repair_kind') return schema.parse({ kind: 'visual' });
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...cut.params, provider: cutter }), /分句边界/);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM scene')).n, 0);
  });
  await t.test('已有时间线、制作任务、已验收视频继续受到替换保护', async () => {
    const f = await confirmed(document()); const m = providerFixture();
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider });
    const existing = await db.run('INSERT INTO scene(chapter_id,"index",visual_prompt,asset_url) VALUES(?,1,?,?)', f.chapterId, '原镜头', '/old.png');
    const params = { scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision };
    await assert.rejects(() => StoryboardGenerationService.applyStoryboardCandidate(params), /已有分镜/);
    const replace = { ...params, replaceExisting: true, expectedSceneIds: [Number(existing.lastID)] };
    await assert.rejects(() => StoryboardGenerationService.applyStoryboardCandidate({ ...replace, expectedSceneIds: [0] }), /Timeline changed/);
    await db.run("INSERT INTO generation_task(task_id,scene_id,status) VALUES('busy',?,'processing')", existing.lastID);
    await assert.rejects(() => StoryboardGenerationService.applyStoryboardCandidate(replace), /正在执行/);
    await db.run("DELETE FROM generation_task WHERE task_id='busy'");
    const project = await db.get('SELECT project_id FROM chapter WHERE id=?', f.chapterId);
    const video = await db.run("INSERT INTO media_asset(project_id,scene_id,media_type,role,status,url) VALUES(?,?,'video','narrative_final','ready','/accepted.mp4')", project.project_id, existing.lastID);
    await assert.rejects(() => StoryboardGenerationService.applyStoryboardCandidate(replace), /已验收/);
    await db.run('DELETE FROM media_asset WHERE id=?', video.lastID);
    const result = await StoryboardGenerationService.applyStoryboardCandidate(replace);
    assert.deepEqual(result.replaced_scene_ids, [Number(existing.lastID)]); assert.ok(result.scene_ids[0]! > Number(existing.lastID));
    const history = JSON.parse((await db.get('SELECT result_json FROM script_change WHERE id=?', candidate.id)).result_json);
    assert.equal(history.previous_timeline.scenes[0].asset_url, '/old.png');
  });
  await t.test('句内连续动作由文本模型拆开，拆不开则不能当成单镜头事实', async () => {
    const source = '阿岚打开门并走到屋外。';
    assert.deepEqual(verbatimActionSplit(source, ['阿岚打开门', '并走到屋外。']), ['阿岚打开门', '并走到屋外。']);
    assert.equal(verbatimActionSplit(source, ['阿岚推开门', '并走到屋外。']), null);
    assert.equal(verbatimActionSplit('阿岚打开门然后走到屋外。', ['阿岚打开门然后走到屋外。']), null);
    const doc = document(); doc.scenes[0]!.blocks[0]!.text = source;
    const f = await confirmed(doc); const m = providerFixture();
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const request = JSON.parse(prompt);
      if (request.task === 'atomicity') return schema.parse({ result: 'sequence' });
      if (request.task === 'split_actions') {
        assert.match(String(system), /Do not return the whole sentence/);
        return schema.parse({ spans: [{ text: '阿岚打开门' }, { text: '并走到屋外。' }] });
      }
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider });
    const facts = JSON.parse(candidate.after_json).fact_contract.facts.filter((fact: any) => fact.block_id === 'action_0');
    assert.deepEqual(facts.map((fact: any) => fact.text), ['阿岚打开门', '并走到屋外。']);
    assert.ok(facts.every((fact: any) => fact.kind === 'visual'));
    const before = m.calls.length;
    const resumed = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider });
    assert.equal(resumed.id, candidate.id);
    assert.equal(m.calls.slice(before).filter(c => ['classify', 'repair_fact', 'repair_kind', 'split_actions', 'state'].includes(c.task)).length, 0);
    const whole = document(); whole.scenes[0]!.blocks[0]!.text = '阿岚打开门然后走到屋外。';
    const keptSource = await confirmed(whole);
    const keeping: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const request = JSON.parse(prompt);
      if (request.task === 'atomicity') return schema.parse({ result: 'sequence' });
      if (request.task === 'split_actions') return schema.parse({ spans: [{ text: request.source }] });
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...keptSource.params, provider: keeping }), /连续动作未能拆成/);
    const keptTask = await StoryboardGenerationService.getTask(keptSource.script.id, StoryboardGenerationService.taskId(keptSource.script.id, keptSource.params.requestKey));
    assert.equal(keptTask.progress.phase, 'needs_review');
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM script_change WHERE script_id=? AND kind='storyboard'", keptSource.script.id)).n, 0);
  });
  await t.test('已判定为连续动作时，拆分失败不会退回一个可采纳镜头', async () => {
    const source = '林岚先坐下然后站起。';
    const splits: Array<(text: string) => Array<{ text: string }>> = [
      (text) => [{ text }],
      (text) => [{ text: text.slice(0, 4) }, { text: text.slice(5) }],
      () => [{ text: '林岚坐下' }, { text: '然后站起。' }],
    ];
    for (const spans of splits) {
      const doc = document();
      doc.scenes[0]!.blocks[0]!.text = source;
      const f = await confirmed(doc);
      const m = providerFixture();
      const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
        const request = JSON.parse(prompt);
        if (request.task === 'atomicity') return schema.parse({ result: 'sequence' });
        if (request.task === 'split_actions') return schema.parse({ spans: spans(request.source) });
        return m.provider.generateStructured(prompt, schema, system, options);
      } };
      await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider }), /连续动作未能拆成/);
      const task = await StoryboardGenerationService.getTask(f.script.id, StoryboardGenerationService.taskId(f.script.id, f.params.requestKey));
      assert.equal(task.progress.phase, 'needs_review');
      assert.equal((await db.get("SELECT COUNT(*) AS n FROM script_change WHERE script_id=? AND kind='storyboard'", f.script.id)).n, 0);
    }
  });
  await t.test('整批翻译含中文时改为逐条翻译', async () => {
    const doc = document();
    doc.scenes[0]!.blocks[0]!.text = '红灯亮起。门半开。';
    const f = await confirmed(doc);
    const m = providerFixture();
    let batched = 0;
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const request = JSON.parse(prompt);
      if (request.task === 'translate' && request.facts.length > 1) {
        batched += 1;
        return schema.parse({ translations: request.facts.map((fact: any) => ({ id: fact.id, english: '灯还亮着' })) });
      }
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider });
    assert.ok(batched >= 1);
    assert.ok(m.calls.some(call => call.task === 'translate' && call.facts.length === 1));
    assert.ok(JSON.parse(candidate.after_json).shots.length >= 1);
  });
  await t.test('整镜审核失败后逐条重译再审一次', async () => {
    const doc = document();
    const f = await confirmed(doc);
    const m = providerFixture();
    let audits = 0;
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const request = JSON.parse(prompt);
      if (request.task === 'audit') {
        audits += 1;
        return schema.parse({ faithful: audits > 1 });
      }
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider });
    assert.ok(audits >= 2);
    assert.ok(JSON.parse(candidate.after_json).shots.length >= 1);
  });
  await t.test('逐条译文通过后不拼成标签汤', async () => {
    const doc = document();
    const f = await confirmed(doc);
    const m = providerFixture();
    const audits: any[] = [];
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const request = JSON.parse(prompt);
      if (request.task === 'audit') {
        audits.push(request);
        return schema.parse({ faithful: request.facts.length === 1 });
      }
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider });
    const payload = JSON.parse(candidate.after_json);
    assert.ok(audits.length >= 1);
    assert.ok(audits.every(call => call.facts.length === 1));
    assert.ok(audits.every(call => !String(call.english).includes('establishing shot')));
    assert.equal(payload.shots[0].visual_prompt, '');
    assert.match(payload.shots[0].shot_spec, /primary_action/);
  });
  await t.test('单条译文矛盾仍拒绝候选', async () => {
    const doc = document();
    doc.scenes[0]!.blocks[0]!.text = '阿岚举起蓝杯。';
    const f = await confirmed(doc);
    const m = providerFixture();
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const request = JSON.parse(prompt);
      if (request.task === 'audit' && request.facts.some((fact: any) => fact.text.includes('蓝杯'))) return schema.parse({ faithful: false });
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider }), /译文待核对/);
  });
  await t.test('引号后的动作分开翻译后再审整句', async () => {
    const doc = document();
    doc.scenes[0]!.blocks[0]!.text = "低喘着喊出那个平日绝不开口的名字：‘雨涵……'裴雨涵笑出了声，";
    const f = await confirmed(doc);
    const m = providerFixture();
    const translated: string[] = [];
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const request = JSON.parse(prompt);
      if (request.task === 'translate') {
        const text = request.facts.map((fact: any) => fact.text).join('');
        translated.push(text);
        const combined = text.includes('低喘') && text.includes('笑出了声');
        return schema.parse({ translations: request.facts.map((fact: any) => ({ id: fact.id, english: fact.id === 'location' ? 'An empty harbor.' : combined ? 'Low whimpers shouted.' : 'The name is called.' })) });
      }
      if (request.task === 'audit') return schema.parse({ faithful: !String(request.english).includes('whimper') });
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider });
    assert.ok(JSON.parse(candidate.after_json).shots.length >= 1);
    assert.ok(translated.some(text => text.includes('低喘') && !text.includes('笑出了声')));
    assert.ok(translated.some(text => text.includes('笑出了声') && !text.includes('低喘')));
  });
  await t.test('译文新增 him 时保留错误证据并拒绝，不能靠删代词通过', async () => {
    const doc = document();
    doc.scenes[0]!.blocks[0]!.text = '青禾跨坐上去。';
    const f = await confirmed(doc);
    const m = providerFixture();
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const request = JSON.parse(prompt);
      if (request.task === 'translate') return schema.parse({ translations: request.facts.map((fact: any) => ({ id: fact.id, english: fact.text.includes('跨坐') ? 'She straddled him.' : 'An empty harbor.' })) });
      if (request.task === 'audit') return schema.parse({ faithful: !/\bhim\b/i.test(request.english) });
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider }), /译文待核对/);
  });
  await t.test('后置对白按顺序分到已有镜头，不挤在最后一镜', async () => {
    const doc = document();
    doc.scenes[0]!.blocks = [
      { id: 'action_0', type: 'action' as const, text: '第1场的第1盏红灯亮起。' },
      { id: 'd1', type: 'voiceover' as const, characterId: null, text: '甲'.repeat(25) },
      { id: 'd2', type: 'voiceover' as const, characterId: null, text: '乙'.repeat(18) },
      { id: 'd3', type: 'voiceover' as const, characterId: null, text: '丙'.repeat(20) },
    ];
    const f = await confirmed(doc); const m = providerFixture();
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider });
    const shots = JSON.parse(candidate.after_json).shots;
    assert.equal(shots.length, 2);
    assert.ok(shots.every((shot: any) => shot.duration <= 15));
    assert.equal(shots.flatMap((shot: any) => JSON.parse(shot.shot_spec).audible_blocks.map((block: any) => block.id)).join(','), 'd1,d2,d3');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM scene')).n, 0);
  });
  await t.test('声音事实保留原文；时长保持镜沿用完整前画面', async () => {
    const doc = document(); doc.scenes[0]!.estimatedDurationSec = 31;
    doc.scenes[0]!.blocks[0]!.text = '红灯亮起。钟声。';
    const f = await confirmed(doc); const m = providerFixture();
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const r = JSON.parse(prompt);
      if (r.task === 'classify') return schema.parse({ items: r.sources.map((u: any) => ({ id: u.id, kind: u.text.includes('钟声') ? 'audio' : 'visual' })) });
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider });
    const payload = JSON.parse(candidate.after_json);
    assert.equal(payload.shots.length, 3);
    assert.deepEqual(payload.shots[1].hold_fact_ids, payload.shots[0].fact_ids);
    assert.equal(JSON.parse(payload.shots[1].shot_spec).primary_action, '红灯亮起。');
    assert.ok(payload.shots.some((s: any) => s.audio_prompt.includes('钟声。')));
    const voiceShot = payload.shots.find((s: any) => s.narration);
    assert.equal(JSON.parse(voiceShot.shot_spec).audible_blocks.find((b: any) => b.type === 'voiceover').characterId, null);
    assert.ok(payload.shots.every((s: any) => s.duration <= 15));
    StoryboardGenerationService.validatePayload(payload, f.script);
    const heldFrame = structuredClone(payload);
    heldFrame.shots[1].visual_prompt = heldFrame.shots[0].visual_prompt;
    heldFrame.shots[1].negative_prompt = compileNegativePrompt({ ...JSON.parse(heldFrame.shots[1].shot_spec), visual_prompt: heldFrame.shots[1].visual_prompt, identity_mode: 'auto' });
    StoryboardGenerationService.validatePayload(heldFrame, f.script);
    const broken = structuredClone(payload); JSON.parse(broken.shots[1].shot_spec);
    broken.shots[1].hold_fact_ids = [];
    assert.throws(() => StoryboardGenerationService.validatePayload(broken, f.script), /事实列表|主动作/);
  });
  await t.test('后一批次的声音与同一时刻画面共用节拍，核对时拉平乱序', async () => {
    const doc = document();
    const scene = doc.scenes[0]!;
    scene.blocks = [
      { id: 'action_0', type: 'action' as const, text: '灯一。灯二。灯三。灯四。灯五。灯六。' },
      { id: 'action_1', type: 'action' as const, text: '钟声响起。阿岚仍站在原地。' },
      { id: 'voice_0', type: 'voiceover' as const, characterId: null, text: '灯亮了。' },
      { id: 'sound_0', type: 'sound' as const, text: '钟声' },
    ];
    const f = await confirmed(doc);
    const m = providerFixture();
    m.failScene('仍站');
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const request = JSON.parse(prompt);
      if (request.task === 'classify') return schema.parse({ items: request.sources.map((unit: any) => ({ id: unit.id, kind: unit.text.includes('钟声响起') ? 'audio' : 'visual' })) });
      if (request.task === 'beat_relation') return schema.parse({ relation: String(request.current || '').includes('仍站') ? 'simultaneous' : 'sequential' });
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider }), /temporary translation failure/);
    const taskId = StoryboardGenerationService.taskId(f.script.id, f.params.requestKey);
    const failed = await StoryboardGenerationService.getTask(f.script.id, taskId);
    assert.deepEqual(failed.progress.facts.filter((fact: any) => fact.block_id === 'action_1').map((fact: any) => fact.beat), [5, 5]);
    const spans = failed.progress.facts.map((fact: any) => ({
      scene_id: fact.scene_id, block_id: fact.block_id, text: fact.text, kind: fact.kind, states: fact.states,
      beat: fact.block_id === 'action_1' && fact.kind === 'audio' ? fact.beat + 3 : fact.beat,
    }));
    const broken = spans.filter((fact: any) => fact.block_id === 'action_1');
    assert.throws(() => anchorSpans(scene.id, 'action_1', '钟声响起。阿岚仍站在原地。', { spans: broken }), /事实节拍乱序/);
    await StoryboardGenerationService.reviewTaskFacts(f.script.id, taskId, { expected_input_hash: failed.progress.input_hash, spans });
    const reviewed = await StoryboardGenerationService.getTask(f.script.id, taskId);
    assert.deepEqual(reviewed.progress.facts.filter((fact: any) => fact.block_id === 'action_1').map((fact: any) => fact.beat), [5, 5]);
    m.failScene('');
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider });
    const payload = JSON.parse(candidate.after_json);
    const bell = payload.fact_contract.facts.find((fact: any) => fact.text.includes('钟声响起'));
    const standing = payload.fact_contract.facts.find((fact: any) => fact.text.includes('仍站'));
    assert.deepEqual(payload.fact_contract.facts.filter((fact: any) => fact.block_id === 'action_1').map((fact: any) => fact.beat), [5, 5]);
    const shot = payload.shots.find((item: any) => item.audio_fact_ids?.includes(bell.id));
    assert.ok(shot.fact_ids.includes(standing.id));
  });
  await t.test('前场状态改变仅重做依赖人物的下游，保留无依赖的已通过镜头', async () => {
    const doc = document(4);
    ['阿岚持红杯。', '阿岚穿灰衣。', '无人港口红灯亮起。', '第4场的灯亮起。'].forEach((text, i) => { doc.scenes[i]!.blocks[0]!.text = text; });
    const f = await confirmed(doc, ['阿岚']); const m = providerFixture(); m.failScene('第4场');
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const r = JSON.parse(prompt);
      if (r.task === 'state') return schema.parse({ states: r.facts.filter((fact: any) => fact.text.includes('阿岚持红杯')).map((fact: any) => ({ fact_id: fact.id, entity: '阿岚', attribute: 'holding', value: '红杯' })) });
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider }), /temporary/);
    const taskId = StoryboardGenerationService.taskId(f.script.id, f.params.requestKey);
    const task = await StoryboardGenerationService.getTask(f.script.id, taskId);
    assert.equal(Object.keys(task.progress.shots).length, 3);
    const spans = task.progress.facts.map((fact: any, index: number) => index ? fact : { ...fact, states: [{ entity: '阿岚', attribute: 'holding', value: '持红杯' }] });
    await StoryboardGenerationService.reviewTaskFacts(f.script.id, taskId, { expected_input_hash: task.progress.input_hash, spans });
    const before = m.calls.length; m.failScene('');
    await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider });
    const sourceTexts = m.calls.slice(before).filter(c => c.task === 'translate').flatMap(c => c.facts.map((fact: any) => fact.text));
    // The first shot's literal translation is unchanged; only dependent inherited state needs inference.
    assert.ok(!sourceTexts.includes('阿岚持红杯。')); assert.ok(sourceTexts.includes('阿岚穿灰衣。'));
    assert.ok(sourceTexts.includes('阿岚 手持：持红杯'));
    assert.ok(!sourceTexts.includes('无人港口红灯亮起。'));
    assert.ok(sourceTexts.includes('第4场的灯亮起。'));
  });
  await t.test('生成中剧本版本变动拒绝保存候选', async () => {
    const f = await confirmed(document()); const m = providerFixture(); let changed = false;
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      if (!changed && JSON.parse(prompt).task === 'translate') { changed = true; await db.run('UPDATE chapter_script SET revision=revision+1 WHERE id=?', f.script.id); }
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider }), /生成期间/);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM script_change WHERE kind='storyboard'")).n, 0);
  });
  await t.test('人物译名来自项目数据；修改译名后旧审核不能复用', async st => {
    const f = await confirmed(document()); const m = providerFixture();
    const project = await db.get('SELECT project_id FROM chapter WHERE id=?', f.chapterId);
    const character = await db.run('INSERT INTO character(project_id,name,english_name) VALUES(?,?,?)', project.project_id, '青禾', 'Qing He');
    f.script = await ScriptService.refreshSourceSnapshot({ scriptId: f.script.id, expectedRevision: f.script.revision });
    f.params.expectedRevision = f.script.revision;
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider: m.provider });
    assert.equal(m.calls.find(c => c.task === 'translate').glossary['青禾'], 'Qing He');
    await db.run('UPDATE character SET english_name=? WHERE id=?', 'He Qing', character.lastID);
    st.mock.method(LLMService, 'getLocalProvider', () => m.provider as any);
    const before = m.calls.filter(c => c.task === 'audit').length;
    await assert.rejects(
      () => StoryboardGenerationService.applyStoryboardCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision }),
      /重新生成分镜候选/,
    );
    assert.equal(m.calls.filter(c => c.task === 'audit').length, before);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM scene')).n, 0);
  });
  await t.test('连续状态没有原文证据时由文本模型重抽，不中断已通过进度', async () => {
    const doc = document();
    doc.scenes[0]!.blocks[0]!.text = '裴雨涵在陆嘉静身下微微战栗。';
    const f = await confirmed(doc, ['裴雨涵', '陆嘉静']);
    const m = providerFixture();
    const stateCalls: any[] = [];
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const request = JSON.parse(prompt);
      if (request.task === 'state' && String(request.facts?.[0]?.text || '').includes('战栗')) {
        stateCalls.push(request);
        const states = String(request.repair || '').includes('逐字证据')
          ? [{ entity: '裴雨涵', attribute: 'position', value: '陆嘉静身下' }]
          : [{ entity: '裴雨涵', attribute: 'holding', value: '无' }];
        return schema.parse({ states });
      }
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider });
    const payload = JSON.parse(candidate.after_json);
    const fact = payload.fact_contract.facts.find((item: any) => String(item.text).includes('战栗'));
    assert.deepEqual(fact.states, [{ entity: '裴雨涵', attribute: 'position', value: '陆嘉静身下' }]);
    assert.ok(stateCalls.some(call => String(call.repair || '').includes('逐字证据') && String(call.repair).includes('无')));
  });
  await t.test('同块后句的衣着挂到前文点名的人，代词镜头沿用该衣着并去掉冲突外形', async () => {
    const doc = document();
    doc.scenes[0]!.blocks[0]!.text = '青禾解开外衣。她把里衣褪到腰间。她伸手。';
    const f = await confirmed(doc, ['青禾']);
    const project = await db.get('SELECT project_id FROM chapter WHERE id=?', f.chapterId);
    await db.run(
      'UPDATE character SET visual_tags=? WHERE project_id=? AND name=?',
      JSON.stringify({ base_model: { tags: { hair: 'voluminous_crimson', face_features: 'calm eyes' } } }), project.project_id, '青禾'
    );
    f.script = await ScriptService.refreshSourceSnapshot({ scriptId: f.script.id, expectedRevision: f.script.revision });
    f.params.expectedRevision = f.script.revision;
    const m = providerFixture();
    const stateCalls: any[] = [];
    const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
      const request = JSON.parse(prompt);
      if (request.task === 'state') {
        stateCalls.push(request);
        const text = String(request.facts?.[0]?.text || '');
        const context = String(request.context || '');
        if (text.includes('解开外衣')) return schema.parse({ states: [{ entity: '青禾', attribute: 'wardrobe', value: '解开外衣' }] });
        if (text.includes('里衣褪到腰间') && context.includes('青禾')) return schema.parse({ states: [{ entity: '青禾', attribute: 'wardrobe', value: '里衣褪到腰间' }] });
        return schema.parse({ states: [] });
      }
      if (request.task === 'present') {
        const facts = (request.facts || []).map((fact: any) => fact.text).join('');
        const named = (request.known || []).filter((name: string) => facts.includes(name));
        return schema.parse({ names: /她|他/.test(facts) ? request.known : named });
      }
      if (request.task === 'lock_fit') {
        return schema.parse({ drop: (request.locks || []).flatMap((lock: any) => (lock.clauses || []).filter((clause: string) => clause === 'voluminous_crimson').map((clause: string) => ({ name: lock.name, clause }))) });
      }
      if (request.task === 'translate') {
        const englishFor = (fact: any) => {
          const text = String(fact.text || '');
          if (fact.id === 'location') return 'An empty harbor.';
          if (text.includes('褪')) return 'Qing He robe lowered to the waist.';
          if (text.includes('青禾')) return 'Qing He loosens the outer robe.';
          return `A red lamp shines. Source ${fact.id}.`;
        };
        return schema.parse({ translations: request.facts.map((fact: any) => ({ id: fact.id, english: englishFor(fact) })) });
      }
      return m.provider.generateStructured(prompt, schema, system, options);
    } };
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider });
    const payload = JSON.parse(candidate.after_json);
    const lowered = payload.fact_contract.facts.find((fact: any) => String(fact.text).includes('里衣褪到腰间'));
    assert.deepEqual(lowered.states, [{ entity: '青禾', attribute: 'wardrobe', value: '里衣褪到腰间' }]);
    assert.ok(stateCalls.some(call => String(call.context || '').includes('青禾') && String(call.facts?.[0]?.text || '').includes('褪')));
    const follow = payload.shots.find((shot: any) => JSON.parse(shot.shot_spec).primary_action === '她伸手。');
    const spec = JSON.parse(follow.shot_spec);
    assert.deepEqual(spec.visible_subjects, ['青禾']);
    assert.deepEqual(spec.continuity_states.map((state: any) => state.value).sort(), ['解开外衣', '里衣褪到腰间'].sort());
    assert.equal(follow.visual_prompt, '');
    assert.equal(spec.primary_action, '她伸手。');
    assert.doesNotMatch(JSON.stringify(follow), /voluminous_crimson|:1\.35/);
    StoryboardGenerationService.validatePayload(payload, f.script);
  });
});

test('双向审核区分语义问题与格式失败', async () => {
  for (const reason of ['missing', 'contradicted', 'added', 'uncertain']) {
    const provider = { ...providerFixture().provider, async generateStructured(_p: string, schema: any) { return schema.parse({ faithful: false }); } } as AIProvider;
    await assert.rejects(() => auditFacts(provider, [{ id: 'f', text: '青禾用左手将两只红杯递给阿岚' }], 'A visitor receives blue cups.'), /译文待核对/);
  }
  const provider = { ...providerFixture().provider, async generateStructured(_p: string, schema: any) { return schema.parse({}); } } as AIProvider;
  await assert.rejects(() => auditFacts(provider, [{ id: 'f', text: '无人街道' }], 'An empty street.'), /审核格式错误/);
  const turned = { async generateStructured(_p: string, schema: any) { return schema.parse({ faithful: false }); } } as AIProvider;
  await assert.rejects(() => auditFacts(turned, [{ id: 'f', text: '林岚举起蓝伞' }], 'Lin Lan turned away.', { glossary: { 林岚: 'Lin Lan' }, visible_names: ['林岚'] }), /译文待核对/);
});

test('英文代词留在待核对译文里，不会改成姓名所有格', async () => {
  const doc = document();
  doc.scenes[0]!.blocks[0]!.text = '林岚把蓝伞递给陈月。';
  const progress: WorkflowProgress = { input_hash: 'pronoun-keep', phase: 'queued', extracted: {}, plans: {}, shots: {}, metrics: [] };
  const m = providerFixture();
  const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
    const input = JSON.parse(prompt);
    if (input.task === 'translate') {
      return schema.parse({ translations: input.facts.map((fact: any) => ({ id: fact.id, english: String(fact.text).includes('递给') ? 'Lin Lan hands the blue umbrella to her.' : 'An empty harbor.' })) });
    }
    return m.provider.generateStructured(prompt, schema, system, options);
  } };
  await assert.rejects(() => runFactWorkflow({ doc, scriptId: 91, revision: 1, provider, model: 'mock', characters: [{ id: 1, name: '林岚' }, { id: 2, name: '陈月' }], glossary: { 林岚: 'Lin Lan', 陈月: 'Chen Yue' }, locks: [], instructions: '', progress, persist: async () => {} }), (error: any) => {
    assert.match(String(error?.message), /to her/);
    assert.doesNotMatch(String(error?.message), /Lin Lan's/);
    return true;
  });
});

test('多人离场带前文建议仍停在待核对，不调用翻译也不把候选都画出来', async () => {
  const doc = document(2);
  doc.scenes[0]!.blocks = [{ id: 'before', type: 'action', text: '林岚离开，陈月留在房间。' }];
  doc.scenes[1]!.blocks = [{ id: 'after', type: 'action', text: '她举起蓝伞。' }];
  const m = providerFixture(); const bindings: any[] = [];
  const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
    const input = JSON.parse(prompt);
    if (input.task === 'entity_binding') { bindings.push(input); return schema.parse({ bindings: input.mentions.map((mention: any) => ({ index: mention.index, entity_id: 'character:1', status: 'resolved' })) }); }
    return m.provider.generateStructured(prompt, schema, system, options);
  } };
  const progress: WorkflowProgress = { input_hash: 'pronoun', phase: 'queued', extracted: {}, plans: {}, shots: {}, metrics: [] };
  await assert.rejects(() => runFactWorkflow({ doc, scriptId: 1, revision: 1, provider, model: 'mock', characters: [{ id: 1, name: '林岚' }, { id: 2, name: '陈月' }], glossary: { 林岚: 'Lin Lan', 陈月: 'Chen Yue' }, locks: [], instructions: '', progress, persist: async () => {} }), /人物绑定待核对/);
  assert.ok(bindings.some(input => input.context.includes('林岚离开') && input.context.includes('陈月留在房间')));
  assert.equal(progress.phase, 'needs_review');
  assert.deepEqual(progress.shots, {});
  assert.equal(m.calls.filter(c => ['translate', 'present', 'plan'].includes(c.task)).length, 0);
  const mention = progress.facts!.find(f => f.text === '她举起蓝伞。')!.binding!.mentions[0]!;
  assert.equal(mention.confirmed, false); assert.equal(mention.visibility, 'uncertain');
  mention.entity = { id: 'character:2', name: '陈月' }; mention.authority = 'human'; mention.confirmed = true; mention.status = 'resolved'; mention.visibility = 'visible';
  const result = await runFactWorkflow({ doc, scriptId: 1, revision: 1, provider, model: 'mock', characters: [{ id: 1, name: '林岚' }, { id: 2, name: '陈月' }], glossary: { 林岚: 'Lin Lan', 陈月: 'Chen Yue' }, locks: [], instructions: '', progress, persist: async () => {} });
  assert.ok(result.shots.filter(s => s.script_scene_id === 'harbor_1').every(s => JSON.parse(s.shot_spec).visible_subjects.join(',') === '陈月'));
  assert.ok(m.calls.filter(c => c.task === 'translate').some(c => c.facts.some((f: any) => f.text === '陈月举起蓝伞。')));
  assert.equal(bindings.length, 1);
});

test('分镜角色反转在模型自审通过时也被拒绝，地点上下文完整进入翻译', async () => {
  const doc = document(); doc.scenes[0]!.blocks[0]!.text = '林岚把蓝伞递给陈月。';
  doc.locations[0]!.description = '白墙'; doc.scenes[0]!.timeOfDay = 'night'; doc.scenes[0]!.interiorExterior = 'interior';
  const f = await confirmed(doc, ['林岚', '陈月']); const m = providerFixture(); const translated: any[] = [];
  const provider: AIProvider = { ...m.provider, async generateStructured(prompt, schema, system, options) {
    const input = JSON.parse(prompt);
    if (input.task === 'translate') { translated.push(input); return schema.parse({ translations: input.facts.map((fact: any) => ({ id: fact.id, english: fact.text.includes('递给') ? 'Chen Yue hands the blue umbrella to Lin Lan.' : 'A white room at night.' })) }); }
    return m.provider.generateStructured(prompt, schema, system, options);
  } };
  await assert.rejects(() => StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, provider }), /施受关系/);
  const faithful: AIProvider = { ...provider, async generateStructured(prompt, schema, system, options) {
    const input = JSON.parse(prompt);
    if (input.task === 'translate') { translated.push(input); return schema.parse({ translations: input.facts.map((fact: any) => ({ id: fact.id, english: fact.text.includes('递给') ? 'The blue umbrella is handed to Chen Yue by Lin Lan.' : fact.id === 'time_of_day' ? 'At night.' : fact.id === 'interior_exterior' ? 'Indoors.' : fact.id === 'location_description' ? 'White walls.' : 'A harbor room.' })) }); }
    return m.provider.generateStructured(prompt, schema, system, options);
  } };
  const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ ...f.params, requestKey: 'passive-storyboard', provider: faithful });
  const payload = JSON.parse(candidate.after_json);
  const inputs = translated.flatMap(call => call.facts);
  assert.ok(['白墙', '室内', '夜间'].every(text => inputs.some(fact => fact.text === text)));
  const spec = JSON.parse(payload.shots[0].shot_spec);
  assert.equal(spec.scene_context.time_of_day, 'night'); assert.deepEqual(spec.visible_subjects, ['林岚', '陈月']);
  const tampered = structuredClone(payload); tampered.fact_contract.facts[0].binding.mentions[0].entity.name = '错误姓名';
  assert.throws(() => StoryboardGenerationService.validatePayload(tampered, f.script), /契约|绑定/);
  const old = structuredClone(payload); old.fact_contract.version = 2; old.fact_contract.policy_version = 'storyboard-facts-2';
  assert.throws(() => StoryboardGenerationService.validatePayload(old, f.script), /旧版|契约|版本/);
});
