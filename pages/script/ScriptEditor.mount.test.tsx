import React, { act } from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LanguageProvider } from '../../LanguageContext';
import { ToastProvider } from '../../ToastContext';
import { ProjectAgentProvider } from '../../contexts/ProjectAgentContext';
import { createEmptyScriptDocument } from '../../backend/src/schemas/script';

test('剧本页挂上章节和待审提纲，脏稿时拒绝生成候选，分镜候选不进审核条', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/project/1/script' });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, entry] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value: entry, configurable: true, writable: true });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/script')
      ? {
          exists: true,
          script: {
            id: 9,
            chapterId: 'ch1',
            projectId: 1,
            revision: 2,
            status: 'draft',
            document: createEmptyScriptDocument('测试剧本'),
            freshness: { sourceChanged: false },
            pendingChanges: [
              {
                id: 'cand-outline-1',
                script_id: 9,
                kind: 'outline',
                base_revision: 1,
                candidate_revision: 3,
                request_key: 'req-1',
                state: 'pending',
                before_json: null,
                after_json: JSON.stringify({ logline: '雨夜重逢', mustKeepEvents: [{ id: 'e1' }], beats: [], endingHook: '门开了' }),
                source_snapshot_json: null,
                generation_info_json: null,
                applied_revision: null,
                result_json: null,
                created_at: '',
                updated_at: '',
              },
              {
                id: 'cand-board-1',
                script_id: 9,
                kind: 'storyboard',
                base_revision: 1,
                candidate_revision: 1,
                request_key: 'req-2',
                state: 'pending',
                before_json: null,
                after_json: JSON.stringify({ marker: '分镜候选标记' }),
                source_snapshot_json: null,
                generation_info_json: null,
                applied_revision: null,
                result_json: null,
                created_at: '',
                updated_at: '',
              },
            ],
          },
        }
      : url.includes('/characters/')
        ? []
        : [{ id: 'ch1', index: 1, title: '开场', content: '小说正文', status: 'draft' }];
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  const { createRoot } = await import('react-dom/client');
  const { ScriptEditor } = await import('../ScriptEditor');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  await act(async () => {
    root.render(
      <LanguageProvider>
        <ToastProvider>
          <ProjectAgentProvider projectId="1">
            <MemoryRouter initialEntries={['/project/1/script']}>
              <Routes>
                <Route path="/project/:id/script" element={<ScriptEditor />} />
              </Routes>
            </MemoryRouter>
          </ProjectAgentProvider>
        </ToastProvider>
      </LanguageProvider>
    );
    await new Promise(resolve => setTimeout(resolve, 40));
  });

  const text = dom.window.document.body.textContent || '';
  const title = dom.window.document.querySelector('input');
  assert.match(text, /剧本章节列表/);
  assert.match(text, /第 1 章 开场/);
  assert.equal(title?.value, '测试剧本');
  assert.match(text, /雨夜重逢/);
  assert.equal(text.includes('分镜候选标记'), false);
  const outlineButton = dom.window.document.querySelector<HTMLButtonElement>('[data-testid="script-generate-outline"]');
  assert.ok(outlineButton);
  assert.ok(dom.window.document.querySelector('[data-testid="script-generate-full"]'));

  const addScene = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent?.includes('添加分场'));
  assert.ok(addScene);
  await act(async () => {
    addScene!.click();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  assert.match(dom.window.document.body.innerHTML, /有未保存修改/);
  assert.equal(dom.window.document.querySelector('button[title="保存草稿"]')?.hasAttribute('disabled'), false);

  await act(async () => {
    outlineButton!.click();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  assert.match(dom.window.document.body.textContent || '', /请先保存当前未保存的修改，再生成候选/);
});
