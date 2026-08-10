/**
 * In-process pub/sub for asset generation progress.
 * Complements Redis so local runs (no REDIS_URL) still get real-time SSE
 * events such as VRAM handoff phases.
 */
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(200);

export type TaskProgressPayload = Record<string, unknown> & {
  type: string;
};

export function publishTaskProgress(taskId: string, payload: TaskProgressPayload): void {
  if (!taskId) return;
  bus.emit(channelKey(taskId), payload);
}

export function subscribeTaskProgress(
  taskId: string,
  handler: (payload: TaskProgressPayload) => void
): () => void {
  const key = channelKey(taskId);
  const wrapped = (payload: TaskProgressPayload) => {
    try {
      handler(payload);
    } catch {
      /* ignore subscriber errors */
    }
  };
  bus.on(key, wrapped);
  return () => {
    bus.off(key, wrapped);
  };
}

function channelKey(taskId: string): string {
  return `task_progress:${taskId}`;
}
