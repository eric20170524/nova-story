import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AIProvider,StructuredGenOptions } from './ai/base';
import type { ContinuityConfirmationContext } from './continuity_confirmation';
import { validateContinuityTypedValue,validateContinuitySuggestionProposal,ContinuityConfirmationError } from './continuity_confirmation';
import { CONTINUITY_ATTRIBUTES,continuityAttribute,continuityAttributeVersion,type ContinuityCell,type ContinuityChangeProposal } from '../schemas/continuity_state';
import { makeContinuityStoryPosition } from './continuity_identity';
import { isInferenceTransportError } from './workflow_inference_budget';

export const CONTINUITY_SUGGESTION_BUDGET=Object.freeze({binding_chars:2200,source_unit_chars:1800,source_batch_chars:900,source_batch_count:6,state_json_chars:2000,beat_chars:1800,group_chars:1400,group_beats:4,output_tokens:768,semantic_repairs:1,network_retries:1});
export const ContinuitySuggestionOutputSchema=z.object({changes:z.array(z.object({entity_id:z.string(),attribute_id:z.string(),operation:z.enum(['assign','clear','transfer']),value:z.union([z.string(),z.null(),z.array(z.string()).min(2)]),source_id:z.string(),quote:z.string().min(1),from:z.string().nullable().optional(),completion:z.enum(['completed','offered','incomplete']).optional()}).strict()).max(6),pending:z.array(z.object({code:z.enum(['ambiguous_entity','shared_holder','unknown_attribute','unknown_time']),entity_ids:z.array(z.string()),source_id:z.string(),quote:z.string().min(1)}).strict()).max(6)}).strict();
type Source={source_id:string;source_type:'novel'|'screenplay';source_document_id:string;source_revision:number;text:string;start?:number};
export class ContinuitySuggestionBudgetError extends Error {readonly code='CONTINUITY_INPUT_BUDGET_EXCEEDED';}
export type ContinuitySuggestionTask={context:ContinuityConfirmationContext;target_scene_id:string;related_entity_ids:string[];prior_state:readonly ContinuityCell[];sources:Source[];preceding_context:string;provider:AIProvider;model_fingerprint?:string;seed?:number;signal?:AbortSignal;budget?:LogicalContinuityBudget;reuse?:{input_hash:string;output:z.infer<typeof ContinuitySuggestionOutputSchema>}[];checkpoint?:(state:{budget:LogicalContinuityBudget;reuse:{input_hash:string;output:z.infer<typeof ContinuitySuggestionOutputSchema>}[]})=>Promise<void>};
/** Shared by parent and children. A child may never reset repair or transport counters. */
export class LogicalContinuityBudget {
  semantic_repairs=0;network_retries=0;calls:{stage:string;kind:'initial'|'semantic_repair'|'network_retry';attempt_state?:'reserved'|'completed'|'error'|'interrupted_unknown';elapsed_ms:number;response?:unknown;error?:string;usage?:unknown;finish_reason?:string|null;model?:string}[]=[];
  consumeSemantic(){if(this.semantic_repairs>=CONTINUITY_SUGGESTION_BUDGET.semantic_repairs)return false;this.semantic_repairs++;return true;}
  consumeNetwork(){if(this.network_retries>=CONTINUITY_SUGGESTION_BUDGET.network_retries)return false;this.network_retries++;return true;}
}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const system='只提出本场已发生的增量变化或待核对项。没有变化时返回 changes=[]。只用提供的实物 ID 和来源 ID。所有者、持有者、穿戴者、地点及完整度互相独立。不要补未知值，不把意图/否定/递出未接当已完成。引文必须来自完整原文且保留否定和接收信息；指代不唯一必须 pending，并保留所有相关人物。共同持有保留双方待核对。损伤 damaged=受损/破洞，broken=断裂/碎裂；明确修好才 intact。只准 registered_attributes 中的属性，未知属性 pending。按来源顺序输出，completed transfer 必须 from 和 completion=completed。模型输出永不确认状态，不添加自审/确认字段。';
const attributeContract=Object.fromEntries(Object.entries(CONTINUITY_ATTRIBUTES).map(([id,definition])=>[id,{...definition,...(definition.type==='entity'?{values:'provided entity ID or null only'}:{})}]));
const instruction=`${system} registered_attributes 明确列出每个属性允许的 operation 和 value。transfer 仅用于 holder 且完成接收，wearer/owner/location 只能 assign 或 clear。unknown、pending、none 不能用作属性值，未知字段省略。只输出与 prior_state 不同且由 sources 明确证明的变化；重复确认、无关状态和动作意图都省略。若仅知道湿度，不能补颜色、完整度或人物关系。holding_hand 只表示当前持有者的身体左手 physical_left、身体右手 physical_right、双手 both 或未持物 unheld，不能用画面左/右推断身体左右；否定、意图、没有明确手别时不提手别变化。`;
export const continuitySuggestionPolicyFingerprint=sha(JSON.stringify([instruction,attributeContract,CONTINUITY_SUGGESTION_BUDGET,'complete-source-schema-v2']));
function sourceConstrainedSchema(sources:Source[]){
  const source_id=z.enum(sources.map(source=>source.source_id) as [string,...string[]]);
  const quote=z.enum([...new Set(sources.map(source=>source.text))] as [string,...string[]]);
  return z.object({changes:z.array(ContinuitySuggestionOutputSchema.shape.changes.element.extend({source_id,quote})).max(6),pending:z.array(ContinuitySuggestionOutputSchema.shape.pending.element.extend({source_id,quote})).max(6)}).strict();
}

