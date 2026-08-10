import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logging';
import { SettingsManager } from '../core/settings_manager';
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from './llm';

const execFileAsync = promisify(execFile);

export type VramLevel = 'good' | 'warning' | 'critical' | 'unknown';

export type VramProcessInfo = {
  name: string;
  bytes: number;
  detail?: string;
};

export type VramStatus = {
  level: VramLevel;
  percent: number | null;
  used_bytes: number | null;
  total_bytes: number | null;
  free_bytes: number | null;
  gpu_name: string | null;
  ollama: {
    online: boolean;
    base_url: string;
    used_bytes: number;
    models: Array<{ name: string; size_vram: number; size: number; processor?: string }>;
  };
  comfyui: {
    online: boolean;
    base_url: string;
    used_bytes: number | null;
    total_bytes: number | null;
    torch_used_bytes: number | null;
  };
  processes: VramProcessInfo[];
  summary: string;
  summary_zh: string;
  tip: string;
  tip_zh: string;
  source: 'nvidia-smi' | 'comfyui' | 'estimated' | 'unavailable';
  polled_at: string;
};

export type VramActionResult = {
  ok: boolean;
  message: string;
  message_zh: string;
  released_bytes?: number;
  details?: string[];
  status?: VramStatus;
  /** True when auto-scheduler found nothing to unload (already free). */
  skipped?: boolean;
  /** Scheduler phase for UI: vram_tuning | vram_ready */
  phase?: 'vram_tuning' | 'vram_ready';
};

export type ReleaseLlmOptions = {
  /**
   * When true (default for manual UI), also try the configured model name even if
   * /api/ps is empty (covers edge cases). Auto image-gen path uses false so we
   * never cold-load a model just to unload it.
   */
  includeConfiguredModel?: boolean;
};

const WARNING_THRESHOLD = 60;
const CRITICAL_THRESHOLD = 85;

function formatGiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0G';
  const gib = bytes / (1024 ** 3);
  return gib >= 10 ? `${gib.toFixed(1)}G` : `${gib.toFixed(1)}G`;
}

function ollamaNativeBaseUrl(openaiCompatUrl?: string | null): string {
  const raw = (openaiCompatUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, '');
  // OpenAI-compat is typically http://host:11434/v1 → native API is host root
  return raw.replace(/\/v1$/i, '') || 'http://127.0.0.1:11434';
}

function classifyLevel(percent: number | null): VramLevel {
  if (percent == null || !Number.isFinite(percent)) return 'unknown';
  if (percent >= CRITICAL_THRESHOLD) return 'critical';
  if (percent >= WARNING_THRESHOLD) return 'warning';
  return 'good';
}

function buildSummaries(input: {
  level: VramLevel;
  ollamaOnline: boolean;
  ollamaModels: number;
  comfyOnline: boolean;
  comfyUsed: number | null;
}): { summary: string; summary_zh: string; tip: string; tip_zh: string } {
  const dualResident =
    input.ollamaModels > 0 &&
    input.comfyOnline &&
    (input.comfyUsed == null || input.comfyUsed > 256 * 1024 * 1024);

  if (input.level === 'critical') {
    return {
      summary: 'VRAM critical',
      summary_zh: '显存紧张',
      tip: dualResident
        ? 'Both LLM and ComfyUI are resident. Free LLM VRAM before Pony / SDXL runs.'
        : 'VRAM is nearly full. Release idle models before generation.',
      tip_zh: dualResident
        ? '双模型同时驻留。建议先释放 LLM 显存再跑 Pony / SDXL。'
        : '显存接近占满，生图前请先释放空闲模型。',
    };
  }

  if (input.level === 'warning') {
    return {
      summary: dualResident ? 'High load — dual models resident' : 'High VRAM load',
      summary_zh: dualResident ? '高负载预警 · 双模型同时驻留' : '高负载预警',
      tip: 'Consider unloading the idle backend before heavy generation.',
      tip_zh: '重负载生图前建议卸载空闲后端。',
    };
  }

  if (input.level === 'good') {
    const llmReady = input.ollamaOnline;
    const comfyReady = input.comfyOnline;
    let summary = 'VRAM healthy';
    let summaryZh = '显存良好';
    if (llmReady && comfyReady) {
      summary = 'VRAM healthy · LLM ready, SD ready';
      summaryZh = '显存良好 · LLM 待命，生图就绪';
    } else if (llmReady) {
      summary = 'VRAM healthy · LLM on standby';
      summaryZh = '显存良好 · LLM 待命';
    } else if (comfyReady) {
      summary = 'VRAM healthy · ComfyUI ready';
      summaryZh = '显存良好 · 生图就绪';
    }
    return {
      summary,
      summary_zh: summaryZh,
      tip: 'Local backends look fine for the next task.',
      tip_zh: '本地后端状态正常，可继续创作。',
    };
  }

  return {
    summary: 'VRAM status unavailable',
    summary_zh: '显存状态未知',
    tip: 'Could not read GPU memory. Is the NVIDIA driver installed?',
    tip_zh: '无法读取 GPU 显存，请确认已安装 NVIDIA 驱动。',
  };
}

