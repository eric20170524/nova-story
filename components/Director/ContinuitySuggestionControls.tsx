import React,{useEffect,useRef,useState} from 'react';
import {api} from '../../services/api';
import {useLanguage} from '../../LanguageContext';
import type {ContinuityReviewView} from '../../services/continuityTypes';
const button='rounded border px-2 py-1 text-xs disabled:opacity-40';
export const ContinuitySuggestionControls:React.FC<{view:ContinuityReviewView;disabled:boolean;onCompleted:()=>void}>=({view,disabled,onCompleted})=>{
  const {t}=useLanguage(),[task,setTask]=useState<any>(null),[history,setHistory]=useState<any[]>([]),[preceding,setPreceding]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const currentCallback=useRef(onCompleted);currentCallback.current=onCompleted;const notified=useRef(new Set<string>());
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const notify=(next:any)=>{if(['completed','pending_review'].includes(next.status)&&!notified.current.has(next.task_id)){notified.current.add(next.task_id);currentCallback.current();}};
  useEffect(()=>{if(task?.status!=='processing')return;let alive=true,inFlight=false;const poll=async()=>{if(inFlight)return;inFlight=true;try{const next=await api.getContinuitySuggestionTask(view.script_id,task.task_id);if(alive){setTask(next);notify(next);}}catch(error:any){if(alive)setError(error.message);}finally{inFlight=false;}};void poll();const timer=setInterval(()=>void poll(),2000);return()=>{alive=false;clearInterval(timer);};},[view.script_id,task?.task_id,task?.status]);
  useEffect(()=>setPreceding([]),[view.target_scene_id]);
  const operate=async(work:()=>Promise<any>)=>{setBusy(true);setError('');try{const next=await work();if(alive.current){setTask(next);notify(next);}}catch(error:any){if(alive.current){const key=`continuity.errors.${error.code}`;setError(t(key)===key?error.message:t(key));}}finally{if(alive.current)setBusy(false);}};
  const index=view.order.scenes.findIndex(scene=>scene.script_scene_id===view.target_scene_id);
  const earlier=view.sources.filter(source=>source.source_type==='screenplay'&&view.order.scenes.slice(0,index).some(scene=>source.source_document_id.startsWith(`script:${view.script_id}:${scene.script_scene_id}:`)));
  const locked=disabled||busy||task?.status==='processing';
  return <div className="rounded border p-2 space-y-2 text-xs" data-testid="continuity-model">
    <p>{t('continuity_model.help')}</p>
    {earlier.length>0&&<details><summary>{t('continuity_model.preceding')}</summary>{earlier.map(source=><label className="flex gap-2 break-words" key={source.source_document_id}><input type="checkbox" disabled={locked} checked={preceding.includes(source.source_document_id)} onChange={event=>setPreceding(event.target.checked?[...preceding,source.source_document_id]:preceding.filter(id=>id!==source.source_document_id))}/>{source.text}</label>)}</details>}
    <button className={button} data-testid="continuity-model-start" disabled={locked||!view.snapshot} onClick={()=>void operate(()=>api.startContinuitySuggestions(view.script_id,{target_scene_id:view.target_scene_id,expected_script_revision:view.script_revision,expected_continuity_revision:view.continuity_revision,request_key:crypto.randomUUID(),preceding_source_ids:preceding,seed:41}))}>{t('continuity_model.start')}</button>
    <button className={button} data-testid="continuity-model-history" disabled={busy} onClick={()=>void(async()=>{setBusy(true);try{setHistory((await api.getContinuitySuggestionTasks(view.script_id)).tasks);}catch(error:any){setError(error.message);}finally{setBusy(false);}})()}>{t('continuity_model.history')}</button>
    {task&&<p data-testid="continuity-model-status">{t(`continuity_model.status_${task.status}`)} · {t('continuity_model.calls')} {task.budget?.calls?.length||0} · {t('continuity_model.reused')} {task.reuse_batches||0}</p>}
    {task?.status==='processing'&&<button className={button} data-testid="continuity-model-cancel" disabled={busy} onClick={()=>void operate(()=>api.cancelContinuitySuggestionTask(view.script_id,task.task_id))}>{t('continuity_model.cancel')}</button>}
    {history.filter(previous=>previous.request.target_scene_id===view.target_scene_id).map(previous=><div key={previous.task_id}>{t(`continuity_model.status_${previous.status}`)} · {previous.request.target_scene_id}{['cancelled','processing'].includes(previous.status)&&<button className={button} data-testid="continuity-model-resume" disabled={locked} onClick={()=>void operate(()=>api.startContinuitySuggestions(view.script_id,previous.request))}>{t('continuity_model.resume')}</button>}</div>)}
    {error&&<p role="alert" className="break-words text-red-600">{error}</p>}
  </div>;
};
