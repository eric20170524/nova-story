import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import type { z } from 'zod';
import { db, initDb } from '../db/database';
import { ScriptService } from './script_service';
import { StoryboardGenerationService } from './ai/storyboard_generation_service';
import { ScriptGenerationService, matchProjectCharacter } from './ai/script_generation_service';
import { AgentExecutor } from './ai/agent_executor';
import { WritingService } from './ai/writing_service';
import { LLMService } from './llm';
import type { AIProvider } from './ai/base';
import { createEmptyScriptDocument, StoryboardCandidatePayloadSchema, type ScriptScene } from '../schemas/script';
import { packShotSpec } from '../schemas/shot_contract';
import { projectRoutes } from '../routes/projects';
import { creativeRoutes } from '../routes/creative';
import { normalizeNovaStoryJsonProject } from './import/novastory_json_model';
import { restoreNovaStoryJsonProject } from './import/novastory_json_import';

async function fixture() {
  await initDb();
  const project = await db.run("INSERT INTO project (title, settings, user_id) VALUES ('review regression', '{}', 'local_admin')");
  const projectId = Number(project.lastID);
  const character = await db.run("INSERT INTO character (project_id, name, role, visual_tags) VALUES (?, '林夏', '主角', '{}')", projectId);
  const characterId = Number(character.lastID);
  const chapterId = crypto.randomUUID();
  await db.run(`INSERT INTO chapter (id, project_id, "index", title, content, condensed_content) VALUES (?, ?, 1, '测试', '原小说正文', '旧摘要')`, chapterId, projectId);
  let script = await ScriptService.createOrGetScript(chapterId);
  const doc = createEmptyScriptDocument();
  doc.locations = [{ id: 'loc_1', name: '仓库', description: '' }];
  doc.scenes = [1, 2].map((i): ScriptScene => ({
    id: `sc_${i}`, beatIds: [], eventIds: [], sourceParagraphIds: [], locationId: 'loc_1',
    interiorExterior: 'interior', timeOfDay: 'day', characterIds: [characterId], propIds: [],
    blocks: [{ id: `b_${i}`, type: 'dialogue', characterId, text: `第${i}段必须保留的对白` }],
  }));
  script = await ScriptService.saveManualScript({ scriptId: script.id, expectedRevision: 1, document: doc });
  script = await ScriptService.confirmScript({ scriptId: script.id, expectedRevision: script.revision });
  return { script, projectId, chapterId, characterId, doc };
}

function storyboard(f: Awaited<ReturnType<typeof fixture>>) {
  return StoryboardCandidatePayloadSchema.parse({
    scriptId: f.script.id, scriptRevision: f.script.revision, chapterId: f.chapterId, totalDuration: 6,
    coverageReport: { coveredSceneIds: ['sc_1', 'sc_2'], totalScenes: 2, coveredBlockIds: ['b_1', 'b_2'], totalAudibleBlocks: 2, coveredMustKeepEventIds: [], totalMustKeepEvents: 0 },
    shots: f.doc.scenes.map((scene, i) => {
      const source = { type: 'script' as const, script_id: f.script.id, script_revision: f.script.revision, script_scene_id: scene.id, block_ids: [scene.blocks[0]!.id] };
      return { index: i + 1, script_scene_id: scene.id, block_ids: source.block_ids, duration: 3,
        dialogue: scene.blocks[0]!.text, source,
        shot_type: i === 0 ? 'Wide Shot' : 'Medium Shot',
        visual_prompt: i === 0 ? 'abandoned warehouse, concrete walls, broad perspective, shadowy shelves' : 'young woman, bright umbrella, smiling face, amber coat, attentive gaze',
        shot_spec: packShotSpec({ source, location: '旧仓库', primary_action: i === 0 ? '人物走入仓库' : '少女抬头微笑', shot_intent: i === 0 ? 'establish' : 'medium-action', key_props: [] }),
      };
    }),
  });
}

function providerFor(value: unknown): AIProvider {
  return { generateText: async () => '', generateImage: async () => ({}),
    generateStructured: async <T>(_prompt: string, schema: z.ZodSchema<T>) => schema.parse(value) };
}

