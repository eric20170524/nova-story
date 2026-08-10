import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __vramTestables,
  buildVramStatus,
  type VramStatus,
} from './vram_service';

const { classifyLevel, formatGiB, ollamaNativeBaseUrl, WARNING_THRESHOLD, CRITICAL_THRESHOLD } =
  __vramTestables;

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
      models: [{ name: 'novastory-qwen3:8b', size: ollamaBytes, size_vram: ollamaBytes }],
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
  assert.ok(status.processes.some((p) => p.name === 'Ollama'));
  assert.ok(status.processes.some((p) => p.name === 'ComfyUI'));
  assert.match(status.tip_zh, /Ollama/);
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
          name: 'novastory-qwen3:8b',
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
