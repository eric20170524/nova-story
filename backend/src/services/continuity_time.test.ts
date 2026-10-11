import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {confirmedContinuityFixture} from '../test_fixtures/continuity_confirmed';
import {confirmContinuityTimePlan,continuityTimePlanHash} from './continuity_time';
import {replayContinuityScene,readContinuityMoment,continuityHash} from './continuity_replay';
import {serializeContinuityRecord,restoreContinuityRecord} from './continuity_store';
import type {ContinuityTimePlan} from '../schemas/continuity_time';
function fixture(){
  const f=confirmedContinuityFixture('F01','ordered');
  for(let i=3;i<5;i++)f.input.context.order.scenes.push({script_scene_id:`F01:s${i+1}`,scene_order:i,beat_ids:[]});
  const quotes=['次日，林岚的外套状态需要核对。','林岚回忆起第一天。','回到现实，陈月仍站在门边。','不知过了多久。'];
  const evidence=quotes.map((text,i)=>{const source={project_id:10,source_type:'screenplay' as const,source_document_id:`script:30:F01:s${i+2}:time`,source_revision:1,text,bindings:[]};f.input.context.sources.push(source);return {kind:'source' as const,source_type:'screenplay' as const,source_document_id:source.source_document_id,source_revision:1,source_text_hash:createHash('sha256').update(text).digest('hex'),evidence_quote:text,start:0,end:text.length};});
  const rules=f.input.entry!.state.map(c=>({entity_id:c.entity_id,attribute_id:c.attribute_id,action:'inherit' as const}));
  const plan:ContinuityTimePlan={schema_version:1,policy_version:'continuity-time-1',initial_day_id:'day-1',boundaries:[]};
  const approveTime=(raw=plan)=>confirmContinuityTimePlan(raw,{...f.input.context,authority:{kind:'human',review_id:'time-review',review_revision:2,actor_id:'human',proposal_hash:continuityTimePlanHash(raw)}});
  return {...f,plan,rules,evidence,approveTime};
}
const ready=(input:any,id:string)=>{const result=replayContinuityScene(input,id);assert.equal(result.status,'ready',JSON.stringify(result));if(result.status!=='ready')throw new Error();return result.snapshot;};
test('CT20 T01: next day inherits damage but leaves garment wetness unknown; no default reset',()=>{
  const f=fixture();f.plan.boundaries=[{script_scene_id:'F01:s2',kind:'new_day',day_id:'day-2',rules:f.rules.map(r=>r.attribute_id==='wetness'?{...r,action:'unknown'}:r),evidence:f.evidence[0]!}];
  f.input.context.time_plan=f.approveTime();const snapshot=ready(f.input,'F01:s2');
  assert.equal(snapshot.entry_state.find(c=>c.attribute_id==='wetness')?.knowledge_status,'unknown');
  const integrity=snapshot.exit_state.find(c=>c.entity_id==='F01:umbrella'&&c.attribute_id==='integrity');assert.equal(integrity?.knowledge_status==='confirmed'?integrity.value:undefined,'broken');
  assert.throws(()=>readContinuityMoment(snapshot,'F01:s2:exit','after',[{entity_id:'F01:coat',attribute_id:'wetness'}]));
  assert.equal(snapshot.moments[0]!.story_position.time_scope?.day_id,'day-2');
});
test('CT20 T02: flashback uses anchored history; branch changes cannot leak through return',()=>{
  const f=fixture();f.plan.boundaries=[{script_scene_id:'F01:s3',kind:'flashback',day_id:'day-1',branch_id:'memory-1',anchor:{script_scene_id:'F01:s1',phase:'entry'},rules:f.rules,evidence:f.evidence[1]!},{script_scene_id:'F01:s4',kind:'return_reality',branch_id:'memory-1',rules:[],evidence:f.evidence[2]!}];
  f.input.context.time_plan=f.approveTime();
  const p={...f.base,change_id:'memory-repair',entity_id:'F01:umbrella',attribute_id:'integrity',value:'intact',basis:'story' as const,story_position:{...f.base.story_position,script_scene_id:'F01:s3',scene_order:2,moment_id:'memory-repair',phase:'after' as const},evidence:[f.evidence[1]!]};
  f.input.changes=[...f.input.changes,f.approve(p)];
  const memory=ready(f.input,'F01:s3'),reality=ready(f.input,'F01:s4');
  const value=(s:typeof memory,attribute:string)=>{const cell=s.exit_state.find(c=>c.entity_id==='F01:umbrella'&&c.attribute_id===attribute);return cell?.knowledge_status==='confirmed'?cell.value:undefined;};
  assert.equal(value(memory,'integrity'),'intact');assert.equal(value(memory,'holder'),'F01:lin');
  assert.equal(value(reality,'integrity'),'broken');assert.equal(value(reality,'holder'),'F01:chen');
  assert.equal(memory.moments[0]!.story_position.time_scope?.branch_id,'memory-1');assert.equal(reality.moments[0]!.story_position.time_scope?.branch_id,'reality');
  const sequence=(ids:string[])=>ids.map(id=>{const s=ready(f.input,id);return [id,s.state_hash,s.source_hash];}).sort();
  assert.deepEqual(sequence(['F01:s4','F01:s1','F01:s3']),sequence(['F01:s1','F01:s3','F01:s4']));
  const restored=restoreContinuityRecord(serializeContinuityRecord(f.input));assert.equal(ready(restored,'F01:s4').state_hash,reality.state_hash);
});
test('CT20 T03: unknown boundary blocks this scene and later scenes, earlier scene remains readable',()=>{
  const f=fixture();f.plan.boundaries=[{script_scene_id:'F01:s5',kind:'unknown',rules:[],evidence:f.evidence[3]!}];f.input.context.time_plan=f.approveTime();
  ready(f.input,'F01:s4');const result=replayContinuityScene(f.input,'F01:s5');assert.equal(result.status,'pending_review');
  assert.throws(()=>ready({...f.input,context:{...f.input.context,time_plan:structuredClone(f.input.context.time_plan)}},'F01:s1'));
});
test('CT20 T04: missing per-property decisions, wrong day and unmatched/nested return fail closed',()=>{
  const f=fixture();const b={script_scene_id:'F01:s3',kind:'flashback' as const,day_id:'day-other',branch_id:'memory-1',anchor:{script_scene_id:'F01:s1',phase:'entry' as const},rules:f.rules,evidence:f.evidence[1]!};
  f.plan.boundaries=[b];f.input.context.time_plan=f.approveTime();assert.equal(replayContinuityScene(f.input,'F01:s3').status,'pending_review');
  f.plan.boundaries=[{script_scene_id:'F01:s2',kind:'new_day',day_id:'day-2',rules:f.rules.slice(1),evidence:f.evidence[0]!}];f.input.context.time_plan=f.approveTime();assert.equal(replayContinuityScene(f.input,'F01:s2').status,'pending_review');
  f.plan.boundaries=[{script_scene_id:'F01:s4',kind:'return_reality',branch_id:'missing',rules:[],evidence:f.evidence[2]!}];assert.throws(()=>f.approveTime());
  f.plan.boundaries=[{...b,day_id:'day-1'},{...b,script_scene_id:'F01:s4'}];assert.throws(()=>f.approveTime());
});
test('CT20 T05: evidence changes, partial quotes, hypothetical next day and authority forgery are rejected',()=>{
  const f=fixture(),b={script_scene_id:'F01:s2',kind:'new_day' as const,day_id:'day-2',rules:f.rules,evidence:f.evidence[0]!};
  f.plan.boundaries=[{...b,evidence:{...b.evidence,source_text_hash:'0'.repeat(64)}}];assert.throws(()=>f.approveTime());
  f.plan.boundaries=[{...b,evidence:{...b.evidence,evidence_quote:'次日',end:2}}];assert.throws(()=>f.approveTime());
  f.plan.boundaries=[b];assert.throws(()=>confirmContinuityTimePlan(f.plan,f.input.context));
  f.plan.boundaries=[{...b,day_id:'day-1'}];assert.throws(()=>f.approveTime());
  const source=f.input.context.sources.find(s=>s.source_document_id===b.evidence.source_document_id)!;source.text='如果到了次日。';f.plan.boundaries=[{...b,evidence:{...b.evidence,evidence_quote:source.text,end:source.text.length,source_text_hash:createHash('sha256').update(source.text).digest('hex')}}];assert.throws(()=>f.approveTime());
});
