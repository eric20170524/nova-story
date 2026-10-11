import '../test_setup';
import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db } from '../db/database';
import { createEmptyScriptDocument } from '../schemas/script';
import { confirmedContinuityFixture } from '../test_fixtures/continuity_confirmed';
import { confirmContinuityReview,getContinuityReview } from './continuity_review';
import { startContinuitySuggestionTask,getContinuitySuggestionTask,waitForContinuitySuggestionTask,cancelContinuitySuggestionTask } from './continuity_suggestion_tasks';
import { continuityRoutes } from '../routes/continuity';
import { LLMService } from './llm';
import type { AIProvider,StructuredGenOptions } from './ai/base';

beforeEach(async()=>{await db.run('DELETE FROM project WHERE id=10');});
async function setup(texts=['黑伞的柄只是弯曲，没有折断。']){
  const fixture=confirmedContinuityFixture('F06','upstream-revision'),doc=createEmptyScriptDocument('CT09');
  doc.locations=[{id:'room',name:'房间',description:''}];
  doc.scenes=['s1','s2'].map((id,index)=>({id,locationId:'room',interiorExterior:'interior' as const,timeOfDay:'day',characterIds:[],propIds:[],eventIds:[],beatIds:[],sourceParagraphIds:[],blocks:(index?['陈月没有接住黑伞。']:texts).map((text,i)=>({id:`${id}-a${i}`,type:'action' as const,text}))}));
  await db.run("INSERT INTO project(id,title,user_id) VALUES(10,'CT09','local_admin')");
  await db.run('INSERT INTO chapter(id,project_id,"index",title,content) VALUES(\'suggest\',10,0,\'CT09\',?)',texts.join('\n'));
  await db.run("INSERT INTO character(id,project_id,name) VALUES(1,10,'林岚'),(2,10,'陈月')");
  await db.run("INSERT INTO chapter_script(id,chapter_id,revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash) VALUES(30,'suggest',1,'confirmed',?,'{}','test','test')",JSON.stringify(doc));
  await confirmContinuityReview(30,{review_action:'human_review',target_scene_id:'s1',expected_script_revision:1,expected_continuity_revision:0,request_key:'entry',reason:'冻结前态',entities:fixture.input.context.entities,entry_values:Object.entries(fixture.fixture.initial_state).flatMap(([entity_id,attrs])=>Object.entries(attrs).map(([attribute_id,value])=>({entity_id,attribute_id,knowledge_status:'confirmed',value}))),changes:[]},'test-human');
  const request={target_scene_id:'s1',expected_script_revision:1,expected_continuity_revision:1,request_key:'suggestion-one',seed:41};
  return {request,doc};
}
function mock(respond:(input:any,index:number,options?:StructuredGenOptions)=>Promise<any>|any){
  const calls:any[]=[];
  const provider:AIProvider={async generateStructured(prompt,schema,_system,options){const input=JSON.parse(prompt);calls.push({input,options});return schema.parse(await respond(input,calls.length,options));},async generateText(){throw new Error('Unexpected text call');},async generateImage(){throw new Error('Unexpected image call');}};
  return {provider,calls};
}
const empty={changes:[],pending:[]};

test('CT09 API reserves idempotent tasks, records trace, and only persists unconfirmed proposals',async t=>{
  const {request}=await setup(),model=mock(input=>({changes:[{entity_id:'F06:u1',attribute_id:'integrity',operation:'assign',value:'damaged',source_id:input.sources[0].source_id,quote:input.sources[0].text}],pending:[]}));
  t.mock.method(LLMService,'getLocalProvider',()=>model.provider);
  const app=Fastify();await app.register(continuityRoutes,{prefix:'/api'});
  try{
    const post=()=>app.inject({method:'POST',url:'/api/scripts/30/continuity/suggestions',payload:request});
    const [one,two]=await Promise.all([post(),post()]);assert.equal(one.statusCode,202,one.body);assert.equal(one.json().task_id,two.json().task_id);
    await waitForContinuitySuggestionTask(one.json().task_id);
    const response=await app.inject({method:'GET',url:`/api/scripts/30/continuity/suggestion-tasks/${one.json().task_id}`});assert.equal(response.statusCode,200);
    const task=response.json();assert.equal(task.status,'completed');assert.equal(task.result.proposals.length,1);assert.equal(task.result.automatic_accepted,0);assert.equal(task.budget.calls.length,1);assert.equal(model.calls[0].options.transportRetries,0);
    assert.equal((await db.get('SELECT revision FROM continuity_ledger WHERE script_id=30')).revision,1);assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_revision')).n,1);
    const view=await getContinuityReview(30,'s1'),cell=view.snapshot!.exit_state.find(cell=>cell.entity_id==='F06:u1'&&cell.attribute_id==='integrity');assert.ok(cell?.knowledge_status==='confirmed');assert.equal(cell.value,'broken');assert.equal(view.pending_suggestions.length,1);
    assert.equal((await post()).json().task_id,task.task_id);assert.equal(model.calls.length,1);
    assert.equal((await app.inject({method:'GET',url:`/api/scripts/31/continuity/suggestion-tasks/${task.task_id}`})).statusCode,404);
    const forged=await app.inject({method:'POST',url:'/api/scripts/30/continuity/suggestions',payload:{...request,authority:'model'}});assert.equal(forged.statusCode,422);
  }finally{await app.close();}
});