async function queryNvidiaSmi(): Promise<{
  name: string;
  total: number;
  used: number;
  free: number;
} | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true }
    );
    const line = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (!line) return null;
    // e.g. "NVIDIA GeForce RTX 4060 Laptop GPU, 8188, 1234, 6800"
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 4) return null;
    const name = parts[0] || 'GPU';
    const totalMiB = Number(parts[1]);
    const usedMiB = Number(parts[2]);
    const freeMiB = Number(parts[3]);
    if (![totalMiB, usedMiB, freeMiB].every((n) => Number.isFinite(n))) return null;
    const miB = 1024 * 1024;
    return {
      name,
      total: Math.round(totalMiB * miB),
      used: Math.round(usedMiB * miB),
      free: Math.round(freeMiB * miB),
    };
  } catch (err) {
    logger.debug({ err }, 'nvidia-smi query failed');
    return null;
  }
}

async function queryOllama(baseUrl: string): Promise<VramStatus['ollama']> {
  const result: VramStatus['ollama'] = {
    online: false,
    base_url: baseUrl,
    used_bytes: 0,
    models: [],
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${baseUrl}/api/ps`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return result;
    const data = (await res.json()) as {
      models?: Array<{
        name?: string;
        model?: string;
        size?: number;
        size_vram?: number;
        details?: { family?: string };
        processor?: string;
      }>;
    };
    result.online = true;
    const models = Array.isArray(data.models) ? data.models : [];
    result.models = models.map((m) => {
      const size = Number(m.size || 0);
      const sizeVram = Number(m.size_vram != null ? m.size_vram : size);
      return {
        name: String(m.name || m.model || 'unknown'),
        size,
        size_vram: sizeVram,
        processor: m.processor,
      };
    });
    result.used_bytes = result.models.reduce((sum, m) => sum + (m.size_vram || 0), 0);
  } catch (err) {
    logger.debug({ err }, 'Ollama /api/ps failed');
  }
  return result;
}

async function queryComfyUi(baseUrl: string): Promise<VramStatus['comfyui']> {
  const result: VramStatus['comfyui'] = {
    online: false,
    base_url: baseUrl,
    used_bytes: null,
    total_bytes: null,
    torch_used_bytes: null,
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${baseUrl}/system_stats`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return result;
    const data = (await res.json()) as {
      devices?: Array<{
        vram_total?: number;
        vram_free?: number;
        torch_vram_total?: number;
        torch_vram_free?: number;
      }>;
    };
    result.online = true;
    const device = Array.isArray(data.devices) ? data.devices[0] : undefined;
    if (device) {
      const total = Number(device.vram_total || 0);
      const free = Number(device.vram_free || 0);
      const torchTotal = Number(device.torch_vram_total || 0);
      const torchFree = Number(device.torch_vram_free || 0);
      if (total > 0) {
        result.total_bytes = total;
        result.used_bytes = Math.max(0, total - free);
      }
      if (torchTotal > 0) {
        result.torch_used_bytes = Math.max(0, torchTotal - torchFree);
      }
    }
  } catch (err) {
    logger.debug({ err }, 'ComfyUI /system_stats failed');
  }
  return result;
}

