import React, { act, useState } from 'react';
import assert from 'node:assert/strict';
import test, { TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { LanguageProvider } from '../../LanguageContext';
import { ToastProvider } from '../../ToastContext';
import { api } from '../../services/api';
import { Character } from '../../types';
import { CharacterEditModal } from './CharacterEditModal';

async function mountModal(t: TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = {
    window: dom.window, document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originalDescriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const requests: { voiceId: string; signal?: AbortSignal; resolve: (blob: Blob) => void }[] = [];
  const voices = ['K01', 'K02'].map(id => ({
    id, name: id, gender: 'female', style: '轻量', locale: 'zh', description: '',
    tier: 'light' as const, offline: true, provider: 'local',
  }));
  t.mock.method(api, 'getTtsStatus', async () => ({ ok: true, enabled: true, base_url: '', voice_count: 2 }));
  t.mock.method(api, 'getTtsVoices', async () => voices);
  t.mock.method(api, 'previewTts', (voiceId: string, _text?: string, signal?: AbortSignal) =>
    new Promise<Blob>(resolve => requests.push({ voiceId, signal, resolve })));

  const audios: { play: () => Promise<void>; pause: () => void; paused: boolean }[] = [];
  class FakeAudio {
    paused = false;
    onended = null;
    onerror = null;
    constructor(_url: string) { audios.push(this); }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
  }
  const oldAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  Object.defineProperty(globalThis, 'Audio', { value: FakeAudio, configurable: true });
  t.after(() => {
    if (oldAudio) Object.defineProperty(globalThis, 'Audio', oldAudio);
    else Reflect.deleteProperty(globalThis, 'Audio');
  });
  let urls = 0;
  t.mock.method(URL, 'createObjectURL', () => `blob:preview-${++urls}`);
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});

  let updateCharacter!: React.Dispatch<React.SetStateAction<Partial<Character>>>;
  function Harness() {
    const [character, setCharacter] = useState<Partial<Character>>({ id: 1, name: '林川', voice_id: 'K01' });
    updateCharacter = setCharacter;
    return <ToastProvider><LanguageProvider><CharacterEditModal
      isOpen editingChar={character} setEditingChar={setCharacter}
      onClose={() => {}} onSave={() => {}} onUploadAsset={() => {}}
    /></LanguageProvider></ToastProvider>;
  }
  await act(async () => root.render(<Harness />));
  const select = dom.window.document.querySelector<HTMLSelectElement>('[data-testid="character-voice-select"]')!;
  const preview = dom.window.document.querySelector<HTMLButtonElement>('[data-testid="character-voice-preview"]')!;
  const choose = async (voiceId: string) => act(async () => {
    select.value = voiceId;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const clickPreview = async () => act(async () => preview.click());
  const resolvePreview = async (index: number) => act(async () => requests[index].resolve(new Blob(['mp3'])));
  return { requests, audios, revoke, select, preview, choose, clickPreview, resolvePreview, updateCharacter };
}

test('changing voice aborts pending preview and ignores a late response', async t => {
  const fixture = await mountModal(t);
  await fixture.clickPreview();
  assert.equal(fixture.preview.disabled, true);
  await fixture.choose('K02');
  assert.equal(fixture.requests[0].signal?.aborted, true);
  assert.equal(fixture.preview.disabled, false);
  await fixture.resolvePreview(0);
  assert.equal(fixture.audios.length, 0, 'Old audio must never start after selection changes');
  await fixture.clickPreview();
  assert.equal(fixture.requests[1].voiceId, 'K02');
  await fixture.resolvePreview(1);
  assert.equal(fixture.audios.length, 1);
});

test('changing or clearing voice pauses playing audio and releases its object URL', async t => {
  const fixture = await mountModal(t);
  await fixture.clickPreview();
  await fixture.resolvePreview(0);
  await fixture.choose('K02');
  assert.equal(fixture.audios[0].paused, true);
  assert.equal(fixture.revoke.mock.calls[0].arguments[0], 'blob:preview-1');
  assert.equal(fixture.preview.disabled, false);
  await fixture.clickPreview();
  await fixture.resolvePreview(1);
  await fixture.choose('');
  assert.equal(fixture.audios[1].paused, true);
  assert.equal(fixture.revoke.mock.calls[1].arguments[0], 'blob:preview-2');
  assert.equal(fixture.preview.disabled, true);
});

test('parent changing the edited character invalidates its pending preview', async t => {
  const fixture = await mountModal(t);
  await fixture.clickPreview();
  await act(async () => fixture.updateCharacter({ id: 2, voice_id: 'K01' }));
  assert.equal(fixture.requests[0].signal?.aborted, true);
  await fixture.resolvePreview(0);
  assert.equal(fixture.audios.length, 0);
  assert.equal(fixture.preview.disabled, false);
});
