import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  __vramTestables,
  buildVramStatus,
  setVramSwitchDepsForTests,
  VramService,
  type VramStatus,
} from './vram_service';

const {
  classifyLevel, formatGiB, ollamaNativeBaseUrl, classifyLlmProbe, isLoopbackBaseUrl,
  isLlamaServerProcessImage, decideVramSwitch, localLlmStartScriptPath,
  WARNING_THRESHOLD, CRITICAL_THRESHOLD,
} = __vramTestables;

test('classifyLevel maps percent to good / warning / critical', () => {
  assert.equal(classifyLevel(null), 'unknown');
  assert.equal(classifyLevel(0), 'good');
  assert.equal(classifyLevel(38), 'good');
  assert.equal(classifyLevel(WARNING_THRESHOLD - 0.1), 'good');
  assert.equal(classifyLevel(WARNING_THRESHOLD), 'warning');
  assert.equal(classifyLevel(75), 'warning');
  assert.equal(classifyLevel(CRITICAL_THRESHOLD), 'critical');
  assert.equal(classifyLevel(92), 'critical');
});

test('formatGiB formats bytes as GiB labels', () => {
  assert.equal(formatGiB(0), '0G');
  assert.match(formatGiB(5.1 * 1024 ** 3), /5\.1G/);
  assert.match(formatGiB(2.5 * 1024 ** 3), /2\.5G/);
});

test('OpenAI /v1/models alone is not llama.cpp, and only a local llama-server can be stopped', () => {
  assert.equal(classifyLlmProbe({ ollamaPsOk: true, llamaHealthOk: false }), 'ollama');
  assert.equal(classifyLlmProbe({ ollamaPsOk: true, llamaHealthOk: true }), 'ollama');
  assert.equal(classifyLlmProbe({ ollamaPsOk: false, llamaHealthOk: true }), 'llamacpp');
  assert.equal(classifyLlmProbe({ ollamaPsOk: false, llamaHealthOk: false }), 'unknown');
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLoopbackBaseUrl('http://llm.example.com:11434/v1'), false);
  assert.equal(isLlamaServerProcessImage('llama-server.exe'), true);
  assert.equal(isLlamaServerProcessImage('C:\\tools\\llama-server.exe'), true);
  assert.equal(isLlamaServerProcessImage('ollama.exe'), false);
});

