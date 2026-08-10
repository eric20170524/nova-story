/**
 * Plan 1 UI bridge: generation pages emit VRAM scheduler phases;
 * the top VramHealthBadge listens and shows seamless status text.
 */

export type VramSchedulerPhase =
  | 'idle'
  | 'vram_tuning'
  | 'vram_ready'
  | 'rendering'
  | 'done';

export type VramSchedulerDetail = {
  phase: VramSchedulerPhase;
  message?: string;
  message_zh?: string;
  task_id?: string;
  skipped?: boolean;
};

export const VRAM_SCHEDULER_EVENT = 'novastory-vram-scheduler';

export function emitVramSchedulerPhase(detail: VramSchedulerDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(VRAM_SCHEDULER_EVENT, { detail }));
}

export function clearVramSchedulerPhase(): void {
  emitVramSchedulerPhase({ phase: 'idle' });
}

/** Map SSE payloads from /assets/stream to scheduler UI events. */
export function handleGenerationStreamForVram(data: any, taskId?: string): void {
  if (!data || typeof data !== 'object') return;
  const type = String(data.type || '');
  const nested = data.data && typeof data.data === 'object' ? data.data : {};
  const message = data.message || nested.message;
  const message_zh = data.message_zh || nested.message_zh;
  const skipped = data.skipped ?? nested.skipped;

  if (type === 'vram_tuning') {
    emitVramSchedulerPhase({
      phase: 'vram_tuning',
      message: message || 'Optimizing VRAM for image generation…',
      message_zh: message_zh || '正在调优显存环境…',
      task_id: taskId,
    });
    return;
  }

  if (type === 'vram_ready') {
    emitVramSchedulerPhase({
      phase: 'vram_ready',
      message: message || 'Starting image render…',
      message_zh: message_zh || '启动生图渲染…',
      task_id: taskId,
      skipped: Boolean(skipped),
    });
    // Brief "ready" then show rendering so the strip stays informative
    window.setTimeout(() => {
      emitVramSchedulerPhase({
        phase: 'rendering',
        message: 'Image generation in progress…',
        message_zh: '生图渲染中…',
        task_id: taskId,
      });
    }, 900);
    return;
  }

  if (type === 'started' || type === 'execution_start') {
    emitVramSchedulerPhase({
      phase: 'rendering',
      message: 'Image generation in progress…',
      message_zh: '生图渲染中…',
      task_id: taskId,
    });
    return;
  }

  if (
    type === 'complete'
    || data.status === 'completed'
    || data.status === 'failed'
  ) {
    emitVramSchedulerPhase({
      phase: 'done',
      message: data.status === 'failed' ? 'Generation finished (error)' : 'Generation finished',
      message_zh: data.status === 'failed' ? '生图结束（失败）' : '生图完成',
      task_id: taskId,
    });
    window.setTimeout(() => clearVramSchedulerPhase(), 1600);
  }
}
