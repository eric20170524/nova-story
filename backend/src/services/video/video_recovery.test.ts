import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../db/database';
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
