import { randomUUID,createHash } from 'node:crypto';
import { db,withImmediateTransaction } from '../db/database';
import { z } from 'zod';
import { ContinuityReadSchema,type ContinuityRead } from '../schemas/continuity_snapshot';
import { createSceneVersion,syncActiveVersionFromScene } from './scene_versions';
import { ScriptDocumentSchema } from '../schemas/script';
import { ContinuityEntitySchema,type ContinuityEntity } from '../schemas/continuity';
import { CONTINUITY_ATTRIBUTES,continuityAttribute,continuityAttributeVersion,type ContinuityAttributeId,type ContinuityCell,type ContinuityChangeProposal } from '../schemas/continuity_state';
import { ConfirmContinuityReviewSchema } from '../schemas/continuity_review';
import { buildContinuityStoryOrder,makeContinuityStoryPosition,validateContinuityEntities } from './continuity_identity';
import { confirmContinuityChange,continuityProposalHash,applyConfirmedContinuityChange,createUnknownContinuityCell,revalidateConfirmedContinuityChange,ContinuityConfirmationError,type ContinuityConfirmationContext } from './continuity_confirmation';
import { continuityHash,canonicalContinuityJson,confirmContinuityEntry,continuityEntryHash,confirmContinuityOverlay,continuityOverlayHash,replayContinuityScene,readContinuityMoment,type ContinuityReplayInput } from './continuity_replay';
import { loadContinuityLedger,continuityScriptScope,commitContinuityLedger,currentContinuitySnapshot,bindContinuityShotInTransaction,ContinuityStoreError } from './continuity_store';
import { restoreContinuityRecord,commitContinuityLedgerInTransaction } from './continuity_store';
import { previewContinuityImpact } from './continuity_impact';
import { continuityVisualStates } from './continuity_visual_state';
import { confirmContinuityTimePlan,continuityTimePlanHash } from './continuity_time';
import { ContinuityTimePlanSchema } from '../schemas/continuity_time';

