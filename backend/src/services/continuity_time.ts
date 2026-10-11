import { ContinuityTimePlanSchema, type ContinuityTimePlan } from '../schemas/continuity_time';
import type { ContinuityConfirmation } from '../schemas/continuity_state';
import { ContinuityConfirmationError, validateContinuityEvidence, type ContinuityConfirmationContext } from './continuity_confirmation';
import { continuityAttribute } from '../schemas/continuity_state';
import { continuityHash } from './continuity_replay';
export type ConfirmedContinuityTimePlan = {proposal:ContinuityTimePlan;confirmation:Extract<ContinuityConfirmation,{kind:'human'}>};
const approved = new WeakSet<object>();
const fail=(message:string):never=>{throw new ContinuityConfirmationError('CONTINUITY_TIME_REVIEW_REQUIRED',message);};
export const continuityTimePlanHash=(raw:unknown)=>continuityHash(ContinuityTimePlanSchema.parse(raw));
export function confirmContinuityTimePlan(raw:unknown,context:ContinuityConfirmationContext):ConfirmedContinuityTimePlan {
  const proposal=ContinuityTimePlanSchema.parse(raw),seen=new Set<string>();
  const realityDays=new Set([proposal.initial_day_id]);
  let branch:string|null=null;
  for(const boundary of [...proposal.boundaries].sort((a,b)=>context.order.scenes.findIndex(s=>s.script_scene_id===a.script_scene_id)-context.order.scenes.findIndex(s=>s.script_scene_id===b.script_scene_id))){
    const index=context.order.scenes.findIndex(s=>s.script_scene_id===boundary.script_scene_id);
    if(index<0||seen.has(boundary.script_scene_id))fail('Each scene has at most one explicit time boundary');
    seen.add(boundary.script_scene_id);
    if(boundary.evidence.source_type!=='screenplay'||!boundary.evidence.source_document_id.startsWith(`script:${context.order.script_id}:${boundary.script_scene_id}:`))fail('Time boundary needs exact evidence from this screenplay scene');
    if(!context.entities.length)fail('Register the physical identities before reviewing a time boundary');
    validateContinuityEvidence(boundary.evidence,context.entities[0]!.entity_id,context);
    const quote=boundary.evidence.evidence_quote;
    const source=context.sources.find(s=>s.source_type==='screenplay'&&s.source_document_id===boundary.evidence.source_document_id)!;
    if(boundary.evidence.start!==0||boundary.evidence.end!==source.text.length)fail('Use the full source block for time review');
    if(boundary.kind!=='unknown'&&/如果|假如|也许|可能|并未|没有|不是|并非|不曾|打算|准备/.test(quote))fail('Hypothetical or negated time boundary remains unresolved');
    if(boundary.kind==='new_day'&&(!boundary.day_id||boundary.anchor||boundary.branch_id||branch||!/次日|翌日|第二天|新的一天|\bnext day\b/i.test(quote)))fail('New day requires an explicit day and source boundary outside a flashback');
    if(boundary.kind==='new_day'){if(realityDays.has(boundary.day_id!))fail('A next-day boundary requires a distinct story day');realityDays.add(boundary.day_id!);}
    if(boundary.kind==='flashback'){
      const anchor=context.order.scenes.findIndex(s=>s.script_scene_id===boundary.anchor?.script_scene_id);
      if(branch||!boundary.branch_id||boundary.branch_id==='reality'||!boundary.day_id||anchor<0||anchor>=index||!/回忆|回想|闪回|\bflashback\b/i.test(quote))fail('Flashback requires an earlier confirmed anchor and a distinct branch; nested flashbacks are not supported');
      branch=boundary.branch_id!;
    }
    if(boundary.kind==='return_reality'){
      if(!branch||boundary.branch_id!==branch||boundary.anchor||boundary.day_id||boundary.rules.length||!/回到现实|返回现实|回忆结束|\bback to (?:the )?present\b/i.test(quote))fail('Return must close the current branch without rewriting its saved reality state');
      branch=null;
    }
    if(boundary.kind==='unknown'&&(boundary.rules.length||boundary.anchor||boundary.day_id||boundary.branch_id))fail('Unresolved time cannot assert inheritance or an anchor');
    const keys=new Set<string>();
    for(const rule of boundary.rules){
      const key=JSON.stringify([rule.entity_id,rule.attribute_id]);if(keys.has(key))fail('Duplicate per-property time decision');keys.add(key);
      const entity=context.entities.find(e=>e.entity_id===rule.entity_id);if(!entity)fail('Unknown physical identity in time decision');
      // Unknown is a deliberate loss of knowledge, never an asset-default reset.
      const definition=continuityAttribute(rule.attribute_id);if(!definition?.kinds.includes(entity!.kind))fail('Unsupported time property');
    }
    if(!['new_day','flashback'].includes(boundary.kind)&&boundary.rules.length)fail('Only explicit day/flashback boundaries accept per-property decisions');
  }
  const authority=context.authority;
  if(authority?.kind!=='human'||authority.proposal_hash!==continuityTimePlanHash(proposal))fail('Time plan requires an exact human review');
  const result={proposal:structuredClone(proposal),confirmation:{...authority}} as ConfirmedContinuityTimePlan;
  const freeze=(value:any)=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};freeze(result);approved.add(result);return result;
}
export function requireContinuityTimePlan(plan:ConfirmedContinuityTimePlan,context:ContinuityConfirmationContext){
  if(!approved.has(plan))fail('Serialized time flags are not confirmed temporal authority');
  confirmContinuityTimePlan(plan.proposal,{...context,authority:plan.confirmation});return plan;
}
