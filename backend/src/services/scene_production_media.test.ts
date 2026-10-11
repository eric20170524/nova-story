import '../test_setup';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db } from '../db/database';
import { confirmedContinuityFixture } from '../test_fixtures/continuity_confirmed';
import { createEmptyScriptDocument } from '../schemas/script';
import { ScriptService } from './script_service';
import { commitContinuityLedger,bindContinuityShot } from './continuity_store';
import { ensureSceneVersionBaseline,createSceneVersion } from './scene_versions';
import { productionMediaView,bindProductionReferences,productionQueuePlan,reviewProductionImage,persistProductionImageResult,prepareProductionImage } from './scene_production_media';
import { continuityHash } from './continuity_replay';
import {confirmContinuityChange,continuityProposalHash} from './continuity_confirmation';
import { sceneProductionRoutes } from '../routes/scene_production';
import { assetRoutes } from '../routes/assets';
import { GenerationService } from './generation_service';
import { SettingsManager } from '../core/settings_manager';
beforeEach(async()=>{await db.run('DELETE FROM image_generation_request WHERE task_id IN (SELECT task_id FROM generation_task WHERE scene_id BETWEEN 101 AND 103)');await db.run('DELETE FROM generation_task WHERE scene_id BETWEEN 101 AND 103');await db.run('DELETE FROM project WHERE id=10');});
async function seed(){
  const fixture=confirmedContinuityFixture('F06','upstream-revision'),doc=createEmptyScriptDocument('CT17/18');
  doc.locations=[{id:'room',name:'房间',description:''}];doc.scenes=fixture.input.context.order.scenes.map(scene=>({id:scene.script_scene_id,locationId:'room',interiorExterior:'interior',timeOfDay:'day',characterIds:[],propIds:[],eventIds:[],beatIds:[],sourceParagraphIds:[],blocks:fixture.fixture.sources.filter(source=>source.scene_id===scene.script_scene_id).map(source=>({id:source.id,type:'action',text:source.text}))})) as any;
  const content=fixture.fixture.sources.map(source=>source.text).join('\n');
  await db.run("INSERT INTO project(id,title,user_id,settings) VALUES(10,'CT17','reviewer','{}')");
  await db.run("INSERT INTO chapter(id,project_id,\"index\",title,content) VALUES('ct17',10,0,'CT17',?)",content);
  await db.run("INSERT INTO character(id,project_id,name,english_name) VALUES(1,10,'林岚','Lin Lan'),(2,10,'陈月','Chen Yue')");
  await db.run("INSERT INTO library_asset(id,project_id,kind,name,revision,status,image_url) VALUES(9,10,'prop','伞设计',1,'completed','/version1.png')");
  const entity=fixture.input.context.entities.find(entity=>entity.entity_id==='F06:u1')!;entity.asset_id=9;entity.asset_revision=1;
  const snapshot=await ScriptService.createSourceSnapshot('ct17',doc.title,content,10);
  await db.run("INSERT INTO chapter_script(id,chapter_id,revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash) VALUES(30,'ct17',1,'confirmed',?,?,?,?)",JSON.stringify(doc),JSON.stringify(snapshot),snapshot.contentHash,snapshot.contextHash);
  await commitContinuityLedger({script_id:30,expected_revision:0,expected_script_revision:1,request_key:'entry',actor_id:'reviewer',reason:'fixture',input:fixture.input});
  for(const [index,scene] of doc.scenes.entries()){
    await db.run("INSERT INTO scene(id,chapter_id,\"index\",asset_status,asset_url,shot_spec) VALUES(?,'ct17',?,'idle',NULL,?)",101+index,index,JSON.stringify({location:'房间',primary_action:scene.blocks[0]!.text,source:{type:'script',script_id:30,script_scene_id:scene.id,script_revision:1,block_ids:[scene.blocks[0]!.id]}}));
    await ensureSceneVersionBaseline(101+index);await bindContinuityShot(101+index,{script_id:30,script_scene_id:scene.id,moment_id:`${scene.id}:exit`,phase:'after',reads:[{entity_id:'F06:u1',attribute_id:'integrity'}]});
  }
  const bound=await bindProductionReferences(30,101,{expected_version:1,references:[{entity_id:'F06:u1',kind:'asset',id:9,version:1}],reason:'Use the approved broken umbrella reference, same physical item'});
  return {fixture,doc,bound};
}
test('FS02 formal stage stores an inactive candidate and leaves the selected image', async (t) => {
  const { bound } = await seed();
  await db.run("UPDATE scene SET asset_url='/kept.png', asset_status='completed' WHERE id=101");
  await db.run("UPDATE scene_version SET asset_url='/kept.png', asset_status='completed' WHERE scene_id=101 AND version=1");
  t.mock.method(SettingsManager, 'loadSettings', () => ({ comfyui: { enabled: true } }) as any);
  t.mock.method(GenerationService, 'generateAssets', async () => {});
  const app = Fastify();
  await app.register(assetRoutes, { prefix: '/api/assets' });
  try {
    const missing = await app.inject({ method: 'POST', url: '/api/assets/generate', payload: { scene_id: 101, production_stage: 'production', workflow: { prompt: 'formal' }, request_key: 'formal-missing' } });
    assert.equal(missing.statusCode, 409);
    assert.equal(missing.json().code, 'CONTINUITY_REFERENCE_REVIEW_REQUIRED');
    const queued = await app.inject({ method: 'POST', url: '/api/assets/generate', payload: { scene_id: 101, production_stage: 'production', request_key: 'formal-kept', workflow: { prompt: 'formal', production_guard: { expected_version: 1, reference_hash: bound.reference_hash, redraw: false } } } });
    assert.equal(queued.statusCode, 200, queued.body);
    assert.equal(queued.json().candidate_version, 2);
    const scene = await db.get('SELECT asset_url, active_version FROM scene WHERE id=101');
    assert.equal(scene.asset_url, '/kept.png');
    assert.equal(scene.active_version, 1);
    const frame = JSON.parse((await db.get('SELECT reference_versions_json FROM scene_production_frame WHERE scene_id=101 AND scene_version=2')).reference_versions_json);
    assert.equal(frame.scene_version, 2);
    assert.equal(frame.references[0].image_url, '/version1.png');
    const stored = JSON.parse((await db.get('SELECT shot_spec FROM scene_version WHERE scene_id=101 AND version=2')).shot_spec).formal_request;
    assert.equal(stored.production_stage, 'production');
    assert.equal(stored.control_branch, 'continuity_pin');
    assert.equal(stored.reference_hash, bound.reference_hash);
    assert.ok(stored.model_fingerprint.model);
  } finally { await app.close(); }
});
test('CT17 pins an immutable asset version to a specific physical identity/state, independent of later design revisions',async()=>{
  const {bound}=await seed(),before=continuityHash((await db.get('SELECT context_json FROM continuity_ledger')).context_json);
  await db.run("UPDATE library_asset SET revision=2,image_url='/version2.png' WHERE id=9");
  const prepared=await prepareProductionImage(101,{expected_version:1,reference_hash:bound.reference_hash,redraw:false},false);
  assert.equal(prepared.pin.references[0]!.image_url,'/version1.png');assert.equal(prepared.pin.references[0]!.entity_id,'F06:u1');
  await assert.rejects(()=>bindProductionReferences(30,101,{expected_version:1,references:[{entity_id:'F06:coat',kind:'asset',id:9,version:1}],reason:'wrong item'}),/visible identity/);
  assert.equal(continuityHash((await db.get('SELECT context_json FROM continuity_ledger')).context_json),before);
});
test('CT17 batch plan lists existing images, queued jobs and unbound states separately',async()=>{
  const {doc}=await seed();
  assert.equal((await productionQueuePlan(30,doc.scenes[0]!.id)).eligible_count,1);
  await db.run("INSERT INTO generation_task(task_id,scene_id,kind,status) VALUES('queued',101,'image','processing')");
  assert.equal((await productionQueuePlan(30,doc.scenes[0]!.id)).skipped[0].reason,'already_queued');
  await db.run("DELETE FROM generation_task WHERE task_id='queued'");await db.run("UPDATE scene SET asset_url='/accepted.png',asset_status='completed' WHERE id=101");
  assert.equal((await productionQueuePlan(30,doc.scenes[0]!.id)).skipped[0].reason,'image_exists');
  const other=await productionQueuePlan(30,doc.scenes[1]!.id);assert.equal(other.eligible_count,0);assert.equal(other.skipped[0].reason,'CONTINUITY_REFERENCE_REVIEW_REQUIRED');
});
test('CT17 repeated HTTP batch clicks produce one real durable job reservation and explicit redraw retains the old version',async t=>{
  const {doc,bound}=await seed();let launches=0;
  t.mock.method(SettingsManager,'loadSettings',()=>({comfyui:{enabled:true},image_provider:'comfyui'} as any));
  t.mock.method(GenerationService,'generateAssets',async()=>{launches++;});
  const app=Fastify();await app.register(assetRoutes,{prefix:'/api/assets'});await app.register(sceneProductionRoutes,{prefix:'/api'});
  try{
    const payload={target_scene_id:doc.scenes[0]!.id,request_key:'batch'};
    const first=await app.inject({method:'POST',url:'/api/scripts/30/production/queue',payload});assert.equal(first.statusCode,200);assert.equal(first.json().queued_count,1);
    const second=await app.inject({method:'POST',url:'/api/scripts/30/production/queue',payload});assert.equal(second.json().queued_count,0);assert.equal(second.json().skipped[0].reason,'already_queued');assert.equal(launches,1);
    await db.run("UPDATE generation_task SET status='completed' WHERE scene_id=101");await db.run("UPDATE scene SET asset_status='completed',asset_url='/old.png' WHERE id=101");await db.run("UPDATE scene_version SET asset_status='completed',asset_url='/old.png' WHERE scene_id=101 AND version=1");
    const redraw=await app.inject({method:'POST',url:'/api/scripts/30/production/frames/101/redraw',payload:{expected_version:1,reference_hash:bound.reference_hash,request_key:'redraw'}});assert.equal(redraw.statusCode,200);assert.equal(redraw.json().active_version,2);assert.equal(launches,2);
    assert.equal((await db.get('SELECT asset_url FROM scene_version WHERE scene_id=101 AND version=1')).asset_url,'/old.png');assert.equal((await productionMediaView(30,101)).reference_pin!.scene_version,2);
  }finally{await app.close();}
});
test('CT17 a late result is retained in its original version and cannot overwrite a different active image',async()=>{
  const {bound}=await seed();await db.run("UPDATE scene SET task_id='late',asset_status='generating' WHERE id=101");
  await createSceneVersion(101,{clearAsset:true});await db.run("UPDATE scene SET asset_url='/newer.png',asset_status='completed',task_id='newer' WHERE id=101");
  const result=await persistProductionImageResult(101,bound.pin,'late',{asset_url:'/late.png',asset_status:'completed',task_id:'late',english_visual_prompt:'captured input'});
  assert.equal(result.current,false);assert.equal((await db.get('SELECT asset_url FROM scene WHERE id=101')).asset_url,'/newer.png');assert.equal((await db.get('SELECT asset_url FROM scene_version WHERE scene_id=101 AND version=1')).asset_url,'/late.png');assert.equal((await db.get('SELECT continuity_status FROM scene_version WHERE scene_id=101 AND version=1')).continuity_status,'stale');
});
test('CT18 image acceptance is distinct from text approval, requires every image check, and rejection changes no story state',async()=>{
  const {bound}=await seed(),ledger=await db.get('SELECT * FROM continuity_ledger WHERE script_id=30');
  await db.run("UPDATE scene SET asset_status='completed',asset_url='/current.png' WHERE id=101");
  const body={expected_version:1,expected_image_url:'/current.png',reference_hash:bound.reference_hash,verdict:'accepted',checks:{wardrobe:true,damage:true,count:true,holder:true,openings:true,space:false},note:'Incorrect space join'};
  await assert.rejects(()=>reviewProductionImage(30,101,body),/Every image check/);
  const rejected=await reviewProductionImage(30,101,{...body,verdict:'rejected'});assert.equal(rejected.image_only,true);
  const accepted=await reviewProductionImage(30,101,{...body,checks:{...body.checks,space:true},note:'All six visual checks passed'});assert.equal(accepted.verdict,'accepted');
  await assert.rejects(()=>reviewProductionImage(30,101,{...body,expected_image_url:'/other.png'}),/current completed image/);
  assert.deepEqual(await db.get('SELECT * FROM continuity_ledger WHERE script_id=30'),ledger);
});
test('CT18 stale images retain frozen properties/references for comparison and rejection, while acceptance and generation stay blocked',async()=>{
  const {bound}=await seed();
  await db.run("UPDATE scene SET asset_url='/old.png',asset_status='completed',continuity_status='stale' WHERE id=101");
  const view=await productionMediaView(30,101);assert.equal(view.text_status,'stale');assert.equal(view.image_url,'/old.png');assert.deepEqual(view.values,bound.pin.state_values);assert.equal(view.reference_pin!.references[0]!.image_url,'/version1.png');
  const body={expected_version:1,expected_image_url:'/old.png',reference_hash:bound.reference_hash,checks:{wardrobe:true,damage:true,count:true,holder:true,openings:true,space:true},note:'Old image kept for comparison'};
  await assert.rejects(()=>reviewProductionImage(30,101,{...body,verdict:'accepted'}),/changed dependencies/);
  assert.equal((await reviewProductionImage(30,101,{...body,verdict:'rejected'})).verdict,'rejected');
  await assert.rejects(()=>prepareProductionImage(101,undefined,false),{code:'CONTINUITY_REFERENCE_REVIEW_REQUIRED'});
  await assert.rejects(()=>prepareProductionImage(101,{expected_version:1,reference_hash:bound.reference_hash,redraw:false},false),{code:'CONTINUITY_STALE'});
});
test('CT19 an unrelated ledger edit preserves a valid image pin and its ability to generate or accept',async()=>{
  const {fixture,doc}=await seed();
  await bindContinuityShot(103,{script_id:30,script_scene_id:doc.scenes[2]!.id,moment_id:`${doc.scenes[2]!.id}:exit`,phase:'after',reads:[{entity_id:'F06:coat',attribute_id:'wetness'}]});
  const bound=await bindProductionReferences(30,103,{expected_version:1,references:[],reason:'Confirmed clothing text only'});
  const previous=fixture.input.changes.find(change=>change.proposal.entity_id==='F06:u1')!;
  const proposal={...previous.proposal,change_revision:previous.proposal.change_revision+1,value:previous.proposal.value==='broken'?'damaged':'broken'};
  const confirmed=confirmContinuityChange(proposal,{...fixture.input.context,authority:{kind:'human',review_id:'related-umbrella',review_revision:2,actor_id:'reviewer',proposal_hash:continuityProposalHash(proposal)}});
  assert.equal(confirmed.status,'confirmed');if(confirmed.status!=='confirmed')throw new Error('Expected reviewed change');
  const committed=await commitContinuityLedger({script_id:30,expected_revision:1,expected_script_revision:1,request_key:'related-edit',actor_id:'reviewer',reason:'Only umbrella changed',input:{...fixture.input,changes:fixture.input.changes.map(change=>change===previous?confirmed.change:change)}});
  assert.ok(committed.revalidated_shot_ids.includes(103));assert.ok(!committed.stale_shot_ids.includes(103));
  await prepareProductionImage(103,{expected_version:1,reference_hash:bound.reference_hash,redraw:false},false);
  await db.run("UPDATE scene SET asset_url='/unrelated.png',asset_status='completed' WHERE id=103");
  const review=await reviewProductionImage(30,103,{expected_version:1,expected_image_url:'/unrelated.png',reference_hash:bound.reference_hash,verdict:'accepted',checks:{wardrobe:true,damage:true,count:true,holder:true,openings:true,space:true},note:'Unchanged frame still passes'});assert.equal(review.verdict,'accepted');
});
