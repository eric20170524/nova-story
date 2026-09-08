import { logger } from '../../core/logging';
import { GpuLeaseService } from '../gpu_lease_service';

export interface ComfyQueueSnapshot {
  running: any[];
  pending: any[];
}

export interface ComfyPromptCancelResult {
  ok: boolean;
  deleted_from_queue: boolean;
  interrupted: boolean;
  message: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const queueEntryContainsPromptId = (entry: unknown, promptId: string): boolean => {
  if (entry === promptId) return true;
  if (Array.isArray(entry)) {
    return entry.some((value) => queueEntryContainsPromptId(value, promptId));
  }
  if (entry && typeof entry === 'object') {
    return Object.values(entry as Record<string, unknown>)
      .some((value) => queueEntryContainsPromptId(value, promptId));
  }
  return false;
};

/**
 * Shared Comfy prompt ownership primitive.
 *
 * This deliberately does NOT submit workflows, interpret websocket messages or parse
 * image/video outputs. It only owns the safety-critical queue/cancel semantics shared
 * by static image and H3 providers:
 *
 * - bounded queue observation;
 * - prompt active/absent checks;
 * - pending prompt deletion;
 * - global /interrupt only when the target is the sole running prompt;
 * - bounded stop confirmation;
 * - opt-in background observation for an execution path that has already returned.
 */
export class ComfyPromptOwnershipService {
  private static stopWatchers = new Set<string>();

  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private watcherKey(promptId: string): string {
    return `${this.baseUrl}::${promptId}`;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = 5000
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async getQueue(timeoutMs: number = 3000): Promise<ComfyQueueSnapshot | null> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/queue`, {}, timeoutMs);
      if (!response.ok) return null;
      const data = await response.json() as any;
      return {
        running: data.queue_running || [],
        pending: data.queue_pending || []
      };
    } catch {
      return null;
    }
  }

  promptIsActive(queue: ComfyQueueSnapshot, promptId: string): boolean {
    return queue.running.some((entry) => queueEntryContainsPromptId(entry, promptId))
      || queue.pending.some((entry) => queueEntryContainsPromptId(entry, promptId));
  }

  async waitForPromptToStop(promptId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const queue = await this.getQueue(Math.min(1000, remaining));
      if (queue && !this.promptIsActive(queue, promptId)) return true;
      if (Date.now() < deadline) {
        await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      }
    }
    return false;
  }

  confirmPromptStopped(promptId: string): void {
    GpuLeaseService.confirmPromptStopped(promptId);
  }

  /**
   * Use only after an execution path has lost its live worker/WS ownership (deadline,
   * connection loss, process reconciliation). Normal route-level cancellation remains
   * strictly bounded and does not spawn an unbounded timer loop by itself.
   */
  watchPromptUntilStopped(promptId: string, context = 'Comfy'): void {
    const key = this.watcherKey(promptId);
    if (ComfyPromptOwnershipService.stopWatchers.has(key)) return;
    ComfyPromptOwnershipService.stopWatchers.add(key);

    logger.warn(`${context} prompt ${promptId} stop is not confirmed; retaining GPU lease guard.`);
    void (async () => {
      try {
        while (true) {
          const queue = await this.getQueue(3000);
          if (queue && !this.promptIsActive(queue, promptId)) {
            this.confirmPromptStopped(promptId);
            logger.info(`${context} prompt ${promptId} stopped; GPU lease guard cleared.`);
            return;
          }
          await sleep(2000);
        }
      } finally {
        ComfyPromptOwnershipService.stopWatchers.delete(key);
      }
    })();
  }

  /**
   * A successful result means the target prompt is confirmed absent from both
   * queue_running and queue_pending. Any uncertainty fails closed. The caller decides
   * whether it still has a live worker or must start background stop observation.
   */
  async cancelPrompt(
    promptId?: string | null,
    timeoutMs: number = 5000,
    context = 'Comfy'
  ): Promise<ComfyPromptCancelResult> {
    if (!promptId) {
      return {
        ok: false,
        deleted_from_queue: false,
        interrupted: false,
        message: 'Refusing unscoped ComfyUI cancel: prompt_id is required'
      };
    }

    const deadline = Date.now() + Math.max(1, timeoutMs);
    const remaining = () => Math.max(0, deadline - Date.now());
    let deletedFromQueue = false;
    let interrupted = false;
    const notes: string[] = [];

    const fail = (message: string): ComfyPromptCancelResult => ({
      ok: false,
      deleted_from_queue: deletedFromQueue,
      interrupted,
      message
    });

    try {
      const queue = await this.getQueue(Math.min(2000, Math.max(1, remaining())));
      if (!queue || remaining() <= 0) {
        return fail('Could not confirm ComfyUI queue state; cancellation failed closed');
      }

      const pendingMatch = queue.pending.some(
        (entry) => queueEntryContainsPromptId(entry, promptId)
      );
      const runningMatches = queue.running.filter(
        (entry) => queueEntryContainsPromptId(entry, promptId)
      );

      if (pendingMatch) {
        const deleteRes = await this.fetchWithTimeout(`${this.baseUrl}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: [promptId] })
        }, Math.max(1, remaining()));
        deletedFromQueue = deleteRes.ok;
        notes.push(deletedFromQueue
          ? `queue delete ${promptId}`
          : `queue delete failed ${deleteRes.status}`);

        if (!deletedFromQueue || remaining() <= 0) {
          return fail(notes.join('; '));
        }

        const stopped = await this.waitForPromptToStop(promptId, remaining());
        if (stopped) this.confirmPromptStopped(promptId);
        notes.push(stopped ? 'prompt stop confirmed' : 'prompt stop not yet confirmed');
        return {
          ok: stopped,
          deleted_from_queue: deletedFromQueue,
          interrupted: false,
          message: notes.join('; ')
        };
      }

      if (runningMatches.length > 0) {
        if (queue.running.length !== 1) {
          logger.warn(
            `Refusing global ComfyUI interrupt for ${context} prompt ${promptId}: `
            + `${queue.running.length} prompts are reported running.`
          );
          return fail(`Refusing global interrupt: ${queue.running.length} prompts are running`);
        }

        const interruptRes = await this.fetchWithTimeout(
          `${this.baseUrl}/interrupt`,
          { method: 'POST' },
          Math.max(1, remaining())
        );
        interrupted = interruptRes.ok;
        notes.push(interrupted ? 'interrupt ok' : `interrupt failed ${interruptRes.status}`);
        if (!interrupted || remaining() <= 0) {
          return fail(notes.join('; '));
        }

        const stopped = await this.waitForPromptToStop(promptId, remaining());
        if (stopped) this.confirmPromptStopped(promptId);
        notes.push(stopped ? 'prompt stop confirmed' : 'prompt stop not yet confirmed');
        return {
          ok: stopped,
          deleted_from_queue: false,
          interrupted,
          message: notes.join('; ')
        };
      }

      // Queue absence is authoritative for GPU ownership. Never blind-interrupt an
      // unrelated current graph when the requested prompt is already gone.
      this.confirmPromptStopped(promptId);
      return {
        ok: true,
        deleted_from_queue: false,
        interrupted: false,
        message: `Prompt ${promptId} is already absent from ComfyUI queue`
      };
    } catch (error) {
      logger.warn(`Failed to cancel ${context} Comfy prompt ${promptId}: ${error}`);
      return fail(`Cancellation error: ${error}`);
    }
  }
}
