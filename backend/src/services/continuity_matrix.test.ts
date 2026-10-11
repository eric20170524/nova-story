import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db } from '../db/database';
import { loadContinuityFixtures } from '../test_fixtures/continuity';
import { confirmedContinuityFixture } from '../test_fixtures/continuity_confirmed';
import { createEmptyScriptDocument } from '../schemas/script';
import { continuityRoutes } from '../routes/continuity';
import { projectRoutes } from '../routes/projects';
import { timelineRoutes } from '../routes/timeline';
import { coverageRoutes } from '../routes/coverage';
import { bindContinuityShot, currentContinuitySnapshot, loadContinuityLedger, commitContinuityLedger } from './continuity_store';
import { confirmContinuityOverlay, continuityOverlayHash, replayContinuityScene, readContinuityMoment } from './continuity_replay';
import { confirmContinuityChange } from './continuity_confirmation';
import { requireCurrentContinuityShot } from './continuity_shot_gate';
import { LLMService } from './llm';
import { normalizeNovaStoryJsonProject } from './import/novastory_json_model';
import { restoreNovaStoryJsonProject } from './import/novastory_json_import';
import type { ContinuityOverlayProposal } from '../schemas/continuity_snapshot';

const dataset = loadContinuityFixtures();
async function setup(fixtureId: string, caseId: string) {
  await db.run('DELETE FROM project');
  const data = confirmedContinuityFixture(fixtureId, caseId === 'out-of-order' ? 'ordered' : caseId);
  const doc = createEmptyScriptDocument(`CT08 ${fixtureId}`); doc.locations = [{ id: 'room', name: '房间', description: '' }];
  const sceneIds = [...new Set([...data.input.context.order.scenes.map(scene => scene.script_scene_id), ...data.fixture.shots.map(shot => shot.scene_id)])].sort();
  doc.scenes = sceneIds.map(id => ({ id, locationId: 'room', interiorExterior: 'interior' as const, timeOfDay: 'day', characterIds: [], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [],
    blocks: data.fixture.sources.filter(source => source.scene_id === id).map(source => ({ id: source.id, type: 'action' as const, text: source.text })) }));
  await db.run("INSERT INTO project(id,title,user_id,settings) VALUES(10,'CT08','local_admin','{}')");
  await db.run("INSERT INTO chapter(id,project_id,\"index\",title,content) VALUES('matrix',10,0,'CT08',?)", data.fixture.sources.map(source => source.text).join('\n'));
  await db.run("INSERT INTO character(id,project_id,name) VALUES(1,10,'林岚'),(2,10,'陈月')");
  await db.run("INSERT INTO chapter_script(id,chapter_id,revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash) VALUES(30,'matrix',1,'confirmed',?,'{}','fixture','fixture')", JSON.stringify(doc));
  for (const [index, shot] of data.fixture.shots.entries()) await db.run('INSERT INTO scene(id,chapter_id,"index",asset_url,asset_status,audio_prompt,shot_spec) VALUES(?,\'matrix\',?, ?,\'completed\',\'retained sound\',?)', 101 + index, index,
    `/static/fixtures/${fixtureId}-${index}.svg`, JSON.stringify({ location: '房间', primary_action: data.fixture.sources.find(source => source.scene_id === shot.scene_id)?.text || '保留该场可见动作。', visible_subjects: [], key_props: [], source: { script_id: 30, script_scene_id: shot.scene_id, block_ids: [] } }));
  const app = Fastify(); await app.register(continuityRoutes, { prefix: '/api' });
  if (fixtureId === 'F05') await app.register(coverageRoutes, { prefix: '/api' });
  if (caseId === 'copy-and-import') await app.register(projectRoutes, { prefix: '/api/projects' });
  if (caseId === 'direct-write-bypass') await app.register(timelineRoutes, { prefix: '/api/timeline' });
  const get = async (target = sceneIds.at(-1)!) => (await app.inject({ method: 'GET', url: `/api/scripts/30/continuity?target_scene_id=${encodeURIComponent(target)}` })).json();
  const initial = await get();
  const evidence = (sourceId: string) => { const source = initial.sources.find((source: any) => source.source_type === 'screenplay' && source.text === data.fixture.sources.find(source => source.id === sourceId)!.text); return { kind: 'source', source_type: source.source_type, source_document_id: source.source_document_id, source_revision: source.source_revision, source_text_hash: source.source_text_hash, evidence_quote: source.text, start: 0, end: source.text.length }; };
  const changes = data.input.changes.map(change => ({ ...change.proposal, evidence: change.proposal.evidence.map(item => item.kind === 'source' ? evidence(item.source_document_id) : item) }));
  const base = { review_action: 'human_review', target_scene_id: sceneIds[0], expected_script_revision: 1, expected_continuity_revision: 0, request_key: 'matrix-entry', reason: '独立预标注人工入口', replace_all: true, entities: data.input.context.entities,
    entry_values: Object.entries(data.fixture.initial_state).flatMap(([entity_id, attributes]) => Object.entries(attributes).map(([attribute_id, value]) => value && typeof value === 'object' ? { entity_id, attribute_id, knowledge_status: 'unknown' } : { entity_id, attribute_id, knowledge_status: 'confirmed', value })), changes };
  const post = (body: any) => app.inject({ method: 'POST', url: '/api/scripts/30/continuity/confirm', payload: body });
  return { ...data, proposalBase: data.base, app, doc, sceneIds, base, post, get, evidence };
}