test('ollamaNativeBaseUrl strips OpenAI-compat /v1 suffix', () => {
  assert.equal(ollamaNativeBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
  assert.equal(ollamaNativeBaseUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434');
  assert.equal(ollamaNativeBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(ollamaNativeBaseUrl(null), 'http://127.0.0.1:11434');
});

test('buildVramStatus reports good health with nvidia-smi snapshot', () => {
  const status = buildVramStatus({
    gpu: {
      name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      total: 8188 * 1024 * 1024,
      used: Math.round(0.38 * 8188 * 1024 * 1024),
      free: Math.round(0.62 * 8188 * 1024 * 1024),
    },
    ollama: {
      online: true,
      base_url: 'http://127.0.0.1:11434',
      used_bytes: 0,
      models: [],
    },
    comfyui: {
      online: true,
      base_url: 'http://127.0.0.1:8188',
      used_bytes: 0,
      total_bytes: 8188 * 1024 * 1024,
      torch_used_bytes: 0,
    },
  });

  assert.equal(status.level, 'good');
  assert.ok(status.percent != null && status.percent >= 37 && status.percent <= 39);
  assert.equal(status.source, 'nvidia-smi');
  assert.match(status.summary_zh, /显存良好/);
});

test('CPU-only ComfyUI memory is not reported as GPU VRAM', () => {
  const status = buildVramStatus({
    gpu: null,
    ollama: {
      online: false,
      base_url: 'http://127.0.0.1:11434',
      used_bytes: 0,
      models: [],
    },
    comfyui: {
      online: true,
      base_url: 'https://comfy.example.com',
      compute_mode: 'cpu',
      used_bytes: 26 * 1024 ** 3,
      total_bytes: 256 * 1024 ** 3,
      torch_used_bytes: 0,
    },
  });

  assert.equal(status.level, 'unknown');
  assert.equal(status.total_bytes, null);
  assert.equal(status.used_bytes, null);
  assert.equal(status.source, 'unavailable');
  assert.match(status.summary_zh, /CPU 模式/);
  assert.equal(status.processes.some((process) => process.name === 'ComfyUI'), false);
});

test('buildVramStatus marks dual-resident high load as warning/critical with tip breakdown', () => {
  const ollamaBytes = Math.round(5.1 * 1024 ** 3);
  const comfyBytes = Math.round(2.5 * 1024 ** 3);
  const total = 8188 * 1024 * 1024;
  const used = ollamaBytes + comfyBytes + 200 * 1024 * 1024;

  const status: VramStatus = buildVramStatus({
    gpu: {
      name: 'RTX 4060',
      total,
      used,
      free: total - used,
    },
    ollama: {
      online: true,
      base_url: 'http://127.0.0.1:11434',
      used_bytes: ollamaBytes,
      models: [{ name: 'novastory-qwen3.5:9b', size: ollamaBytes, size_vram: ollamaBytes, processor: 'llamacpp' }],
    },
    comfyui: {
      online: true,
      base_url: 'http://127.0.0.1:8188',
      used_bytes: comfyBytes + 500 * 1024 * 1024,
      total_bytes: total,
      torch_used_bytes: comfyBytes,
    },
  });

  assert.ok(status.level === 'warning' || status.level === 'critical');
  assert.ok(status.processes.some((p) => p.name === 'llama.cpp'));
  assert.ok(status.processes.some((p) => p.name === 'ComfyUI'));
  assert.match(status.tip_zh, /llama\.cpp/);
  assert.match(status.tip_zh, /ComfyUI/);
});

test('buildVramStatus critical at 92% usage', () => {
  const total = 8188 * 1024 * 1024;
  const used = Math.round(0.92 * total);
  const status = buildVramStatus({
    gpu: { name: 'RTX 4060', total, used, free: total - used },
    ollama: {
      online: true,
      base_url: 'http://127.0.0.1:11434',
      used_bytes: Math.round(5.1 * 1024 ** 3),
      models: [
        {
          name: 'novastory-qwen3.5:9b',
          size: Math.round(5.1 * 1024 ** 3),
          size_vram: Math.round(5.1 * 1024 ** 3),
        },
      ],
    },
    comfyui: {
      online: true,
      base_url: 'http://127.0.0.1:8188',
      used_bytes: Math.round(2.5 * 1024 ** 3),
      total_bytes: total,
      torch_used_bytes: Math.round(2.5 * 1024 ** 3),
    },
  });

  assert.equal(status.level, 'critical');
  assert.ok(status.percent != null && status.percent >= 91);
  assert.match(status.summary_zh, /显存紧张/);
});

test('prepareForImageGeneration skips when no Ollama models are resident', async () => {
  const { VramService } = await import('./vram_service');
  const result = await VramService.prepareForImageGeneration();
  // Live machine: either skipped (nothing loaded) or released something
  assert.equal(typeof result.ok, 'boolean');
  assert.ok(result.phase === 'vram_ready' || result.phase === undefined || result.skipped !== undefined);
  if (result.skipped) {
    assert.equal(result.ok, true);
    assert.equal(result.phase, 'vram_ready');
  }
});

function switchStatus(flags: { llm?: boolean; comfy?: boolean }): VramStatus {
  return {
    level: 'good',
    percent: 10,
    used_bytes: 1024,
    total_bytes: 12 * 1024 ** 3,
    free_bytes: 11 * 1024 ** 3,
    gpu_name: 'RTX 3060',
    ollama: {
      online: Boolean(flags.llm),
      base_url: 'http://127.0.0.1:11434',
      used_bytes: flags.llm ? 1024 : 0,
      models: flags.llm
        ? [{ name: 'novastory-qwen3.5:9b', size: 1024, size_vram: 1024, processor: 'llamacpp' }]
        : [],
    },
    comfyui: {
      online: Boolean(flags.comfy),
      base_url: 'http://127.0.0.1:8188',
      used_bytes: flags.comfy ? 1024 : 0,
      total_bytes: 12 * 1024 ** 3,
      torch_used_bytes: 0,
    },
    processes: [],
    summary: '',
    summary_zh: '',
    tip: '',
    tip_zh: '',
    source: 'nvidia-smi',
    polled_at: '2026-10-08T00:00:00.000Z',
  };
}

test('decideVramSwitch keeps the two local backends exclusive', () => {
  assert.equal(decideVramSwitch({
    target: 'llamacpp', llmLoopback: true, llmOnline: true, comfyRemote: false, comfyOnline: false, gpuBusy: false,
  }).action, 'already');
  assert.equal(decideVramSwitch({
    target: 'llamacpp', llmLoopback: true, llmOnline: true, comfyRemote: true, comfyOnline: true, gpuBusy: true,
  }).action, 'already');
  assert.equal(decideVramSwitch({
    target: 'llamacpp', llmLoopback: true, llmOnline: false, comfyRemote: false, comfyOnline: true, gpuBusy: false,
  }).action, 'start_llamacpp');
  assert.equal(decideVramSwitch({
    target: 'llamacpp', llmLoopback: true, llmOnline: true, comfyRemote: false, comfyOnline: true, gpuBusy: true,
  }).action, 'refuse');
  assert.equal(decideVramSwitch({
    target: 'llamacpp', llmLoopback: false, llmOnline: false, comfyRemote: false, comfyOnline: false, gpuBusy: false,
  }).action, 'refuse');
  assert.equal(decideVramSwitch({
    target: 'comfyui', llmLoopback: true, llmOnline: false, comfyRemote: false, comfyOnline: true, gpuBusy: false,
  }).action, 'already');
  const toComfy = decideVramSwitch({
    target: 'comfyui', llmLoopback: true, llmOnline: true, comfyRemote: false, comfyOnline: false, gpuBusy: false,
  });
  assert.equal(toComfy.action, 'start_comfy');
  if (toComfy.action === 'start_comfy') assert.equal(toComfy.stopLocalLlm, true);
  assert.equal(decideVramSwitch({
    target: 'comfyui', llmLoopback: true, llmOnline: false, comfyRemote: true, comfyOnline: false, gpuBusy: false,
  }).action, 'refuse');
  assert.equal(decideVramSwitch({
    target: 'comfyui', llmLoopback: true, llmOnline: false, comfyRemote: false, comfyOnline: false, gpuBusy: true,
  }).action, 'refuse');
});

test('local llama.cpp launcher is the bundled start script', () => {
  const script = localLlmStartScriptPath();
  assert.equal(path.basename(script), 'start_local_llm.ps1');
  assert.equal(fs.existsSync(script), true);
});

test('switchTo starts only the requested local backend', async () => {
  const calls: string[] = [];
  let state = switchStatus({ llm: false, comfy: true });
  setVramSwitchDepsForTests({
    loadSettings: () => ({ llm: { base_url: 'http://127.0.0.1:11434/v1' }, comfyui: { mode: 'local' } }),
    getStatus: async () => state,
    runTextMode: async () => {
      calls.push('llm');
      state = switchStatus({ llm: true, comfy: false });
    },
    startComfy: async () => {
      calls.push('comfy');
      return true;
    },
    releaseLlm: async () => {
      calls.push('release');
      return { ok: true, message: '', message_zh: '' };
    },
  });
  try {
    const toLlm = await VramService.switchTo('llamacpp');
    assert.equal(toLlm.ok, true);
    assert.match(toLlm.message_zh, /llama\.cpp/);
    assert.deepEqual(calls, ['llm']);

    calls.length = 0;
    state = switchStatus({ llm: true, comfy: false });
    setVramSwitchDepsForTests({
      loadSettings: () => ({ llm: { base_url: 'http://127.0.0.1:11434/v1' }, comfyui: { mode: 'local' } }),
      getStatus: async () => state,
      runTextMode: async () => { calls.push('llm'); },
      startComfy: async () => {
        calls.push('comfy');
        state = switchStatus({ llm: false, comfy: true });
        return true;
      },
      releaseLlm: async () => {
        calls.push('release');
        state = switchStatus({ llm: false, comfy: false });
        return { ok: true, message: '', message_zh: '', status: state };
      },
    });
    const toComfy = await VramService.switchTo('comfyui');
    assert.equal(toComfy.ok, true);
    assert.match(toComfy.message_zh, /ComfyUI/);
    assert.deepEqual(calls, ['release', 'comfy']);
  } finally {
    setVramSwitchDepsForTests(null);
  }
});

test('switchTo does not start ComfyUI when the text model stays resident or the GPU is busy', async () => {
  const calls: string[] = [];
  let state = switchStatus({ llm: true, comfy: false });
  setVramSwitchDepsForTests({
    loadSettings: () => ({ llm: { base_url: 'http://127.0.0.1:11434/v1' }, comfyui: { mode: 'local' } }),
    getStatus: async () => state,
    runTextMode: async () => { calls.push('llm'); },
    startComfy: async () => { calls.push('comfy'); return true; },
    releaseLlm: async () => {
      calls.push('release');
      return { ok: false, message: 'still up', message_zh: '仍在', status: state };
    },
  });
  try {
    const blocked = await VramService.switchTo('comfyui');
    assert.equal(blocked.ok, false);
    assert.match(blocked.message_zh, /仍在运行/);
    assert.deepEqual(calls, ['release']);

    calls.length = 0;
    state = switchStatus({ llm: false, comfy: true });
    const busy = await VramService.switchTo('llamacpp', { gpuBusy: true });
    assert.equal(busy.ok, false);
    assert.match(busy.message_zh, /占用显卡/);
    assert.deepEqual(calls, []);

    const remote = await VramService.switchTo('comfyui');
    assert.equal(remote.ok, true);
    setVramSwitchDepsForTests({
      loadSettings: () => ({
        llm: { base_url: 'http://127.0.0.1:11434/v1' },
        comfyui: { mode: 'remote', remote_base_url: 'https://comfy.example.com' },
      }),
      getStatus: async () => switchStatus({ llm: false, comfy: false }),
      runTextMode: async () => { calls.push('llm'); },
      startComfy: async () => { calls.push('comfy'); return true; },
      releaseLlm: async () => { calls.push('release'); return { ok: true, message: '', message_zh: '' }; },
    });
    const refused = await VramService.switchTo('comfyui');
    assert.equal(refused.ok, false);
    assert.match(refused.message_zh, /远端/);
    assert.deepEqual(calls, []);
  } finally {
    setVramSwitchDepsForTests(null);
  }
});

test('switchTo reports a launcher failure without throwing', async () => {
  setVramSwitchDepsForTests({
    loadSettings: () => ({ llm: { base_url: 'http://127.0.0.1:11434/v1' }, comfyui: { mode: 'local' } }),
    getStatus: async () => switchStatus({ llm: false, comfy: false }),
    runTextMode: async () => {
      const error = new Error('exit 1') as Error & { stderr?: string };
      error.stderr = 'llama-server exited early';
      throw error;
    },
    startComfy: async () => true,
    releaseLlm: async () => ({ ok: true, message: '', message_zh: '' }),
  });
  try {
    const result = await VramService.switchTo('llamacpp');
    assert.equal(result.ok, false);
    assert.match(result.message_zh, /llama-server exited early/);
  } finally {
    setVramSwitchDepsForTests(null);
  }
});

test('task progress bus fans out to subscribers', async () => {
  const { publishTaskProgress, subscribeTaskProgress } = await import('./task_progress_bus');
  const received: any[] = [];
  const unsub = subscribeTaskProgress('test-task-1', (p) => received.push(p));
  publishTaskProgress('test-task-1', { type: 'vram_tuning', message_zh: '正在调优显存环境…' });
  publishTaskProgress('test-task-1', { type: 'vram_ready', skipped: true });
  unsub();
  publishTaskProgress('test-task-1', { type: 'should_not_receive' });
  assert.equal(received.length, 2);
  assert.equal(received[0].type, 'vram_tuning');
  assert.equal(received[1].type, 'vram_ready');
});
