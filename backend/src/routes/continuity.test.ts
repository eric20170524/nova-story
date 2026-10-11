import '../test_setup';
import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db } from '../db/database';
import { continuityRoutes } from './continuity';
import { createEmptyScriptDocument } from '../schemas/script';
import { confirmedContinuityFixture } from '../test_fixtures/continuity_confirmed';
import { bindContinuityShot,currentContinuitySnapshot } from '../services/continuity_store';
import { requireCurrentContinuityShot } from '../services/continuity_shot_gate';

beforeEach(async()=>{await db.run('DELETE FROM project WHERE id IN (10,20)');});
async function setup(){
  const fixture=confirmedContinuityFixture('F06','upstream-revision');
  const doc=createEmptyScriptDocument('CT07');doc.locations=[{id:'room',name:'房间',description:''}];
  doc.scenes=fixture.input.context.order.scenes.map(scene=>({id:scene.script_scene_id,locationId:'room',interiorExterior:'interior' as const,timeOfDay:'day',characterIds:[],propIds:[],eventIds:[],beatIds:[],sourceParagraphIds:[],
    blocks:fixture.fixture.sources.filter(source=>source.scene_id===scene.script_scene_id).map(source=>({id:source.id,type:'action' as const,text:source.text}))}));
  await db.run("INSERT INTO project(id,title,user_id) VALUES(10,'CT07','test-user')");
  await db.run("INSERT INTO chapter(id,project_id,\"index\",title,content) VALUES('ct07',10,0,'CT07',?)",fixture.fixture.sources.map(source=>source.text).join('\n'));
  await db.run("INSERT INTO character(id,project_id,name) VALUES(1,10,'林岚'),(2,10,'陈月')");
  await db.run("INSERT INTO chapter_script(id,chapter_id,revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash) VALUES(30,'ct07',1,'confirmed',?,'{}','fixture','fixture')",JSON.stringify(doc));
  await db.run(`INSERT INTO scene(id,chapter_id,"index",asset_url,asset_status,audio_prompt) VALUES(101,'ct07',0,'/old-umbrella.svg','completed','rain'),(102,'ct07',1,'/old-coat.svg','completed','silence')`);
  const app=Fastify();await app.register(continuityRoutes,{prefix:'/api'});
  const get=async(target='F06:s1')=>(await app.inject({method:'GET',url:`/api/scripts/30/continuity?target_scene_id=${encodeURIComponent(target)}`})).json();
  const post=(body:any)=>app.inject({method:'POST',url:'/api/scripts/30/continuity/confirm',payload:body});
  const view=await get();
  const body={review_action:'human_review',target_scene_id:'F06:s1',expected_script_revision:1,expected_continuity_revision:0,request_key:'entry',reason:'人工核对入口',entities:fixture.input.context.entities,
    entry_values:Object.entries(fixture.fixture.initial_state).flatMap(([entity_id,attributes])=>Object.entries(attributes).map(([attribute_id,value])=>({entity_id,attribute_id,knowledge_status:'confirmed',value}))),changes:[]};
  const proposal=(index:number)=>{
    const raw=fixture.input.changes[index]!.proposal;const evidence=raw.evidence[0]!;assert.equal(evidence.kind,'source');
    const source=fixture.fixture.sources.find(source=>source.id===evidence.source_document_id)!;
    const actual=view.sources.find((row:any)=>row.source_type==='screenplay'&&row.text===source.text);
    return {...raw,evidence:[{kind:'source',source_type:actual.source_type,source_document_id:actual.source_document_id,source_revision:actual.source_revision,source_text_hash:actual.source_text_hash,evidence_quote:actual.text,start:0,end:actual.text.length}]};
  };
  return {app,fixture,body,get,post,proposal};
}