test('SC04: simultaneous edits accept only one candidate version', async () => {
  const f = await fixture();
  const candidate = await ScriptService.createPendingCandidate({ scriptId: f.script.id, kind: 'outline', expectedRevision: f.script.revision, requestKey: 'cas', afterJson: '{}' });
  const results = await Promise.allSettled(['A', 'B'].map((logline) => ScriptService.updatePendingCandidate({
    scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision,
    expectedCandidateRevision: candidate.candidate_revision, afterJson: JSON.stringify({ logline }),
  })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected?.reason.statusCode, 409);
  const row = await db.get('SELECT candidate_revision FROM script_change WHERE id = ?', candidate.id);
  assert.equal(row.candidate_revision, candidate.candidate_revision + 1);
});

test('SC08/09: edited storyboard must retain coverage, audio, identities and uniqueness', async () => {
  const f = await fixture();
  const good = storyboard(f);
  const cases = [
    (p: typeof good) => { p.shots.pop(); },
    (p: typeof good) => { p.shots[0]!.dialogue = ''; },
    (p: typeof good) => { const spec = JSON.parse(p.shots[0]!.shot_spec); spec.source.script_id = 99999; p.shots[0]!.shot_spec = JSON.stringify(spec); },
    (p: typeof good) => { p.shots[1]!.visual_prompt = p.shots[0]!.visual_prompt; },
    (p: typeof good) => {
      for (let i = 2; i < 5; i++) {
        const shot = structuredClone(p.shots[1]!);
        const source = { ...shot.source!, block_ids: [] };
        Object.assign(shot, { index: i + 1, block_ids: [], dialogue: '', source, visual_prompt: ['orange spaceship orbital launch engines', 'blue underwater coral swimming fish', 'snowy mountain forest white cabin'][i - 2] });
        shot.shot_spec = packShotSpec({ source, location: '新地点', primary_action: `独立动作${i}`, shot_intent: 'medium-action' });
        p.shots.push(shot);
      }
    },
  ];
  for (const [index, mutate] of cases.entries()) {
    const candidate = await ScriptService.createPendingCandidate({ scriptId: f.script.id, kind: 'storyboard', expectedRevision: f.script.revision, requestKey: `edited_${index}`, afterJson: JSON.stringify(good) });
    const bad = structuredClone(good); mutate(bad);
    const edited = await ScriptService.updatePendingCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision, expectedCandidateRevision: candidate.candidate_revision, afterJson: JSON.stringify(bad) });
    await assert.rejects(() => StoryboardGenerationService.applyStoryboardCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision, expectedCandidateRevision: edited.candidate_revision }));
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM scene WHERE chapter_id = ?', f.chapterId)).n, 0);
    assert.equal((await db.get('SELECT state FROM script_change WHERE id = ?', candidate.id)).state, 'pending');
  }
});

test('SC09: script updated between preflight and transaction rejects storyboard', async () => {
  const f = await fixture();
  const candidate = await ScriptService.createPendingCandidate({ scriptId: f.script.id, kind: 'storyboard', expectedRevision: f.script.revision, requestKey: 'race', afterJson: JSON.stringify(storyboard(f)) });
  const originalExec = db.exec;
  let interrupted = false;
  db.exec = async (...args: Parameters<typeof db.exec>) => {
    if (args[0] === 'BEGIN IMMEDIATE TRANSACTION' && !interrupted) {
      interrupted = true;
      db.exec = originalExec;
      await ScriptService.saveManualScript({ scriptId: f.script.id, expectedRevision: f.script.revision, document: { ...f.doc, title: 'new version' } });
    }
    return originalExec(...args);
  };
  try {
    await assert.rejects(() => StoryboardGenerationService.applyStoryboardCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision }), (error: any) => error.statusCode === 409);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM scene WHERE chapter_id = ?', f.chapterId)).n, 0);
  } finally { db.exec = originalExec; }
});

