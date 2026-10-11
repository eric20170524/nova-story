import React,{act} from 'react';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {LanguageProvider} from '../../LanguageContext';
import {ToastProvider} from '../../ToastContext';
import {api} from '../../services/api';
import {SceneProductionPanel} from './SceneProductionPanel';
const material=(revision=1)=>({script_revision:1,continuity_revision:revision,timeline_revision:0,entities:[],timeline:[],candidates:[],scenes:['s1','s2'].map(id=>({scene_id:id,blocks:[{id:`${id}:source`,type:'action',text:`${id} 完整动作。`}],moments:[{story_position:{moment_id:`${id}:exit`,phase:'after'},state:[]}]}))});
async function mount(t:TestContext,get=async()=>material()){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'}),globals={window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true};
  const originals=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);t.mock.method(api,'getSceneProduction',get);
  t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  const query=<T extends HTMLElement=HTMLElement>(id:string)=>dom.window.document.querySelector<T>(`[data-testid="${id}"]`)!;
  const click=async(id:string)=>act(async()=>query<HTMLButtonElement>(id).click());
  const choose=async(id:string,value:string)=>act(async()=>{const element=query<HTMLSelectElement>(id);element.value=value;element.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  const render=async(id=30)=>act(async()=>root.render(<ToastProvider><LanguageProvider><SceneProductionPanel key={id} script={{id,revision:1}} onChanged={()=>{}}/></LanguageProvider></ToastProvider>));
  await render();await click('production-toggle');
  return {dom,query,click,choose,render};
}
test('CT15 draft sources and shot moments survive scene/chapter switches without copying one scene buffer over another',async t=>{
  const ui=await mount(t);await ui.click('production-block-s1:source');await ui.choose('production-moment','s1:exit|after');await ui.click('production-add-shot');
  await ui.choose('production-scene','s2');assert.equal(JSON.parse(localStorage.getItem('novastory:production:30:s2')!).shots.length,0);
  await ui.click('production-block-s2:source');await ui.choose('production-moment','s2:exit|after');await ui.click('production-add-shot');
  await ui.choose('production-scene','s1');assert.equal(JSON.parse(localStorage.getItem('novastory:production:30:s1')!).shots[0].block_ids[0],'s1:source');assert.ok(ui.query('production-dirty'));
  await ui.render(31);await ui.render(30);await ui.click('production-toggle');assert.equal(JSON.parse(localStorage.getItem('novastory:production:30:s2')!).shots[0].block_ids[0],'s2:source');
});
test('CT15 a conflicting save retains sources and old guards until explicit evidence refresh',async t=>{
  let revision=1;const bodies:any[]=[];t.mock.method(api,'createSceneProductionCandidate',async(_id,body:any)=>{bodies.push(body);if(bodies.length===1){revision=2;throw new Error('Saved state changed');}return{};});
  const ui=await mount(t,async()=>material(revision));await ui.click('production-block-s1:source');await ui.choose('production-moment','s1:exit|after');await ui.click('production-add-shot');await ui.click('production-save');
  assert.equal(JSON.parse(localStorage.getItem('novastory:production:30:s1')!).base_continuity_revision,1);assert.ok(ui.query('production-dirty'));
  await ui.click('production-refresh');await ui.click('production-save');assert.equal(bodies[1].expected_continuity_revision,2);assert.deepEqual(bodies[1].shots[0].block_ids,['s1:source']);
});
test('CT16 dirty edits disable adoption; a saved candidate needs a fresh impact preview and sends the exact reviewed range',async t=>{
  const view:any=material();view.timeline=[{id:101,shot_spec:JSON.stringify({source:{script_scene_id:'s1'}})}];view.candidates=[{id:'candidate',revision:1,payload:{scope:{target_scene_id:'s1'},scriptRevision:1,continuityRevision:1,round:'skeleton',shots:[{}],coverage:{complete:false,gaps:[{block_id:'sound',text:'雨声'}]}}}];
  let submitted:any;t.mock.method(api,'previewSceneProductionApply',async(_id,_change,body)=>({impact_hash:'a'.repeat(64),replacement_ids:(body as any).replace_scene_ids,new_shot_count:0,preserved_other_scene_ids:[102],placement:[{role:'replaced',scene_id:101,shot_index:0}]}));t.mock.method(api,'applySceneProduction',async(_id,_change,body)=>{submitted=body;return{};});
  const ui=await mount(t,async()=>view);await ui.click('production-block-s1:source');assert.equal(ui.query<HTMLButtonElement>('production-preview').disabled,true);
  t.mock.method(api,'createSceneProductionCandidate',async()=>({}));await ui.choose('production-moment','s1:exit|after');await ui.click('production-add-shot');await ui.click('production-save');await ui.click('production-replace-101');await ui.click('production-preview');assert.match(ui.query('production-order').textContent!,/#101/);await ui.click('production-apply');
  assert.deepEqual(submitted.replace_scene_ids,[101]);assert.equal(submitted.expected_impact_hash,'a'.repeat(64));assert.equal(submitted.target_scene_id,'s1');assert.match(ui.dom.window.document.body.textContent!,/雨声/);
});