test('CT07 GET returns old-project review material without writes and validates target scope',async()=>{
  const {app,get}=await setup();try{
    const view=await get();assert.equal(view.status,'pending_review');assert.equal(view.continuity_revision,0);assert.equal(view.issues[0].code,'CONTINUITY_ENTRY_REQUIRED');
    assert.equal(view.order.scenes.length,3);assert.ok(view.registry.wetness);assert.equal(view.sources.length,4);assert.equal(view.shots[0].asset_url,'/old-umbrella.svg');
    assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_ledger')).n,0);assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_entity')).n,0);
    const invalid=await app.inject({method:'GET',url:'/api/scripts/30/continuity?target_scene_id=another-project'});assert.equal(invalid.statusCode,404);assert.equal(invalid.json().code,'CONTINUITY_SCOPE_INVALID');
  }finally{await app.close();}
});
test('CT20 API: time impact is read-only; confirmed unresolved boundary blocks only later scenes; stale preview retains state',async()=>{
  const {app,body,post,get}=await setup();try{
    const row=await db.get('SELECT document_json FROM chapter_script WHERE id=30'),doc=JSON.parse(row.document_json);
    doc.scenes[1].blocks.push({id:'time-day',type:'action',text:'次日，人物再次进入房间。'});doc.scenes[2].blocks.push({id:'time-unknown',type:'action',text:'不知过了多久。'});
    await db.run('UPDATE chapter_script SET document_json=? WHERE id=30',JSON.stringify(doc));assert.equal((await post(body)).statusCode,200);
    const view=await get(),evidence=(id:string)=>{const s=view.sources.find((s:any)=>s.source_document_id.endsWith(`:${id}`));return {kind:'source',source_type:s.source_type,source_document_id:s.source_document_id,source_revision:s.source_revision,source_text_hash:s.source_text_hash,evidence_quote:s.text,start:0,end:s.text.length};};
    const time={review_action:'human_review',expected_script_revision:1,expected_continuity_revision:1,request_key:'time-api',reason:'人工逐属性核对故事日',time_plan:{schema_version:1,policy_version:'continuity-time-1',initial_day_id:'day-1',boundaries:[{script_scene_id:'F06:s2',kind:'new_day',day_id:'day-2',rules:body.entry_values.map(c=>({entity_id:c.entity_id,attribute_id:c.attribute_id,action:c.attribute_id==='wetness'?'unknown':'inherit'})),evidence:evidence('time-day')},{script_scene_id:'F06:s3',kind:'unknown',rules:[],evidence:evidence('time-unknown')}]}};
    const preview=await app.inject({method:'POST',url:'/api/scripts/30/continuity/time-preview',payload:time});assert.equal(preview.statusCode,200,preview.body);assert.equal((await get()).continuity_revision,1);
    const accept=()=>app.inject({method:'POST',url:'/api/scripts/30/continuity/time-confirm',payload:{...time,expected_impact_hash:preview.json().impact_hash}});
    const saved=await accept();assert.equal(saved.statusCode,200,saved.body);assert.deepEqual((await accept()).json(),saved.json());
    assert.equal((await get('F06:s1')).status,'ready');const second=await get('F06:s2');assert.equal(second.status,'ready');assert.equal(second.snapshot.exit_state.find((c:any)=>c.attribute_id==='wetness').knowledge_status,'unknown');assert.equal((await get('F06:s3')).issues[0].code,'CONTINUITY_TIME_REVIEW_REQUIRED');
    const before=await db.get('SELECT context_json FROM continuity_ledger WHERE script_id=30');const stale=await app.inject({method:'POST',url:'/api/scripts/30/continuity/time-confirm',payload:{...time,request_key:'stale-time',expected_impact_hash:preview.json().impact_hash}});assert.equal(stale.statusCode,409);assert.deepEqual(await db.get('SELECT context_json FROM continuity_ledger WHERE script_id=30'),before);
    const invalid={...time,expected_continuity_revision:2,request_key:'incomplete',time_plan:{...time.time_plan,boundaries:[{...time.time_plan.boundaries[0],rules:[]}]}};assert.equal((await app.inject({method:'POST',url:'/api/scripts/30/continuity/time-preview',payload:invalid})).statusCode,422);
    assert.equal((await app.inject({method:'POST',url:'/api/scripts/30/continuity/time-preview',payload:{...time,authority:{kind:'human'}}})).statusCode,422);
    // A source edit must be recoverable through one explicit full ledger review,
    // with renewed exact time evidence rather than silently discarding the plan.
    doc.scenes[1].blocks.find((b:any)=>b.id==='time-day').text='次日，人物重新走进房间。';
    await db.run('UPDATE chapter_script SET revision=2,document_json=? WHERE id=30',JSON.stringify(doc));
    const renewed=await get(),quote=(id:string)=>{const s=renewed.sources.find((s:any)=>s.source_document_id.endsWith(`:${id}`));return {kind:'source',source_type:s.source_type,source_document_id:s.source_document_id,source_revision:s.source_revision,source_text_hash:s.source_text_hash,evidence_quote:s.text,start:0,end:s.text.length};};
    const full={...body,replace_all:true,expected_script_revision:2,expected_continuity_revision:2,request_key:'renewed-full'};
    assert.equal((await post(full)).statusCode,409);
    const joint={...full,time_plan:{...time.time_plan,boundaries:time.time_plan.boundaries.map((b:any)=>({...b,evidence:quote(b.kind==='new_day'?'time-day':'time-unknown')}))}};
    const jointPreview=await app.inject({method:'POST',url:'/api/scripts/30/continuity/preview',payload:joint});assert.equal(jointPreview.statusCode,200,jointPreview.body);
    const jointSaved=await post({...joint,expected_impact_hash:jointPreview.json().impact_hash});assert.equal(jointSaved.statusCode,200,jointSaved.body);assert.equal((await get('F06:s2')).snapshot.moments[0].story_position.time_scope.day_id,'day-2');assert.equal((await get('F06:s3')).issues[0].code,'CONTINUITY_TIME_REVIEW_REQUIRED');
  }finally{await app.close();}
});

