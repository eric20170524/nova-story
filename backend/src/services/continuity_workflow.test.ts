import '../test_setup';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { db } from '../db/database';
import { confirmedContinuityFixture } from '../test_fixtures/continuity_confirmed';
import { createEmptyScriptDocument } from '../schemas/script';
import { ScriptService } from './script_service';
import { commitContinuityLedger, bindContinuityShot, currentContinuitySnapshot } from './continuity_store';
import { StoryboardGenerationService } from './ai/storyboard_generation_service';
import type { AIProvider } from './ai/base';
import { LLMService } from './llm';
import { coverageRoutes } from '../routes/coverage';
import { requireCurrentContinuityShot } from './continuity_shot_gate';
import { canonicalContinuityJson, confirmContinuityOverlay, continuityOverlayHash } from './continuity_replay';
import type { ContinuityOverlayProposal } from '../schemas/continuity_snapshot';

beforeEach(async () => { await db.run('DELETE FROM project WHERE id=10'); });
async function seed(confirmed = true, fixtureId = 'F01', caseId = 'ordered', originalSources = false) {
  const fixture = confirmedContinuityFixture(fixtureId,caseId);
  const doc = createEmptyScriptDocument('CT06'); doc.locations = [{ id: 'room', name: '无人港口', description: '' }];
  doc.scenes = fixture.input.context.order.scenes.map((scene,index) => ({ id: scene.script_scene_id, locationId: 'room', interiorExterior: 'interior' as const, timeOfDay: 'day',
    characterIds: [], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: originalSources ? fixture.fixture.sources.filter(source=>source.scene_id===scene.script_scene_id&&fixture.selected.source_ids.includes(source.id)).map(source=>({id:source.id,type:'action' as const,text:source.text})): [{ id: `${scene.script_scene_id}:block`, type: 'action' as const, text: `第${index+1}盏红灯亮起。` }] }));
  await db.run("INSERT INTO project(id,title,user_id,settings) VALUES(10,'CT06','test-user','{}')");
  const content = fixture.fixture.sources.map(source => source.text).join('\n');
  await db.run("INSERT INTO chapter(id,project_id,\"index\",title,content) VALUES('ct06',10,0,'CT06',?)", content);
  await db.run("INSERT INTO character(id,project_id,name,english_name) VALUES(1,10,'林岚','Lin Lan'),(2,10,'陈月','Chen Yue')");
  const snapshot = await ScriptService.createSourceSnapshot('ct06','CT06',content,10);
  await db.run("INSERT INTO chapter_script(id,chapter_id,revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash) VALUES(30,'ct06',1,'confirmed',?,?,?,?)", JSON.stringify(doc), JSON.stringify(snapshot), snapshot.contentHash, snapshot.contextHash);
  if (confirmed) await commitContinuityLedger({ script_id: 30, expected_revision: 0, expected_script_revision: 1, request_key: 'entry', actor_id: 'reviewer', reason: 'fixture', input: fixture.input });
  for (const [index,scene] of doc.scenes.entries()) await db.run('INSERT INTO scene(id,chapter_id,"index",visual_prompt,audio_prompt,asset_url,asset_status,shot_spec) VALUES(?,\'ct06\',?,\'old prompt\',\'rain\',\'/old.svg\',\'completed\',?)',101+index,index,
    JSON.stringify({ location: '无人港口', primary_action: scene.blocks[0]!.text, visible_subjects: [], key_props: [] }));
  return { fixture, doc };
}
function provider(translations?:Record<string,string>) {
  const calls: any[] = [];
  const ai: AIProvider = { async generateStructured(prompt,schema) {
    const input = JSON.parse(prompt); calls.push(input);
    if (input.task === 'classify') return schema.parse({ items: input.sources.map((source: any) => ({ id: source.id, kind: 'visual' })) });
    if (input.task === 'atomicity') return schema.parse({ result: 'one_frame' });
    if (input.task === 'beat_relation') return schema.parse({ relation: 'sequential' });
    if (input.task === 'plan') return schema.parse({ primary_by_slot: Object.fromEntries(input.slots.map((slot: any) => [slot.id,slot.fact_ids[0] || null])) });
    if (input.task === 'translate') return schema.parse({ translations: input.facts.map((fact: any) => ({ id: fact.id, english: translations?.[fact.text] ?? `${Object.entries(input.glossary || {}).filter(([name]) => fact.text.includes(name)).map(([,name]) => name).join(' ')} A red lamp shines. Fact ${fact.id}.` })) });
    if (input.task === 'audit') return schema.parse({ faithful: true });
    throw new Error(`Unexpected model task ${input.task}`);
  }, async generateText() { throw new Error('Unexpected free text'); }, async generateImage() { throw new Error('Unexpected image'); } };
  return { ai,calls };
}
const bindings = (doc: ReturnType<typeof createEmptyScriptDocument>, target: string) => [{ block_id: `${target}:block`, start: 0, end: doc.scenes.find(scene => scene.id === target)!.blocks[0]!.text.length,
  moment_id: `${target}:exit`, phase: 'after' as const, reads: [{ entity_id: 'F01:coat', attribute_id: 'wetness' }, { entity_id: 'F01:umbrella', attribute_id: 'holder' }] }];

