import React, { act } from 'react';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider, useLanguage } from '../../LanguageContext';
import { ToastProvider } from '../../ToastContext';
import { api } from '../../services/api';
import { ContinuityPanel } from './ContinuityPanel';
import { ContinuityOverlayProposalSchema } from '../../backend/src/schemas/continuity_snapshot';
import { ContinuityChangeProposalSchema } from '../../backend/src/schemas/continuity_state';

function material(target = 's1', revision = 1): any {
  const position = { version: 1, project_id: 10, script_id: 30, script_revision: 1,
    screenplay_order_revision: 1, story_segment_id: 'linear', script_scene_id: target,
    scene_order: target === 's1' ? 0 : 1, beat_id: null, beat_order: null, change_order: 0,
    moment_id: `${target}:exit`, phase: 'after' };
  const cell = { entity_id: 'coat', attribute_id: 'wetness', knowledge_status: 'confirmed', value: 'dry' };
  return { script_id: 30, project_id: 10, script_revision: 1, continuity_revision: revision,
    target_scene_id: target, status: 'ready', order: { story_segment_id: 'linear', scenes: [{ script_scene_id: 's1' }, { script_scene_id: 's2' }] },
    entities: [{ entity_id: 'coat', project_id: 10, kind: 'garment', display_name: '外套', aliases: [] }],
    registry: { wetness: { type: 'enum', kinds: ['garment'], values: ['dry', 'wet'], operations: ['assign'] } },
    resources: { characters: [], assets: [] }, sources: [{ source_type: 'screenplay', source_document_id: 'script:30:s1:a1', source_revision: 1, source_text_hash: 'a'.repeat(64), text: '外套被雨水打湿。' }],
    snapshot: { entry_state: [cell], exit_state: [cell], confirmed_changes: [], moments: [{ story_position: position, state: [cell], during_overlay: null }] },
    issues: [], shots: [{ id: 101, active_version: 1, asset_url: '/old.svg', continuity_status: 'stale', script_scene_id: 's1', moment_id: 's1:exit', phase: 'after', reads: [{ entity_id: 'coat', attribute_id: 'wetness' }], image_versions: [{ version: 1, label: 'original', asset_url: '/old.svg', continuity_status: 'stale' }] }],
    pending_suggestions: [], draft: { entry_values: [cell], changes: [], during_overlays: [] }, history: [] };
}

function LanguageSwitch() {
  const { setLanguage } = useLanguage();
  return <button data-testid="english" onClick={() => setLanguage('en')}>English</button>;
}

