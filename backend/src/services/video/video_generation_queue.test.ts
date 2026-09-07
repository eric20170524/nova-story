import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../db/database';
import { GpuLeaseService } from '../gpu_lease_service';
import { VideoGenerationService } from './video_generation_service';

test('createTask reserves a real queue position before returning and queued cancel removes the waiter', async () => {
  GpuLeaseService.resetForTesting();

  const originalPreflight = (VideoGenerationService as any).preflight;
  const originalPipeline = (VideoGenerationService as any).runTaskPipeline;
  const busyLease = await GpuLeaseService.acquireLease('test_busy_gpu_owner', 'video');
  let createdTaskId: string | null = null;

  try {
    (VideoGenerationService as any).preflight = async () => ({ ready: true, blockers: [] });
    // Keep the test focused on reservation semantics; the production pipeline calls
    // acquireLease again and receives the exact same queued Promise idempotently.
    (VideoGenerationService as any).runTaskPipeline = async () => {};

    const created = await VideoGenerationService.createTask({ scene_id: 0 } as any);
    createdTaskId = created.task_id;

    assert.equal(created.queue_position, 1);
    assert.equal(GpuLeaseService.getQueuePosition(created.task_id), 1);
    assert.equal(GpuLeaseService.isQueued(created.task_id), true);

    const cancelled = await VideoGenerationService.cancelTask(created.task_id);
    assert.equal(cancelled, true);
    assert.equal(GpuLeaseService.isQueued(created.task_id), false);
    assert.equal(GpuLeaseService.getQueueLength(), 0);

    const row = await db.get('SELECT status, stage FROM generation_task WHERE task_id = ?', created.task_id);
    assert.equal(row.status, 'cancelled');
    assert.equal(row.stage, 'cancelled');
  } finally {
    (VideoGenerationService as any).preflight = originalPreflight;
    (VideoGenerationService as any).runTaskPipeline = originalPipeline;
    GpuLeaseService.releaseLease(busyLease.lease_id, 'test_busy_gpu_owner');
    GpuLeaseService.resetForTesting();
    if (createdTaskId) {
      await db.run('DELETE FROM generation_task WHERE task_id = ?', createdTaskId);
    }
  }
});