test('CT06 scene preview 3→1→2 and 1→2→3 share approved semantics and only extract/plan/write their target', async () => {
  const { doc } = await seed(); const beforeScenes = await db.all('SELECT * FROM scene ORDER BY id');
  const values = new Map<string,string>();
  for (const [run,order] of [[3,1,2],[1,2,3]].entries()) for (const index of order) {
    const target = `F01:s${index}`, mock = provider();
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({ scriptId: 30, expectedRevision: 1, requestKey: `${run}:${target}`, scope: 'scene', targetSceneId: target, momentBindings: bindings(doc,target), provider: mock.ai });
    const payload = JSON.parse(candidate.after_json);
    assert.equal(payload.scope.target_scene_id, target); assert.ok(payload.shots.every((shot: any) => shot.script_scene_id === target));
    assert.ok(payload.fact_contract.facts.every((fact: any) => fact.scene_id === target && fact.states.length === 0));
    assert.ok(mock.calls.filter(call => call.task === 'plan').every(call => call.scene_id === target && call.confirmed_moments.length));
    assert.equal(mock.calls.filter(call => call.task === 'state').length, 0);
    assert.ok(mock.calls.filter(call => call.task === 'classify').every(call => call.sources.every((source: any) => source.text === doc.scenes[index-1]!.blocks[0]!.text)));
    const references = payload.shots.map((shot: any) => JSON.parse(shot.shot_spec).source.continuity);
    const semantic = canonicalContinuityJson(references.map((reference: any) => ({ position: reference.story_position, hash: reference.reference.dependency_hash })));
    if (run === 0) values.set(target,semantic); else assert.equal(semantic,values.get(target));
    const task = await StoryboardGenerationService.getTask(30,StoryboardGenerationService.taskId(30,`${run}:${target}`));
    assert.ok(task.progress.facts.every((fact: any) => fact.scene_id === target));
    await assert.rejects(StoryboardGenerationService.applyStoryboardCandidate({ scriptId: 30, changeId: candidate.id, expectedRevision: 1 }), /单场候选仅供预览/);
  }
  assert.deepEqual(await db.all('SELECT * FROM scene ORDER BY id'), beforeScenes);
  assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_revision WHERE script_id=30')).n,1);
  assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_suggestion WHERE script_id=30')).n,0);
});

