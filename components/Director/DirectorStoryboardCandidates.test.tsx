import React, { act } from 'react';
import assert from 'node:assert/strict';
import test, { TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { LanguageProvider } from '../../LanguageContext';
import { ToastProvider } from '../../ToastContext';
import { api } from '../../services/api';
import { DirectorStoryboardCandidates, type DirectorScreenplay } from './DirectorStoryboardCandidates';

function longShot(index: number) {
  return {
    index,
    shot_type: 'Medium Shot',
    shot_spec: JSON.stringify({ shot_intent: 'hold' }),
    script_scene_id: index,
    duration: 4,
    location: '殿前石阶',
    primary_action: `第${index}镜的可见动作`.repeat(24),
    dialogue: index % 2 === 0 ? `对白${index}`.repeat(20) : '',
    narration: '',
    audio_prompt: `风声${index}`,
  };
}

function screenplay(shotCount: number): DirectorScreenplay {
  const shots = Array.from({ length: shotCount }, (_, index) => longShot(index + 1));
  return {
    id: 7,
    revision: 3,
    status: 'confirmed',
    pendingChanges: [{
      id: 'cand-scroll-1',
      kind: 'storyboard',
      candidate_revision: 2,
      after_json: JSON.stringify({
        shots,
        totalDuration: shotCount * 4,
        estimatedScriptDuration: 90,
        coverageReport: {
          coveredSceneIds: [1],
          totalScenes: 1,
          coveredBlockIds: [],
          totalAudibleBlocks: 0,
          coveredMustKeepEventIds: [],
          totalMustKeepEvents: 0,
        },
      }),
    }],
  };
}

async function mount(t: TestContext, shotCount = 12, tasks: any[] = []) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originalDescriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.mock.method(api, 'getStoryboardTasks', async () => ({ tasks }));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  await act(async () => {
    root.render(
      <ToastProvider>
        <LanguageProvider>
          <DirectorStoryboardCandidates
            script={screenplay(shotCount)}
            sceneIds={[]}
            timelineReady
            onApplied={() => {}}
            onScriptChanged={() => {}}
          />
        </LanguageProvider>
      </ToastProvider>
    );
  });

  return dom;
}

test('storyboard candidate review scrolls in one panel and keeps adopt actions reachable', async (t) => {
  const dom = await mount(t);
  const document = dom.window.document;
  const panel = document.querySelector<HTMLElement>('[data-testid="storyboard-candidate-panel"]')!;
  const scroll = document.querySelector<HTMLElement>('[data-testid="storyboard-candidate-scroll"]')!;
  assert.ok(panel);
  assert.match(panel.className, /min-h-0/);
  assert.match(panel.className, /max-h-\[min\(52dvh,36rem\)\]/);
  assert.match(panel.className, /overflow-hidden/);
  assert.match(scroll.className, /overflow-y-auto/);
  assert.match(scroll.className, /min-h-0/);
  assert.equal(panel.contains(scroll), true);

  const view = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('查看详情'));
  assert.ok(view);
  await act(async () => view.click());

  assert.match(scroll.textContent || '', /镜头 #12/);
  assert.equal(scroll.querySelector('.max-h-80'), null);
  assert.equal([...scroll.querySelectorAll('div')].some((node) => node.className.includes('max-h-80')), false);
  const adopt = document.querySelector<HTMLButtonElement>('[data-testid="storyboard-adopt-cand-scroll-1"]')!;
  assert.equal(scroll.contains(adopt), true);
});

test('adopt confirmation scrolls the shot list and keeps the actions outside that scroller', async (t) => {
  const dom = await mount(t);
  const document = dom.window.document;
  const adopt = document.querySelector<HTMLButtonElement>('[data-testid="storyboard-adopt-cand-scroll-1"]')!;
  await act(async () => adopt.click());

  const dialog = document.body.querySelector<HTMLElement>('[data-testid="storyboard-adopt-confirm"]')!;
  const body = document.body.querySelector<HTMLElement>('[data-testid="storyboard-adopt-confirm-body"]')!;
  const actions = document.body.querySelector<HTMLElement>('[data-testid="storyboard-adopt-confirm-actions"]')!;
  assert.ok(dialog);
  assert.equal(document.getElementById('root')!.contains(dialog), false);
  assert.match(dialog.className, /overflow-y-auto/);
  assert.match(body.className, /overflow-y-auto/);
  assert.match(body.className, /max-h-\[min\(32rem,calc\(100dvh-13rem\)\)\]/);
  assert.match(body.textContent || '', /镜头 #1/);
  assert.match(body.textContent || '', /镜头 #12/);
  assert.equal(body.contains(actions), false);
  assert.equal(actions.contains(document.querySelector('[data-testid="storyboard-adopt-confirm-submit"]')), true);
  assert.equal(document.body.style.overflow, 'hidden');

  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(document.body.querySelector('[data-testid="storyboard-adopt-confirm"]'), null);
  assert.equal(document.body.style.overflow, '');
});

test('fact review opens a dialog on the saved sentences and lines up sequence numbers', async (t) => {
  const tasks = [{
    task_id: 'task-facts',
    status: 'failed',
    error: '事实节拍乱序: action_1',
    progress: {
      phase: 'failed',
      error: '事实节拍乱序: action_1',
      input_hash: 'hash',
      facts: [
        { id: 'lamp', scene_id: 's1', block_id: 'action_0', text: '灯六。', kind: 'visual', beat: 5, states: [] },
        { id: 'bell', scene_id: 's1', block_id: 'action_1', text: '钟声响起。', kind: 'audio', beat: 6, states: [] },
        { id: 'stand', scene_id: 's1', block_id: 'action_1', text: '阿岚仍站在原地。', kind: 'visual', beat: 5, states: [] },
      ],
      shots: {},
      request: { expected_revision: 3 },
    },
  }];
  const dom = await mount(t, 1, tasks);
  const document = dom.window.document;
  let open: HTMLButtonElement | null = null;
  for (let attempt = 0; attempt < 10 && !open; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    open = document.querySelector<HTMLButtonElement>('[data-testid="storyboard-fact-review-open-task-facts"]');
  }
  assert.ok(open);
  const scroll = document.querySelector<HTMLElement>('[data-testid="storyboard-candidate-scroll"]')!;
  assert.equal(scroll.contains(open), true);
  await act(async () => open!.click());

  const dialog = document.body.querySelector<HTMLElement>('[data-testid="storyboard-fact-review"]')!;
  const body = document.body.querySelector<HTMLElement>('[data-testid="storyboard-fact-review-body"]')!;
  const actions = document.body.querySelector<HTMLElement>('[data-testid="storyboard-fact-review-actions"]')!;
  assert.ok(dialog);
  assert.equal(document.getElementById('root')!.contains(dialog), false);
  assert.equal(scroll.contains(dialog), false);
  assert.match(body.textContent || '', /钟声响起。/);
  assert.match(body.textContent || '', /阿岚仍站在原地。/);
  assert.match(body.className, /overflow-y-auto/);
  assert.equal(body.contains(actions), false);
  assert.deepEqual(
    [0, 1, 2].map((index) => document.querySelector<HTMLInputElement>(`[data-testid="storyboard-fact-review-beat-${index}"]`)!.value),
    ['5', '5', '5'],
  );
  assert.equal(document.body.style.overflow, 'hidden');

  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(document.body.querySelector('[data-testid="storyboard-fact-review"]'), null);
  assert.equal(document.body.style.overflow, '');
});