test('CT07 human entry/scene correction is audited, idempotent and only stales actual reads while retaining old images',async()=>{
  const {app,body,post,get,proposal}=await setup();try{
    const [first,repeat]=await Promise.all([post(body),post(body)]);assert.equal(first.statusCode,200,first.body);assert.deepEqual(first.json(),repeat.json());
    assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_revision')).n,1);
    await bindContinuityShot(101,{script_id:30,script_scene_id:'F06:s3',moment_id:'F06:s3:exit',phase:'after',reads:[{entity_id:'F06:u1',attribute_id:'integrity'}]});
    await bindContinuityShot(102,{script_id:30,script_scene_id:'F06:s3',moment_id:'F06:s3:exit',phase:'after',reads:[{entity_id:'F06:coat',attribute_id:'wetness'}]});
    const correction=await post({review_action:'human_review',target_scene_id:'F06:s1',expected_script_revision:1,expected_continuity_revision:1,request_key:'correct-umbrella',reason:'伞柄只是弯曲',changes:[proposal(0)]});
    assert.equal(correction.statusCode,200,correction.body);assert.deepEqual(correction.json().stale_shot_ids,[101]);assert.deepEqual(correction.json().revalidated_shot_ids,[102]);
    const view=await get('F06:s3');assert.equal(view.status,'ready');assert.equal(view.history[0].actor_id,'local_admin');assert.equal(view.shots.find((shot:any)=>shot.id===101).asset_url,'/old-umbrella.svg');
    assert.deepEqual(view.shots.find((shot:any)=>shot.id===101).recovery.attributes,[{entity_id:'F06:u1',attribute_id:'integrity'}]);
    assert.ok(await requireCurrentContinuityShot(await db.get('SELECT * FROM scene WHERE id=102')));
    assert.equal((await db.get('SELECT audio_prompt FROM scene WHERE id=101')).audio_prompt,'rain');
    const conflict=await post({...body,request_key:'stale-approval'});assert.equal(conflict.statusCode,409);assert.equal(conflict.json().code,'CONTINUITY_REVISION_CONFLICT');
    const changedKey=await post({...body,reason:'different'});assert.equal(changedKey.statusCode,409);
    const raw=await db.get('SELECT context_json,changes_json FROM continuity_ledger WHERE script_id=30');assert.ok(raw.changes_json.includes('correct-umbrella'));assert.ok(!raw.context_json.includes('authority'));
  }finally{await app.close();}
});

