import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {confirmedContinuityFixture} from '../test_fixtures/continuity_confirmed';
import {ContinuityChangeProposalSchema,continuityAttributeVersion} from '../schemas/continuity_state';
import {applyConfirmedContinuityChange,confirmContinuityChange,continuityProposalHash} from './continuity_confirmation';
import {replayContinuityScene,readContinuityMoment,confirmContinuityOverlay,continuityOverlayHash} from './continuity_replay';
import type {ContinuityOverlayProposal} from '../schemas/continuity_snapshot';
import {continuityVisualStates,continuityVisualFact} from './continuity_visual_state';
function fixture(){
  const f=confirmedContinuityFixture('F01','ordered');
  const change=(text:string,value:string,order=9)=>{const source={project_id:10,source_type:'screenplay' as const,source_document_id:`hand:${order}`,source_revision:1,text,bindings:[]};f.input.context.sources.push(source);return {...f.base,...continuityAttributeVersion('holding_hand'),change_id:`hand:${order}`,entity_id:'F01:umbrella',attribute_id:'holding_hand',value,basis:'story' as const,story_position:{...f.base.story_position,phase:'after' as const,change_order:order,moment_id:`hand:${order}`},evidence:[{kind:'source' as const,source_type:'screenplay' as const,source_document_id:source.source_document_id,source_revision:1,source_text_hash:createHash('sha256').update(text).digest('hex'),evidence_quote:text,start:0,end:text.length}]};};
  return {...f,change};
}
test('CT21 H-A01: confirmed physical hand compiles anatomical direction and reads its exact holder',()=>{
  const f=fixture(),p=f.change('林岚用自己的左手握着黑伞。','physical_left');
  f.input.changes=[...f.input.changes,f.approve(p)];const result=replayContinuityScene(f.input,'F01:s1');assert.equal(result.status,'ready');if(result.status!=='ready')throw new Error();
  const read=readContinuityMoment(result.snapshot,'F01:s1:exit','after',[{entity_id:'F01:umbrella',attribute_id:'holding_hand'}]);
  assert.deepEqual(read.values.map(v=>v.attribute_id).sort(),['holder','holding_hand']);
  const facts=continuityVisualStates(f.input.context.entities,read.values,'snapshot').map(continuityVisualFact).join('\n');assert.match(facts,/anatomical left hand/);assert.match(facts,/independent of screen left\/right/);
});
test('CT21 H-A02: completed transfer makes receiving hand unknown until separately established',()=>{
  const f=fixture();f.input.changes=[...f.input.changes,f.approve(f.change('林岚用自己的左手握着黑伞。','physical_left'))];
  const second=replayContinuityScene(f.input,'F01:s2');assert.equal(second.status,'ready');if(second.status!=='ready')throw new Error();
  assert.equal(second.snapshot.exit_state.find(c=>c.attribute_id==='holding_hand')?.knowledge_status,'unknown');assert.throws(()=>readContinuityMoment(second.snapshot,'F01:s2:exit','after',[{entity_id:'F01:umbrella',attribute_id:'holding_hand'}]));
  const right={...f.change('陈月用自己的右手握着黑伞。','physical_right',10),story_position:{...f.base.story_position,script_scene_id:'F01:s2',scene_order:1,change_order:10,moment_id:'chen-hand',phase:'after' as const}};
  f.input.changes=[...f.input.changes,f.approve(right)];const next=replayContinuityScene(f.input,'F01:s2');assert.equal(next.status,'ready');if(next.status!=='ready')throw new Error();
  const read=readContinuityMoment(next.snapshot,'F01:s2:exit','after',[{entity_id:'F01:umbrella',attribute_id:'holding_hand'}]);assert.ok(read.values.some(v=>v.attribute_id==='holder'&&v.value==='F01:chen'));assert.notEqual(read.dependency_hash,readContinuityMoment(replayReady(f.input,'F01:s1'),'F01:s1:exit','after',[{entity_id:'F01:umbrella',attribute_id:'holding_hand'}]).dependency_hash);
});
const replayReady=(input:any,id:string)=>{const r=replayContinuityScene(input,id);if(r.status!=='ready')throw new Error();return r.snapshot;};
test('CT21 during overlay holder change drops the previous hand and a same-holder frame keeps it',()=>{
  const f=fixture();
  const hand=f.approve(f.change('林岚用自己的左手握着黑伞。','physical_left',8));
  const source={project_id:10,source_type:'screenplay' as const,source_document_id:'crack',source_revision:1,text:'黑伞出现裂痕。',bindings:[]};
  f.input.context.sources.push(source);
  const later=f.approve({...f.base,change_id:'crack',entity_id:'F01:umbrella',attribute_id:'integrity',value:'damaged',basis:'story',operation:'assign',story_position:{...f.base.story_position,phase:'after',change_order:10,moment_id:'crack'},evidence:[{kind:'source',source_type:'screenplay',source_document_id:'crack',source_revision:1,source_text_hash:createHash('sha256').update(source.text).digest('hex'),evidence_quote:source.text,start:0,end:source.text.length}]});
  f.input.changes=[...f.input.changes,hand,later];
  const frame=(overlay_id:string,values:ContinuityOverlayProposal['values'],extended=false):ContinuityOverlayProposal=>({schema_version:extended?2:1,policy_version:extended?'continuity-state-2':'continuity-state-1',overlay_id,overlay_revision:1,binding_revision:1,story_position:{...later.proposal.story_position,moment_id:overlay_id,phase:'during'},event_change_id:later.proposal.change_id,after_change_id:hand.proposal.change_id,values,evidence:[{kind:'design',design_id:'F01:umbrella:entry-design',design_revision:1}]});
  const approve=(raw:ContinuityOverlayProposal)=>confirmContinuityOverlay(raw,{...f.input.context,authority:{kind:'human',review_id:raw.overlay_id,review_revision:1,actor_id:'fixture-reviewer',proposal_hash:continuityOverlayHash(raw)}});
  const changed=replayContinuityScene({...f.input,during_overlays:[approve(frame('handoff',[{entity_id:'F01:umbrella',attribute_id:'holder',value:'F01:chen'}]))]},'F01:s1');
  assert.equal(changed.status,'ready');if(changed.status!=='ready')throw new Error();
  const during=changed.snapshot.moments.find(moment=>moment.story_position.moment_id==='handoff')!;
  const duringHolder=during.state.find(cell=>cell.attribute_id==='holder');
  assert.ok(duringHolder?.knowledge_status==='confirmed');
  assert.equal(duringHolder.value,'F01:chen');
  assert.equal(during.state.find(cell=>cell.attribute_id==='holding_hand')?.knowledge_status,'unknown');
  assert.throws(()=>readContinuityMoment(changed.snapshot,'handoff','during',[{entity_id:'F01:umbrella',attribute_id:'holding_hand'}]));
  const exitHolder=changed.snapshot.exit_state.find(cell=>cell.attribute_id==='holder'&&cell.entity_id==='F01:umbrella');
  assert.ok(exitHolder?.knowledge_status==='confirmed');
  assert.equal(exitHolder.value,'F01:lin');
  const exitHand=changed.snapshot.exit_state.find(cell=>cell.attribute_id==='holding_hand');
  assert.ok(exitHand?.knowledge_status==='confirmed');
  assert.equal(exitHand.value,'physical_left');
  const kept=replayContinuityScene({...f.input,during_overlays:[approve(frame('same-holder',[{entity_id:'F01:umbrella',attribute_id:'holder',value:'F01:lin'}]))]},'F01:s1');
  assert.equal(kept.status,'ready');if(kept.status!=='ready')throw new Error();
  const read=readContinuityMoment(kept.snapshot,'same-holder','during',[{entity_id:'F01:umbrella',attribute_id:'holding_hand'}]);
  assert.equal(read.values.find(value=>value.attribute_id==='holding_hand')?.value,'physical_left');
  assert.equal(read.values.find(value=>value.attribute_id==='holder')?.value,'F01:lin');
});
test('CT21 during overlay can establish the new holder’s hand in the same frame',()=>{
  const f=fixture();
  const hand=f.approve(f.change('林岚用自己的左手握着黑伞。','physical_left',8));
  const quote='陈月用自己的右手握着黑伞。';
  const crackText='黑伞出现裂痕。';
  const source={project_id:10,source_type:'screenplay' as const,source_document_id:'chen-hand-frame',source_revision:1,text:quote,bindings:[]};
  const crack={project_id:10,source_type:'screenplay' as const,source_document_id:'crack-2',source_revision:1,text:crackText,bindings:[]};
  f.input.context.sources.push(source,crack);
  const later=f.approve({...f.base,change_id:'after-hand',entity_id:'F01:umbrella',attribute_id:'integrity',value:'damaged',basis:'story',operation:'assign',story_position:{...f.base.story_position,phase:'after',change_order:10,moment_id:'after-hand'},evidence:[{kind:'source',source_type:'screenplay',source_document_id:crack.source_document_id,source_revision:1,source_text_hash:createHash('sha256').update(crackText).digest('hex'),evidence_quote:crackText,start:0,end:crackText.length}]});
  f.input.changes=[...f.input.changes,hand,later];
  const evidence=[{kind:'source' as const,source_type:'screenplay' as const,source_document_id:source.source_document_id,source_revision:1,source_text_hash:createHash('sha256').update(quote).digest('hex'),evidence_quote:quote,start:0,end:quote.length}];
  const proposal:ContinuityOverlayProposal={schema_version:2,policy_version:'continuity-state-2',overlay_id:'chen-frame',overlay_revision:1,binding_revision:1,story_position:{...later.proposal.story_position,moment_id:'chen-frame',phase:'during'},event_change_id:later.proposal.change_id,after_change_id:hand.proposal.change_id,values:[{entity_id:'F01:umbrella',attribute_id:'holder',value:'F01:chen'},{entity_id:'F01:umbrella',attribute_id:'holding_hand',value:'physical_right'}],evidence};
  const overlay=confirmContinuityOverlay(proposal,{...f.input.context,authority:{kind:'human',review_id:'chen-frame',review_revision:1,actor_id:'fixture-reviewer',proposal_hash:continuityOverlayHash(proposal)}});
  const result=replayContinuityScene({...f.input,during_overlays:[overlay]},'F01:s1');
  assert.equal(result.status,'ready');if(result.status!=='ready')throw new Error();
  const read=readContinuityMoment(result.snapshot,'chen-frame','during',[{entity_id:'F01:umbrella',attribute_id:'holding_hand'}]);
  assert.equal(read.values.find(value=>value.attribute_id==='holder')?.value,'F01:chen');
  assert.equal(read.values.find(value=>value.attribute_id==='holding_hand')?.value,'physical_right');
});
test('CT21 H-A03: camera coordinates, intention, negation, wrong enum and v1 claims stay pending',()=>{
  const f=fixture();for(const [text,value] of [['黑伞出现在画面左侧。','physical_left'],['林岚打算换到右手。','physical_right'],['林岚并未换到右手。','physical_right'],['林岚用左手握伞。','screen_left'],['林岚把黑伞从自己的左手换到自己的右手。','physical_left']]){
    const p=f.change(text!,value!);const result=confirmContinuityChange(p,{...f.input.context,authority:{kind:'human',review_id:'review',review_revision:1,actor_id:'human',proposal_hash:continuityProposalHash(p)}});assert.equal(result.status,'pending_review');
  }
  const p=f.change('林岚用左手握伞。','physical_left');assert.equal(ContinuityChangeProposalSchema.safeParse({...p,schema_version:1,policy_version:'continuity-state-1'}).success,false);
  assert.throws(()=>applyConfirmedContinuityChange([],f.approve(p),f.input.context));
  assert.throws(()=>applyConfirmedContinuityChange(f.state,f.approve(f.change('陈月用自己的左手握着黑伞。','physical_left')),f.input.context));
});
test('CT21 H-A04: both means one holder’s two hands; shared carrying and quantities remain unsupported',()=>{
  const f=fixture(),p=f.change('林岚用自己的双手握着黑伞。','both');const result=applyConfirmedContinuityChange(f.state,f.approve(p),f.input.context);assert.ok(result.some(c=>c.attribute_id==='holding_hand'&&c.knowledge_status==='confirmed'&&c.value==='both'));
  const shared={...f.base,entity_id:'F01:umbrella',attribute_id:'holder',value:['F01:lin','F01:chen']};assert.equal(confirmContinuityChange(shared,f.input.context).status,'pending_review');
  const volume={...f.base,entity_id:'F01:umbrella',attribute_id:'volume_ml',value:'250'};assert.equal(confirmContinuityChange(volume,f.input.context).status,'pending_review');
});