test('SC09: partial storyboard insertion rolls back and can be retried', async () => {
  const f = await fixture();
  const candidate = await ScriptService.createPendingCandidate({ scriptId: f.script.id, kind: 'storyboard', expectedRevision: f.script.revision, requestKey: 'rollback', afterJson: JSON.stringify(storyboard(f)) });
  const originalRun = db.run;
  let inserts = 0;
  db.run = async (...args: Parameters<typeof db.run>) => {
    if (args[0].includes('INSERT INTO scene (') && ++inserts === 2) throw new Error('injected second shot failure');
    return originalRun(...args);
  };
  try {
    await assert.rejects(() => StoryboardGenerationService.applyStoryboardCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision }), /injected second shot failure/);
  } finally { db.run = originalRun; }
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM scene WHERE chapter_id = ?', f.chapterId)).n, 0);
  assert.equal((await db.get('SELECT state FROM script_change WHERE id = ?', candidate.id)).state, 'pending');
  const applied = await StoryboardGenerationService.applyStoryboardCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision });
  assert.equal(applied.count, 2);
});

test('SC11: duplicate/import remap scene candidates, storyboard sources and applied result IDs', async () => {
  const f = await fixture();
  await ScriptService.createPendingCandidate({ scriptId: f.script.id, kind: 'scene', expectedRevision: f.script.revision, requestKey: 'scene-copy', afterJson: JSON.stringify(f.doc.scenes[0]), beforeJson: JSON.stringify(f.doc.scenes[0]), generationInfo: { target_scene_id: 'sc_1' } });
  const candidate = await ScriptService.createPendingCandidate({ scriptId: f.script.id, kind: 'storyboard', expectedRevision: f.script.revision, requestKey: 'story-copy', afterJson: JSON.stringify(storyboard(f)) });
  await StoryboardGenerationService.applyStoryboardCandidate({ scriptId: f.script.id, changeId: candidate.id, expectedRevision: f.script.revision });
  const app = Fastify(); await app.register(projectRoutes, { prefix: '/api/projects' });
  try {
    const duplicate = await app.inject({ method: 'POST', url: `/api/projects/${f.projectId}/duplicate`, payload: {} });
    assert.equal(duplicate.statusCode, 201);
    const exported = (await app.inject({ method: 'GET', url: `/api/projects/${f.projectId}/export` })).json();
    const imported = await restoreNovaStoryJsonProject(normalizeNovaStoryJsonProject(exported), 'local_admin');
    for (const projectId of [duplicate.json().project.id, imported.id]) {
      const chapter = await db.get('SELECT id FROM chapter WHERE project_id = ?', projectId);
      let script = (await ScriptService.getScriptByChapterId(chapter.id))!;
      const character = await db.get('SELECT id FROM character WHERE project_id = ?', projectId);
      assert.equal(script.sourceSnapshot.chapterId, chapter.id);
      assert.equal(script.sourceSnapshot.characterSnapshots[0]!.id, character.id);
      const change = await db.get("SELECT * FROM script_change WHERE script_id = ? AND kind = 'storyboard'", script.id);
      const payload = JSON.parse(change.after_json);
      assert.equal(payload.scriptId, script.id);
      assert.equal(payload.chapterId, chapter.id);
      assert.equal(JSON.parse(payload.shots[0].shot_spec).source.script_id, script.id);
      assert.equal(payload.shots[0].source.script_id, script.id);
      const timeline = await db.all('SELECT id FROM scene WHERE chapter_id = ? ORDER BY "index"', chapter.id);
      assert.deepEqual(JSON.parse(change.result_json).scene_ids, timeline.map((scene: any) => scene.id));
      const sceneCandidate = script.pendingChanges.find((c) => c.kind === 'scene')!;
      script = await ScriptService.applyCandidate({ scriptId: script.id, changeId: sceneCandidate.id, expectedRevision: script.revision });
      assert.deepEqual(script.document.scenes[0]!.characterIds, [character.id]);
      await ScriptService.confirmScript({ scriptId: script.id, expectedRevision: script.revision });
    }
  } finally { await app.close(); }
});

