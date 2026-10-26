import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComfyUIService, applyRemoteLoraCatalog, comfyDownloadShouldRetry, comfyHistoryFailure, comfyPromptGiveUp, comfySocketDropShouldFinish, loraNamesFromObjectInfo, resolveComfyReferenceFile } from './comfyui_service';
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

test('a failed ComfyUI history row keeps the node error', () => {
  assert.equal(comfyHistoryFailure(null), null);
  assert.equal(comfyHistoryFailure({ status: { status_str: 'success', messages: [] } }), null);
  assert.match(comfyHistoryFailure({
    status: {
      status_str: 'error',
      messages: [['execution_error', { node_type: 'LoraLoader', exception_message: "Value not in list: lora_name: 'Pony_DetailV2.0.safetensors' not in []" }]],
    },
  }) || '', /LoraLoader.*Pony_DetailV2\.0/);
  assert.deepEqual(loraNamesFromObjectInfo({ LoraLoader: { input: { required: { lora_name: [['H3_Combat_V2.safetensors']] } } } }), ['H3_Combat_V2.safetensors']);
});

test('remote LoRA catalog is attached for every image compile caller', async () => {
  const local = await applyRemoteLoraCatalog(
    { comfyui: { pony_lora: 'Pony_DetailV2.0.safetensors' } },
    { isRemote: false, authenticatedFetch: async () => { throw new Error('fetch must not be called'); } }
  );
  assert.equal(local.comfyui.remote_lora_names, undefined);

  const remote = await applyRemoteLoraCatalog(
    { comfyui: { pony_lora: 'Pony_DetailV2.0.safetensors' } },
    {
      isRemote: true,
      authenticatedFetch: async () => jsonResponse({
        LoraLoader: { input: { required: { lora_name: [['H3_Combat_V2.safetensors']] } } },
        UNETLoader: { input: { required: { unet_name: [['qwen_image_2.1_bf16.safetensors']] } } },
        CLIPLoader: { input: { required: { clip_name: [['qwen3vl_8b_bf16.safetensors']] } } },
        VAELoader: { input: { required: { vae_name: [['qwen_image_2.1_vae_bf16.safetensors']] } } },
      }),
    }
  );
  assert.deepEqual(remote.comfyui.remote_lora_names, ['H3_Combat_V2.safetensors']);
  assert.deepEqual(remote.comfyui.remote_unet_names, ['qwen_image_2.1_bf16.safetensors']);
  assert.deepEqual(remote.comfyui.remote_clip_names, ['qwen3vl_8b_bf16.safetensors']);
  assert.deepEqual(remote.comfyui.remote_vae_names, ['qwen_image_2.1_vae_bf16.safetensors']);
  assert.deepEqual(remote.comfyui.remote_node_names, ['LoraLoader', 'UNETLoader', 'CLIPLoader', 'VAELoader']);
});

test('a dropped websocket keeps polling while the prompt is still active', () => {
  assert.equal(comfySocketDropShouldFinish(false), false);
  assert.equal(comfySocketDropShouldFinish(true), true);
});

test('ComfyUI image download retries a dropped connection', () => {
    assert.equal(comfyDownloadShouldRetry(null, 'TypeError: terminated', 1), true);
    assert.equal(comfyDownloadShouldRetry(525, '', 2), true);
    assert.equal(comfyDownloadShouldRetry(403, 'Upload image through this account first', 1), false);
    assert.equal(comfyDownloadShouldRetry(null, 'TypeError: terminated', 3), false);
});

test('ComfyUI prompt retries only an empty gateway timeout', () => {
  assert.equal(comfyPromptGiveUp(525, 1), false);
  assert.equal(comfyPromptGiveUp(522, 2), false);
  assert.equal(comfyPromptGiveUp(524, 3), true);
  assert.equal(comfyPromptGiveUp(400, 1), true);
  assert.equal(comfyPromptGiveUp(500, 1), true);
});

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
        SettingsManager.saveSettings({
            comfyui: {
                remote_password: 'mock_password_123'
            }
        });

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

test('resolveComfyReferenceFile finds a plate stored under static/generated', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-ref-'));
    const nested = path.join(root, 'generated', 'projects', '90713821', 'assets', '66', 'v2');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'plate.png'), 'png');
    assert.equal(resolveComfyReferenceFile(root, 'plate.png'), path.join(nested, 'plate.png'));
    fs.rmSync(root, { recursive: true, force: true });
});

test('ComfyUIService uploadWorkflowReferences uploads a nested reference', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-upload-'));
    const nested = path.join(root, 'generated', 'projects', 'x');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'plate.png'), 'png-bytes');
    const service = ComfyUIService.fromSettings({
        mode: 'remote',
        remote_base_url: 'https://comfy.example.com',
        remote_username: '',
        remote_password: ''
    });
    let uploaded = '';
    service.uploadImage = async (_buffer: Buffer, filename: string) => {
        uploaded = filename;
        return 'remote-plate.png';
    };
    const workflow = {
        '1': { class_type: 'LoadImage', inputs: { image: 'plate.png' } }
    };
    const res = await service.uploadWorkflowReferences(workflow, root);
    assert.equal(uploaded, 'plate.png');
    assert.equal(res['1'].inputs.image, 'remote-plate.png');
    fs.rmSync(root, { recursive: true, force: true });
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

test('ComfyUIService uploadWorkflowReferences maps multi-image slots to images.image_N for TextEncodeQwenImage21', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-upload-multi-'));
    fs.writeFileSync(path.join(root, 'ref1.png'), 'bytes1');
    fs.writeFileSync(path.join(root, 'ref2.png'), 'bytes2');
    fs.writeFileSync(path.join(root, 'ref3.png'), 'bytes3');

    const service = ComfyUIService.fromSettings({
        mode: 'remote',
        remote_base_url: 'https://comfy.example.com',
        remote_username: '',
        remote_password: ''
    });
    service.uploadImage = async (_buffer: Buffer, filename: string) => `remote_${filename}`;

    const workflow = {
        '1': { class_type: 'LoadImage', inputs: { image: 'ref1.png' } },
        '2': { class_type: 'LoadImage', inputs: { image: 'ref2.png' } },
        '3': { class_type: 'LoadImage', inputs: { image: 'ref3.png' } },
        '4': {
            class_type: 'TextEncodeQwenImage21',
            inputs: {
                prompt: 'test prompt',
                image_1: ['1', 0],
                image_2: ['2', 0],
                image_3: ['3', 0],
            }
        }
    };

    const res = await service.uploadWorkflowReferences(workflow, root);
    assert.equal(res['1'].inputs.image, 'remote_ref1.png');
    assert.equal(res['2'].inputs.image, 'remote_ref2.png');
    assert.equal(res['3'].inputs.image, 'remote_ref3.png');
    assert.deepEqual(res['4'].inputs['images.image_1'], ['1', 0]);
    assert.deepEqual(res['4'].inputs['images.image_2'], ['2', 0]);
    assert.deepEqual(res['4'].inputs['images.image_3'], ['3', 0]);
    assert.equal(res['4'].inputs.image_1, undefined);
    assert.equal(res['4'].inputs.image_2, undefined);
    assert.equal(res['4'].inputs.image_3, undefined);

    fs.rmSync(root, { recursive: true, force: true });
});
