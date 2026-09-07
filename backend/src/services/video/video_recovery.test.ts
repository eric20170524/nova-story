import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/database';
import { AssetTaskStore } from '../task_store';
import { VideoGenerationService } from './video_generation_service';

test('recoverTasksOnStartup marks unrecoverable tasks as interrupted', async () => {
  await db.run('DELETE FROM generation_task WHERE task_id = "test_orphaned_task_1"');

  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO generation_task (task_id, kind, status, stage, request_json, created_at, updated_at)
     VALUES (?, 'video', 'processing', 'generating', ?, ?, ?)`,
    'test_orphaned_task_1',
    JSON.stringify({
      scene_id: 9999,
      scene_version: 1,
      profile: 'narrative_clip',
      preset: 'preview_480p_5s'
    }),
    now,
    now
  );

  const recovered = await VideoGenerationService.recoverTasksOnStartup();
  assert.equal(typeof recovered, 'number');

  const task = await db.get('SELECT * FROM generation_task WHERE task_id = ?', 'test_orphaned_task_1');
  assert.equal(task.status, 'interrupted');
  assert.equal(task.stage, 'interrupted');
  assert.ok(task.error.includes('Server restarted'));

  await db.run('DELETE FROM generation_task WHERE task_id = "test_orphaned_task_1"');
});

test('cancelTask remains cancelled after progress publication, query, and startup recovery', async () => {
  const taskId = `test_cancel_recovery_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date().toISOString();

  try {
    await db.run(
      `INSERT INTO generation_task (task_id, scene_id, kind, status, stage, request_json, created_at, updated_at)
       VALUES (?, ?, 'video', 'processing', 'generating', ?, ?, ?)`,
      taskId,
      9999,
      JSON.stringify({
        scene_id: 9999,
        scene_version: 1,
        profile: 'narrative_clip',
        preset: 'preview_480p_5s'
      }),
      now,
      now
    );

    // Prime the stale in-memory task-store state that used to overwrite the terminal
    // DB status when the cancellation progress event was published.
    const cached = await AssetTaskStore.get(taskId);
    assert.equal(cached?.status, 'processing');

    assert.equal(await VideoGenerationService.cancelTask(taskId), true);

    const afterCancel = await VideoGenerationService.getTask(taskId);
    assert.equal(afterCancel?.status, 'cancelled');
    assert.equal(afterCancel?.stage, 'cancelled');
    assert.equal(afterCancel?.error, 'Cancelled by user');

    // Startup recovery only scans processing rows. A correctly persisted cancellation
    // must remain terminal and must never be reclassified as interrupted.
    await VideoGenerationService.recoverTasksOnStartup();
    const afterRecovery = await VideoGenerationService.getTask(taskId);
    assert.equal(afterRecovery?.status, 'cancelled');
    assert.equal(afterRecovery?.stage, 'cancelled');
  } finally {
    await db.run('DELETE FROM generation_task WHERE task_id = ?', taskId);
  }
});