test('CT07 unsupported/shared/conflicting changes preserve suggestions and cannot grant trusted state or overwrite source text',async()=>{
  const {app,body,post,proposal}=await setup();try{
    assert.equal((await post(body)).statusCode,200);
    const chapter=await db.get('SELECT content FROM chapter WHERE id=\'ct07\'');
    const base={review_action:'human_review',target_scene_id:'F06:s1',expected_script_revision:1,expected_continuity_revision:1,reason:'核对建议'};
    const unsupported=await post({...base,request_key:'unknown-property',changes:[{...proposal(0),attribute_id:'quantity_in_cup',value:'one'}]});assert.equal(unsupported.statusCode,409,unsupported.body);assert.equal(unsupported.json().code,'CONTINUITY_ATTRIBUTE_UNSUPPORTED');
    const shared=await post({...base,request_key:'shared',changes:[{...proposal(0),attribute_id:'holder',value:['F06:lin','F06:chen']}]});assert.equal(shared.statusCode,409,shared.body);assert.equal(shared.json().code,'CONTINUITY_SHARED_HOLDER_UNSUPPORTED');
    const transfer=proposal(1);const wrong=await post({...base,target_scene_id:'F06:s2',request_key:'wrong-holder',changes:[{...transfer,value:'F06:lin',precondition:{knowledge_status:'confirmed',value:'F06:chen'}}]});assert.equal(wrong.statusCode,409,wrong.body);assert.equal(wrong.json().code,'CONTINUITY_PRECONDITION_CONFLICT');
    const forged=await post({...base,request_key:'forged',authority:{kind:'human',actor_id:'model'},changes:[]});assert.equal(forged.statusCode,422);
    const cross=await post({...base,request_key:'cross',changes:[transfer]});assert.equal(cross.statusCode,422,cross.body);assert.equal(cross.json().code,'CONTINUITY_SCOPE_INVALID');
    assert.equal((await db.get('SELECT revision FROM continuity_ledger WHERE script_id=30')).revision,1);assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_suggestion')).n,3);
    assert.deepEqual(await db.get('SELECT content FROM chapter WHERE id=\'ct07\''),chapter);
    const snapshot=await currentContinuitySnapshot(30,'F06:s3');const holder=snapshot.snapshot.exit_state.find(cell=>cell.entity_id==='F06:u1'&&cell.attribute_id==='holder');assert.ok(holder?.knowledge_status==='confirmed');assert.equal(holder.value,'F06:lin');
  }finally{await app.close();}
});