test('CT08 full original F01 scene workflow preserves labelled wetness, holder, breakage and source boundaries in both call orders',async()=>{
  const {doc,fixture}=await seed(true,'F01','ordered',true);
  const before=await db.all('SELECT * FROM scene ORDER BY id'),semantics=new Map<string,string>();
  for(const [run,order] of [[3,1,2],[1,2,3]].entries())for(const index of order){
    const target=`F01:s${index}`,mock=provider(fixture.fixture.legacy_mock!.translations),scene=doc.scenes.find(scene=>scene.id===target)!;
    const momentBindings=scene.blocks.map(block=>({block_id:block.id,start:0,end:block.text.length,moment_id:`${target}:exit`,phase:'after' as const,reads:[{entity_id:'F01:coat',attribute_id:'wetness' as const},{entity_id:'F01:umbrella',attribute_id:'holder' as const},{entity_id:'F01:umbrella',attribute_id:'integrity' as const},{entity_id:'F01:lock',attribute_id:'lock_function' as const}]}));
    const candidate=await StoryboardGenerationService.generateStoryboardCandidate({scriptId:30,expectedRevision:1,requestKey:`full:${run}:${target}`,scope:'scene',targetSceneId:target,momentBindings,provider:mock.ai});
    const payload=JSON.parse(candidate.after_json);assert.equal(payload.scope.target_scene_id,target);assert.ok(payload.fact_contract.facts.length);
    assert.ok(mock.calls.filter(call=>call.task==='classify').every(call=>call.sources.every((source:any)=>scene.blocks.some(block=>block.text.includes(source.text)))));
    assert.ok(payload.shots.length);assert.ok(payload.shots.every((shot:any)=>shot.script_scene_id===target));
    const states=payload.shots.flatMap((shot:any)=>JSON.parse(shot.shot_spec).continuity_states);
    assert.ok(states.some((state:any)=>state.entity==='蓝外套'&&state.attribute==='wetness'&&state.value==='wet'));
    assert.ok(states.some((state:any)=>state.entity==='黑伞'&&state.attribute==='integrity'&&state.value==='broken'));
    assert.ok(states.some((state:any)=>state.entity==='门锁'&&state.attribute==='lock_function'&&state.value==='broken'));
    assert.ok(states.some((state:any)=>state.entity==='黑伞'&&state.attribute==='holder'&&state.value===(index===1?'林岚':'陈月')));
    const refs=canonicalContinuityJson(payload.shots.map((shot:any)=>JSON.parse(shot.shot_spec).source.continuity));
    if(run===0)semantics.set(target,refs);else assert.equal(refs,semantics.get(target));
    assert.equal(mock.calls.filter(call=>call.task==='state').length,0);
  }
  assert.deepEqual(await db.all('SELECT * FROM scene ORDER BY id'),before);
  assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_revision WHERE script_id=30')).n,1);
  assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_suggestion WHERE script_id=30')).n,0);
});

test('CT06 coverage shares a confirmed during overlay, keeps intact airborne state and never applies after-event state again', async () => {
  const { fixture } = await seed(false,'F04','three-moments');
  const event = fixture.input.changes.find(change => change.proposal.attribute_id === 'integrity')!;
  const source = fixture.input.context.sources.find(source => source.source_document_id === 'explicit')!;
  const proposal: ContinuityOverlayProposal = { schema_version:1,policy_version:'continuity-state-1',overlay_id:'airborne',overlay_revision:1,binding_revision:1,
    story_position:{...event.proposal.story_position,moment_id:'F04:airborne',phase:'during'},event_change_id:event.proposal.change_id,after_change_id:null,
    values:[{entity_id:'F04:cup',attribute_id:'holder',value:null},{entity_id:'F04:cup',attribute_id:'visible_position',value:{mode:'airborne'}}],
    evidence:[{kind:'source',source_type:'novel',source_document_id:source.source_document_id,source_revision:1,source_text_hash:createHash('sha256').update(source.text).digest('hex'),evidence_quote:source.text,start:0,end:source.text.length}] };
  const overlay=confirmContinuityOverlay(proposal,{...fixture.input.context,authority:{kind:'human',review_id:'airborne-review',review_revision:1,actor_id:'reviewer',proposal_hash:continuityOverlayHash(proposal)}});
  await commitContinuityLedger({script_id:30,expected_revision:0,expected_script_revision:1,request_key:'during',actor_id:'reviewer',reason:'source-confirmed frame',input:{...fixture.input,during_overlays:[overlay]}});
  await bindContinuityShot(101,{script_id:30,script_scene_id:'F04:s1',moment_id:'F04:airborne',phase:'during',reads:[{entity_id:'F04:cup',attribute_id:'integrity'},{entity_id:'F04:cup',attribute_id:'visible_position'}]});
  const original=LLMService.generateSceneCoverage; LLMService.generateSceneCoverage=async () => Array.from({length:9},(_,index) => ({slot:index+1,shot_size:'Medium Shot'}));
  const app=Fastify(); await app.register(coverageRoutes,{prefix:'/api'});
  try {
    const generated=await app.inject({method:'POST',url:'/api/scenes/101/coverage'}); assert.equal(generated.statusCode,200,generated.body);
    const candidate=generated.json().shots[0]; const promoted=await app.inject({method:'POST',url:`/api/scenes/coverage/${candidate.id}/promote`,payload:{position:'after'}}); assert.equal(promoted.statusCode,200,promoted.body);
    const gate=await requireCurrentContinuityShot(await db.get('SELECT * FROM scene WHERE id=?',promoted.json().scene_id));
    assert.equal(gate.read.story_position.phase,'during'); assert.equal(gate.read.values.find(value => value.attribute_id==='integrity')!.value,'intact');
    assert.deepEqual(gate.read.values.find(value => value.attribute_id==='visible_position')!.value,{mode:'airborne'});
    const snapshot=await currentContinuitySnapshot(30,'F04:s1'); const exit=snapshot.snapshot.exit_state.find(cell => cell.entity_id==='F04:cup' && cell.attribute_id==='integrity');
    assert.ok(exit?.knowledge_status==='confirmed'); assert.equal(exit.value,'broken');
    assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_revision WHERE script_id=30')).n,1);
  } finally {LLMService.generateSceneCoverage=original;await app.close();}
});