test('SC05/11: duplicate/import preserve stale historical sources', async () => {
  const f = await fixture();
  await db.run('UPDATE chapter SET content = ? WHERE id = ?', '来源已修改', f.chapterId);
  const app = Fastify(); await app.register(projectRoutes, { prefix: '/api/projects' });
  try {
    const duplicate = (await app.inject({ method: 'POST', url: `/api/projects/${f.projectId}/duplicate`, payload: {} })).json();
    const exported = (await app.inject({ method: 'GET', url: `/api/projects/${f.projectId}/export` })).json();
    const imported = await restoreNovaStoryJsonProject(normalizeNovaStoryJsonProject(exported), 'local_admin');
    for (const projectId of [duplicate.project.id, imported.id]) {
      const chapter = await db.get('SELECT id FROM chapter WHERE project_id = ?', projectId);
      const script = (await ScriptService.getScriptByChapterId(chapter.id))!;
      assert.equal(script.sourceSnapshot.content, '原小说正文');
      assert.equal(script.freshness.sourceChanged, true);
    }
  } finally { await app.close(); }
});

test('writing metadata null/empty protects prose in agent draft/skills and HTTP routes', async () => {
  const f = await fixture();
  const oldSkill = WritingService.executeSkill;
  const oldDraft = WritingService.generateChapterDraft;
  const oldStructured = LLMService.generateStructuredWithRetry;
  WritingService.executeSkill = async () => '新正文';
  WritingService.generateChapterDraft = async () => ({ content: '新片段', condensed: '片段摘要' });
  const app = Fastify(); await app.register(creativeRoutes, { prefix: '/api/agent' });
  try {
    for (const response of [null, { condensed: '   ', next_plot: '' }]) {
      LLMService.generateStructuredWithRetry = async () => response as any;
      for (const action of [
        { op: 'DRAFT_CONTENT', instructions: '续写' },
        { op: 'CINEMATIC_REWRITE', technique: 'sensory', instructions: '改写' },
        { op: 'ADD_CONFLICT', conflictType: 'extreme_pressure' },
        { op: 'REVERSE_PLOT', reversalType: 'motive_switch' },
      ]) {
        const result = await AgentExecutor.executeAll([action], { projectId: f.projectId, chapterId: f.chapterId, apply: true });
        assert.equal(result[0]?.status, 'error');
      }
      const draft = await app.inject({ method: 'POST', url: '/api/agent/draft', payload: { project_id: f.projectId, chapter_id: f.chapterId, instructions: '续写', apply: true } });
      assert.equal(draft.statusCode, 502);
      const skill = await app.inject({ method: 'POST', url: '/api/agent/skill', payload: { project_id: f.projectId, chapter_id: f.chapterId, skill: 'CINEMATIC_REWRITE', technique: 'sensory', apply: true } });
      assert.equal(skill.statusCode, 502);
      const chapter = await db.get('SELECT content, condensed_content FROM chapter WHERE id = ?', f.chapterId);
      assert.deepEqual(chapter, { content: '原小说正文', condensed_content: '旧摘要' });
    }
  } finally { WritingService.executeSkill = oldSkill; WritingService.generateChapterDraft = oldDraft; LLMService.generateStructuredWithRetry = oldStructured; await app.close(); }
});

test('SC07: scene rewrite rejects lost must-keep event and updates event IDs on success', async () => {
  const f = await fixture();
  const event = { id: 'ev_1', text: '林夏打开保险柜拿出红色信封', sourceParagraphIds: ['p_1'] };
  f.doc.outline.mustKeepEvents = [event];
  f.doc.scenes[0]!.eventIds = ['ev_1'];
  f.doc.scenes[0]!.blocks = [{ id: 'b_event', type: 'action', text: event.text }];
  const script = await ScriptService.saveManualScript({ scriptId: f.script.id, expectedRevision: f.script.revision, document: f.doc });
  await assert.rejects(() => ScriptGenerationService.generateSceneRewriteCandidate({ scriptId: script.id, expectedRevision: script.revision, requestKey: 'missing-event', targetSceneId: 'sc_1', provider: providerFor({ location: { name: '仓库' }, blocks: [{ type: 'action', text: '雨一直下，空无一人' }] }) }), /遗漏必保关键事件/);
  const candidate = await ScriptGenerationService.generateSceneRewriteCandidate({ scriptId: script.id, expectedRevision: script.revision, requestKey: 'kept-event', targetSceneId: 'sc_1', provider: providerFor({ location: { name: '仓库' }, blocks: [{ type: 'action', text: event.text }] }) });
  assert.deepEqual(JSON.parse(candidate.after_json).eventIds, ['ev_1']);
});