test('CT07 recovery reviews a current moment into a fresh image version, preserves old image/audio and is idempotent',async()=>{
  const {app,body,post,proposal}=await setup();try{
    assert.equal((await post(body)).statusCode,200);
    await db.run("UPDATE scene SET shot_spec=? WHERE id=101",JSON.stringify({location:'房间',primary_action:'陈月仍握着黑伞。'}));
    await bindContinuityShot(101,{script_id:30,script_scene_id:'F06:s3',moment_id:'F06:s3:exit',phase:'after',reads:[{entity_id:'F06:u1',attribute_id:'integrity'}]});
    const correction=await post({review_action:'human_review',target_scene_id:'F06:s1',expected_script_revision:1,expected_continuity_revision:1,request_key:'correct',reason:'核对损伤',changes:[proposal(0)]});assert.equal(correction.statusCode,200,correction.body);
    const recovery={scene_id:101,expected_scene_version:1,expected_script_revision:1,expected_continuity_revision:2,request_key:'redo-one',reason:'按已核对状态新建镜头版本',target_scene_id:'F06:s3',moment_id:'F06:s3:exit',phase:'after',reads:[{entity_id:'F06:u1',attribute_id:'integrity'}]};
    const call=(payload:any)=>app.inject({method:'POST',url:'/api/scripts/30/continuity/refresh-shot',payload});
    const first=await call(recovery);assert.equal(first.statusCode,200,first.body);const repeated=await call(recovery);assert.deepEqual(first.json(),repeated.json());
    assert.equal(first.json().new_version,2);assert.equal(first.json().previous_image_url,'/old-umbrella.svg');assert.equal(first.json().new_image_url,null);
    const scene=await db.get('SELECT * FROM scene WHERE id=101');assert.equal(scene.asset_url,null);assert.equal(scene.audio_prompt,'rain');assert.equal(scene.continuity_status,'current');
    assert.equal((await db.get('SELECT asset_url FROM scene_version WHERE scene_id=101 AND version=1')).asset_url,'/old-umbrella.svg');
    assert.equal((await requireCurrentContinuityShot(scene)).read.values[0]!.value,'damaged');
    const conflict=await call({...recovery,request_key:'old-version'});assert.equal(conflict.statusCode,409);assert.equal(conflict.json().code,'CONTINUITY_REVISION_CONFLICT');
    const other=await db.get('SELECT * FROM scene WHERE id=102');assert.equal(other.asset_url,'/old-coat.svg');assert.equal(other.audio_prompt,'silence');
    assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_shot_recovery')).n,1);
    await db.run('DELETE FROM project WHERE id=10');assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_shot_recovery')).n,0);
  }finally{await app.close();}
});

test('CT13 preview shows old/new evidence and actual impacts without writes; undo appends an audited idempotent revision',async()=>{
  const {app,body,post,proposal,get}=await setup();try{
    assert.equal((await post(body)).statusCode,200);
    await bindContinuityShot(101,{script_id:30,script_scene_id:'F06:s3',moment_id:'F06:s3:exit',phase:'after',reads:[{entity_id:'F06:u1',attribute_id:'integrity'}]});
    await bindContinuityShot(102,{script_id:30,script_scene_id:'F06:s3',moment_id:'F06:s3:exit',phase:'after',reads:[{entity_id:'F06:coat',attribute_id:'wetness'}]});
    const correction={review_action:'human_review',target_scene_id:'F06:s1',expected_script_revision:1,expected_continuity_revision:1,request_key:'review-preview',reason:'弯曲并未折断',changes:[proposal(0)]};
    const preview=await app.inject({method:'POST',url:'/api/scripts/30/continuity/preview',payload:correction});assert.equal(preview.statusCode,200,preview.body);
    const impact=preview.json();assert.deepEqual(impact.affected_shot_ids,[101]);
    const change=impact.changes.find((change:any)=>change.script_scene_id==='F06:s3'&&change.attribute_id==='integrity');
    assert.equal(change.before.value,'broken');assert.equal(change.after.value,'damaged');assert.ok(change.after.evidence[0].evidence_quote.includes('只是弯曲'));
    assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_revision')).n,1);
    assert.equal((await db.get('SELECT asset_url FROM scene WHERE id=101')).asset_url,'/old-umbrella.svg');
    assert.equal((await post({...correction,expected_impact_hash:impact.impact_hash})).statusCode,200);
    const undo={review_action:'human_review',target_revision:1,expected_script_revision:1,expected_continuity_revision:2,request_key:'undo-review',reason:'撤销本次修正'};
    const undoPreview=await app.inject({method:'POST',url:'/api/scripts/30/continuity/undo-preview',payload:undo});assert.equal(undoPreview.statusCode,200,undoPreview.body);
    assert.deepEqual(undoPreview.json().affected_shot_ids,[101]);
    const request={...undo,expected_impact_hash:undoPreview.json().impact_hash};
    const [first,repeat]=await Promise.all([app.inject({method:'POST',url:'/api/scripts/30/continuity/undo',payload:request}),app.inject({method:'POST',url:'/api/scripts/30/continuity/undo',payload:request})]);
    assert.equal(first.statusCode,200,first.body);assert.deepEqual(first.json(),repeat.json());assert.equal(first.json().revision,3);
    const view=await get('F06:s3');assert.equal(view.snapshot.exit_state.find((cell:any)=>cell.entity_id==='F06:u1'&&cell.attribute_id==='integrity').value,'broken');
    assert.equal(view.history[0].actor_id,'local_admin');assert.match(view.history[0].reason,/undo:1/);assert.equal(view.history.length,3);
    assert.equal(view.shots.find((shot:any)=>shot.id===101).asset_url,'/old-umbrella.svg');assert.equal(view.shots.find((shot:any)=>shot.id===102).continuity_status,'current');
  }finally{await app.close();}
});