test('CT06 source revision changing during coverage inference rolls back candidate-group writes', async () => {
  await seed(); await bindContinuityShot(101,{script_id:30,script_scene_id:'F01:s1',moment_id:'F01:s1:exit',phase:'after',reads:[{entity_id:'F01:coat',attribute_id:'wetness'}]});
  const original=LLMService.generateSceneCoverage; let calls=0;
  LLMService.generateSceneCoverage=async () => {calls++;await db.run('UPDATE chapter_script SET revision=2 WHERE id=30');return Array.from({length:9},(_,index)=>({slot:index+1,shot_size:'Wide Shot'}));};
  const app=Fastify();await app.register(coverageRoutes,{prefix:'/api'});
  try { const response=await app.inject({method:'POST',url:'/api/scenes/101/coverage'}); assert.equal(response.statusCode,409,response.body);assert.equal(response.json().code,'CONTINUITY_STALE');
    assert.equal(calls,1);assert.equal((await db.get('SELECT COUNT(*) n FROM coverage_group')).n,0);assert.equal((await db.get('SELECT asset_url FROM scene WHERE id=101')).asset_url,'/old.svg');
  } finally {LLMService.generateSceneCoverage=original;await app.close();}
});

test('CT06 missing entry/unknown read/cross-target range fail before provider or task/candidate writes', async () => {
  const { doc } = await seed(false); const mock = provider();
  const params = { scriptId: 30, expectedRevision: 1, requestKey: 'blocked', scope: 'scene' as const, targetSceneId: 'F01:s3', momentBindings: bindings(doc,'F01:s3'), provider: mock.ai };
  await assert.rejects(StoryboardGenerationService.generateStoryboardCandidate(params), (error: any) => error.code === 'CONTINUITY_ENTRY_REQUIRED');
  const data = confirmedContinuityFixture('F01','ordered'); await commitContinuityLedger({ script_id: 30, expected_revision: 0, expected_script_revision: 1, request_key: 'entry', actor_id: 'reviewer', reason: 'fixture', input: data.input });
  await assert.rejects(StoryboardGenerationService.generateStoryboardCandidate({ ...params, momentBindings: [{ ...bindings(doc,'F01:s3')[0], reads: [{ entity_id: 'F01:coat',attribute_id: 'owner' }] }] }), (error: any) => error.code === 'CONTINUITY_REVIEW_REQUIRED');
  await assert.rejects(StoryboardGenerationService.generateStoryboardCandidate({ ...params, momentBindings: bindings(doc,'F01:s2') }), (error: any) => error.code === 'CONTINUITY_REVIEW_REQUIRED');
  assert.equal(mock.calls.length,0); assert.equal((await db.get("SELECT COUNT(*) n FROM generation_task WHERE task_id=?",StoryboardGenerationService.taskId(30,'blocked'))).n,0);
  assert.equal((await db.get('SELECT COUNT(*) n FROM script_change WHERE script_id=30')).n,0);
});

