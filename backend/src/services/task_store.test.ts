import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../db/database';
import { AssetTaskStore } from './task_store';

test('AssetTaskStore progress persistence never revives a stale terminal state', async () => {
  const taskId = `test_progress_terminal_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  try {
    // Prime the hot cache with the exact stale state that previously caused the
    // cancellation regression.
    await AssetTaskStore.processing(taskId, 0);
    const cached = await AssetTaskStore.get(taskId);
    assert.equal(cached?.status, 'processing');

    await db.run(
      `UPDATE generation_task
       SET status = 'cancelled', stage = 'cancelled', error = 'Cancelled by user', updated_at = ?
       WHERE task_id = ?`,
      new Date().toISOString(),
      taskId
    );

    await AssetTaskStore.setProgress(taskId, {
      type: 'cancelled',
      phase: 'cancelled',
      message: 'Task cancelled by user'
    });

    const row = await db.get('SELECT * FROM generation_task WHERE task_id = ?', taskId);
    assert.equal(row.status, 'cancelled');
    assert.equal(row.stage, 'cancelled');
    assert.equal(row.error, 'Cancelled by user');
    assert.match(String(row.progress_json || ''), /cancelled/);

    // setProgress refreshes the hot cache from the canonical DB row as well, so a
    // later store read cannot resurrect the old processing state either.
    const refreshed = await AssetTaskStore.get(taskId);
    assert.equal(refreshed?.status, 'cancelled');
  } finally {
    await db.run('DELETE FROM generation_task WHERE task_id = ?', taskId);
  }
});

test('generic orphan cleanup leaves processing video rows for specialized recovery', async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const imageTaskId = `test_orphan_image_${suffix}`;
  const videoTaskId = `test_orphan_video_${suffix}`;
  const now = new Date().toISOString();

  try {
    await db.run(
      `INSERT INTO generation_task (task_id, scene_id, kind, status, stage, created_at, updated_at)
       VALUES (?, 0, 'image', 'processing', 'queued', ?, ?)`,
      imageTaskId,
      now,
      now
    );
    await db.run(
      `INSERT INTO generation_task (task_id, scene_id, kind, status, stage, created_at, updated_at)
       VALUES (?, 0, 'video', 'processing', 'generating', ?, ?)`,
      videoTaskId,
      now,
      now
    );

    const interrupted = await AssetTaskStore.markOrphanedProcessingInterrupted();
    assert.ok(interrupted >= 1);

    const imageRow = await db.get('SELECT status FROM generation_task WHERE task_id = ?', imageTaskId);
    const videoRow = await db.get('SELECT status FROM generation_task WHERE task_id = ?', videoTaskId);
    assert.equal(imageRow.status, 'interrupted');
    assert.equal(videoRow.status, 'processing');
  } finally {
    await db.run('DELETE FROM generation_task WHERE task_id IN (?, ?)', imageTaskId, videoTaskId);
  }
});
