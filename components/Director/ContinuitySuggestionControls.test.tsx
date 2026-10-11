import React,{act} from 'react';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {LanguageProvider} from '../../LanguageContext';
import {api} from '../../services/api';
import {ContinuitySuggestionControls} from './ContinuitySuggestionControls';
async function mount(t:TestContext){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'}),globals={window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true};
  const originals=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);let notifications=0;
  t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  const view:any={script_id:30,script_revision:2,continuity_revision:4,target_scene_id:'s1',snapshot:{},order:{scenes:[{script_scene_id:'s1'}]},sources:[]};
  await act(async()=>root.render(<LanguageProvider><ContinuitySuggestionControls view={view} disabled={false} onCompleted={()=>notifications++}/></LanguageProvider>));
  const click=async(id:string)=>act(async()=>dom.window.document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click());
  return {click,notifications:()=>notifications,root};
}
test('CT19 model suggestions require an explicit request and notify for review without confirming the ledger',async t=>{
  const requests:any[]=[];t.mock.method(api,'startContinuitySuggestions',async(_id,body)=>{requests.push(body);return{task_id:'done',status:'pending_review',budget:{calls:[{}]}};});
  const ui=await mount(t);assert.equal(requests.length,0);await ui.click('continuity-model-start');assert.equal(requests[0].expected_script_revision,2);assert.equal(requests[0].expected_continuity_revision,4);assert.equal(ui.notifications(),1);
});
test('CT19 cancelled suggestion tasks resume the original revision, request key and budget checkpoint',async t=>{
  const previous={task_id:'cancelled',status:'cancelled',request:{target_scene_id:'s1',expected_script_revision:1,expected_continuity_revision:3,request_key:'original',seed:41,preceding_source_ids:['old']}};let submitted:any;
  t.mock.method(api,'getContinuitySuggestionTasks',async()=>({tasks:[previous]}));t.mock.method(api,'startContinuitySuggestions',async(_id,body)=>{submitted=body;return{task_id:'cancelled',status:'pending_review'};});
  const ui=await mount(t);await ui.click('continuity-model-history');await ui.click('continuity-model-resume');assert.deepEqual(submitted,previous.request);assert.equal(ui.notifications(),1);
});
test('CT19 a late suggestion response after switching chapters cannot reload the new chapter review',async t=>{
  let complete:(value:any)=>void=()=>{};t.mock.method(api,'startContinuitySuggestions',()=>new Promise(resolve=>{complete=resolve;}));
  const ui=await mount(t);await ui.click('continuity-model-start');await act(async()=>ui.root.render(<div/>));await act(async()=>complete({task_id:'late',status:'pending_review'}));assert.equal(ui.notifications(),0);
});