test('CT09 cancellation and process restart reuse complete batches and preserve the consumed parent repair budget',async()=>{
  const {request}=await setup(['第一段完整动作。'.repeat(65),'第二段完整动作。'.repeat(65)]);
  let blocked:()=>void=()=>{};const entered=new Promise<void>(resolve=>{blocked=resolve;});
  const model=mock((input,index,options)=>{
    if(index===1)return {faithful:true,...empty};
    if(index===2)return empty;
    blocked();return new Promise((_resolve,reject)=>{options!.signal!.addEventListener('abort',()=>reject(options!.signal!.reason),{once:true});});
  });
  const first=await startContinuitySuggestionTask(30,request,{provider:model.provider,modelFingerprint:'frozen-9b'});await entered;
  const inFlight=await getContinuitySuggestionTask(30,first.task_id);assert.equal(inFlight.budget.calls.length,3);assert.equal(inFlight.budget.calls[2].attempt_state,'reserved');
  const cancelled=await cancelContinuitySuggestionTask(30,first.task_id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.reuse_batches,1);assert.equal(cancelled.budget.semantic_repairs,1);assert.equal(cancelled.budget.calls.length,3);
  // A processing record without an in-memory owner is the durable state after a process restart.
  await db.run("UPDATE continuity_suggestion_task SET status='processing' WHERE id=?",first.task_id);
  const fresh=mock(()=>empty);const resumed=await startContinuitySuggestionTask(30,request,{provider:fresh.provider,modelFingerprint:'frozen-9b'});await waitForContinuitySuggestionTask(resumed.task_id);
  const result=await getContinuitySuggestionTask(30,resumed.task_id);assert.equal(result.status,'completed');assert.equal(result.result.reuse_hits,1);assert.equal(fresh.calls.length,1);assert.equal(result.budget.semantic_repairs,1);assert.equal(result.budget.calls.length,4);assert.equal(result.attempt,2);
});

test('CT09 changed source/model/scene scope cannot reuse an old checkpoint or write late results',async()=>{
  const {request}=await setup();let release:(value:any)=>void=()=>{};
  const model=mock(()=>new Promise(resolve=>{release=resolve;}));
  const started=await startContinuitySuggestionTask(30,request,{provider:model.provider,modelFingerprint:'9b-v1'});
  await assert.rejects(startContinuitySuggestionTask(30,request,{provider:model.provider,modelFingerprint:'9b-v2'}),/checkpoint/);
  await assert.rejects(startContinuitySuggestionTask(30,{...request,request_key:'bad-context',preceding_source_ids:['script:30:s2:s2-a0']},{provider:model.provider}),/earlier saved scene/);
  await assert.rejects(startContinuitySuggestionTask(30,{...request,request_key:'foreign-entity',related_entity_ids:['foreign']},{provider:model.provider}),/outside this project/);
  await db.run("UPDATE chapter SET content='修改后的原文' WHERE id='suggest'");
  release(empty);await waitForContinuitySuggestionTask(started.task_id);
  assert.equal((await getContinuitySuggestionTask(30,started.task_id)).status,'stale');assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_suggestion')).n,0);assert.equal((await db.get('SELECT revision FROM continuity_ledger WHERE script_id=30')).revision,1);
});

test('CT09 deleted project cleans task/checkpoint rows through the screenplay lifecycle',async()=>{
  const {request}=await setup(),model=mock(()=>empty);
  const started=await startContinuitySuggestionTask(30,request,{provider:model.provider});await waitForContinuitySuggestionTask(started.task_id);
  await db.run('DELETE FROM project WHERE id=10');assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_suggestion_task')).n,0);
});