for (const { fixture } of dataset) for (const row of fixture.cases) test(`CT08 frozen ${fixture.id}/${row.id}`, async () => {
  const data = await setup(fixture.id, row.id), { app, base, post, get } = data;
  try {
    if (row.id === 'missing-entry' || row.id === 'legacy-no-snapshot') {
      const view = await get(); assert.equal(view.snapshot, null); assert.equal(view.issues[0].code, 'CONTINUITY_ENTRY_REQUIRED');
      assert.ok(view.shots.every((shot: any) => shot.asset_url));
      await assert.rejects(requireCurrentContinuityShot(await db.get('SELECT * FROM scene WHERE id=101')), /Confirm|confirmed|continuity/i);
      assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_ledger')).n, 0); return;
    }
    let overlay: any;
    if (fixture.id === 'F04' && row.expected.moments?.some(moment => moment.phase === 'during')) {
      const during = row.expected.moments.find(moment => moment.phase === 'during')!, event = base.changes.find(change => change.attribute_id === 'integrity');
      const position = event?.story_position || data.proposalBase.story_position;
      overlay = { schema_version: 1, policy_version: 'continuity-state-1', overlay_id: during.id, overlay_revision: 1, binding_revision: 1, story_position: { ...position, phase: 'during', moment_id: during.id }, event_change_id: event?.change_id ?? null, after_change_id: null,
        values: Object.entries(during.overlay!).flatMap(([entity_id, attrs]) => Object.entries(attrs).map(([attribute_id, value]) => ({ entity_id, attribute_id, value: attribute_id === 'visible_position' ? { mode: value } : value }))),
        evidence: during.source_id ? [data.evidence(during.source_id)] : [{ kind: 'design', design_id: 'manual:F04:cup', design_revision: 1 }] };
      (base as any).during_overlays = [overlay];
    }
    const confirmed = await post(base); assert.equal(confirmed.statusCode, 200, confirmed.body);
    const view = await get(); assert.equal(view.status, 'ready');
    for (const [entity, attributes] of Object.entries(row.expected.checks)) for (const [attribute, value] of Object.entries(attributes)) {
      const cell = view.snapshot.exit_state.find((cell: any) => cell.entity_id === entity && cell.attribute_id === attribute); assert.ok(cell, `${entity}.${attribute}`);
      if (value && typeof value === 'object') assert.equal(cell.knowledge_status, 'unknown'); else { assert.equal(cell.knowledge_status, 'confirmed'); assert.equal(cell.value, value); }
    }
    const current = await currentContinuitySnapshot(30, data.sceneIds.at(-1)!);
    if (overlay) {
      const read = readContinuityMoment(current.snapshot, overlay.story_position.moment_id, 'during', overlay.values.map((value: any) => ({ entity_id: value.entity_id, attribute_id: value.attribute_id })));
      assert.equal(read.values.find(value => value.attribute_id === 'holder')!.value, null);
      assert.deepEqual(read.values.find(value => value.attribute_id === 'visible_position')!.value, { mode: 'airborne' });
      assert.equal(current.snapshot.moments.find(moment => moment.story_position.moment_id === overlay.story_position.moment_id)!.state.find(cell => cell.attribute_id === 'integrity')!.knowledge_status, 'confirmed');
      assert.equal(current.snapshot.exit_state.some(cell => String(cell.attribute_id) === 'visible_position'), false);
      if (!overlay.event_change_id) assert.equal(current.snapshot.confirmed_changes.length, 0);
    }
    if (row.id === 'ordered' || row.id === 'out-of-order') {
      const ordered = await Promise.all([1, 2, 3].map(index => currentContinuitySnapshot(30, `F01:s${index}`)));
      const unordered = await Promise.all([3, 1, 2].map(index => currentContinuitySnapshot(30, `F01:s${index}`)));
      assert.deepEqual(ordered.map(value => [value.snapshot.script_scene_id, value.snapshot.state_hash, value.snapshot.source_hash]).sort(), unordered.map(value => [value.snapshot.script_scene_id, value.snapshot.state_hash, value.snapshot.source_hash]).sort());
      assert.equal((await db.get('SELECT COUNT(*) n FROM script_change')).n, 0);
    }
    if (row.id === 'missing-during-evidence') assert.throws(() => readContinuityMoment(current.snapshot, 'F04:airborne', 'during', [{ entity_id: 'F04:cup', attribute_id: 'integrity' }]), /Selected moment/);
    if (row.id === 'unknown-is-not-dry') assert.throws(() => readContinuityMoment(current.snapshot, `${current.snapshot.script_scene_id}:exit`, 'after', [{ entity_id: 'F02:coat1', attribute_id: 'wetness' }]), /unknown/);
    if (row.id === 'ambiguous-identity' || row.id === 'unconfirmed-wrong-owner') {
      const ledger = await loadContinuityLedger(30);
      const proposal = { ...data.proposalBase, story_position:{...ledger.input!.entry!.story_position,phase:'after',moment_id:'unconfirmed-model'}, origin: 'model', basis: 'story', entity_id: fixture.id === 'F02' ? 'F02:coat1' : 'F07:coat', attribute_id: 'wearer', value: `${fixture.id}:lin`, evidence: [data.evidence(row.source_ids[0]!)] };
      const result = confirmContinuityChange(proposal, ledger.input!.context);
      assert.equal(result.status, 'pending_review'); if (result.status === 'pending_review') assert.equal(result.issues[0]!.code, 'CONTINUITY_REVIEW_REQUIRED');
      const forged = { ...ledger.input!, changes: [{ proposal, confirmation: { kind: 'human', actor_id: 'model', faithful: true } }] } as any;
      await assert.rejects(commitContinuityLedger({ script_id: 30, expected_revision: 1, expected_script_revision: 1, request_key: 'forged', actor_id: 'model', reason: 'self audit', input: forged }));
      assert.equal((await loadContinuityLedger(30)).revision, 1);
    }
    if (row.id === 'shared-holder' || row.id === 'unknown-time') {
      const invalid = { ...base, request_key: 'pending', expected_continuity_revision: 1,
        ...(row.id === 'unknown-time' ? { time_relation: 'unknown' } : { changes: [{ ...data.proposalBase, basis: 'story', origin: 'human_entry', entity_id: 'F07:u1', attribute_id: 'holder', value: row.expected.retained_entity_ids, evidence: [data.evidence('shared')] }] }) };
      const result = await post(invalid); assert.equal(result.statusCode, 409, result.body);
      assert.equal(result.json().code, row.id === 'unknown-time' ? 'CONTINUITY_TIME_REVIEW_REQUIRED' : 'CONTINUITY_SHARED_HOLDER_UNSUPPORTED');
      const suggestions = (await get()).pending_suggestions; assert.equal(suggestions.length, 1);
      if (row.id === 'shared-holder') assert.deepEqual(suggestions[0].raw.review.changes[0].value, row.expected.retained_entity_ids);
    }
    if (row.id === 'repeat-and-equivalent-permutation' || row.id === 'evidence-revision') {
      const input = (await loadContinuityLedger(30)).input!, old = replayContinuityScene(input, data.sceneIds[0]!); assert.equal(old.status, 'ready');
      const altered = { ...input, context: { ...input.context, entities: [...input.context.entities].reverse(), sources: row.id === 'evidence-revision' ? input.context.sources.map(source => ({ ...source, source_revision: 2, text: `${source.text}\n` })) : [...input.context.sources].reverse() } };
      const next = replayContinuityScene(altered, data.sceneIds[0]!); assert.equal(next.status, 'ready');
      if (old.status === 'ready' && next.status === 'ready') { assert.equal(next.snapshot.state_hash, old.snapshot.state_hash); assert.equal(next.snapshot.source_hash === old.snapshot.source_hash, row.id !== 'evidence-revision'); }
    }
    if (row.id === 'copy-and-import') {
      const copy = await app.inject({ method: 'POST', url: '/api/projects/10/duplicate', payload: {} }); assert.equal(copy.statusCode, 201, copy.body);
      const scripts = await db.all('SELECT cs.id FROM chapter_script cs JOIN chapter c ON c.id=cs.chapter_id WHERE c.project_id=?', copy.json().project.id); assert.equal(scripts.length, 1);
      const copied = await loadContinuityLedger(scripts[0].id); assert.ok(copied.input);
      assert.ok(copied.input.context.entities.every(entity => entity.project_id === copy.json().project.id && !base.entities.some(old => old.entity_id === entity.entity_id)));
      const component = copied.input.context.entities.find(entity => entity.kind === 'component')!;
      assert.ok(copied.input.context.entities.some(entity => entity.entity_id === component.parent_entity_id));
      const backup = await app.inject({ method: 'GET', url: `/api/projects/${copy.json().project.id}/export` }); assert.equal(backup.statusCode, 200, backup.body); assert.ok(backup.json().continuity.signature);
      const imported=await restoreNovaStoryJsonProject(normalizeNovaStoryJsonProject(backup.json()),'local_admin');
      const importedScript=await db.get('SELECT cs.id FROM chapter_script cs JOIN chapter c ON c.id=cs.chapter_id WHERE c.project_id=?',imported.id);
      const restored=await loadContinuityLedger(importedScript.id);assert.ok(restored.input);
      assert.ok(restored.input.context.entities.every(entity=>entity.project_id===imported.id&&!copied.input!.context.entities.some(old=>old.entity_id===entity.entity_id)));
      const lock=restored.input.context.entities.find(entity=>entity.kind==='component')!;
      assert.ok(restored.input.context.entities.some(entity=>entity.entity_id===lock.parent_entity_id));
      assert.equal(restored.input.entry!.state.find(cell=>cell.attribute_id==='wearer')!.knowledge_status,'confirmed');
      assert.equal((await db.get('SELECT COUNT(*) n FROM scene s JOIN chapter c ON c.id=s.chapter_id WHERE c.project_id=? AND s.asset_url IS NOT NULL',imported.id)).n,2);
    }
    if (row.id === 'direct-write-bypass') {
      const direct = await app.inject({ method: 'POST', url: '/api/timeline/generate', payload: { chapter_id: 'matrix' } });
      assert.equal(direct.statusCode, 410); assert.equal(direct.json().code, 'TIMELINE_DIRECT_WRITE_DISABLED');
    }
    if (['all-three-endpoints', 'stale-source'].includes(row.id)) {
      await bindContinuityShot(102, { script_id: 30, script_scene_id: 'F05:s2', moment_id: 'F05:s2:exit', phase: 'after', reads: [{ entity_id: 'F05:u1', attribute_id: 'holder' }, { entity_id: 'F05:u1', attribute_id: 'integrity' }] });
      const original = LLMService.generateSceneCoverage; LLMService.generateSceneCoverage = async () => Array.from({ length: 9 }, (_, index) => ({ slot: index + 1, shot_size: 'Medium Shot' }));
      try {
        const before = await db.all('SELECT * FROM scene WHERE id IN (101,103) ORDER BY id');
        const generated = await app.inject({ method: 'POST', url: '/api/scenes/102/coverage' }); assert.equal(generated.statusCode, 200, generated.body);
        const shots = generated.json().shots;
        if (row.id === 'stale-source') {
          await db.run('UPDATE chapter_script SET revision=2 WHERE id=30');
          const stale = await app.inject({ method: 'POST', url: `/api/scenes/coverage/${shots[0].id}/apply` }); assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'CONTINUITY_STALE');
        } else {
          const apply = await app.inject({ method: 'POST', url: `/api/scenes/coverage/${shots[0].id}/apply` }); assert.equal(apply.statusCode, 200, apply.body);
          for (const [index, position] of ['before', 'after', 'replace'].entries()) { const promoted = await app.inject({ method: 'POST', url: `/api/scenes/coverage/${shots[index + 1].id}/promote`, payload: { position } }); assert.equal(promoted.statusCode, 200, promoted.body); }
          assert.equal((await loadContinuityLedger(30)).input!.changes.length, 0);
        }
        const after = await db.all('SELECT * FROM scene WHERE id IN (101,103) ORDER BY id');
        assert.deepEqual(after.map(({ index, ...row }) => row), before.map(({ index, ...row }) => row));
        assert.equal((await db.get('SELECT audio_prompt FROM scene WHERE id=102')).audio_prompt, 'retained sound');
        assert.ok((await db.get('SELECT asset_url FROM scene_version WHERE scene_id=102 AND version=1')).asset_url);
      } finally { LLMService.generateSceneCoverage = original; }
    }
    if (row.id === 'reject-destructive-invalidation' || row.id === 'story-order-revision') {
      await bindContinuityShot(101, { script_id: 30, script_scene_id: data.sceneIds.at(-1)!, moment_id: `${data.sceneIds.at(-1)}:exit`, phase: 'after', reads: fixture.shots[0]!.reads as any });
      const old = await db.get('SELECT * FROM scene WHERE id=101');
      await db.run('UPDATE chapter_script SET revision=2 WHERE id=30');
      await assert.rejects(requireCurrentContinuityShot(await db.get('SELECT * FROM scene WHERE id=101')));
      assert.deepEqual(await db.get('SELECT * FROM scene WHERE id=101'), old);
      assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_revision')).n, 1);
    }
  } finally { await app.close(); }
});
