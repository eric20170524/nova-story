import React, { act } from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { LanguageProvider } from '../../LanguageContext';
import { FormalShotActions, FormalStageStrip, shotMediaStage, storyboardStages } from './FormalShotActions';
import type { Scene } from '../../types';

const scene = {
  id: 9995,
  visual_prompt: 'wide',
  audio_prompt: '',
  dialogue: '',
  duration: 3,
  asset_status: 'completed',
  asset_url: '/static/kept.png',
  active_version: 1,
  shot_spec: JSON.stringify({ visible_subjects: ['南宫雪'] }),
  versions: [
    { version: 1, label: 'v1', formal_stage: 'draft', asset_url: '/static/kept.png', has_image: true },
    { version: 2, label: 'formal-candidate', formal_stage: 'production', asset_url: '/static/candidate.png', has_image: true, reference_hash: 'a'.repeat(64) },
  ],
} as Scene;

async function mount(width: number) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const original = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const calls: string[] = [];
  await act(async () => {
    root.render(
      <LanguageProvider>
        <div style={{ width }}>
          <FormalShotActions
            scene={scene}
            capabilities={[{ id: 'sdxl_ip_adapter', reason: 'offline', chain_ready: false, live_verified: false }]}
            onDraft={() => calls.push('draft')}
            onProduction={() => calls.push('production')}
            onDecide={() => calls.push('decide')}
          />
          <FormalStageStrip scene={scene} />
        </div>
      </LanguageProvider>
    );
  });
  return {
    document: dom.window.document,
    calls,
    async close() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as any)[key];
      }
    },
  };
}

test('formal and draft actions stay available at both viewport widths', async () => {
  for (const width of [390, 1280]) {
    const { document, calls, close } = await mount(width);
    const draft = document.querySelector('[data-testid="director-generate-draft"]') as HTMLButtonElement;
    const production = document.querySelector('[data-testid="director-generate-production"]') as HTMLButtonElement;
    assert.ok(draft);
    assert.ok(production);
    assert.equal(document.body.textContent?.includes('生成本版'), false);
    assert.equal(document.body.textContent?.includes('生成 16:9 关键帧'), false);
    assert.match(document.body.textContent || '', /南宫雪/);
    assert.match(document.body.textContent || '', /生图服务离线/);
    await act(async () => { production.click(); draft.click(); });
    assert.deepEqual(calls, ['production', 'draft']);
    const image = document.querySelector('[data-testid="formal-stage-strip"] img');
    assert.equal(image?.className.includes('object-contain'), true);
    assert.equal(image?.getAttribute('src'), '/static/kept.png');
    await close();
  }
  const stages = storyboardStages(scene);
  assert.equal(stages.draft?.asset_url, '/static/kept.png');
  assert.equal(stages.adopted, null);
  assert.equal(stages.candidates[0]?.asset_url, '/static/candidate.png');
  assert.equal(shotMediaStage(stages), 'candidate');
});

function setInput(view: typeof globalThis, input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new view.Event('input', { bubbles: true }));
  input.dispatchEvent(new view.Event('change', { bubbles: true }));
}

test('formal adopt stays disabled until every check and a real note are set', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const original = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const decisions: Array<{ verdict: string; checks: Record<string, boolean>; note: string }> = [];
  const render = (next: Scene = scene) => act(async () => {
    root.render(
      <LanguageProvider>
        <FormalShotActions
          scene={next}
          onDraft={() => {}}
          onProduction={() => {}}
          onDecide={(_version, verdict, checks, note) => { decisions.push({ verdict, checks, note }); }}
        />
      </LanguageProvider>
    );
  });
  await render();
  const document = dom.window.document;
  const adopt = () => document.querySelector('[data-testid="director-production-adopt"]') as HTMLButtonElement;
  const reject = () => document.querySelector('[data-testid="director-production-reject"]') as HTMLButtonElement;
  const checks = ['wardrobe', 'damage', 'count', 'holder', 'openings', 'space'];
  assert.equal(adopt().disabled, true);
  assert.equal(reject().disabled, true);
  assert.equal(checks.every((key) => document.querySelector(`[data-testid="formal-check-badge-${key}"]`)?.getAttribute('data-passed') === 'false'), true);
  assert.equal(document.body.textContent?.includes('正式图已通过参考核验'), false);
  assert.equal(document.body.textContent?.includes('默认已全部自动核验通过'), false);

  const note = document.querySelector('[data-testid="formal-review-note"]') as HTMLInputElement;
  await act(async () => setInput(dom.window as unknown as typeof globalThis, note, '衣着与持有者不符'));
  assert.equal(adopt().disabled, true);
  assert.equal(reject().disabled, false);
  await act(async () => reject().click());
  assert.equal(decisions[0].verdict, 'rejected');
  assert.equal(decisions[0].note, '衣着与持有者不符');
  assert.equal(checks.every((key) => decisions[0].checks[key] === false), true);

  for (const key of checks) {
    const box = document.querySelector(`[data-testid="formal-check-${key}"]`) as HTMLInputElement;
    await act(async () => box.click());
  }
  assert.equal(checks.every((key) => document.querySelector(`[data-testid="formal-check-badge-${key}"]`)?.getAttribute('data-passed') === 'true'), true);
  assert.equal(adopt().disabled, false);
  await act(async () => adopt().click());
  assert.equal(decisions[1].verdict, 'accepted');
  assert.equal(decisions[1].note, '衣着与持有者不符');
  assert.equal(checks.every((key) => decisions[1].checks[key] === true), true);

  const next = {
    ...scene,
    versions: scene.versions?.map((version) => version.version === 2 ? { ...version, version: 3 } : version),
  } as Scene;
  await render(next);
  assert.equal(adopt().disabled, true);
  assert.equal((document.querySelector('[data-testid="formal-review-note"]') as HTMLInputElement).value, '');
  assert.equal(checks.every((key) => (document.querySelector(`[data-testid="formal-check-${key}"]`) as HTMLInputElement).checked === false), true);

  await act(async () => root.unmount());
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as any)[key];
  }
});