test('CT13 a frame version change invalidates its earlier impact preview before any confirmation write',async()=>{
  const {app,body,post,proposal}=await setup();try{
    assert.equal((await post(body)).statusCode,200);
    await bindContinuityShot(101,{script_id:30,script_scene_id:'F06:s3',moment_id:'F06:s3:exit',phase:'after',reads:[{entity_id:'F06:u1',attribute_id:'integrity'}]});
    const correction={review_action:'human_review',target_scene_id:'F06:s1',expected_script_revision:1,expected_continuity_revision:1,request_key:'changed-frame-preview',reason:'核对差异',changes:[proposal(0)]};
    const preview=await app.inject({method:'POST',url:'/api/scripts/30/continuity/preview',payload:correction});assert.equal(preview.statusCode,200);
    await db.run("UPDATE scene SET asset_url='/new-version.svg' WHERE id=101");
    const confirmed=await post({...correction,expected_impact_hash:preview.json().impact_hash});assert.equal(confirmed.statusCode,409,confirmed.body);assert.equal(confirmed.json().code,'CONTINUITY_REVISION_CONFLICT');
    assert.equal((await db.get('SELECT revision FROM continuity_ledger WHERE script_id=30')).revision,1);
    assert.equal((await db.get('SELECT asset_url FROM scene WHERE id=101')).asset_url,'/new-version.svg');
  }finally{await app.close();}
});

test('CT08 browser round-trip entity ordering permits a scene review but still rejects real binding edits',async()=>{
  const {app,body,post,proposal,get}=await setup();try{
    assert.equal((await post(body)).statusCode,200);
    const view=await get();
    assert.notDeepEqual(view.entities.map((entity:any)=>entity.entity_id),body.entities.map(entity=>entity.entity_id));
    const correction={review_action:'human_review',target_scene_id:'F06:s1',expected_script_revision:1,expected_continuity_revision:1,request_key:'browser-order',reason:'核对浏览器往返顺序',entities:view.entities,entry_values:view.draft.entry_values,changes:[proposal(0)]};
    const preview=await app.inject({method:'POST',url:'/api/scripts/30/continuity/preview',payload:correction});assert.equal(preview.statusCode,200,preview.body);
    const changed=await app.inject({method:'POST',url:'/api/scripts/30/continuity/preview',payload:{...correction,entities:view.entities.map((entity:any)=>entity.entity_id==='F06:u1'?{...entity,display_name:'另一把伞'}:entity)}});
    assert.equal(changed.statusCode,409);assert.equal(changed.json().code,'CONTINUITY_REVIEW_REQUIRED');
    assert.equal((await post({...correction,expected_impact_hash:preview.json().impact_hash})).statusCode,200);
  }finally{await app.close();}
});
