import '../test_setup';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db } from '../db/database';
import { confirmedContinuityFixture } from '../test_fixtures/continuity_confirmed';
import { createEmptyScriptDocument } from '../schemas/script';
import { ScriptService } from './script_service';
import { commitContinuityLedger, bindContinuityShot } from './continuity_store';
import { createSceneProductionCandidate, previewSceneProductionApply, applySceneProduction, sceneProductionView } from './scene_production';
import { sceneProductionRoutes } from '../routes/scene_production';
import { StoryboardGenerationService } from './ai/storyboard_generation_service';
import { requireCurrentContinuityShot } from './continuity_shot_gate';
import { ensureSceneVersionBaseline } from './scene_versions';

beforeEach(async () => { await db.run("DELETE FROM generation_task WHERE task_id='active'"); await db.run('DELETE FROM project WHERE id=10'); });
async function seed() {
  const fixture = confirmedContinuityFixture('F06', 'upstream-revision'), doc = createEmptyScriptDocument('CT15/16');
  doc.locations = [{ id: 'room', name: '房间', description: '' }];
  doc.scenes = fixture.input.context.order.scenes.map(scene => ({ id: scene.script_scene_id, locationId: 'room', interiorExterior: 'interior' as const, timeOfDay: 'day', characterIds: [], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: fixture.fixture.sources.filter(source => source.scene_id === scene.script_scene_id).map(source => ({ id: source.id, type: 'action' as const, text: source.text })) }));
  doc.scenes[0]!.blocks.push({ id: 'sound', type: 'sound', text: '雨声' } as any);
  const content = fixture.fixture.sources.map(source => source.text).join('\n');
  await db.run("INSERT INTO project(id,title,user_id,settings) VALUES(10,'CT15','reviewer','{}')");
  await db.run("INSERT INTO chapter(id,project_id,\"index\",title,content) VALUES('ct15',10,0,'CT15',?)", content);
  await db.run("INSERT INTO character(id,project_id,name,english_name) VALUES(1,10,'林岚','Lin Lan'),(2,10,'陈月','Chen Yue')");
  const snapshot = await ScriptService.createSourceSnapshot('ct15', 'CT15', content, 10);
  await db.run("INSERT INTO chapter_script(id,chapter_id,revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash) VALUES(30,'ct15',1,'confirmed',?,?,?,?)", JSON.stringify(doc), JSON.stringify(snapshot), snapshot.contentHash, snapshot.contextHash);
  await commitContinuityLedger({ script_id: 30, expected_revision: 0, expected_script_revision: 1, request_key: 'entry', actor_id: 'reviewer', reason: 'fixture', input: fixture.input });
  for (const [index, scene] of doc.scenes.entries()) {
    await db.run("INSERT INTO scene(id,chapter_id,\"index\",visual_prompt,audio_prompt,asset_url,asset_status,shot_spec) VALUES(?,'ct15',?,'old prompt','old rain','/old.svg','completed',?)", 101 + index, index + 1, JSON.stringify({ location: '房间', primary_action: scene.blocks[0]!.text, source: { type: 'script', script_id: 30, script_revision: 1, script_scene_id: scene.id, block_ids: scene.blocks.filter(block => block.type === 'action').map(block => block.id) } }));
    await ensureSceneVersionBaseline(101 + index);
    await bindContinuityShot(101 + index, { script_id: 30, script_scene_id: scene.id, moment_id: `${scene.id}:exit`, phase: 'after', reads: [{ entity_id: 'F06:u1', attribute_id: 'integrity' }] });
  }
  const target = doc.scenes[0]!;
  const draft = { target_scene_id: target.id, expected_script_revision: 1, expected_continuity_revision: 1, request_key: 'draft', round: 'skeleton', shots: [{ block_ids: [target.blocks[0]!.id], moment_id: `${target.id}:exit`, phase: 'after', reads: [{ entity_id: 'F06:u1', attribute_id: 'integrity' }], duration: 5 }] };
  const apply = { target_scene_id: target.id, expected_script_revision: 1, expected_continuity_revision: 1, expected_candidate_revision: 1, expected_timeline_revision: 0, replace_scene_ids: [101], request_key: 'adopt' };
  return { fixture, doc, draft, apply };
}
test('CT15 rounds preserve source/state gates while a skeleton explicitly retains audible coverage gaps', async () => {
  const f = await seed(), before = await db.all('SELECT * FROM scene ORDER BY id');
  const candidate = await createSceneProductionCandidate(30, f.draft);
  assert.equal(candidate.payload.round, 'skeleton'); assert.equal(candidate.payload.coverage.complete, false);
  assert.deepEqual(candidate.payload.coverage.gaps.map(gap => gap.block_id), ['sound']);
  assert.deepEqual(await db.all('SELECT * FROM scene ORDER BY id'), before);
  assert.ok(JSON.parse(candidate.payload.shots[0].shot_spec).continuity_states.some((state: any) => state.entity_id === 'F06:u1'));
  for (const round of ['continuity', 'look', 'completion']) assert.equal((await createSceneProductionCandidate(30, { ...f.draft, round, request_key: round })).payload.round, round);
  assert.equal((await createSceneProductionCandidate(30, f.draft)).replayed, true);
  await assert.rejects(() => createSceneProductionCandidate(30, { ...f.draft, target_scene_id: f.doc.scenes[1]!.id }), /outside.*selected scene/);
  await assert.rejects(() => StoryboardGenerationService.applyStoryboardCandidate({ scriptId: 30, changeId: candidate.id, expectedRevision: 1 }), /单场候选/);
});
test('CT16 local adoption retains replaced image/version, every other scene and audio, and replays exact idempotent result', async () => {
  const f = await seed(), other = await db.all('SELECT * FROM scene WHERE id<>101 ORDER BY id');
  const candidate = await createSceneProductionCandidate(30, f.draft), preview = await previewSceneProductionApply(30, candidate.id, f.apply);
  const body = { ...f.apply, expected_impact_hash: preview.impact_hash }, result = await applySceneProduction(30, candidate.id, body);
  assert.deepEqual(result.scene_ids, [101]); assert.equal(result.timeline_revision, 1);
  assert.deepEqual(await db.all('SELECT * FROM scene WHERE id<>101 ORDER BY id'), other);
  assert.equal((await db.get('SELECT asset_url FROM scene_version WHERE scene_id=101 AND version=1')).asset_url, '/old.svg');
  assert.equal((await db.get('SELECT audio_prompt FROM scene_version WHERE scene_id=101 AND version=1')).audio_prompt, 'old rain');
  const current = await db.get('SELECT * FROM scene WHERE id=101');
  assert.equal(current.asset_url, null); assert.equal(current.active_version, 2); await requireCurrentContinuityShot(current);
  assert.equal((await applySceneProduction(30, candidate.id, body)).replayed, true);
  assert.equal((await db.get('SELECT COUNT(*) n FROM scene_production_receipt')).n, 1);
  await assert.rejects(() => applySceneProduction(30, candidate.id, { ...body, replace_scene_ids: [] }), /another reviewed range/);
});
test('CT16 another-scene range, stale impact, concurrent timeline and pending jobs cannot adopt', async () => {
  const f = await seed(), candidate = await createSceneProductionCandidate(30, f.draft);
  await assert.rejects(() => previewSceneProductionApply(30, candidate.id, { ...f.apply, replace_scene_ids: [102] }), /another screenplay scene/);
  const preview = await previewSceneProductionApply(30, candidate.id, f.apply);
  await db.run('UPDATE scene SET audio_prompt=? WHERE id=103', 'changed elsewhere');
  await assert.rejects(() => applySceneProduction(30, candidate.id, { ...f.apply, expected_impact_hash: preview.impact_hash }), /Preview.*first/);
  const refreshed = await previewSceneProductionApply(30, candidate.id, f.apply);
  await db.run("INSERT INTO generation_task(task_id,scene_id,kind,status) VALUES('active',101,'image','processing')");
  await assert.rejects(() => applySceneProduction(30, candidate.id, { ...f.apply, expected_impact_hash: refreshed.impact_hash }), /still being produced/);
  assert.equal((await db.get('SELECT active_version FROM scene WHERE id=101')).active_version, 1);
});
test('CT16 a mid-transaction failure rolls back scene/version, candidate, references and receipt', async t => {
  const f = await seed(), candidate = await createSceneProductionCandidate(30, f.draft), preview = await previewSceneProductionApply(30, candidate.id, f.apply);
  const before = await db.all('SELECT * FROM scene ORDER BY id'), versions = await db.all('SELECT * FROM scene_version ORDER BY id');
  const original = db.run.bind(db);
  const mock = t.mock.method(db, 'run', async (sql: string, ...args: any[]) => { if (sql.startsWith('INSERT INTO scene_production_frame')) throw new Error('simulated rollback'); return original(sql, ...args); });
  await assert.rejects(() => applySceneProduction(30, candidate.id, { ...f.apply, expected_impact_hash: preview.impact_hash }), /simulated rollback/); mock.mock.restore();
  assert.deepEqual(await db.all('SELECT * FROM scene ORDER BY id'), before); assert.deepEqual(await db.all('SELECT * FROM scene_version ORDER BY id'), versions);
  assert.equal((await db.get('SELECT state FROM script_change WHERE id=?', candidate.id)).state, 'pending');
  assert.equal((await db.get('SELECT COUNT(*) n FROM scene_production_receipt')).n, 0);
});
test('CT15/16 HTTP keeps independent local route and explicit preview before adoption', async () => {
  const f = await seed(), app = Fastify(); await app.register(sceneProductionRoutes, { prefix: '/api' });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/scripts/30/production/candidates', payload: f.draft });
    assert.equal(created.statusCode, 201); const candidate = created.json();
    assert.equal((await app.inject({ method: 'POST', url: `/api/scripts/30/storyboard-candidates/${candidate.id}/apply-scene`, payload: f.apply })).statusCode, 409);
    const preview = (await app.inject({ method: 'POST', url: `/api/scripts/30/storyboard-candidates/${candidate.id}/preview-scene`, payload: f.apply })).json();
    assert.equal((await app.inject({ method: 'POST', url: `/api/scripts/30/storyboard-candidates/${candidate.id}/apply-scene`, payload: { ...f.apply, expected_impact_hash: preview.impact_hash } })).statusCode, 200);
    assert.equal((await sceneProductionView(30)).timeline_revision, 1);
  } finally { await app.close(); }
});

