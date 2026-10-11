import React,{act,StrictMode} from 'react';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {LanguageProvider} from '../../LanguageContext';
import {api} from '../../services/api';
import {ContinuityTimePanel} from './ContinuityTimePanel';
const material=(revision=1):any=>({script_id:30,script_revision:1,continuity_revision:revision,target_scene_id:'s2',entities:[{entity_id:'coat',display_name:'外套'}],order:{scenes:[{script_scene_id:'s1'},{script_scene_id:'s2'}]},sources:[{source_type:'screenplay',source_document_id:'script:30:s2:b1',source_revision:1,source_text_hash:'a'.repeat(64),text:'次日，林岚走进屋内。'}],draft:{entry_values:[{entity_id:'coat',attribute_id:'wetness'}],changes:[]}});
async function mount(t:TestContext){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'}),globals={window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true};
  const previous=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);let changed=0,plan:any;
  const render=async(view=material(),fullReview=false)=>act(async()=>root.render(<StrictMode><LanguageProvider><ContinuityTimePanel view={view} disabled={false} fullReview={fullReview} onPlanChange={next=>{plan=next;}} onChanged={()=>{changed++;}}/></LanguageProvider></StrictMode>));
  const query=(id:string)=>dom.window.document.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
  const click=async(id:string)=>act(async()=>query(id).click());
  const fill=async(id:string,value:string)=>act(async()=>{const element=query(id);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const[key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
  await render();return {dom,root,render,query,click,fill,get changed(){return changed;},get plan(){return plan;}};
}
test('CT20 UI: StrictMode preview completes, edits invalidate approval, and explicit confirmation clears only this draft',async t=>{
  const m=await mount(t);let confirmed:any;
  t.mock.method(api,'previewContinuityTime',async()=>({impact_hash:'b'.repeat(64),affected_shot_ids:[101],changes:[],shots:[]}));
  t.mock.method(api,'confirmContinuityTime',async(_id,body)=>{confirmed=body;});
  await m.click('continuity-time-add');await m.fill('continuity-time-reason','人工核对时间');await m.click('continuity-time-preview');
  assert.ok(m.query('continuity-time-impact'));assert.equal(m.query('continuity-time-confirm').disabled,false);assert.equal(m.query('continuity-time-preview').disabled,false);
  await m.fill('continuity-time-initial-day','day-custom');assert.equal(m.query('continuity-time-confirm').disabled,true);assert.equal(m.query('continuity-time-impact'),null);
  await m.click('continuity-time-preview');await m.click('continuity-time-confirm');assert.equal(confirmed.expected_impact_hash,'b'.repeat(64));assert.equal(confirmed.time_plan.initial_day_id,'day-custom');assert.equal(m.changed,1);assert.equal(localStorage.getItem('continuity-time:30'),null);
});
test('CT20 UI: stale revision preserves time plan and reason; full review includes the draft without a separate write',async t=>{
  const m=await mount(t);await m.click('continuity-time-add');await m.fill('continuity-time-reason','保留手工理由');await m.fill('continuity-time-initial-day','custom');await m.render(material(2),true);
  assert.equal(m.query('continuity-time-initial-day').value,'custom');assert.equal(m.query('continuity-time-reason').value,'保留手工理由');assert.equal(m.plan.initial_day_id,'custom');assert.equal(m.query('continuity-time-preview').disabled,true);
  const draft=JSON.parse(localStorage.getItem('continuity-time:30')!);assert.equal(draft.base.continuity,1);await m.click('continuity-time-refresh');assert.equal(JSON.parse(localStorage.getItem('continuity-time:30')!).base.continuity,2);assert.equal(m.changed,0);
});