export function buildVramStatus(parts: {
  gpu: { name: string; total: number; used: number; free: number } | null;
  ollama: VramStatus['ollama'];
  comfyui: VramStatus['comfyui'];
}): VramStatus {
  const processes: VramProcessInfo[] = [];
  if (parts.ollama.used_bytes > 0) {
    const modelNames = parts.ollama.models.map((m) => m.name).join(', ') || 'Ollama';
    processes.push({
      name: 'Ollama',
      bytes: parts.ollama.used_bytes,
      detail: modelNames,
    });
  }
  const comfyUsed =
    parts.comfyui.torch_used_bytes ??
    (parts.comfyui.used_bytes != null && parts.comfyui.used_bytes > 0
      ? parts.comfyui.used_bytes
      : null);
  // Prefer torch reservation as "ComfyUI occupied" when available; else device used if Comfy online alone.
  if (parts.comfyui.online) {
    let comfyBytes = parts.comfyui.torch_used_bytes;
    if (comfyBytes == null || comfyBytes <= 0) {
      // Estimate residual after Ollama when nvidia-smi/device totals available later
      comfyBytes = parts.comfyui.used_bytes;
    }
    if (comfyBytes != null && comfyBytes > 0) {
      processes.push({
        name: 'ComfyUI',
        bytes: comfyBytes,
        detail: 'models / torch cache',
      });
    }
  }

  let used: number | null = null;
  let total: number | null = null;
  let free: number | null = null;
  let source: VramStatus['source'] = 'unavailable';
  let gpuName: string | null = null;

  if (parts.gpu) {
    used = parts.gpu.used;
    total = parts.gpu.total;
    free = parts.gpu.free;
    gpuName = parts.gpu.name;
    source = 'nvidia-smi';

    // If ComfyUI torch numbers missing, refine process list using residual GPU after Ollama
    if (
      parts.comfyui.online &&
      !processes.some((p) => p.name === 'ComfyUI') &&
      used > parts.ollama.used_bytes + 300 * 1024 * 1024
    ) {
      const residual = Math.max(0, used - parts.ollama.used_bytes - 200 * 1024 * 1024);
      if (residual > 256 * 1024 * 1024) {
        processes.push({ name: 'ComfyUI', bytes: residual, detail: 'estimated from GPU residual' });
      }
    }
  } else if (parts.comfyui.total_bytes && parts.comfyui.used_bytes != null) {
    total = parts.comfyui.total_bytes;
    used = parts.comfyui.used_bytes;
    free = Math.max(0, total - used);
    source = 'comfyui';
  } else if (parts.ollama.used_bytes > 0) {
    // Rough estimate when only Ollama is reporting
    used = parts.ollama.used_bytes;
    total = null;
    free = null;
    source = 'estimated';
  }

  const percent =
    used != null && total != null && total > 0
      ? Math.min(100, Math.round((used / total) * 1000) / 10)
      : null;

  const level = classifyLevel(percent);
  const texts = buildSummaries({
    level,
    ollamaOnline: parts.ollama.online,
    ollamaModels: parts.ollama.models.length,
    comfyOnline: parts.comfyui.online,
    comfyUsed: comfyUsed,
  });

  // Human tip with occupancy breakdown for critical/warning tooltips
  const breakdownParts: string[] = [];
  const breakdownPartsZh: string[] = [];
  for (const p of processes) {
    breakdownParts.push(`${p.name} ${formatGiB(p.bytes)}`);
    breakdownPartsZh.push(`${p.name} 占用 ${formatGiB(p.bytes)}`);
  }
  let tip = texts.tip;
  let tipZh = texts.tip_zh;
  if (breakdownParts.length > 0) {
    tip = breakdownParts.join(', ') + (texts.tip ? `. ${texts.tip}` : '');
    tipZh = breakdownPartsZh.join('，') + (texts.tip_zh ? `。${texts.tip_zh}` : '');
  }

  return {
    level,
    percent,
    used_bytes: used,
    total_bytes: total,
    free_bytes: free,
    gpu_name: gpuName,
    ollama: parts.ollama,
    comfyui: parts.comfyui,
    processes,
    summary: texts.summary,
    summary_zh: texts.summary_zh,
    tip,
    tip_zh: tipZh,
    source,
    polled_at: new Date().toISOString(),
  };
}