test('outline and scene apply keep the original snapshot', async () => {
  const f = await fixture();
  const before = await db.get(
    'SELECT source_snapshot_json, source_content_hash, source_context_hash FROM chapter_script WHERE id = ?',
    f.script.id
  );
  const fresh = await ScriptService.createSourceSnapshot(f.chapterId, '测试', '原小说正文', f.projectId);
  const outline = await ScriptService.createPendingCandidate({
    scriptId: f.script.id,
    kind: 'outline',
    expectedRevision: f.script.revision,
    requestKey: 'outline-current',
    afterJson: JSON.stringify({ logline: '只改提纲' }),
    sourceSnapshot: fresh,
  });
  let script = await ScriptService.applyCandidate({
    scriptId: f.script.id,
    changeId: outline.id,
    expectedRevision: f.script.revision,
  });
  assert.equal(script.document.outline.logline, '只改提纲');
  assert.equal(script.freshness.sourceChanged, false);
  const afterOutline = await db.get(
    'SELECT source_snapshot_json, source_content_hash, source_context_hash FROM chapter_script WHERE id = ?',
    f.script.id
  );
  assert.deepEqual(afterOutline, before);

  const rewritten = {
    ...f.doc.scenes[0],
    blocks: [{ id: 'b_1', type: 'dialogue' as const, characterId: f.characterId, text: '改过的对白' }],
  };
  const sceneCandidate = await ScriptService.createPendingCandidate({
    scriptId: script.id,
    kind: 'scene',
    expectedRevision: script.revision,
    requestKey: 'scene-current',
    beforeJson: JSON.stringify(f.doc.scenes[0]),
    afterJson: JSON.stringify(rewritten),
    sourceSnapshot: fresh,
    generationInfo: { target_scene_id: 'sc_1' },
  });
  script = await ScriptService.applyCandidate({
    scriptId: script.id,
    changeId: sceneCandidate.id,
    expectedRevision: script.revision,
  });
  assert.equal(script.document.scenes[0]!.blocks[0]!.text, '改过的对白');
  const afterScene = await db.get(
    'SELECT source_snapshot_json, source_content_hash, source_context_hash FROM chapter_script WHERE id = ?',
    f.script.id
  );
  assert.deepEqual(afterScene, before);

  await db.run('UPDATE chapter SET content = ? WHERE id = ?', '小说已经改写', f.chapterId);
  const drifted = await ScriptService.createSourceSnapshot(f.chapterId, '测试', '小说已经改写', f.projectId);
  const staleOutline = await ScriptService.createPendingCandidate({
    scriptId: script.id,
    kind: 'outline',
    expectedRevision: script.revision,
    requestKey: 'outline-stale',
    afterJson: JSON.stringify({ logline: '不该应用' }),
    sourceSnapshot: drifted,
  });
  await assert.rejects(
    () => ScriptService.applyCandidate({
      scriptId: script.id,
      changeId: staleOutline.id,
      expectedRevision: script.revision,
    }),
    (err: any) => err.statusCode === 409 && /keep the existing source snapshot/.test(err.message)
  );
  const staleScene = await ScriptService.createPendingCandidate({
    scriptId: script.id,
    kind: 'scene',
    expectedRevision: script.revision,
    requestKey: 'scene-stale',
    beforeJson: JSON.stringify(rewritten),
    afterJson: JSON.stringify({
      ...rewritten,
      blocks: [{ id: 'b_1', type: 'dialogue', characterId: f.characterId, text: '不该写入' }],
    }),
    sourceSnapshot: drifted,
    generationInfo: { target_scene_id: 'sc_1' },
  });
  await assert.rejects(
    () => ScriptService.applyCandidate({
      scriptId: script.id,
      changeId: staleScene.id,
      expectedRevision: script.revision,
    }),
    (err: any) => err.statusCode === 409 && /keep the existing source snapshot/.test(err.message)
  );
  const unchanged = await db.get(
    'SELECT source_snapshot_json, source_content_hash, source_context_hash FROM chapter_script WHERE id = ?',
    f.script.id
  );
  assert.deepEqual(unchanged, before);
  const current = await ScriptService.getScriptById(script.id);
  assert.equal(current.freshness.sourceChanged, true);
  assert.equal(current.document.outline.logline, '只改提纲');
  assert.equal(current.document.scenes[0]!.blocks[0]!.text, '改过的对白');

  const full = await ScriptService.createPendingCandidate({
    scriptId: current.id,
    kind: 'script',
    expectedRevision: current.revision,
    requestKey: 'full-refresh',
    afterJson: JSON.stringify(current.document),
    sourceSnapshot: drifted,
  });
  const applied = await ScriptService.applyCandidate({
    scriptId: current.id,
    changeId: full.id,
    expectedRevision: current.revision,
  });
  assert.equal(applied.freshness.sourceChanged, false);
  const refreshed = await db.get(
    'SELECT source_content_hash, source_context_hash FROM chapter_script WHERE id = ?',
    current.id
  );
  assert.equal(refreshed.source_content_hash, drifted.contentHash);
  assert.equal(refreshed.source_context_hash, drifted.contextHash);
});

