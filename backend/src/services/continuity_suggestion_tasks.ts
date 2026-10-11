import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db, withImmediateTransaction } from '../db/database';
import { SettingsManager } from '../core/settings_manager';
import { LLMService } from './llm';
import type { AIProvider } from './ai/base';
import { withLocalTextInference } from './local_text_inference';
import { loadContinuityLedger, ContinuityStoreError } from './continuity_store';
import { continuityHash } from './continuity_replay';
import { getContinuityReview } from './continuity_review';
import { extractContinuitySuggestions, LogicalContinuityBudget, continuitySuggestionPolicyFingerprint, type ContinuitySuggestionTask } from './continuity_suggestions';

export const ContinuitySuggestionRequestSchema = z.object({
  target_scene_id: z.string().min(1), expected_script_revision: z.number().int().positive(),
  expected_continuity_revision: z.number().int().nonnegative(), request_key: z.string().trim().min(1).max(100),
  related_entity_ids: z.array(z.string().min(1)).min(1).max(50).optional(),
  preceding_source_ids: z.array(z.string().min(1)).max(50).default([]), seed: z.number().int().optional(),
}).strict();
type Request = z.infer<typeof ContinuitySuggestionRequestSchema>;
type Reuse = NonNullable<ContinuitySuggestionTask['reuse']>;
type Running = { controller: AbortController; done: Promise<void> };
const running = new Map<string, Running>();
const fail = (code: string, message: string, status: 404|409|422 = 409): never => { throw new ContinuityStoreError(code,message,status); };

async function assemble(scriptId: number, body: Request, modelFingerprint: string) {
  const ledger = await loadContinuityLedger(scriptId);
  if (ledger.script.revision !== body.expected_script_revision || ledger.revision !== body.expected_continuity_revision)
    return fail('CONTINUITY_REVISION_CONFLICT','Saved source or review changed');
  if (!ledger.input) return fail(ledger.issues[0]?.code || 'CONTINUITY_ENTRY_REQUIRED','Confirm the first-scene entry before extraction');
  const view = await getContinuityReview(scriptId,body.target_scene_id);
  if (!view.snapshot) return fail('CONTINUITY_REVIEW_REQUIRED','Review the saved scene entry first');
  const sceneIndex = view.order.scenes.findIndex(scene => scene.script_scene_id === body.target_scene_id);
  const sceneSource = (id: string) => view.order.scenes.findIndex(scene => id.startsWith(`script:${scriptId}:${scene.script_scene_id}:`));
  const sources = view.sources.filter(source => source.source_type === 'screenplay' && sceneSource(source.source_document_id) === sceneIndex)
    .map(source => ({ source_id: source.source_document_id, source_type: source.source_type, source_document_id: source.source_document_id, source_revision: source.source_revision, text: source.text }));
  const preceding = body.preceding_source_ids.map(id => {
    const source = view.sources.find(source => source.source_type === 'screenplay' && source.source_document_id === id);
    if (!source || sceneSource(id) < 0 || sceneSource(id) >= sceneIndex) return fail('CONTINUITY_SCOPE_INVALID','Preceding context must come from an earlier saved scene',422);
    return source;
  }).sort((a,b) => view.sources.indexOf(a)-view.sources.indexOf(b));
  const task = { context: {...ledger.input.context,sources:view.sources.map(source=>({...source,project_id:view.project_id,bindings:[]}))},
    target_scene_id: body.target_scene_id, related_entity_ids: [...new Set(body.related_entity_ids ?? view.entities.map(entity=>entity.entity_id))].sort(),
    prior_state: view.snapshot.entry_state, sources, preceding_context: preceding.map(source=>source.text).join('\n'), seed:body.seed, model_fingerprint:modelFingerprint };
  if (task.related_entity_ids.some(id => !task.context.entities.some(entity=>entity.entity_id===id))) return fail('CONTINUITY_SCOPE_INVALID','Related entity is outside this project',422);
  // The whole saved source and review are part of the checkpoint contract, even if an unrelated block was edited.
  return {task,inputHash:continuityHash([task,view.script_revision,view.continuity_revision,view.sources,continuitySuggestionPolicyFingerprint])};
}

export async function getContinuitySuggestionTask(scriptId: number, taskId: string) {
  const row = await db.get('SELECT * FROM continuity_suggestion_task WHERE id=? AND script_id=?',taskId,scriptId);
  if (!row) return fail('CONTINUITY_SCOPE_INVALID','Suggestion task does not belong to this screenplay',404);
  return {task_id:row.id,script_id:row.script_id,status:row.status,attempt:row.attempt,error:row.error,
    request:JSON.parse(row.request_json) as Request,budget:JSON.parse(row.budget_json),reuse_batches:(JSON.parse(row.reuse_json) as Reuse).length,
    result:row.result_json?JSON.parse(row.result_json):null};
}
export async function listContinuitySuggestionTasks(scriptId: number) {
  await loadContinuityLedger(scriptId);
  const rows=await db.all('SELECT id FROM continuity_suggestion_task WHERE script_id=? ORDER BY created_at DESC,id LIMIT 20',scriptId);
  return Promise.all(rows.map(row=>getContinuitySuggestionTask(scriptId,row.id)));
}
export async function waitForContinuitySuggestionTask(taskId: string) { await running.get(taskId)?.done; }

