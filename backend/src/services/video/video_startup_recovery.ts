import { db } from '../../db/database';
import { logger } from '../../core/logging';
import { GpuLeaseService, type GpuLease } from '../gpu_lease_service';
import { ComfyH3Provider } from './comfy_h3_provider';

export const VIDEO_ORPHAN_RECOVERY_TASK_ID = '__video_orphan_recovery__';

export type ComfyRecoveryProvider = {
  getQueue(timeoutMs?: number): Promise<{ running: any[]; pending: any[] } | null>;
  cancelPrompt(promptId: string, timeoutMs?: number): Promise<boolean>;
};

type OrphanPromptRow = {
  task_id: string;
  stage?: string | null;
  comfy_prompt_id?: string | null;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const queueEntryContainsPromptId = (entry: unknown, promptId: string): boolean => {
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

const promptIsActive = (
  queue: { running: any[]; pending: any[] },
  promptId: string
): boolean => queue.running.some((entry) => queueEntryContainsPromptId(entry, promptId))
  || queue.pending.some((entry) => queueEntryContainsPromptId(entry, promptId));

/**
 * Startup-only safety reconciliation for video tasks whose worker process disappeared
 * while ComfyUI may still own GPU work.
 *
 * The normal VideoGenerationService recovery can resume from raw.mp4 or completed
 * Comfy history. This service handles the harder case: a prompt is still active (or
 * Comfy is temporarily unreachable, so ownership cannot be disproved). It acquires a
 * synthetic recovery lease before requests are served, marks the abandoned task
 * interrupted, and retains the GPU exclusively until every owned prompt is confirmed
 * gone. This turns the single-GPU invariant into a process-restart invariant as well.
 */
export class VideoStartupRecoveryService {
  private static reconciliationPromise: Promise<void> | null = null;

  static async reconcileActivePromptsOnStartup(
    provider: ComfyRecoveryProvider = new ComfyH3Provider()
  ): Promise<number> {
    if (this.reconciliationPromise) {
      logger.info('[Recovery] Video orphan prompt reconciliation is already active.');
      return 0;
    }

    const rows = await db.all(
      `SELECT task_id, stage, comfy_prompt_id
       FROM generation_task
       WHERE kind = 'video'
         AND status = 'processing'
         AND comfy_prompt_id IS NOT NULL
         AND comfy_prompt_id <> ''`
    ) as OrphanPromptRow[];

    if (rows.length === 0) return 0;

    const queue = await provider.getQueue(2500);
    const guardedRows = rows.filter((row) => {
      const promptId = String(row.comfy_prompt_id || '');
      if (!promptId) return false;

      if (queue) {
        return promptIsActive(queue, promptId);
      }

      // When Comfy cannot be reached, a task that had reached `generating` still has
      // unresolved external GPU ownership. Fail closed until queue state is observable.
      return row.stage === 'generating';
    });

    if (guardedRows.length === 0) return 0;

    const lease = await GpuLeaseService.acquireLease(
      VIDEO_ORPHAN_RECOVERY_TASK_ID,
      'video',
      60 * 60 * 1000
    );

    const now = new Date().toISOString();
    for (const row of guardedRows) {
      await db.run(
        `UPDATE generation_task
         SET status = 'interrupted',
             stage = 'interrupted',
             error = ?,
             updated_at = ?
         WHERE task_id = ? AND status = 'processing'`,
        `Server restarted while Comfy prompt ${row.comfy_prompt_id} still had unresolved GPU ownership`,
        now,
        row.task_id
      );
    }

    const promptIds = new Set(
      guardedRows
        .map((row) => String(row.comfy_prompt_id || ''))
        .filter(Boolean)
    );

    logger.warn(
      `[Recovery] Holding GPU for ${promptIds.size} orphaned Comfy video prompt(s): ${Array.from(promptIds).join(', ')}`
    );

    this.reconciliationPromise = this.monitorAndDrain(provider, lease, promptIds)
      .catch((err) => {
        logger.error(`[Recovery] Video orphan reconciliation failed: ${err}`);
      })
      .finally(() => {
        this.reconciliationPromise = null;
      });

    return guardedRows.length;
  }

  private static async monitorAndDrain(
    provider: ComfyRecoveryProvider,
    lease: GpuLease,
    promptIds: Set<string>
  ): Promise<void> {
    const heartbeat = setInterval(() => {
      GpuLeaseService.heartbeat(lease.lease_id, VIDEO_ORPHAN_RECOVERY_TASK_ID);
    }, 20_000);

    try {
      while (promptIds.size > 0) {
        for (const promptId of Array.from(promptIds)) {
          try {
            // Retry scoped cancellation. With multiple running prompts Comfy's global
            // interrupt is intentionally refused; later passes will retry after queue
            // state changes instead of risking an unrelated prompt.
            const stopped = await provider.cancelPrompt(promptId, 2500);
            if (stopped) promptIds.delete(promptId);
          } catch (err) {
            logger.warn(`[Recovery] Failed to cancel orphan prompt ${promptId}: ${err}`);
          }
        }

        if (promptIds.size === 0) break;

        const queue = await provider.getQueue(3000);
        if (queue) {
          for (const promptId of Array.from(promptIds)) {
            if (!promptIsActive(queue, promptId)) {
              promptIds.delete(promptId);
              logger.info(`[Recovery] Orphan prompt ${promptId} is no longer active.`);
            }
          }
        }

        if (promptIds.size > 0) await sleep(2000);
      }

      logger.info('[Recovery] All orphaned Comfy video prompts are cleared; releasing recovery GPU lease.');
    } finally {
      clearInterval(heartbeat);
      GpuLeaseService.releaseLease(lease.lease_id, VIDEO_ORPHAN_RECOVERY_TASK_ID);
    }
  }

  static async waitForIdleForTesting(): Promise<void> {
    if (this.reconciliationPromise) await this.reconciliationPromise;
  }
}