async function mount(t: TestContext, get: (id: number, target?: string) => Promise<any> = async (_id, target) => material(target)) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const original = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.mock.method(api, 'getContinuityReview', get);
  t.mock.method(api,'previewContinuity',async()=>({impact_hash:'a'.repeat(64),affected_shot_ids:[101],changes:[],shots:[]}));
  const render = async (id = 30) => act(async () => root.render(<MemoryRouter><ToastProvider><LanguageProvider><LanguageSwitch/><ContinuityPanel key={id} script={{ id, revision: 1 }} projectId={10} onChanged={() => {}}/></LanguageProvider></ToastProvider></MemoryRouter>));
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  const query = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.querySelector<T>(`[data-testid="${id}"]`)!;
  const click = async (id: string) => act(async () => query<HTMLButtonElement>(id).click());
  const choose = async (element: HTMLSelectElement, value: string) => act(async () => { element.value = value; element.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  await render(); await click('continuity-toggle'); await click('continuity-edit');
  const wet = async () => choose(query('continuity-entry-editor').querySelectorAll<HTMLSelectElement>('select')[2], 'wet');
  const confirm=async()=>{await click('continuity-preview');await click('continuity-confirm');};
  return { dom, query, click, choose, wet, render,confirm };
}

test('CT07 review submits explicit human values and guards while the confirmed snapshot stays unchanged during editing', async t => {
  let submitted: any;
  t.mock.method(api, 'confirmContinuity', async (_id, body) => { submitted = body; return {}; });
  const ui = await mount(t);
  await ui.wet();
  assert.match(ui.query('continuity-entry').textContent!, /干燥/);
  assert.equal(JSON.parse(ui.dom.window.localStorage.getItem('continuity-review:10:30')!).entry[0].value, 'wet');
  await ui.confirm();
  assert.equal(submitted.review_action, 'human_review');
  assert.equal(submitted.expected_script_revision, 1); assert.equal(submitted.expected_continuity_revision, 1);
  assert.equal(submitted.entry_values[0].value, 'wet'); assert.equal('authority' in submitted, false);
  assert.equal(ui.dom.window.localStorage.getItem('continuity-review:10:30'), null);
});

test('CT07 scene/chapter changes retain dirty values and prevent a narrower confirmation from dropping other edits', async t => {
  const ui = await mount(t);
  await ui.wet(); await ui.choose(ui.query<HTMLSelectElement>('continuity-scene-select'), 's2');
  assert.equal(ui.query<HTMLButtonElement>('continuity-confirm').disabled, true);
  assert.equal(ui.query<HTMLButtonElement>('continuity-preview').disabled, true);
  await ui.choose(ui.query<HTMLSelectElement>('continuity-scene-select'), 's1');
  assert.equal(ui.query('continuity-entry-editor').querySelectorAll<HTMLSelectElement>('select')[2].value, 'wet');
  assert.equal(ui.query<HTMLButtonElement>('continuity-preview').disabled, false);
  await ui.render(31); await ui.render(30); await ui.click('continuity-toggle');
  assert.equal(ui.query('continuity-entry-editor').querySelectorAll<HTMLSelectElement>('select')[2].value, 'wet');
  assert.ok(ui.dom.window.localStorage.getItem('continuity-review:10:30'));
});

test('CT07 a concurrent review retains edits and old guards until the user refreshes the evidence', async t => {
  let revision = 1;
  const submissions: any[] = [];
  t.mock.method(api, 'confirmContinuity', async (_id, body) => {
    submissions.push(body); if (submissions.length === 1) { revision = 2; localStorage.removeItem('continuity-review:10:30'); throw Object.assign(new Error('conflict'), { code: 'CONTINUITY_REVISION_CONFLICT' }); } return {};
  });
  const ui = await mount(t, async (_id, target) => material(target, revision));
  await ui.wet(); await ui.confirm();
  assert.equal(ui.query('continuity-entry-editor').querySelectorAll<HTMLSelectElement>('select')[2].value, 'wet');
  assert.match(ui.query('continuity-panel').textContent!, /确认记录已变化/);
  assert.equal(JSON.parse(ui.dom.window.localStorage.getItem('continuity-review:10:30')!).base.continuity, 1);
  await ui.click('continuity-refresh'); await ui.confirm();
  assert.equal(submissions[1].expected_continuity_revision, 2); assert.equal(submissions[1].entry_values[0].value, 'wet');
});

test('CT07 recovery names one shot/version and retains its previous image after making a fresh slot', async t => {
  let recovered = false, request: any;
  t.mock.method(api, 'refreshContinuityShot', async (_id, body) => { recovered = true; request = body; return {}; });
  const ui = await mount(t, async (_id, target) => { const data = material(target); if (recovered) Object.assign(data.shots[0], { active_version: 2, asset_url: null, continuity_status: 'current' }); return data; });
  await ui.click('continuity-recover-shot');
  assert.equal(request.scene_id, 101); assert.equal(request.expected_scene_version, 1);
  assert.equal(request.moment_id, 's1:exit'); assert.deepEqual(request.reads, [{ entity_id: 'coat', attribute_id: 'wetness' }]);
  assert.match(ui.query<HTMLAnchorElement>('continuity-old-image').href, /old.svg$/);
  assert.equal(ui.dom.window.document.querySelector('[data-testid="continuity-recover-shot"]'), null);
  assert.equal(ui.query<HTMLAnchorElement>('continuity-script-link').getAttribute('href'), '/project/10/script');
  await ui.click('english'); assert.match(ui.query('continuity-panel').textContent!, /Scene continuity/);
  assert.match(ui.query('continuity-panel').textContent!, /Previous image/);
});

test('CT07 late responses from the previous chapter do not replace the current review', async t => {
  let resolveOld: (value: any) => void = () => {};
  let calls = 0;
  const ui = await mount(t, async (id, target) => {
    calls++; if (calls === 2) return new Promise(resolve => { resolveOld = resolve; });
    const data = material(target); data.script_id = id; data.entities[0].display_name = `chapter-${id}`; return data;
  });
  await ui.choose(ui.query<HTMLSelectElement>('continuity-scene-select'), 's2');
  await ui.render(31); await ui.click('continuity-toggle');
  await act(async () => resolveOld(material('s2')));
  assert.match(ui.query('continuity-entry').textContent!, /chapter-31/);
  assert.doesNotMatch(ui.query('continuity-entry').textContent!, /外套/);
});

test('CT08 new changes and standalone frame designs submit valid server contracts without inventing story events', async t => {
  let submitted: any;
  t.mock.method(api, 'confirmContinuity', async (_id, body) => { submitted = body; return {}; });
  const ui = await mount(t);
  await ui.click('continuity-add-overlay'); await ui.confirm();
  assert.equal(submitted.changes.length, 0);
  const frame = ContinuityOverlayProposalSchema.parse(submitted.during_overlays[0]);
  assert.equal(frame.event_change_id, null); assert.equal(frame.evidence[0].kind, 'design');
  await ui.click('continuity-add-change'); await ui.confirm();
  const change = ContinuityChangeProposalSchema.parse(submitted.changes[0]);
  assert.equal(change.story_position.version, 1); assert.equal(change.story_position.script_scene_id, 's1');
  assert.equal(change.evidence[0].kind, 'source');
});

test('CT13 changing a reviewed draft invalidates the visible impact until a new preview; undo remains a separate action',async t=>{
  let undo:any;
  t.mock.method(api,'previewContinuityUndo',async()=>({impact_hash:'b'.repeat(64),affected_shot_ids:[101],changes:[{script_scene_id:'s1',entity_id:'coat',attribute_id:'wetness',before:{knowledge_status:'confirmed',value:'wet'},after:{knowledge_status:'confirmed',value:'dry'}}],shots:[]}));
  t.mock.method(api,'undoContinuity',async(_id,body)=>{undo=body;return {};});
  const ui=await mount(t,async(_id,target)=>{const view=material(target,2);view.history=[{revision:1,actor_id:'local_admin',reason:'原入口',created_at:''}];return view;});
  await ui.click('continuity-preview');assert.equal(ui.query<HTMLButtonElement>('continuity-confirm').disabled,false);
  await ui.wet();assert.equal(ui.query<HTMLButtonElement>('continuity-confirm').disabled,true);assert.equal(ui.dom.window.document.querySelector('[data-testid="continuity-impact"]'),null);
  await ui.click('continuity-reset');
  await ui.click('continuity-undo-preview');assert.match(ui.query('continuity-undo-impact').textContent!,/湿润 → 干燥/);
  assert.equal(undo,undefined);await ui.click('continuity-undo-confirm');assert.equal(undo.target_revision,1);assert.equal(undo.expected_continuity_revision,2);assert.equal(undo.expected_impact_hash,'b'.repeat(64));
});

test('CT09 suggestions load only through a human draft and no-change is a valid visible outcome',async t=>{
  let submitted:any;
  t.mock.method(api,'confirmContinuity',async(_id,body)=>{submitted=body;return {};});
  const position={version:1,project_id:10,script_id:30,script_revision:1,screenplay_order_revision:1,story_segment_id:'linear',script_scene_id:'s1',scene_order:0,beat_id:null,beat_order:null,change_order:0,moment_id:'suggestion:after',phase:'after'};
  const proposal=ContinuityChangeProposalSchema.parse({schema_version:1,policy_version:'continuity-state-1',change_id:'suggested-wetness',change_revision:1,binding_revision:1,story_position:position,entity_id:'coat',attribute_id:'wetness',operation:'assign',value:'wet',basis:'story',time_relation:'confirmed_linear',origin:'model',evidence:[{kind:'source',source_type:'screenplay',source_document_id:'script:30:s1:a1',source_revision:1,source_text_hash:'a'.repeat(64),evidence_quote:'外套被雨水打湿。',start:0,end:8}]});
  const ui=await mount(t,async(_id,target)=>{const view=material(target);view.draft.changes=[{...proposal,change_id:'earlier-human-change',origin:'human_entry',value:'dry'}];view.pending_suggestions=[{id:'no-change',script_scene_id:'s1',raw:{review:{changes:[]},pending:[],automatic_accepted:0}},{id:'change',script_scene_id:'s1',raw:{review:{changes:[proposal]},pending:[],automatic_accepted:0}}];return view;});
  assert.match(ui.query('continuity-panel').textContent!,/未发现明确的变化建议/);assert.equal(submitted,undefined);
  await ui.click('continuity-load-suggestion');assert.equal(ui.query<HTMLButtonElement>('continuity-confirm').disabled,true);assert.match(ui.query('continuity-entry').textContent!,/干燥/);
  await ui.confirm();assert.equal(submitted.review_action,'human_review');assert.equal(submitted.changes.length,2);assert.equal(submitted.changes[0].change_id,'earlier-human-change');assert.equal(submitted.changes[1].origin,'model');assert.equal(submitted.changes[1].value,'wet');assert.equal(submitted.changes[1].story_position.change_order,1);
});