test('CT06 coverage generate/apply/promote share source moment and do not replay a transfer or rewrite other scenes', async () => {
  await seed();
  await bindContinuityShot(103,{ script_id: 30,script_scene_id: 'F01:s3',moment_id: 'F01:s3:exit',phase: 'after',reads: [{ entity_id: 'F01:umbrella',attribute_id: 'holder' }] });
  const others = await db.all('SELECT * FROM scene WHERE id<103 ORDER BY id');
  const original = LLMService.generateSceneCoverage;
  LLMService.generateSceneCoverage = async () => Array.from({length:9},(_,index) => ({ slot:index+1, location:'wrong location', primary_action:'invented transfer', shot_size:'Wide Shot', source:{ type:'chapter' }, visible_subjects: [] }));
  const app = Fastify(); await app.register(coverageRoutes,{prefix:'/api'});
  try {
    const response = await app.inject({method:'POST',url:'/api/scenes/103/coverage'}); assert.equal(response.statusCode,200,response.body);
    const group = response.json(); const source = JSON.parse((await db.get('SELECT shot_spec FROM scene WHERE id=103')).shot_spec).source;
    for (const shot of group.shots) { const spec=JSON.parse(shot.shot_spec); assert.deepEqual(spec.source,source); assert.equal(spec.primary_action,'第3盏红灯亮起。'); }
    const candidate = group.shots[0];
    const promoted = await app.inject({method:'POST',url:`/api/scenes/coverage/${candidate.id}/promote`,payload:{position:'before'}}); assert.equal(promoted.statusCode,200,promoted.body);
    const newScene = await db.get('SELECT * FROM scene WHERE id=?',promoted.json().scene_id);
    const gate = await requireCurrentContinuityShot(newScene); assert.equal(gate.read.values[0]!.value,'F01:chen');
    assert.equal(gate.source.continuity!.story_position.scene_order,2); assert.equal(newScene.index,2);
    const repeated = await app.inject({method:'POST',url:`/api/scenes/coverage/${candidate.id}/promote`,payload:{position:'before'}}); assert.equal(repeated.json().scene_id,newScene.id);
    const applied = await app.inject({method:'POST',url:`/api/scenes/coverage/${group.shots[1].id}/apply`}); assert.equal(applied.statusCode,200,applied.body);
    assert.equal((await requireCurrentContinuityShot(await db.get('SELECT * FROM scene WHERE id=103'))).read.dependency_hash,gate.read.dependency_hash);
    assert.equal((await db.get('SELECT asset_url FROM scene_version WHERE scene_id=103 AND version=1')).asset_url,'/old.svg');
    assert.deepEqual(await db.all('SELECT * FROM scene WHERE id<103 ORDER BY id'),others);
    assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_revision WHERE script_id=30')).n,1);
    const snapshot = await currentContinuitySnapshot(30,'F01:s3'); assert.equal(snapshot.snapshot.confirmed_changes.length,0);
    await db.run('UPDATE chapter_script SET revision=2 WHERE id=30');
    for (const url of ['/api/scenes/103/coverage',`/api/scenes/coverage/${group.shots[2].id}/apply`,`/api/scenes/coverage/${group.shots[2].id}/promote`]) {
      const blocked=await app.inject({method:'POST',url,payload:{position:'after'}}); assert.equal(blocked.statusCode,409,blocked.body); assert.equal(blocked.json().code,'CONTINUITY_STALE');
    }
    assert.equal((await db.get('SELECT COUNT(*) n FROM scene WHERE chapter_id=\'ct06\'')).n,4);
  } finally { LLMService.generateSceneCoverage=original; await app.close(); }
});