const fail=(code:string,message:string,status:404|409|422=409):never=>{throw new ContinuityStoreError(code,message,status);};
const textHash=(text:string)=>createHash('sha256').update(text).digest('hex');
async function resources(projectId:number) {
  return {characters:await db.all('SELECT id,project_id,name FROM character WHERE project_id=? ORDER BY id',projectId),assets:await db.all('SELECT id,project_id,kind,name,revision FROM library_asset WHERE project_id=? ORDER BY id',projectId)};
}
function actualSources(script:any,doc:ReturnType<typeof ScriptDocumentSchema.parse>) {
  return [{project_id:script.project_id,source_type:'novel' as const,source_document_id:script.chapter_id,source_revision:script.revision,text:script.chapter_content,bindings:[]},
    ...doc.scenes.flatMap(scene=>scene.blocks.map(block=>({project_id:script.project_id,source_type:'screenplay' as const,source_document_id:`script:${script.id}:${scene.id}:${block.id}`,source_revision:script.revision,text:block.text,bindings:[]})))];
}
export async function getContinuityReview(scriptId:number,targetSceneId?:string) {
  const ledger=await loadContinuityLedger(scriptId),script=ledger.script,doc=ScriptDocumentSchema.parse(JSON.parse(script.document_json));
  const target=targetSceneId??doc.scenes[0]?.id;
  if (!target || !doc.scenes.some(scene=>scene.id===target)) return fail('CONTINUITY_SCOPE_INVALID','Target scene does not belong to this screenplay',404);
  const projectResources=await resources(script.project_id);
  const saved=(await db.all('SELECT entity_json FROM continuity_entity WHERE project_id=? ORDER BY entity_id',script.project_id)).map(row=>ContinuityEntitySchema.parse(JSON.parse(row.entity_json)));
  const entities=saved.length?saved:projectResources.characters.map(character=>ContinuityEntitySchema.parse({entity_id:`project:${script.project_id}:character:${character.id}`,project_id:script.project_id,kind:'character',display_name:character.name,aliases:[],character_id:character.id}));
  const order=buildContinuityStoryOrder({project_id:script.project_id,script_id:script.id,script_revision:script.revision,story_segment_id:ledger.record?.context.order.story_segment_id??`script:${script.id}:linear`,document:doc});
  const replay=ledger.input?replayContinuityScene(ledger.input,target):null;
  const shots=await db.all(`SELECT s.id,s.active_version,s.asset_url,s.continuity_status,s.continuity_reason_json,d.script_scene_id,d.moment_id,d.phase,d.reads_json FROM scene s JOIN chapter c ON c.id=s.chapter_id
    LEFT JOIN continuity_shot_dependency d ON d.scene_id=s.id AND d.scene_version=COALESCE(s.active_version,1) WHERE c.project_id=? AND (d.script_id=? OR s.chapter_id=?) ORDER BY s."index",s.id`,script.project_id,script.id,script.chapter_id);
  const source=actualSources(script,doc).map(source=>({...source,source_text_hash:textHash(source.text)}));
  const imageVersions=new Map<number,any[]>();
  for(const shot of shots)imageVersions.set(shot.id,await db.all('SELECT version,label,asset_url,continuity_status FROM scene_version WHERE scene_id=? ORDER BY version DESC',shot.id));
  return {script_id:script.id,project_id:script.project_id,script_revision:script.revision,continuity_revision:ledger.revision,target_scene_id:target,
    status:replay?.status??'pending_review',order,entities,registry:CONTINUITY_ATTRIBUTES,resources:projectResources,sources:source,time_plan:ledger.record?.context.time_plan?.proposal??null,
    snapshot:replay?.status==='ready'?replay.snapshot:null,issues:replay&&replay.status!=='ready'?replay.issues:ledger.issues,
    shots:shots.map(shot=>({...shot,image_versions:imageVersions.get(shot.id),reads:shot.reads_json?JSON.parse(shot.reads_json):[],recovery:shot.continuity_status==='current'?null:{action:'review_actual_reads',attributes:shot.reads_json?JSON.parse(shot.reads_json):[]}})),
    draft:{entry_values:ledger.record?.entry?.cells.map(({cell})=>({entity_id:cell.entity_id,attribute_id:cell.attribute_id,knowledge_status:cell.knowledge_status,
      ...(cell.knowledge_status==='confirmed'?{value:cell.value,evidence:cell.provenance.evidence}:{})}))??[],changes:ledger.record?.changes.map(change=>change.proposal)??[],during_overlays:ledger.record?.overlays.map(overlay=>overlay.proposal)??[]},
    pending_suggestions:(await db.all('SELECT id,script_scene_id,raw_json,created_at FROM continuity_suggestion WHERE script_id=? ORDER BY created_at DESC,id LIMIT 50',scriptId)).map(row=>({...row,raw:JSON.parse(row.raw_json),raw_json:undefined})),
    history:await db.all('SELECT revision,actor_id,reason,created_at,result_json FROM continuity_revision WHERE script_id=? ORDER BY revision DESC LIMIT 10',scriptId)};
}
/** Explicit local human review. No confirmation/authority field from client JSON is accepted. */
export async function confirmContinuityReview(scriptId:number,raw:unknown,actorId:string,previewOnly=false) {
  try{return await withImmediateTransaction(async()=>{
  const body=ConfirmContinuityReviewSchema.parse(raw),bodyHash=continuityHash(body);
  const repeated=await db.get('SELECT request_body_hash,result_json FROM continuity_revision WHERE script_id=? AND request_key=?',scriptId,body.request_key);
  if (repeated&&!previewOnly) {if(repeated.request_body_hash!==bodyHash)return fail('CONTINUITY_REVISION_CONFLICT','Request key belongs to a different human review');return JSON.parse(repeated.result_json);}
  const ledger=await loadContinuityLedger(scriptId),script=ledger.script,doc=ScriptDocumentSchema.parse(JSON.parse(script.document_json));
  if (script.revision!==body.expected_script_revision||ledger.revision!==body.expected_continuity_revision) return fail('CONTINUITY_REVISION_CONFLICT','Script or continuity changed; keep the draft and refresh the review');
  if (!doc.scenes.some(scene=>scene.id===body.target_scene_id))return fail('CONTINUITY_SCOPE_INVALID','Target does not belong to this screenplay',404);
  if (ledger.record&&!ledger.input&&!body.replace_all)return fail(ledger.issues[0]!.code,'Review the preserved full ledger before replacing stale/imported approvals');
  if (body.replace_all&&!body.entry_values)return fail('CONTINUITY_ENTRY_REQUIRED','Full review requires an explicit first-scene entry');
  if (body.entry_values&&body.entry_values.length===0)return fail('CONTINUITY_ENTRY_REQUIRED','Full review requires an explicit first-scene entry');
  const previous=body.replace_all?null:ledger.input;
  const entityInput=body.entities??previous?.context.entities??[];
  const entities=validateContinuityEntities(script.project_id,entityInput,await resources(script.project_id));
  const bindingSet=(items:ContinuityEntity[])=>canonicalContinuityJson(items.map(entity=>({...entity,aliases:[...new Set(entity.aliases)].sort()})).sort((a,b)=>a.entity_id.localeCompare(b.entity_id)));
  const entityChanged=previous&&bindingSet(entities)!==bindingSet(previous.context.entities);
  if (entityChanged&&!body.replace_all)return fail('CONTINUITY_REVIEW_REQUIRED','Changing established physical bindings requires full review');
  const bindingRevision=body.replace_all?(ledger.record?.context.binding_revision??0)+1:previous?.context.binding_revision??1;
  const order=buildContinuityStoryOrder({project_id:script.project_id,script_id:script.id,script_revision:script.revision,story_segment_id:ledger.record?.context.order.story_segment_id??`script:${script.id}:linear`,document:doc});
  const sources=new Map<string,ContinuityConfirmationContext['sources'][number]>((previous?.context.sources??[]).map(source=>[`${source.source_type}:${source.source_document_id}`,source]));
  for(const source of actualSources(script,doc))sources.set(`${source.source_type}:${source.source_document_id}`,source);
  const designs=new Map<string,ContinuityConfirmationContext['designs'][number]>((previous?.context.designs??[]).map(design=>[design.design_id,design]));
  for(const entity of entities)designs.set(`manual:${entity.entity_id}`,{project_id:script.project_id,entity_id:entity.entity_id,design_id:`manual:${entity.entity_id}`,design_revision:1});
  const context:ContinuityConfirmationContext={project_id:script.project_id,entities,order,binding_revision:bindingRevision,time_relation:body.time_relation,sources:[...sources.values()],designs:[...designs.values()]};
  const human=(hash:string,id:string)=>({kind:'human' as const,review_id:`${body.request_key}:${id}`,review_revision:body.expected_continuity_revision+1,actor_id:actorId,proposal_hash:hash});
  const timePlan=body.time_plan??ledger.record?.context.time_plan?.proposal;
  if(timePlan)context.time_plan=confirmContinuityTimePlan(timePlan,{...context,authority:body.time_plan?human(continuityTimePlanHash(timePlan),'time'):ledger.record!.context.time_plan!.confirmation});
  const approve=(proposal:ContinuityChangeProposal)=>{
    const old=previous?.changes.find(change=>continuityProposalHash(change.proposal)===continuityProposalHash(proposal));
    if(old){revalidateConfirmedContinuityChange(old,context);return old;}
    const result=confirmContinuityChange(proposal,{...context,authority:human(continuityProposalHash(proposal),proposal.change_id)});
    if(result.status!=='confirmed')return fail(result.issues[0]!.code,result.issues[0]!.message);return result.change;
  };
  try {
    let entry=previous?.entry;
    if(body.entry_values){
      if(!body.replace_all&&body.target_scene_id!==order.scenes[0]!.script_scene_id)return fail('CONTINUITY_SCOPE_INVALID','Edit the first-scene entry or explicitly review the full ledger',422);
      const state:ContinuityCell[]=[];
      for(const cell of [...body.entry_values].sort((a,b)=>Number(a.attribute_id==='holding_hand')-Number(b.attribute_id==='holding_hand'))){
        if(!continuityAttribute(cell.attribute_id))return fail('CONTINUITY_ATTRIBUTE_UNSUPPORTED','Unknown property is retained as a review suggestion');
        const old=entry?.state.find(old=>old.entity_id===cell.entity_id&&old.attribute_id===cell.attribute_id);
        if(old&&old.knowledge_status===cell.knowledge_status&&(old.knowledge_status==='unknown'||canonicalContinuityJson(old.value)===canonicalContinuityJson(cell.value)&&canonicalContinuityJson(old.provenance.evidence)===canonicalContinuityJson(cell.evidence??old.provenance.evidence))){state.push(old);continue;}
        if(cell.knowledge_status==='unknown'){state.push(createUnknownContinuityCell(context,cell.entity_id,cell.attribute_id as ContinuityAttributeId));continue;}
        const proposal:ContinuityChangeProposal={...continuityAttributeVersion(cell.attribute_id),change_id:`entry:${cell.entity_id}:${cell.attribute_id}`,change_revision:body.expected_continuity_revision+1,binding_revision:bindingRevision,
          story_position:makeContinuityStoryPosition(order,{script_scene_id:order.scenes[0]!.script_scene_id,change_order:0,moment_id:`script:${scriptId}:entry`,phase:'before'}),entity_id:cell.entity_id,attribute_id:cell.attribute_id,
          operation:cell.value===null?'clear':'assign',value:cell.value,basis:cell.evidence?.some(item=>item.kind==='source')?'story':'initial_design',time_relation:body.time_relation,origin:'human_entry',
          evidence:cell.evidence??[{kind:'design',design_id:`manual:${cell.entity_id}`,design_revision:1}]};
        const next=applyConfirmedContinuityChange(state,approve(proposal),context);state.splice(0,state.length,...next);
      }
      const proposal={entry_id:entry?.entry_id??`script:${scriptId}:entry`,entry_revision:(entry?.entry_revision??0)+1,binding_revision:bindingRevision,
        story_position:makeContinuityStoryPosition(order,{script_scene_id:order.scenes[0]!.script_scene_id,change_order:0,moment_id:`script:${scriptId}:entry`,phase:'before'}),state};
      entry=confirmContinuityEntry(proposal,{...context,authority:human(continuityEntryHash(proposal),'entry')});
    }
    if(!entry)return fail('CONTINUITY_ENTRY_REQUIRED','Confirm the explicit first-scene entry, including unknown values');
    const requestedChanges=body.changes??previous?.changes.filter(change=>change.proposal.story_position.script_scene_id===body.target_scene_id).map(change=>change.proposal)??[];
    for(const change of requestedChanges)if(!body.replace_all&&change.story_position.script_scene_id!==body.target_scene_id)return fail('CONTINUITY_SCOPE_INVALID','Scene review cannot change another scene',422);
    const normalize=(proposal:ContinuityChangeProposal)=>({...proposal,binding_revision:bindingRevision,origin:'human_entry' as const,story_position:makeContinuityStoryPosition(order,{script_scene_id:proposal.story_position.script_scene_id,beat_id:proposal.story_position.beat_id??undefined,change_order:proposal.story_position.change_order,moment_id:proposal.story_position.moment_id,phase:proposal.story_position.phase})});
    const changes=[...(previous?.changes.filter(change=>change.proposal.story_position.script_scene_id!==body.target_scene_id)??[]),...requestedChanges.map(change=>approve(normalize(change)))];
    const requestedOverlays=body.during_overlays??previous?.during_overlays?.filter(overlay=>overlay.proposal.story_position.script_scene_id===body.target_scene_id).map(overlay=>overlay.proposal)??[];
    const overlays=[...(previous?.during_overlays?.filter(overlay=>overlay.proposal.story_position.script_scene_id!==body.target_scene_id)??[]),...requestedOverlays.map(overlay=>{
      if(!body.replace_all&&overlay.story_position.script_scene_id!==body.target_scene_id)return fail('CONTINUITY_SCOPE_INVALID','Overlay belongs to another scene',422);
      const proposal={...overlay,binding_revision:bindingRevision,story_position:makeContinuityStoryPosition(order,{script_scene_id:overlay.story_position.script_scene_id,beat_id:overlay.story_position.beat_id??undefined,change_order:overlay.story_position.change_order,moment_id:overlay.story_position.moment_id,phase:'during'})};
      return confirmContinuityOverlay(proposal,{...context,authority:human(continuityOverlayHash(proposal),overlay.overlay_id)});
    })];
    const input:ContinuityReplayInput={context,entry,changes,during_overlays:overlays,revisions:{fact_revision:script.revision,entity_mapping_revision:bindingRevision,confirmation_revision:body.expected_continuity_revision+1,design_revision:bindingRevision}};
    const replay=replayContinuityScene(input,body.target_scene_id);
    if(replay.status!=='ready')return fail(replay.issues[0]!.code,replay.issues[0]!.message);
    const {expected_impact_hash,...review}=body;
    if(previewOnly||expected_impact_hash){const preview=await previewContinuityImpact(scriptId,ledger.input,input,review);if(previewOnly)return preview;if(preview.impact_hash!==expected_impact_hash)return fail('CONTINUITY_REVISION_CONFLICT','The impact preview changed; review again before confirming');}
    return await commitContinuityLedgerInTransaction({script_id:scriptId,expected_revision:body.expected_continuity_revision,expected_script_revision:body.expected_script_revision,request_key:body.request_key,actor_id:actorId,reason:body.reason,input,request_body_hash:bodyHash,expected_source_hash:continuityHash([script.chapter_content,doc])});
  } catch(error) {
    throw error;
  }
  });}catch(error){
    const parsed=ConfirmContinuityReviewSchema.safeParse(raw);
    if(parsed.success&&!previewOnly&&(error instanceof ContinuityStoreError||error instanceof ContinuityConfirmationError)&&!['CONTINUITY_REVISION_CONFLICT','CONTINUITY_SCOPE_INVALID'].includes(error.code))await db.run('INSERT INTO continuity_suggestion(id,script_id,script_scene_id,raw_json) VALUES(?,?,?,?)',randomUUID(),scriptId,parsed.data.target_scene_id,JSON.stringify({review:parsed.data,issue:{code:error.code,message:error.message}}));
    throw error;
  }
}

