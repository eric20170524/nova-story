import React, { act } from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EntityBindingReview } from './EntityBindingReview';
import { bindEntities, entityRoster, validateBinding } from '../../backend/src/services/entity_binding';
import { createEmptyScriptDocument } from '../../backend/src/schemas/script';
import { editScriptReferences, scriptReviewCharacters } from '../../services/scriptEntityReferences';

test('核对预选已识别姓名，可选择其他出场角色并同步正文与绑定偏移', async t => {
  const characters = [{ id: 1, name: '林岚' }, { id: 2, name: '陈月' }, { id: 3, name: '赵明远' }, { id: 4, name: '未出场角色' }];
  const roster = entityRoster(characters);
  const doc = createEmptyScriptDocument();
  doc.scenes = [{ id: 's1', locationId: 'room', interiorExterior: 'interior', timeOfDay: 'day', characterIds: [1, 2], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: [] },
    { id: 's2', locationId: 'room', interiorExterior: 'interior', timeOfDay: 'day', characterIds: [3], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: [] }];
  const options = scriptReviewCharacters(doc, characters);
  assert.deepEqual(options.map(entity => entity.name), ['林岚', '陈月', '赵明远']);
  let value = { text: '林岚把蓝伞递给陈月。', binding: bindEntities('林岚把蓝伞递给陈月。', roster) };
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, entry] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value: entry, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  const render = () => root.render(<EntityBindingReview binding={value.binding} characters={options} onChange={async binding => { value = await editScriptReferences(value.text, binding); render(); }} />);
  await act(async () => render());
  let picker = dom.window.document.querySelector<HTMLSelectElement>('select')!;
  assert.equal(picker.value, 'character:1');
  assert.deepEqual([...picker.options].map(option => option.text), ['待核对', '林岚', '陈月', '赵明远']);
  assert.ok(!dom.window.document.body.textContent!.includes('（待核对）'));
  await act(async () => { picker.value = 'character:3'; picker.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal(value.text, '赵明远把蓝伞递给陈月。');
  assert.equal(value.binding.mentions[0]!.authority, 'human');
  assert.equal(value.binding.mentions[1]!.start, '赵明远把蓝伞递给'.length);
  validateBinding(value.binding, value.text, roster);
  picker = dom.window.document.querySelector<HTMLSelectElement>('select')!;
  assert.equal(picker.value, 'character:3');
});