test('CT16 local adoption pairs replacements by timeline order and keeps the candidate as one span', async () => {
  const f = await seed();
  const target = f.doc.scenes[0]!;
  const spec = (await db.get('SELECT shot_spec FROM scene WHERE id=101')).shot_spec;
  await db.run("INSERT INTO scene(id,chapter_id,\"index\",visual_prompt,audio_prompt,dialogue,asset_url,asset_status,shot_spec) VALUES(201,'ct15',1.2,'later prompt','later rain','后句','/later.svg','completed',?)", spec);
  await db.run("INSERT INTO scene(id,chapter_id,\"index\",visual_prompt,audio_prompt,asset_url,asset_status,shot_spec) VALUES(202,'ct15',1.4,'end prompt','end rain','/end.svg','completed',?)", spec);
  await ensureSceneVersionBaseline(201);
  await ensureSceneVersionBaseline(202);
  const others = await db.all('SELECT * FROM scene WHERE id IN (102,103) ORDER BY id');
  const draft = { ...f.draft, request_key: 'ordered', shots: [5, 6, 7].map(duration => ({ ...f.draft.shots[0], duration })) };
  const candidate = await createSceneProductionCandidate(30, draft);
  const apply = { ...f.apply, request_key: 'ordered-adopt', replace_scene_ids: [202, 101] };
  const preview = await previewSceneProductionApply(30, candidate.id, apply);
  assert.deepEqual(preview.replacement_ids, [101, 202]);
  assert.deepEqual(preview.placement.map(item => item.role), ['replaced', 'replaced', 'inserted', 'kept']);
  assert.equal(preview.placement[3]!.scene_id, 201);
  const result = await applySceneProduction(30, candidate.id, { ...apply, expected_impact_hash: preview.impact_hash });
  assert.deepEqual(result.scene_ids.slice(0, 2), [101, 202]);
  const rows = await db.all('SELECT id, duration, asset_url, audio_prompt FROM scene ORDER BY "index", id');
  const span = rows.filter((row: any) => [101, 201, 202, result.scene_ids[2]].includes(row.id));
  assert.deepEqual(span.map((row: any) => row.id), [101, 202, result.scene_ids[2], 201]);
  assert.deepEqual(span.map((row: any) => row.duration), [5, 6, 7, 3]);
  assert.equal(span[3].asset_url, '/later.svg');
  assert.equal(span[3].audio_prompt, 'later rain');
  assert.deepEqual(await db.all('SELECT * FROM scene WHERE id IN (102,103) ORDER BY id'), others);
});