test('import restores glossary, and a file without one recomputes the context hash', async () => {
  const f = await fixture();
  await db.run(
    'INSERT INTO glossary (project_id, term, definition, category) VALUES (?, ?, ?, ?)',
    f.projectId,
    '黑龙会',
    '犯罪组织',
    '组织'
  );
  await ScriptService.refreshSourceSnapshot({
    scriptId: f.script.id,
    expectedRevision: f.script.revision,
  });
  const app = Fastify();
  await app.register(projectRoutes, { prefix: '/api/projects' });
  try {
    const exported = (await app.inject({ method: 'GET', url: `/api/projects/${f.projectId}/export` })).json();
    assert.equal(exported.glossary[0].term, '黑龙会');
    assert.equal(exported.summary.glossary, 1);
    const imported = await restoreNovaStoryJsonProject(normalizeNovaStoryJsonProject(exported), 'local_admin');
    const rows = await db.all(
      'SELECT term, definition, category FROM glossary WHERE project_id = ? ORDER BY id ASC',
      imported.id
    );
    assert.deepEqual(rows, [{ term: '黑龙会', definition: '犯罪组织', category: '组织' }]);
    const chapter = await db.get('SELECT id FROM chapter WHERE project_id = ?', imported.id);
    const restored = (await ScriptService.getScriptByChapterId(chapter.id))!;
    assert.equal(restored.freshness.sourceChanged, false);

    delete exported.glossary;
    const withoutGlossary = await restoreNovaStoryJsonProject(
      normalizeNovaStoryJsonProject(exported),
      'local_admin'
    );
    const missingTerms = await db.all('SELECT term FROM glossary WHERE project_id = ?', withoutGlossary.id);
    assert.deepEqual(missingTerms, []);
    const bareChapter = await db.get('SELECT id FROM chapter WHERE project_id = ?', withoutGlossary.id);
    const bare = (await ScriptService.getScriptByChapterId(bareChapter.id))!;
    assert.equal(bare.freshness.sourceChanged, false);
    assert.notEqual(bare.sourceContextHash, exported.screenplay.scripts[0].source_context_hash);
  } finally {
    await app.close();
  }
});