test('CT06 coverage legacy source is readable but blocks model calls and writes with explicit entry review', async () => {
  await seed(false); let calls=0; const original=LLMService.generateSceneCoverage;
  LLMService.generateSceneCoverage=async () => { calls++; return []; };
  const app=Fastify(); await app.register(coverageRoutes,{prefix:'/api'});
  try { const response=await app.inject({method:'POST',url:'/api/scenes/101/coverage'}); assert.equal(response.statusCode,409,response.body); assert.equal(response.json().code,'CONTINUITY_ENTRY_REQUIRED');
    assert.equal((await app.inject({method:'GET',url:'/api/scenes/101/coverage'})).statusCode,200); assert.equal(calls,0);
    assert.equal((await db.get('SELECT COUNT(*) n FROM coverage_group')).n,0); assert.equal((await db.get('SELECT asset_url FROM scene WHERE id=101')).asset_url,'/old.svg');
  } finally { LLMService.generateSceneCoverage=original; await app.close(); }
});

test('CT06 promote insert keeps audible lines on the source shot and replace does not clear an unchanged image', async () => {
  await seed();
  await db.run("UPDATE scene SET dialogue=?, narration=? WHERE id=101", '林岚说。', '旁白');
  await bindContinuityShot(101, { script_id: 30, script_scene_id: 'F01:s1', moment_id: 'F01:s1:exit', phase: 'after', reads: [{ entity_id: 'F01:coat', attribute_id: 'wetness' }] });
  const source = await db.get('SELECT * FROM scene WHERE id=101');
  const group = await db.run("INSERT INTO coverage_group(source_scene_id,version,status) VALUES(101,1,'completed')");
  const insertShot = await db.run(
    'INSERT INTO coverage_shot(coverage_group_id,slot,shot_size,camera_angle,camera_movement,visual_prompt,negative_prompt,shot_spec,asset_status) VALUES(?,?,?,?,?,?,?,?,?)',
    group.lastID, 1, 'Medium Shot', 'Eye-level', 'Static', source.visual_prompt, source.negative_prompt, source.shot_spec, 'idle'
  );
  const app = Fastify();
  await app.register(coverageRoutes, { prefix: '/api' });
  try {
    const inserted = await app.inject({ method: 'POST', url: `/api/scenes/coverage/${insertShot.lastID}/promote`, payload: { position: 'after' } });
    assert.equal(inserted.statusCode, 200, inserted.body);
    const created = await db.get('SELECT audio_prompt, dialogue, narration, continuity_status FROM scene WHERE id=?', inserted.json().scene_id);
    assert.equal(created.audio_prompt, null);
    assert.equal(created.dialogue, null);
    assert.equal(created.narration, null);
    assert.equal(created.continuity_status, 'current');
    const still = await db.get('SELECT audio_prompt, dialogue, narration, asset_url FROM scene WHERE id=101');
    assert.equal(still.audio_prompt, 'rain');
    assert.equal(still.dialogue, '林岚说。');
    assert.equal(still.narration, '旁白');
    assert.equal(still.asset_url, '/old.svg');
    const replaceShot = await db.run(
      'INSERT INTO coverage_shot(coverage_group_id,slot,shot_size,camera_angle,camera_movement,visual_prompt,negative_prompt,shot_spec,asset_status) VALUES(?,?,?,?,?,?,?,?,?)',
      group.lastID, 2, source.shot_type, source.camera_angle, source.camera_movement, source.visual_prompt, source.negative_prompt, source.shot_spec, 'idle'
    );
    const replaced = await app.inject({ method: 'POST', url: `/api/scenes/coverage/${replaceShot.lastID}/promote`, payload: { position: 'replace' } });
    assert.equal(replaced.statusCode, 200, replaced.body);
    const live = await db.get('SELECT asset_url, active_version FROM scene WHERE id=101');
    assert.equal(live.asset_url, '/old.svg');
    assert.equal(live.active_version, 1);
    assert.equal((await db.get('SELECT asset_url FROM scene_version WHERE scene_id=101 AND version=1')).asset_url, '/old.svg');
    assert.equal((await db.get('SELECT COUNT(*) n FROM scene_version WHERE scene_id=101')).n, 1);
  } finally { await app.close(); }
});