export class VramService {
  /** Serialize concurrent auto-prepare calls (batch storyboard / multi-character). */
  private static prepareChain: Promise<void> = Promise.resolve();

  static async getStatus(): Promise<VramStatus> {
    const settings = SettingsManager.loadSettings();
    const ollamaBase = ollamaNativeBaseUrl(settings.llm?.base_url);
    const comfyBase = String(settings.comfyui?.base_url || 'http://127.0.0.1:8188').replace(
      /\/$/,
      ''
    );

    const [gpu, ollama, comfyui] = await Promise.all([
      queryNvidiaSmi(),
      queryOllama(ollamaBase),
      queryComfyUi(comfyBase),
    ]);

    return buildVramStatus({ gpu, ollama, comfyui });
  }

  /**
   * Plan 1 — silent VRAM handoff before ComfyUI:
   * if Ollama models are resident, unload them (keep_alive: 0) so Pony/SDXL can own VRAM.
   * No-op when nothing is loaded. Concurrent callers share one chain.
   * Failures are soft (ok:false) so generation can still attempt; Plan 2 UI remains fallback.
   */
  static async prepareForImageGeneration(): Promise<VramActionResult> {
    let releaseGate!: () => void;
    const previous = this.prepareChain;
    this.prepareChain = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    await previous;

    try {
      const settings = SettingsManager.loadSettings();
      const ollamaBase = ollamaNativeBaseUrl(settings.llm?.base_url);
      const before = await queryOllama(ollamaBase);

      if (!before.online) {
        return {
          ok: true,
          skipped: true,
          phase: 'vram_ready',
          message: 'Ollama offline — VRAM handoff skipped.',
          message_zh: 'Ollama 未在线，跳过显存交接。',
          released_bytes: 0,
          details: [`base_url=${ollamaBase}`],
        };
      }

      if (before.models.length === 0 || before.used_bytes <= 0) {
        return {
          ok: true,
          skipped: true,
          phase: 'vram_ready',
          message: 'LLM not resident — ready for ComfyUI.',
          message_zh: 'LLM 未驻留，可直接生图。',
          released_bytes: 0,
          details: ['no loaded models'],
        };
      }

      logger.info(
        `VRAM auto-scheduler: unloading ${before.models.length} Ollama model(s) `
        + `(~${formatGiB(before.used_bytes)}) before image generation`
      );

      const result = await this.releaseLlm({ includeConfiguredModel: false });
      return {
        ...result,
        skipped: false,
        phase: 'vram_ready',
        // Soft-ok: even partial unload is better than aborting generation
        ok: true,
        message: result.ok
          ? result.message
          : `${result.message} Generation will continue; use the VRAM badge if needed.`,
        message_zh: result.ok
          ? result.message_zh
          : `${result.message_zh} 仍将继续生图；如失败请用顶部显存指示灯手动释放。`,
      };
    } catch (err: any) {
      logger.warn({ err }, 'VRAM auto-scheduler prepare failed (soft)');
      return {
        ok: false,
        skipped: false,
        phase: 'vram_ready',
        message: `VRAM handoff failed: ${err?.message || String(err)}. Continuing generation.`,
        message_zh: `显存交接失败：${err?.message || String(err)}。仍将尝试生图。`,
        details: [String(err?.message || err)],
      };
    } finally {
      releaseGate();
    }
  }

