import React, { act } from 'react';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../LanguageContext';
import { ToastProvider } from '../../ToastContext';
import { api } from '../../services/api';
import { DirectorWorkbenchDeck } from './DirectorWorkbenchDeck';
import type { DirectorScreenplay } from './DirectorStoryboardCandidates';

const productionView = {
  script_revision: 3,
  continuity_revision: 1,
  scenes: [
    { scene_id: 'sc_1', blocks: [], moments: [] },
    { scene_id: 'sc_2', blocks: [], moments: [] },
  ],
  entities: [],
  candidates: [],
  timeline: [],
};

function change(id: string, after: Record<string, unknown>) {
  return { id, kind: 'storyboard', candidate_revision: 1, after_json: JSON.stringify(after) };
}

function screenplay(changes: DirectorScreenplay['pendingChanges']): DirectorScreenplay {
  return { id: 7, revision: 3, status: 'confirmed', pendingChanges: changes };
}

const productionDraft = change('prod-1', { production_version: 1, shots: [] });
const directorCandidate = change('cand-1', { shots: [{ index: 1 }], totalDuration: 4 });

async function mount(t: TestContext, tasks: any[] = []) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const original = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.mock.method(api, 'getStoryboardTasks', async () => ({ tasks }));
  t.mock.method(api, 'getContinuityReview', async () => { throw Object.assign(new Error('skip'), { code: 'SKIP' }); });
  t.mock.method(api, 'getSceneProduction', async () => productionView);
  let current = screenplay([productionDraft]);
  const render = () => act(async () => {
    root.render(
      <MemoryRouter>
        <ToastProvider>
          <LanguageProvider>
            <DirectorWorkbenchDeck
              script={current}
              projectId={10}
              screenplay={current}
              sceneIds={[]}
              timelineReady
              onTimelineRefresh={() => {}}
              onScreenplayRefresh={() => {}}
            />
          </LanguageProvider>
        </ToastProvider>
      </MemoryRouter>
    );
  });
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await render();
  await act(async () => { await Promise.resolve(); });
  const query = (id: string) => dom.window.document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return {
    dom,
    query,
    render,
    setScreenplay(next: DirectorScreenplay['pendingChanges']) {
      current = screenplay(next);
    },
  };
}

test('a production draft does not count as a director candidate or steal the production tab', async (t) => {
  const ui = await mount(t);
  assert.equal(ui.query('workbench-candidate-count')?.textContent?.trim(), '(0)');
  assert.match(ui.query('workbench-candidates-shell')?.className || '', /hidden/);
  assert.match(ui.query('workbench-production-shell')?.className || '', /hidden/);

  await act(async () => ui.query('production-toggle')!.click());
  const scene = ui.query('production-scene') as HTMLSelectElement;
  assert.ok(scene);
  await act(async () => {
    scene.value = 'sc_2';
    scene.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
  });
  assert.equal(scene.value, 'sc_2');

  ui.setScreenplay([productionDraft, directorCandidate]);
  await ui.render();
  assert.equal(ui.query('workbench-candidate-count')?.textContent?.trim(), '1');
  assert.match(ui.query('workbench-production-shell')?.className || '', /^(?!.*\bhidden\b)/);
  assert.match(ui.query('workbench-candidates-shell')?.className || '', /hidden/);
  assert.equal((ui.query('production-scene') as HTMLSelectElement).value, 'sc_2');
});

test('a new director candidate opens the candidates tab when no other tab is active', async (t) => {
  const ui = await mount(t);
  ui.setScreenplay([productionDraft, directorCandidate]);
  await ui.render();
  assert.equal(ui.query('workbench-candidate-count')?.textContent?.trim(), '1');
  assert.doesNotMatch(ui.query('workbench-candidates-shell')?.className || '', /\bhidden\b/);
  assert.ok(ui.query('storyboard-candidate-panel'));
});

test('a needs_review task stays mounted and opens the candidates tab', async (t) => {
  const ui = await mount(t, [{
    task_id: 'task-1',
    status: 'failed',
    progress: {
      phase: 'needs_review',
      facts: [{ id: 'f1', scene_id: 'sc_1', block_id: 'b_1_1', text: '她推门', kind: 'uncertain', beat: 0, states: [], binding: { mentions: [] } }],
      request: { expected_revision: 3 },
      shots: {},
    },
  }]);
  assert.equal(ui.query('workbench-candidate-count')?.textContent?.trim(), '1');
  assert.doesNotMatch(ui.query('workbench-candidates-shell')?.className || '', /\bhidden\b/);
  assert.ok(ui.query('storyboard-fact-review-open-task-1'));
  await act(async () => ui.query('continuity-toggle')!.click());
  assert.match(ui.query('workbench-candidates-shell')?.className || '', /hidden/);
  assert.ok(ui.query('storyboard-fact-review-open-task-1'));
});