function fullSources(sources:Source[]){
  const units:Source[]=[];
  for(const source of sources){
    if(source.text.length<=CONTINUITY_SUGGESTION_BUDGET.source_batch_chars){units.push(source);continue;}
    // Complete sentences only. Never slice character counts or detach a negation clause.
    const sentences=source.text.match(/[^。！？\n]+[。！？\n]?|\n/g)??[];let offset=0;
    if(sentences.join('')!==source.text)throw new ContinuitySuggestionBudgetError('Source cannot be split without losing text');
    for(const [index,text] of sentences.entries()){
      if(text.length>CONTINUITY_SUGGESTION_BUDGET.source_unit_chars||text.length>CONTINUITY_SUGGESTION_BUDGET.source_batch_chars)throw new ContinuitySuggestionBudgetError('A complete action exceeds the source budget; review manually');
      units.push({...source,source_id:`${source.source_id}:sentence:${index}`,text,start:(source.start??0)+offset});offset+=text.length;
    }
  }
  const groups:Source[][]=[];
  for(const source of units){let group=groups.at(-1);if(!group||group.length>=6||group.reduce((sum,item)=>sum+item.text.length,0)+source.text.length>900){group=[];groups.push(group);}group.push(source);}
  return groups;
}
function assemble(task:ContinuitySuggestionTask){
  const ids=new Set(task.related_entity_ids);
  for(const id of ids)if(!task.context.entities.some(entity=>entity.entity_id===id&&entity.project_id===task.context.project_id))throw new ContinuitySuggestionBudgetError('Physical binding is outside this project');
  let grew=true;while(grew){grew=false;for(const entity of task.context.entities)if(ids.has(entity.entity_id)){
    const refs=[entity.parent_entity_id,...task.prior_state.filter(cell=>cell.entity_id===entity.entity_id&&cell.knowledge_status==='confirmed'&&['holder','owner','wearer','location'].includes(cell.attribute_id)).map(cell=>cell.knowledge_status==='confirmed'?cell.value:null)].filter((value):value is string=>typeof value==='string');
    for(const id of refs)if(!ids.has(id)){ids.add(id);grew=true;}
  }}
  const entities=task.context.entities.filter(entity=>ids.has(entity.entity_id));
  const prior=task.prior_state.filter(cell=>ids.has(cell.entity_id)).map(cell=>({entity_id:cell.entity_id,attribute_id:cell.attribute_id,knowledge_status:cell.knowledge_status,...(cell.knowledge_status==='confirmed'?{value:cell.value}:{})}));
  if(JSON.stringify(prior).length>2000||JSON.stringify(entities).length+task.preceding_context.length>2200)throw new ContinuitySuggestionBudgetError('Related identities or complete prior state exceed the binding budget');
  return {entities,prior,ids};
}
function normalize(output:z.infer<typeof ContinuitySuggestionOutputSchema>,task:ContinuitySuggestionTask,sources:Source[],ids:Set<string>,offset:number){
  const proposals:ContinuityChangeProposal[]=[],pending:any[]=[];
  const evidence=(id:string,quote:string)=>{const source=sources.find(source=>source.source_id===id);if(!source||!quote||quote!==source.text)throw new Error('Evidence must quote the complete action, including negation and receipt');
    const full=task.context.sources.find(full=>full.source_type===source.source_type&&full.source_document_id===source.source_document_id&&full.source_revision===source.source_revision);
    if(!full||full.text.slice((source.start??0),(source.start??0)+source.text.length)!==source.text)throw new Error('Server source changed');
    const start=(source.start??0)+source.text.indexOf(quote);return {kind:'source' as const,source_type:source.source_type,source_document_id:source.source_document_id,source_revision:source.source_revision,source_text_hash:sha(full.text),evidence_quote:quote,start,end:start+quote.length};};
  for(const [index,item] of output.changes.entries()){
    if(!ids.has(item.entity_id))throw new Error('Suggested entity is outside the related physical bindings');
    const quote=evidence(item.source_id,item.quote),attribute=continuityAttribute(item.attribute_id);
    const proposal:ContinuityChangeProposal={...continuityAttributeVersion(item.attribute_id),change_id:`suggestion:${sha(JSON.stringify([task.target_scene_id,item,offset+index])).slice(0,32)}`,change_revision:1,binding_revision:task.context.binding_revision,story_position:makeContinuityStoryPosition(task.context.order,{script_scene_id:task.target_scene_id,change_order:offset+index,moment_id:`suggestion:${offset+index}:after`,phase:'after'}),entity_id:item.entity_id,attribute_id:item.attribute_id,operation:item.operation,value:item.value,basis:'story',time_relation:task.context.time_relation,origin:'model',evidence:[quote],...(item.operation==='transfer'?{precondition:{knowledge_status:'confirmed' as const,value:item.from??null},...(item.completion==='completed'?{completion:'completed' as const}:{})}:{})};
    try{
      if(!attribute)throw new ContinuityConfirmationError('CONTINUITY_ATTRIBUTE_UNSUPPORTED','Unknown attribute retained');
      if(Array.isArray(item.value))throw new ContinuityConfirmationError('CONTINUITY_SHARED_HOLDER_UNSUPPORTED','All holders retained');
      if(attribute.type==='entity'&&typeof item.value==='string'&&!ids.has(item.value))throw new Error('Suggested relation target is outside the related physical bindings');
      if(item.operation==='clear'&&item.value!==null)throw new Error('Clear must retain an explicit null value');
      validateContinuityTypedValue(item.entity_id,item.attribute_id,item.value,task.context);
      if(item.attribute_id==='holding_hand')validateContinuitySuggestionProposal(proposal,task.context);
      if(!attribute.operations.includes(item.operation))throw new ContinuityConfirmationError('CONTINUITY_OPERATION_UNSUPPORTED','Operation does not apply to this property');
      if(item.operation==='transfer'&&(item.attribute_id!=='holder'||item.completion!=='completed'||item.from===undefined))throw new ContinuityConfirmationError('CONTINUITY_TRANSFER_NOT_COMPLETED','Receipt is incomplete');
      if(item.operation==='transfer'&&item.from!==null&&!ids.has(item.from!))throw new Error('Previous holder is outside this task');
      proposals.push(proposal);
    }catch(error:any){if(error instanceof ContinuityConfirmationError)pending.push({code:error.code,proposal,raw:item,evidence:[quote]});else throw error;}
  }
  for(const item of output.pending){if(item.entity_ids.some(id=>!ids.has(id)))throw new Error('Pending references are outside this task');pending.push({...item,evidence:[evidence(item.source_id,item.quote)]});}
  return {proposals,pending};
}
export async function extractContinuitySuggestions(task:ContinuitySuggestionTask){
  const budget=task.budget??new LogicalContinuityBudget(),start=Date.now(),raw:unknown[]=[],proposals:ContinuityChangeProposal[]=[],pending:any[]=[];
  const reuse=[...(task.reuse??[])];let reuse_hits=0;
  let groups:Source[][],assembled:ReturnType<typeof assemble>;
  try{assembled=assemble(task);groups=fullSources(task.sources);}catch(error:any){return {status:'pending_review',proposals,pending:[{code:error.code||'CONTINUITY_INPUT_BUDGET_EXCEEDED',message:error.message,sources:task.sources}],raw,budget,elapsed_ms:Date.now()-start,batches:0,automatic_accepted:0};}
  for(const [index,sources] of groups.entries()){
    if(task.signal?.aborted)throw task.signal.reason;
    const preceding_context=[task.preceding_context,...groups.slice(0,index).flat().map(source=>source.text)].filter(Boolean).join('\n');
    if(JSON.stringify(assembled.entities).length+preceding_context.length>2200){pending.push({code:'CONTINUITY_INPUT_BUDGET_EXCEEDED',sources,preceding_context});continue;}
    let repair='',kind:'initial'|'semantic_repair'|'network_retry'='initial';
    const input_hash=sha(JSON.stringify([task.context.project_id,task.target_scene_id,task.context.binding_revision,task.context.time_relation,task.context.time_plan?.proposal,task.context.order,assembled.entities,assembled.prior,sources,preceding_context,task.seed,task.model_fingerprint,continuitySuggestionPolicyFingerprint]));
    const cached=reuse.find(item=>item.input_hash===input_hash);
    if(cached){const normalized=normalize(ContinuitySuggestionOutputSchema.parse(cached.output),task,sources,assembled.ids,proposals.length);proposals.push(...normalized.proposals);pending.push(...normalized.pending);reuse_hits++;continue;}
    while(true){
      if(task.signal?.aborted)throw task.signal.reason;
      const input={task:'continuity_changes',related_entities:assembled.entities,prior_state:assembled.prior,sources,preceding_context,registered_attributes:attributeContract,repair};
      const call={stage:`changes:${index+1}`,kind,attempt_state:'reserved' as const,elapsed_ms:0};const before=Date.now();let traced=false;
      const callIndex=budget.calls.push(call)-1;
      // Reserve the attempt before sending it; a hard process loss must not erase a consumed repair or an unknown in-flight call.
      await task.checkpoint?.({budget,reuse});
      const options:StructuredGenOptions={temperature:0.1,maxTokens:CONTINUITY_SUGGESTION_BUDGET.output_tokens,transportRetries:0,seed:task.seed,signal:task.signal,onInference:record=>{traced=true;budget.calls[callIndex]={...call,...record,attempt_state:record.error?'error':'completed'};}};
      try{
        const output=await task.provider.generateStructured(JSON.stringify(input),sourceConstrainedSchema(sources),instruction,options);raw.push(output);
        if(!traced){budget.calls[callIndex]={...call,attempt_state:'completed',elapsed_ms:Date.now()-before,response:output};traced=true;}
        const parsed=ContinuitySuggestionOutputSchema.parse(output),normalized=normalize(parsed,task,sources,assembled.ids,proposals.length);proposals.push(...normalized.proposals);pending.push(...normalized.pending);reuse.push({input_hash,output:parsed});break;
      }catch(error:any){
        if(!traced)budget.calls[callIndex]={...call,attempt_state:'error',elapsed_ms:Date.now()-before,error:error.message};
        if(task.signal?.aborted)throw task.signal.reason;
        const network=isInferenceTransportError(error);
        if(network&&budget.consumeNetwork()){kind='network_retry';await task.checkpoint?.({budget,reuse});continue;}
        if(!network&&budget.consumeSemantic()){kind='semantic_repair';repair=error instanceof z.ZodError?'Return all required schema fields and no extra confirmation/audit fields.':error.message;await task.checkpoint?.({budget,reuse});continue;}
        pending.push({code:network?'CONTINUITY_MODEL_UNAVAILABLE':'CONTINUITY_REVIEW_REQUIRED',message:error.message,sources});break;
      }
    }
    await task.checkpoint?.({budget,reuse});
  }
  return {status:pending.length?'pending_review':'ready_for_review',proposals,pending,raw,budget,reuse,reuse_hits,elapsed_ms:Date.now()-start,batches:groups.length,automatic_accepted:0};
}
