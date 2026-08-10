/**
 * Unified progress publisher for asset generation tasks.
 * Writes: in-memory bus (SSE), optional Redis, AssetTaskStore.progress_json.
 */
import Redis from 'ioredis';
import { logger } from '../core/logging';
import { AssetTaskStore } from './task_store';
import { publishTaskProgress } from './task_progress_bus';

export type ProgressPublisher = (msgType: string, data?: Record<string, unknown>) => Promise<void>;

export function createProgressPublisher(
  taskId: string,
  redis: Redis | null
): ProgressPublisher {
  return async (msgType: string, data: Record<string, unknown> = {}) => {
    const payload = { type: msgType, data, ...data };

    // Always fan out in-process (SSE without Redis)
    publishTaskProgress(taskId, payload as any);

    if (redis && redis.status === 'ready') {
      try {
        await redis.publish(`task_progress:${taskId}`, JSON.stringify(payload));
      } catch {
        /* ignore */
      }
    }

    // Persist phase for poll fallback / status API
    try {
      await AssetTaskStore.setProgress(taskId, {
        type: msgType,
        ...data,
        at: new Date().toISOString(),
      });
    } catch {
      /* ignore */
    }

    logger.info(`[Task ${taskId}] Progress: ${msgType}`);
  };
}

/**
 * Plan 1: silent VRAM handoff before any ComfyUI work.
 * Emits vram_tuning → vram_ready (or skips quietly when LLM already free).
 */
export async function runVramHandoffForImageGen(
  publish: ProgressPublisher
): Promise<void> {
  const { VramService } = await import('./vram_service');

  await publish('vram_tuning', {
    phase: 'vram_tuning',
    message: 'Optimizing VRAM for image generation…',
    message_zh: '正在调优显存环境…',
  });

  const result = await VramService.prepareForImageGeneration();

  await publish('vram_ready', {
    phase: 'vram_ready',
    skipped: Boolean(result.skipped),
    ok: result.ok,
    released_bytes: result.released_bytes ?? 0,
    message: result.skipped
      ? 'Starting image render…'
      : 'VRAM ready — starting image render…',
    message_zh: result.skipped
      ? '启动生图渲染…'
      : '显存就绪，启动生图渲染…',
    details: result.details,
  });
}
