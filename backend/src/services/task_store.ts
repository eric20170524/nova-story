/**
 * Asset generation task store: in-memory hot path + SQLite persistence.
 * Survives process restart for status queries and cancel-by-prompt_id.
 */
import { db } from '../db/database';
import { logger } from '../core/logging';

export type AssetTaskStatus =
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface AssetTaskState {
  task_id: string;
  scene_id: number;
  status: AssetTaskStatus;
  image_url?: string | null;
  error?: string | null;
  comfy_prompt_id?: string | null;
  progress_json?: string | null;
  retry_count?: number;
  created_at?: string;
  updated_at: string;
}

const memory = new Map<string, AssetTaskState>();

const nowIso = () => new Date().toISOString();

const rowToState = (row: any): AssetTaskState => ({
  task_id: String(row.task_id),
  scene_id: Number(row.scene_id),
  status: row.status as AssetTaskStatus,
  image_url: row.image_url ?? null,
  error: row.error ?? null,
  comfy_prompt_id: row.comfy_prompt_id ?? null,
  progress_json: row.progress_json ?? null,
  retry_count: Number(row.retry_count || 0),
  created_at: row.created_at,
  updated_at: row.updated_at
});

const persist = async (state: AssetTaskState) => {
  memory.set(state.task_id, state);
  try {
    await db.run(
      `INSERT INTO generation_task (
        task_id, scene_id, status, image_url, error, comfy_prompt_id,
        progress_json, retry_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)
      ON CONFLICT(task_id) DO UPDATE SET
        scene_id = excluded.scene_id,
        status = excluded.status,
        image_url = excluded.image_url,
        error = excluded.error,
        comfy_prompt_id = COALESCE(excluded.comfy_prompt_id, generation_task.comfy_prompt_id),
        progress_json = COALESCE(excluded.progress_json, generation_task.progress_json),
        retry_count = excluded.retry_count,
        updated_at = excluded.updated_at`,
      state.task_id,
      state.scene_id,
      state.status,
      state.image_url ?? null,
      state.error ?? null,
      state.comfy_prompt_id ?? null,
      state.progress_json ?? null,
      state.retry_count ?? 0,
      state.created_at ?? state.updated_at,
      state.updated_at
    );
  } catch (err: any) {
    // Table may not exist yet during very early boot; keep memory path alive
    logger.warn(`generation_task persist failed: ${err?.message || err}`);
  }
  return state;
};

export const AssetTaskStore = {
  async processing(taskId: string, sceneId: number) {
    const updated = nowIso();
    return persist({
      task_id: taskId,
      scene_id: sceneId,
      status: 'processing',
      retry_count: 0,
      created_at: updated,
      updated_at: updated
    });
  },

  async setComfyPromptId(taskId: string, promptId: string) {
    const existing =
      memory.get(taskId) || (await AssetTaskStore.get(taskId));
    if (!existing) {
      return persist({
        task_id: taskId,
        scene_id: 0,
        status: 'processing',
        comfy_prompt_id: promptId,
        updated_at: nowIso()
      });
    }
    return persist({
      ...existing,
      comfy_prompt_id: promptId,
      updated_at: nowIso()
    });
  },

  async setProgress(taskId: string, progress: Record<string, unknown>) {
    const existing = memory.get(taskId) || (await AssetTaskStore.get(taskId));
    if (!existing) return null;
    return persist({
      ...existing,
      progress_json: JSON.stringify(progress),
      updated_at: nowIso()
    });
  },

  async completed(taskId: string, sceneId: number, imageUrl: string) {
    const existing = memory.get(taskId);
    return persist({
      task_id: taskId,
      scene_id: sceneId,
      status: 'completed',
      image_url: imageUrl,
      comfy_prompt_id: existing?.comfy_prompt_id ?? null,
      retry_count: existing?.retry_count ?? 0,
      created_at: existing?.created_at,
      updated_at: nowIso()
    });
  },

  async failed(taskId: string, sceneId: number, error: string) {
    const existing = memory.get(taskId);
    return persist({
      task_id: taskId,
      scene_id: sceneId,
      status: 'failed',
      error,
      comfy_prompt_id: existing?.comfy_prompt_id ?? null,
      retry_count: existing?.retry_count ?? 0,
      created_at: existing?.created_at,
      updated_at: nowIso()
    });
  },

  async cancelled(taskId: string, sceneId: number, error = 'Cancelled by user') {
    const existing = memory.get(taskId) || (await AssetTaskStore.get(taskId));
    return persist({
      task_id: taskId,
      scene_id: sceneId ?? existing?.scene_id ?? 0,
      status: 'cancelled',
      error,
      comfy_prompt_id: existing?.comfy_prompt_id ?? null,
      retry_count: existing?.retry_count ?? 0,
      created_at: existing?.created_at,
      updated_at: nowIso()
    });
  },

  async get(taskId: string): Promise<AssetTaskState | undefined> {
    const hot = memory.get(taskId);
    if (hot) return hot;
    try {
      const row = await db.get(
        'SELECT * FROM generation_task WHERE task_id = ?',
        taskId
      );
      if (!row) return undefined;
      const state = rowToState(row);
      memory.set(taskId, state);
      return state;
    } catch {
      return undefined;
    }
  },

  /**
   * After process restart, in-flight rows cannot be resumed (no worker queue).
   * Mark them interrupted so clients stop polling forever as "processing".
   */
  async markOrphanedProcessingInterrupted(): Promise<number> {
    try {
      const rows = await db.all(
        `SELECT task_id, scene_id FROM generation_task WHERE status = 'processing'`
      );
      let n = 0;
      for (const row of rows as any[]) {
        await persist({
          task_id: String(row.task_id),
          scene_id: Number(row.scene_id),
          status: 'interrupted',
          error: 'Server restarted while task was processing',
          updated_at: nowIso()
        });
        // Align scene row if still generating with this task
        await db.run(
          `UPDATE scene SET asset_status = 'failed'
           WHERE task_id = ? AND asset_status = 'generating'`,
          row.task_id
        );
        n += 1;
      }
      if (n > 0) {
        logger.info(`Marked ${n} orphaned generation_task row(s) as interrupted`);
      }
      return n;
    } catch (err: any) {
      logger.warn(`markOrphanedProcessingInterrupted: ${err?.message || err}`);
      return 0;
    }
  }
};
