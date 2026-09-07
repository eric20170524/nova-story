import test from 'node:test';
import assert from 'node:assert/strict';
import { ComfyH3Provider } from './comfy_h3_provider';

const makeJsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });

test('ComfyH3Provider removes a pending prompt without global interrupt', async () => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    calls.push({ url, method });
    if (url.endsWith('/queue') && method === 'GET') {
      return makeJsonResponse({ queue_running: [], queue_pending: [[1, 'prompt_pending', {}]] });
    }
    if (url.endsWith('/queue') && method === 'POST') return makeJsonResponse({});
    if (url.endsWith('/interrupt')) throw new Error('interrupt must not be called for pending prompt');
    return makeJsonResponse({});
  }) as typeof fetch;

  try {
    const provider = new ComfyH3Provider({ baseUrl: 'http://127.0.0.1:8188' });
    assert.equal(await provider.cancelPrompt('prompt_pending'), true);
    assert.equal(calls.some((call) => call.url.endsWith('/interrupt')), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ComfyH3Provider interrupts when the owned prompt is the sole running prompt', async () => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    calls.push({ url, method });
    if (url.endsWith('/queue') && method === 'GET') {
      return makeJsonResponse({ queue_running: [[1, 'prompt_running', {}]], queue_pending: [] });
    }
    if (url.endsWith('/queue') && method === 'POST') return makeJsonResponse({});
    if (url.endsWith('/interrupt') && method === 'POST') return makeJsonResponse({});
    return makeJsonResponse({});
  }) as typeof fetch;

  try {
    const provider = new ComfyH3Provider({ baseUrl: 'http://127.0.0.1:8188' });
    assert.equal(await provider.cancelPrompt('prompt_running'), true);
    assert.equal(calls.filter((call) => call.url.endsWith('/interrupt')).length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ComfyH3Provider refuses a global interrupt when multiple prompts are reported running', async () => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    calls.push({ url, method });
    if (url.endsWith('/queue') && method === 'GET') {
      return makeJsonResponse({
        queue_running: [[1, 'our_prompt', {}], [2, 'foreign_prompt', {}]],
        queue_pending: []
      });
    }
    if (url.endsWith('/queue') && method === 'POST') return makeJsonResponse({});
    if (url.endsWith('/interrupt')) throw new Error('global interrupt must not be called with multiple running prompts');
    return makeJsonResponse({});
  }) as typeof fetch;

  try {
    const provider = new ComfyH3Provider({ baseUrl: 'http://127.0.0.1:8188' });
    assert.equal(await provider.cancelPrompt('our_prompt'), false);
    assert.equal(calls.some((call) => call.url.endsWith('/interrupt')), false);
  } finally {
    global.fetch = originalFetch;
  }
});
