import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/database';
import { VideoGenerationService } from './video_generation_service';

test('cancelTask cannot overwrite a terminal state when its pre-check is stale', async () => {
  const taskId = `test_terminal_race_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date().toISOString();
  const originalGetTask = VideoGenerationService.getTask;

  try {
    await db.run(
      `INSERT INTO generation_task (
        task_id, scene_id, kind, status, stage, created_at, updated_at
      ) VALUES (?, 0, 'video', 'completed', 'completed', ?, ?)`,
      taskId,
      now,
      now
    );

    // Simulate the exact TOCTOU race: cancelTask saw `processing`, then another
    // terminal transition committed before its UPDATE reached SQLite.
    (VideoGenerationService as any).getTask = async () => ({
      task_id: taskId,
      scene_id: 0,
      status: 'processing',
      stage: 'postprocessing',
      queue_position: 0,
      error: null,
      output_url: null,
      raw_video_url: null,
      poster_url: null,
      qa_report_url: null,
      qa_report: null,
      created_at: now,
      updated_at: now
    });

    const cancelled = await VideoGenerationService.cancelTask(taskId);
    assert.equal(cancelled, false);

    const row = await db.get(
      'SELECT status, stage FROM generation_task WHERE task_id = ?',
      taskId
    );
    assert.equal(row.status, 'completed');
    assert.equal(row.stage, 'completed');
  } finally {
    (VideoGenerationService as any).getTask = originalGetTask;
    await db.run('DELETE FROM generation_task WHERE task_id = ?', taskId);
  }
});
