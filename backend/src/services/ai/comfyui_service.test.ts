import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ComfyUIService } from './comfyui_service';
import { GpuLeaseService } from '../gpu_lease_service';
import { SettingsManager } from '../../core/settings_manager';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

const withMockFetch = async (
  mock: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>
) => {
  const original = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
    GpuLeaseService.resetForTesting();
  }
};

test('image cancel without prompt id fails closed and never calls ComfyUI', async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    throw new Error('fetch must not be called');
  }, async () => {
    const service = new ComfyUIService('http://127.0.0.1:8188');
    const result = await service.cancelExecution();
    assert.equal(result.ok, false);
    assert.equal(result.interrupted, false);
    assert.match(result.message, /prompt_id is required/);
    assert.equal(calls, 0);
  });
});

test('pending image prompt is queue-deleted without global interrupt', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let queueReads = 0;

  await withMockFetch(async (input, init) => {
    const url = String(input);
    const method = String(init?.method || 'GET');
    calls.push({ url, method });

    if (url.endsWith('/queue') && method === 'GET') {
      queueReads += 1;
      return queueReads === 1
        ? jsonResponse({ queue_running: [], queue_pending: [[1, 'image_pending']] })
        : jsonResponse({ queue_running: [], queue_pending: [] });
    }
    if (url.endsWith('/queue') && method === 'POST') {
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  }, async () => {
    const service = new ComfyUIService('http://127.0.0.1:8188');
    const result = await service.cancelExecution('image_pending', 2000);
    assert.equal(result.ok, true);
    assert.equal(result.deleted_from_queue, true);
    assert.equal(result.interrupted, false);
    assert.equal(calls.some((call) => call.url.endsWith('/interrupt')), false);
  });
});

test('sole running image prompt may use global interrupt after ownership check', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let queueReads = 0;

  await withMockFetch(async (input, init) => {
    const url = String(input);
    const method = String(init?.method || 'GET');
    calls.push({ url, method });

    if (url.endsWith('/queue') && method === 'GET') {
      queueReads += 1;
      return queueReads === 1
        ? jsonResponse({ queue_running: [[1, 'image_running']], queue_pending: [] })
        : jsonResponse({ queue_running: [], queue_pending: [] });
    }
    if (url.endsWith('/interrupt') && method === 'POST') {
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  }, async () => {
    const service = new ComfyUIService('http://127.0.0.1:8188');
    const result = await service.cancelExecution('image_running', 2000);
    assert.equal(result.ok, true);
    assert.equal(result.interrupted, true);
    assert.equal(calls.filter((call) => call.url.endsWith('/interrupt')).length, 1);
  });
});

test('image cancel refuses global interrupt when multiple prompts are reported running', async () => {
  const calls: Array<{ url: string; method: string }> = [];

  await withMockFetch(async (input, init) => {
    const url = String(input);
    const method = String(init?.method || 'GET');
    calls.push({ url, method });

    if (url.endsWith('/queue') && method === 'GET') {
      return jsonResponse({
        queue_running: [[1, 'image_target'], [2, 'h3_other']],
        queue_pending: []
      });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  }, async () => {
    const service = new ComfyUIService('http://127.0.0.1:8188');
    const result = await service.cancelExecution('image_target', 2000);
    assert.equal(result.ok, false);
    assert.equal(result.interrupted, false);
    assert.match(result.message, /Refusing global interrupt/);
    assert.equal(calls.some((call) => call.url.endsWith('/interrupt')), false);
  });
});

test('already absent image prompt is idempotently confirmed without interrupt', async () => {
  const calls: Array<{ url: string; method: string }> = [];

  await withMockFetch(async (input, init) => {
    const url = String(input);
    const method = String(init?.method || 'GET');
    calls.push({ url, method });
    if (url.endsWith('/queue') && method === 'GET') {
      return jsonResponse({ queue_running: [], queue_pending: [] });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  }, async () => {
    const service = new ComfyUIService('http://127.0.0.1:8188');
    const result = await service.cancelExecution('already_done', 2000);
    assert.equal(result.ok, true);
    assert.equal(result.interrupted, false);
    assert.equal(result.deleted_from_queue, false);
    assert.equal(calls.some((call) => call.url.endsWith('/interrupt')), false);
  });
});

test('ComfyUIService.fromSettings correctly resolves local mode', () => {
    const service = ComfyUIService.fromSettings({
        mode: 'local',
        local_base_url: 'http://127.0.0.1:8188',
        remote_base_url: 'https://comfy.example.com',
        remote_username: 'mock_user',
        remote_password: 'mock_password'
    });

    assert.equal(service.isRemote, false);
    assert.equal(service.baseUrl, 'http://127.0.0.1:8188');
});

test('ComfyUIService.fromSettings correctly resolves remote mode', () => {
    const service = ComfyUIService.fromSettings({
        mode: 'remote',
        local_base_url: 'http://127.0.0.1:8188',
        remote_base_url: 'https://comfy.example.com',
        remote_username: 'mock_user',
        remote_password: 'mock_password_123'
    });

    assert.equal(service.isRemote, true);
    assert.equal(service.baseUrl, 'https://comfy.example.com');
});

test('SettingsManager masks remote_password in toPublicSettings and preserves on save', () => {
    const original = {
        comfyui: {
            mode: 'remote',
            base_url: 'https://comfy.example.com',
            remote_base_url: 'https://comfy.example.com',
            remote_username: 'mock_user',
            remote_password: 'mock_password_123'
        }
    };

    const publicView = SettingsManager.toPublicSettings(original);
    assert.equal(publicView.comfyui.has_remote_password, true);
    assert.equal(publicView.comfyui.remote_password, '');

    const envPath = SettingsManager.getEnvPath();
    const settingsPath = SettingsManager.getFilePath();
    const originalEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : null;
    const originalSettings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf-8') : null;

    try {
        const saved = SettingsManager.saveSettings({
            comfyui: {
                mode: 'remote',
                remote_base_url: 'https://comfy.example.com',
                remote_username: 'mock_user',
                remote_password: ''
            }
        });

        assert.equal(saved.comfyui.has_remote_password, true);
        assert.equal(saved.comfyui.mode, 'remote');
        assert.equal(saved.comfyui.base_url, 'https://comfy.example.com');
    } finally {
        if (originalEnv !== null) {
            fs.writeFileSync(envPath, originalEnv, 'utf-8');
        }
        if (originalSettings !== null) {
            fs.writeFileSync(settingsPath, originalSettings, 'utf-8');
        }
    }
});

test('ComfyUIService uploadWorkflowReferences leaves local workflow intact', async () => {
    const service = ComfyUIService.fromSettings({ mode: 'local' });
    const workflow = {
        '1': {
            class_type: 'LoadImage',
            inputs: { image: 'test.png' }
        }
    };

    const res = await service.uploadWorkflowReferences(workflow, '/tmp');
    assert.equal(res['1'].inputs.image, 'test.png');
});