const UndoReviewSchema=z.object({review_action:z.literal('human_review'),target_revision:z.number().int().positive(),expected_script_revision:z.number().int().positive(),expected_continuity_revision:z.number().int().positive(),request_key:z.string().trim().min(1).max(100),reason:z.string().trim().min(1).max(1000),expected_impact_hash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
const TimeReviewSchema=z.object({review_action:z.literal('human_review'),expected_script_revision:z.number().int().positive(),expected_continuity_revision:z.number().int().positive(),request_key:z.string().trim().min(1).max(100),reason:z.string().trim().min(1).max(1000),time_plan:ContinuityTimePlanSchema,expected_impact_hash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
/** A reviewed unresolved boundary is saved as a block, never guessed into a linear day. */
export async function reviewContinuityTime(scriptId:number,raw:unknown,actorId:string,previewOnly=false){
  return withImmediateTransaction(async()=>{
    const body=TimeReviewSchema.parse(raw),hash=continuityHash({operation:'time',body});
    const repeated=await db.get('SELECT request_body_hash,result_json FROM continuity_revision WHERE script_id=? AND request_key=?',scriptId,body.request_key);
    if(repeated&&!previewOnly){if(repeated.request_body_hash!==hash)return fail('CONTINUITY_REVISION_CONFLICT','Time review key already used');return JSON.parse(repeated.result_json);}
    const ledger=await loadContinuityLedger(scriptId);
    if(!ledger.input)return fail('CONTINUITY_REVIEW_REQUIRED','Review preserved source and first-scene state before time boundaries');
    if(ledger.revision!==body.expected_continuity_revision||ledger.script.revision!==body.expected_script_revision)return fail('CONTINUITY_REVISION_CONFLICT','Time review base changed; draft is preserved');
    const context={...ledger.input.context};
    context.time_plan=confirmContinuityTimePlan(body.time_plan,{...context,authority:{kind:'human',review_id:`${body.request_key}:time`,review_revision:ledger.revision+1,actor_id:actorId,proposal_hash:continuityTimePlanHash(body.time_plan)}});
    const input={...ledger.input,context};
    for(const scene of context.order.scenes){const result=replayContinuityScene(input,scene.script_scene_id);if(result.status!=='ready'&&result.issues.some(i=>i.code!=='CONTINUITY_TIME_REVIEW_REQUIRED'))return fail(result.issues[0]!.code,result.issues[0]!.message,422);}
    const {expected_impact_hash,...review}=body;
    const impact=await previewContinuityImpact(scriptId,ledger.input,input,{operation:'time',...review});
    if(previewOnly)return impact;
    if(expected_impact_hash!==impact.impact_hash)return fail('CONTINUITY_REVISION_CONFLICT','Review time impact before confirming');
    return commitContinuityLedgerInTransaction({script_id:scriptId,expected_revision:ledger.revision,expected_script_revision:ledger.script.revision,request_key:body.request_key,actor_id:actorId,reason:body.reason,input,request_body_hash:hash,expected_source_hash:continuityHash([ledger.script.chapter_content,JSON.parse(ledger.script.document_json)])});
  });
}
/** Undo appends a revision. Historical records and every image version stay intact. */
export async function undoContinuityReview(scriptId:number,raw:unknown,actorId:string,previewOnly=false){
  return withImmediateTransaction(async()=>{
    const body=UndoReviewSchema.parse(raw),hash=continuityHash({operation:'undo',body});
    const repeated=await db.get('SELECT request_body_hash,result_json FROM continuity_revision WHERE script_id=? AND request_key=?',scriptId,body.request_key);
    if(repeated&&!previewOnly){if(repeated.request_body_hash!==hash)return fail('CONTINUITY_REVISION_CONFLICT','Undo key belongs to another request');return JSON.parse(repeated.result_json);}
    const ledger=await loadContinuityLedger(scriptId);
    if(!ledger.input||ledger.script.revision!==body.expected_script_revision||ledger.revision!==body.expected_continuity_revision)return fail('CONTINUITY_REVISION_CONFLICT','Current sources or approvals changed');
    if(body.target_revision>=ledger.revision)return fail('CONTINUITY_SCOPE_INVALID','Undo requires an earlier audited revision',422);
    const historical=await db.get('SELECT record_json FROM continuity_revision WHERE script_id=? AND revision=?',scriptId,body.target_revision);
    if(!historical)return fail('CONTINUITY_SCOPE_INVALID','Historical review does not belong to this screenplay',404);
    const record=JSON.parse(historical.record_json),doc=ScriptDocumentSchema.parse(JSON.parse(ledger.script.document_json));
    const actual=actualSources(ledger.script,doc);
    if(record.context.order.script_revision!==ledger.script.revision||actual.some(source=>!record.context.sources.some((old:any)=>old.source_type===source.source_type&&old.source_document_id===source.source_document_id&&old.source_revision===source.source_revision&&old.text===source.text)))return fail('CONTINUITY_STALE','Historical evidence changed; use full manual review');
    const input=restoreContinuityRecord(record);
    const {expected_impact_hash,...review}=body;
    const impact=await previewContinuityImpact(scriptId,ledger.input,input,{operation:'undo',...review});
    if(previewOnly)return impact;
    if(expected_impact_hash!==impact.impact_hash)return fail('CONTINUITY_REVISION_CONFLICT','Review the current undo impact before confirming');
    return commitContinuityLedgerInTransaction({script_id:scriptId,expected_revision:body.expected_continuity_revision,expected_script_revision:body.expected_script_revision,request_key:body.request_key,request_body_hash:hash,actor_id:actorId,reason:`undo:${body.target_revision} ${body.reason}`,input,expected_source_hash:continuityHash([ledger.script.chapter_content,doc])});
  });
}

export const RefreshContinuityShotSchema=z.object({scene_id:z.number().int().positive(),expected_scene_version:z.number().int().positive(),expected_script_revision:z.number().int().positive(),expected_continuity_revision:z.number().int().positive(),
  request_key:z.string().trim().min(1).max(100),reason:z.string().trim().min(1).max(1000),target_scene_id:z.string().min(1),moment_id:z.string().min(1),phase:z.enum(['before','during','after']),reads:z.array(ContinuityReadSchema)}).strict();
/** Explicit recovery creates a fresh image slot; it never declares the retained old image correct. */
export async function refreshContinuityShot(scriptId:number,raw:unknown,actorId:string){
  const body=RefreshContinuityShotSchema.parse(raw),requestHash=continuityHash(body);
  return withImmediateTransaction(async()=>{
    const repeated=await db.get('SELECT request_hash,result_json FROM continuity_shot_recovery WHERE script_id=? AND request_key=?',scriptId,body.request_key);
    if(repeated){if(repeated.request_hash!==requestHash)return fail('CONTINUITY_REVISION_CONFLICT','Recovery key belongs to another frame review');return JSON.parse(repeated.result_json);}
    const ledger=await loadContinuityLedger(scriptId),scene=await db.get('SELECT * FROM scene WHERE id=?',body.scene_id);
    if(!scene||scene.chapter_id!==ledger.script.chapter_id)return fail('CONTINUITY_SCOPE_INVALID','Shot does not belong to this screenplay',404);
    if(ledger.script.revision!==body.expected_script_revision||ledger.revision!==body.expected_continuity_revision||Number(scene.active_version||1)!==body.expected_scene_version)return fail('CONTINUITY_REVISION_CONFLICT','Shot or review changed; keep the selected moment and refresh');
    const current=await currentContinuitySnapshot(scriptId,body.target_scene_id),reads=body.reads as ContinuityRead[];
    const read=readContinuityMoment(current.snapshot,body.moment_id,body.phase,reads);
    const spec=JSON.parse(scene.shot_spec||'{}'),doc=ScriptDocumentSchema.parse(JSON.parse(ledger.script.document_json)),target=doc.scenes.find(scene=>scene.id===body.target_scene_id)!;
    if(!String(spec.primary_action||'').trim()||!String(spec.location||'').trim()||(spec.source?.block_ids||[]).some((id:string)=>!target.blocks.some(block=>block.id===id)))return fail('CONTINUITY_REVIEW_REQUIRED','Review the shot action/source before creating a new image version');
    const version=await createSceneVersion(scene.id,{clearAsset:true,label:`continuity-${ledger.revision}`});
    delete spec.english_visual_prompt;
    spec.continuity_states=continuityVisualStates(ledger.input!.context.entities,read.values,current.id);
    await db.run("UPDATE scene SET shot_spec=?,visual_prompt='',asset_status='idle',task_id=NULL WHERE id=?",JSON.stringify(spec),scene.id);
    await bindContinuityShotInTransaction(scene.id,{script_id:scriptId,script_scene_id:body.target_scene_id,moment_id:body.moment_id,phase:body.phase,reads});
    await syncActiveVersionFromScene(scene.id);
    const result={scene_id:scene.id,old_version:body.expected_scene_version,new_version:version!.version.version,previous_image_url:scene.asset_url,new_image_url:null,continuity_revision:ledger.revision};
    await db.run('INSERT INTO continuity_shot_recovery(script_id,request_key,request_hash,scene_id,actor_id,reason,review_json,result_json) VALUES(?,?,?,?,?,?,?,?)',scriptId,body.request_key,requestHash,scene.id,actorId,body.reason,JSON.stringify(body),JSON.stringify(result));
    return result;
  });
}

/** Bind script-backed shots that already declare attribute reads and have no continuity reference. */
export async function bindChapterContinuityShots(scriptId:number,_actorId='local_admin'){
  const initial=await loadContinuityLedger(scriptId);
  const initialDoc=ScriptDocumentSchema.parse(JSON.parse(initial.script.document_json));
  if (!initialDoc.scenes.length) return fail('CONTINUITY_SCOPE_INVALID','Screenplay has no scenes',404);
  if (!initial.input) return fail('CONTINUITY_REVIEW_REQUIRED','Confirm the explicit first-scene entry before binding chapter shots');
  return withImmediateTransaction(async()=>{
    const ledger=await loadContinuityLedger(scriptId);
    if (!ledger.input) return fail('CONTINUITY_REVIEW_REQUIRED','Continuity ledger is not ready');
    const doc=ScriptDocumentSchema.parse(JSON.parse(ledger.script.document_json));
    const validSceneIds=new Set(doc.scenes.map(scene=>scene.id));
    const scenes=await db.all('SELECT id,active_version,shot_spec FROM scene WHERE chapter_id=? ORDER BY "index",id',ledger.script.chapter_id);
    const boundSceneIds:number[]=[];
    for (const row of scenes) {
      let spec:any={};
      try { spec=JSON.parse(row.shot_spec||'{}'); } catch { continue; }
      if (spec?.source?.type!=='script' || Number(spec?.source?.script_id)!==scriptId) continue;
      const scriptSceneId=String(spec?.source?.script_scene_id||'');
      if (!scriptSceneId || !validSceneIds.has(scriptSceneId)) continue;
      if (spec?.source?.continuity?.reference) continue;
      const declared=spec?.source?.continuity?.reads;
      if (!Array.isArray(declared) || !declared.length) continue;
      const reads=declared.map(read=>ContinuityReadSchema.parse(read) as ContinuityRead);
      await bindContinuityShotInTransaction(Number(row.id),{
        script_id:scriptId,
        script_scene_id:scriptSceneId,
        moment_id:`${scriptSceneId}:exit`,
        phase:'after',
        reads,
      });
      await syncActiveVersionFromScene(Number(row.id));
      boundSceneIds.push(Number(row.id));
    }
    return {script_id:scriptId,continuity_revision:ledger.revision,bound_scene_ids:boundSceneIds};
  });
}

