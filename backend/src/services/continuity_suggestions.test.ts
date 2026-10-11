import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { confirmedContinuityFixture } from '../test_fixtures/continuity_confirmed';
import { extractContinuitySuggestions,LogicalContinuityBudget,CONTINUITY_SUGGESTION_BUDGET } from './continuity_suggestions';
import { confirmContinuityChange } from './continuity_confirmation';
import type { AIProvider } from './ai/base';
function task(respond:(input:any,index:number)=>any,fixtureId='F07',caseId='legal-human-correction'){
  const {input}=confirmedContinuityFixture(fixtureId,caseId),calls:any[]=[];
  const provider:AIProvider={async generateStructured(prompt,schema){const request=JSON.parse(prompt);calls.push(request);return schema.parse(await respond(request,calls.length));},async generateText(){throw new Error('Unexpected text');},async generateImage(){throw new Error('Unexpected image');}};
  return {calls,task:{context:input.context,target_scene_id:input.context.order.scenes[0]!.script_scene_id,related_entity_ids:input.context.entities.map(entity=>entity.entity_id),prior_state:input.entry!.state,
    sources:input.context.sources.slice(0,1).map(source=>({source_id:source.source_document_id,source_type:source.source_type,source_document_id:source.source_document_id,source_revision:source.source_revision,text:source.text})),preceding_context:'',provider}};
}
const noChange=()=>({changes:[],pending:[]});
test('CT09 freezes 36 independent labels/72 logical tasks before model runs and never includes labels in inference input',async()=>{
  const labels=fs.readFileSync(path.resolve(__dirname,'../test_fixtures/continuity/eval-labels-v1.json'),'utf8'),manifest=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../test_fixtures/continuity/eval-manifest-v1.json'),'utf8'));
  assert.equal(createHash('sha256').update(labels).digest('hex'),manifest.labels_sha256);const parsed=JSON.parse(labels);assert.equal(parsed.fixtures.length,12);assert.equal(parsed.fixtures.flatMap((fixture:any)=>fixture.cases).length,36);assert.deepEqual(parsed.seeds,[41,97]);
  const data=task(noChange);const result=await extractContinuitySuggestions(data.task);assert.equal(result.status,'ready_for_review');assert.equal(result.proposals.length,0);assert.equal(result.automatic_accepted,0);assert.equal(data.calls[0].expected,undefined);
});
test('CT09 a valid evidence-bearing model proposal stays unconfirmed and cannot write a trusted state through self audit',async()=>{
  const data=task(input=>({changes:[{entity_id:'F07:u1',attribute_id:'holder',operation:'assign',value:'F07:chen',source_id:input.sources[0].source_id,quote:input.sources[0].text}],pending:[]}));
  const result=await extractContinuitySuggestions(data.task);assert.equal(result.proposals.length,1);assert.equal(result.proposals[0]!.origin,'model');assert.equal(result.proposals[0]!.evidence[0]!.kind,'source');assert.equal(result.automatic_accepted,0);
  assert.equal(confirmContinuityChange(result.proposals[0],data.task.context).status,'pending_review');assert.equal(result.budget.calls.length,1);
});
test('CT09 one shared semantic repair spans all children; no nested reset or double-counted inference',async()=>{
  const data=task((_input,index)=>index===2?noChange():{faithful:true,changes:[],pending:[]});
  data.task.sources=Array.from({length:3},(_,index)=>({source_id:`source-${index}`,source_type:'novel',source_document_id:`source-${index}`,source_revision:1,text:`完整动作 ${index}。`.repeat(80)}));
  data.task.context.sources=data.task.sources.map(source=>({...source,project_id:10,bindings:[]}));
  const budget=new LogicalContinuityBudget(),result=await extractContinuitySuggestions({...data.task,budget});
  assert.equal(budget.semantic_repairs,1);assert.equal(data.calls.length,4);assert.equal(budget.calls.length,4);assert.equal(result.status,'pending_review');
  assert.equal(budget.calls.filter(call=>call.kind==='semantic_repair').length,1);assert.ok(data.calls.every(call=>call.sources.reduce((sum:number,source:any)=>sum+source.text.length,0)<=900));
});
test('CT09 transport retries are counted separately and share their own task-wide budget',async()=>{
  const data=task((_input,index)=>{if(index===1)throw Object.assign(new Error('temporary connection'),{code:'ECONNRESET'});return noChange();});
  const result=await extractContinuitySuggestions(data.task);assert.equal(result.budget.network_retries,1);assert.equal(result.budget.semantic_repairs,0);assert.equal(result.budget.calls.length,2);assert.equal(result.budget.calls[1]!.kind,'network_retry');
});
test('CT09 the installed SDK connection-error class consumes only transport budget even when Error.name remains Error',async()=>{
  class APIConnectionError extends Error {}
  const data=task((_input,index)=>{if(index===1)throw new APIConnectionError('Connection error.');return noChange();});
  const result=await extractContinuitySuggestions(data.task);assert.equal(result.budget.network_retries,1);assert.equal(result.budget.semantic_repairs,0);assert.equal(result.budget.calls[1]!.kind,'network_retry');assert.equal(result.status,'ready_for_review');
});
test('CT09 a long indivisible action, unknown required state or complete context is retained for manual review without truncating negation',async()=>{
  const data=task(noChange);const text=`${'完整动作'.repeat(500)}，陈月没有接住。`;data.task.sources[0]!.text=text;
  const result=await extractContinuitySuggestions(data.task);assert.equal(result.status,'pending_review');assert.equal(data.calls.length,0);assert.equal(result.pending[0].sources[0].text,text);
  data.task.sources[0]!.text='陈月没有接住。';data.task.preceding_context='前文。'.repeat(1000);
  const context=await extractContinuitySuggestions(data.task);assert.equal(context.status,'pending_review');assert.equal(data.calls.length,0);assert.equal(CONTINUITY_SUGGESTION_BUDGET.binding_chars,2200);assert.equal(CONTINUITY_SUGGESTION_BUDGET.state_json_chars,2000);
});
test('CT09 complete source splitting preserves every character and forwards preceding sentences instead of losing pronoun context',async()=>{
  const data=task(noChange);const text=Array.from({length:6},(_,index)=>`${'完整动作'.repeat(55)}${index}。`).join('');
  data.task.sources[0]!.text=text;data.task.context.sources[0]!.text=text;
  const result=await extractContinuitySuggestions(data.task);assert.equal(result.status,'ready_for_review');assert.ok(data.calls.length>=2);
  assert.equal(data.calls.flatMap(call=>call.sources.map((source:any)=>source.text)).join(''),text);assert.ok(data.calls[1].preceding_context.includes(data.calls[0].sources[0].text));
});
test('CT09 unknown properties and joint holders retain exact quotes and all values as pending suggestions',async()=>{
  const data=task(input=>({changes:[{entity_id:'F07:u1',attribute_id:'holder',operation:'assign',value:['F07:lin','F07:chen'],source_id:input.sources[0].source_id,quote:input.sources[0].text},{entity_id:'F07:cup',attribute_id:'cup_quantity',operation:'assign',value:'one',source_id:input.sources[0].source_id,quote:input.sources[0].text}],pending:[]}));
  const result=await extractContinuitySuggestions(data.task);assert.equal(result.proposals.length,0);assert.equal(result.pending.length,2);assert.deepEqual(result.pending[0].raw.value,['F07:lin','F07:chen']);assert.equal(result.pending[1].raw.attribute_id,'cup_quantity');assert.equal(result.pending[0].evidence[0].evidence_quote,data.task.sources[0]!.text);
});
test('CT09 cancellation reaches child inference and cannot restart an exhausted parent budget',async()=>{
  const data=task(noChange),budget=new LogicalContinuityBudget();budget.consumeSemantic();const controller=new AbortController();controller.abort(new Error('cancelled review'));
  await assert.rejects(extractContinuitySuggestions({...data.task,budget,signal:controller.signal}),/cancelled review/);assert.equal(data.calls.length,0);assert.equal(budget.consumeSemantic(),false);
});

test('CT09 partial quotes cannot drop a negation/receipt clause; model and scene changes invalidate cached batches',async()=>{
  const data=task(input=>({changes:[{entity_id:'F07:u1',attribute_id:'holder',operation:'assign',value:'F07:chen',source_id:input.sources[0].source_id,quote:input.sources[0].text.slice(0,-1)}],pending:[]}));
  const rejected=await extractContinuitySuggestions(data.task);assert.equal(rejected.proposals.length,0);assert.equal(rejected.budget.semantic_repairs,1);assert.equal(rejected.status,'pending_review');
  const source=task(noChange);const first=await extractContinuitySuggestions({...source.task,model_fingerprint:'model-v1'});
  const repeat=await extractContinuitySuggestions({...source.task,model_fingerprint:'model-v1',reuse:first.reuse});assert.equal(repeat.reuse_hits,1);assert.equal(source.calls.length,1);
  await extractContinuitySuggestions({...source.task,model_fingerprint:'model-v2',reuse:first.reuse});assert.equal(source.calls.length,2);
});
