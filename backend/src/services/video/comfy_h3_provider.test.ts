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
  let deleted = false;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    calls.push({ url, method });
    if (url.endsWith('/queue') && method === 'GET') {
      return makeJsonResponse({
        queue_running: [],
        queue_pending: deleted ? [] : [[1, 'prompt_pending', {}]]
      });
    }
    if (url.endsWith('/queue') && method === 'POST') {
      deleted = true;
      return makeJsonResponse({});
    }
    if (url.endsWith('/interrupt')) throw new Error('interrupt must not be called for pending prompt');
    return makeJsonResponse({});
  }) as typeof fetch;

  try {
    const provider = new ComfyH3Provider({ baseUrl: 'http://127.0.0.1:8188' });
    assert.equal(await provider.cancelPrompt('prompt_pending', 500), true);
    assert.equal(calls.some((call) => call.url.endsWith('/interrupt')), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ComfyH3Provider interrupts when the owned prompt is the sole running prompt', async () => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  let interrupted = false;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    calls.push({ url, method });
    if (url.endsWith('/queue') && method === 'GET') {
      return makeJsonResponse({
        queue_running: interrupted ? [] : [[1, 'prompt_running', {}]],
        queue_pending: []
      });
    }
    if (url.endsWith('/interrupt') && method === 'POST') {
      interrupted = true;
      return makeJsonResponse({});
    }
    return makeJsonResponse({});
  }) as typeof fetch;

  try {
    const provider = new ComfyH3Provider({ baseUrl: 'http://127.0.0.1:8188' });
    assert.equal(await provider.cancelPrompt('prompt_running', 500), true);
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
    if (url.endsWith('/interrupt')) throw new Error('global interrupt must not be called with multiple running prompts');
    return makeJsonResponse({});
  }) as typeof fetch;

  try {
    const provider = new ComfyH3Provider({ baseUrl: 'http://127.0.0.1:8188' });
    assert.equal(await provider.cancelPrompt('our_prompt', 500), false);
    assert.equal(calls.some((call) => call.url.endsWith('/interrupt')), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ComfyH3Provider cancellation is bounded when ComfyUI hangs', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new Error('aborted'));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }) as typeof fetch;

  try {
    const provider = new ComfyH3Provider({ baseUrl: 'http://127.0.0.1:8188' });
    const started = Date.now();
    assert.equal(await provider.cancelPrompt('prompt_hung', 50), false);
    assert.ok(Date.now() - started < 1000, 'cancelPrompt should respect its independent timeout budget');
  } finally {
    global.fetch = originalFetch;
  }
});