  /** Unload resident Ollama models (keep_alive: 0). Manual UI + auto scheduler. */
  static async releaseLlm(options: ReleaseLlmOptions = {}): Promise<VramActionResult> {
    const includeConfiguredModel = options.includeConfiguredModel !== false;
    const settings = SettingsManager.loadSettings();
    const ollamaBase = ollamaNativeBaseUrl(settings.llm?.base_url);
    const configuredModel = String(settings.llm?.model || DEFAULT_OLLAMA_MODEL);
    const details: string[] = [];
    let released = 0;

    const before = await queryOllama(ollamaBase);
    if (!before.online) {
      return {
        ok: false,
        message: 'Ollama is offline; nothing to release.',
        message_zh: 'Ollama 未在线，无需释放。',
        details: [`base_url=${ollamaBase}`],
        status: await this.getStatus(),
      };
    }

    const targets = new Set<string>();
    for (const m of before.models) {
      if (m.name) targets.add(m.name);
    }
    // Manual path: also poke the configured model name (covers odd /api/ps lag).
    // Auto path must NOT — generating against an unloaded model would cold-load then free it.
    if (includeConfiguredModel && configuredModel) {
      targets.add(configuredModel);
    }

    if (targets.size === 0) {
      return {
        ok: true,
        skipped: true,
        message: 'No Ollama models were loaded in VRAM.',
        message_zh: '当前没有驻留在显存中的 Ollama 模型。',
        released_bytes: 0,
        details,
        status: await this.getStatus(),
      };
    }

    for (const model of targets) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        // keep_alive: 0 immediately unloads the model from VRAM
        const res = await fetch(`${ollamaBase}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, keep_alive: 0, prompt: '' }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        details.push(res.ok ? `unload ${model} ok` : `unload ${model} HTTP ${res.status}`);
        if (res.ok) {
          const matched = before.models.find((m) => m.name === model);
          released += matched?.size_vram || matched?.size || 0;
        }
      } catch (err: any) {
        details.push(`unload ${model} error: ${err?.message || String(err)}`);
        logger.warn({ err, model }, 'Failed to unload Ollama model');
      }
    }

    // Brief settle so nvidia-smi /api/ps reflect the unload
    await new Promise((r) => setTimeout(r, 600));
    const status = await this.getStatus();
    const stillLoaded = status.ollama.models.length;
    const ok = stillLoaded === 0;

    return {
      ok,
      message: ok
        ? `Released LLM VRAM (${formatGiB(released || before.used_bytes)}). Ready for ComfyUI / Pony.`
        : `Attempted unload; ${stillLoaded} model(s) still resident.`,
      message_zh: ok
        ? `已释放 LLM 显存（约 ${formatGiB(released || before.used_bytes)}），可留给 ComfyUI / Pony。`
        : `已尝试卸载，仍有 ${stillLoaded} 个模型驻留。`,
      released_bytes: released || before.used_bytes,
      details,
      status,
    };
  }

  /** Ask ComfyUI to unload models and free torch VRAM cache. */
  static async freeComfy(): Promise<VramActionResult> {
    const settings = SettingsManager.loadSettings();
    const comfyBase = String(settings.comfyui?.base_url || 'http://127.0.0.1:8188').replace(
      /\/$/,
      ''
    );
    const details: string[] = [];

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(`${comfyBase}/free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      details.push(res.ok ? 'POST /free ok' : `POST /free HTTP ${res.status}`);

      if (!res.ok) {
        // Older forks may lack /free — try soft interrupt as no-op fallback note
        return {
          ok: false,
          message: `ComfyUI refused free request (HTTP ${res.status}). Is ComfyUI running?`,
          message_zh: `ComfyUI 拒绝释放请求（HTTP ${res.status}）。请确认 ComfyUI 已启动。`,
          details,
          status: await this.getStatus(),
        };
      }
    } catch (err: any) {
      details.push(`error: ${err?.message || String(err)}`);
      return {
        ok: false,
        message: 'ComfyUI is offline or unreachable; cannot free cache.',
        message_zh: 'ComfyUI 未在线或无法连接，无法重置显存缓存。',
        details,
        status: await this.getStatus(),
      };
    }

    await new Promise((r) => setTimeout(r, 800));
    const status = await this.getStatus();
    return {
      ok: true,
      message: 'ComfyUI model cache reset. VRAM should free shortly.',
      message_zh: '已重置 ComfyUI 显存缓存，显存将很快释放。',
      details,
      status,
    };
  }
}

// Exported for unit tests
export const __vramTestables = {
  classifyLevel,
  formatGiB,
  ollamaNativeBaseUrl,
  buildSummaries,
  WARNING_THRESHOLD,
  CRITICAL_THRESHOLD,
};