export async function startContinuitySuggestionTask(scriptId: number, raw: unknown, options: {provider?:AIProvider;modelFingerprint?:string} = {}) {
  const body=ContinuitySuggestionRequestSchema.parse(raw);
  const modelFingerprint=options.modelFingerprint ?? continuityHash(SettingsManager.loadSettings().llm || {});
  const prepared=await assemble(scriptId,body,modelFingerprint),requestHash=continuityHash(body);
  const row=await withImmediateTransaction(async()=>{
    const old=await db.get('SELECT * FROM continuity_suggestion_task WHERE script_id=? AND request_key=?',scriptId,body.request_key);
    if(old){
      if(old.request_hash!==requestHash||old.input_hash!==prepared.inputHash) return fail('CONTINUITY_REVISION_CONFLICT','Request key or checkpoint inputs changed; review and start a new task');
      return {...old,fresh:false};
    }
    const id=randomUUID();
    await db.run('INSERT INTO continuity_suggestion_task(id,script_id,request_key,request_hash,input_hash,request_json,status,budget_json) VALUES(?,?,?,?,?,?,?,?)',id,scriptId,body.request_key,requestHash,prepared.inputHash,JSON.stringify(body),'processing',JSON.stringify(new LogicalContinuityBudget()));
    return {...await db.get('SELECT * FROM continuity_suggestion_task WHERE id=?',id),fresh:true};
  });
  if(running.has(row.id)||['completed','pending_review','stale','failed'].includes(row.status)) return getContinuitySuggestionTask(scriptId,row.id);
  const controller=new AbortController(),budget:LogicalContinuityBudget=Object.assign(new LogicalContinuityBudget(),JSON.parse(row.budget_json)),reuse:Reuse=JSON.parse(row.reuse_json);
  budget.calls=budget.calls.map(call=>call.attempt_state==='reserved'?{...call,attempt_state:'interrupted_unknown'}:call);
  const attempt=row.fresh?row.attempt:row.attempt+1;
  const checkpoint=async(state:{budget:LogicalContinuityBudget;reuse:Reuse})=>{
    await db.run('UPDATE continuity_suggestion_task SET budget_json=?,reuse_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',JSON.stringify(state.budget),JSON.stringify(state.reuse),row.id);
  };
  // Reservation is durable before work starts. Keep a single in-process owner for each logical task.
  const done=(async()=>{
    try{
      await db.run("UPDATE continuity_suggestion_task SET status='processing',error=NULL,attempt=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",attempt,row.id);
      const infer=()=>extractContinuitySuggestions({...prepared.task,provider:options.provider??LLMService.getLocalProvider(),signal:controller.signal,budget,reuse,checkpoint});
      const result=await (options.provider?infer():withLocalTextInference(infer));
      if(controller.signal.aborted) throw controller.signal.reason;
      await withImmediateTransaction(async()=>{
        const current=await assemble(scriptId,body,modelFingerprint);
        if(current.inputHash!==prepared.inputHash) return fail('CONTINUITY_STALE','Source changed during extraction');
        const status=result.status==='ready_for_review'?'completed':'pending_review';
        await db.run('INSERT INTO continuity_suggestion(id,script_id,script_scene_id,raw_json) VALUES(?,?,?,?)',row.id,scriptId,body.target_scene_id,JSON.stringify({task_id:row.id,review:{changes:result.proposals},pending:result.pending,automatic_accepted:0}));
        await db.run('UPDATE continuity_suggestion_task SET status=?,budget_json=?,reuse_json=?,result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',status,JSON.stringify(result.budget),JSON.stringify(result.reuse??reuse),JSON.stringify(result),row.id);
      });
    }catch(error:any){
      const status=controller.signal.aborted?'cancelled':error instanceof ContinuityStoreError&&['CONTINUITY_STALE','CONTINUITY_REVISION_CONFLICT'].includes(error.code)?'stale':'failed';
      await db.run('UPDATE continuity_suggestion_task SET status=?,budget_json=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',status,JSON.stringify(budget),error.message??String(error),row.id);
    }finally{running.delete(row.id);}
  })();
  running.set(row.id,{controller,done});
  void done.catch(()=>undefined);
  return getContinuitySuggestionTask(scriptId,row.id);
}
export async function cancelContinuitySuggestionTask(scriptId: number, taskId: string) {
  const task=await getContinuitySuggestionTask(scriptId,taskId),owner=running.get(taskId);
  if(owner){owner.controller.abort(new Error('Suggestion extraction cancelled'));await owner.done;}
  else if(task.status==='processing') await db.run("UPDATE continuity_suggestion_task SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?",taskId);
  return getContinuitySuggestionTask(scriptId,taskId);
}