test('imported applied_revision null stays null', () => {
  const normalized = normalizeNovaStoryJsonProject({
    format: 'novastory-project',
    project: { title: '修订' },
    screenplay: {
      chapters: [{ id: 'c1', title: '章', content: '正文' }],
      scripts: [{
        chapter_id: 'c1',
        document: { schemaVersion: 1 },
        changes: [
          { state: 'pending', applied_revision: null, after_json: { logline: '' } },
          { state: 'applied', applied_revision: 3, after_json: { logline: '' } },
        ],
      }],
    },
  });
  assert.equal(normalized.scripts[0]!.changes[0]!.appliedRevision, null);
  assert.equal(normalized.scripts[0]!.changes[1]!.appliedRevision, 3);
  assert.equal(normalized.glossaryProvided, false);
});

test('scene rewrite attributes an event only to the scene that already owns it', async () => {
  const f = await fixture();
  const own = { id: 'ev_1', text: '林夏打开保险柜拿出红色信封', sourceParagraphIds: ['p_1'] };
  const other = { id: 'ev_2', text: '苏晚举起火把照亮石门', sourceParagraphIds: ['p_2'] };
  f.doc.outline.mustKeepEvents = [own, other];
  f.doc.scenes[0]!.eventIds = ['ev_1'];
  f.doc.scenes[0]!.blocks = [{ id: 'b_event', type: 'action', text: own.text }];
  f.doc.scenes[1]!.eventIds = ['ev_2'];
  f.doc.scenes[1]!.blocks = [{ id: 'b_other', type: 'action', text: `${own.text}。旁边还有别的动作` }];
  const script = await ScriptService.saveManualScript({
    scriptId: f.script.id,
    expectedRevision: f.script.revision,
    document: f.doc,
  });
  let seenPrompt = '';
  const provider = (value: unknown): AIProvider => ({
    generateText: async () => '',
    generateImage: async () => ({}),
    generateStructured: async <T>(prompt: string, schema: z.ZodSchema<T>) => {
      seenPrompt = prompt;
      return schema.parse(value);
    },
  });
  await assert.rejects(
    () => ScriptGenerationService.generateSceneRewriteCandidate({
      scriptId: script.id,
      expectedRevision: script.revision,
      requestKey: 'lost-only-copy',
      targetSceneId: 'sc_1',
      provider: provider({ location: { name: '仓库' }, blocks: [{ type: 'action', text: '雨一直下，空无一人' }] }),
    }),
    /遗漏必保关键事件/
  );
  const kept = await ScriptGenerationService.generateSceneRewriteCandidate({
    scriptId: script.id,
    expectedRevision: script.revision,
    requestKey: 'keep-own-event',
    targetSceneId: 'sc_1',
    provider: provider({
      location: { name: '仓库' },
      blocks: [{ type: 'action', text: `${own.text}。${other.text}` }],
    }),
  });
  assert.deepEqual(JSON.parse(kept.after_json).eventIds, ['ev_1']);
  assert.match(seenPrompt, /林夏打开保险柜拿出红色信封/);

  f.doc.scenes[0]!.eventIds = ['ev_1'];
  f.doc.scenes[1]!.eventIds = ['ev_1', 'ev_2'];
  f.doc.scenes[1]!.blocks = [{ id: 'b_other', type: 'action', text: own.text }];
  const shared = await ScriptService.saveManualScript({
    scriptId: script.id,
    expectedRevision: script.revision,
    document: f.doc,
  });
  const dropped = await ScriptGenerationService.generateSceneRewriteCandidate({
    scriptId: shared.id,
    expectedRevision: shared.revision,
    requestKey: 'covered-elsewhere',
    targetSceneId: 'sc_1',
    provider: provider({ location: { name: '仓库' }, blocks: [{ type: 'action', text: '雨一直下，空无一人' }] }),
  });
  assert.deepEqual(JSON.parse(dropped.after_json).eventIds, []);
});

test('character matching prefers exact/longest names and rejects equally ambiguous matches', () => {
  const chars = [{ id: 1, name: '王' }, { id: 2, name: '王总监' }];
  assert.equal(matchProjectCharacter('王总', chars)?.id, 2);
  assert.equal(matchProjectCharacter('王', chars)?.id, 1);
  assert.equal(matchProjectCharacter('王总', [{ id: 1, name: '王总监' }, { id: 2, name: '王总裁' }]), null);
});
