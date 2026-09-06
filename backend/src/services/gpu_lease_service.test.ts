import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuLeaseService } from './gpu_lease_service';

test('GpuLeaseService enforces concurrency of 1 and queues subsequent requests', async () => {
  GpuLeaseService.resetForTesting();

  const lease1 = await GpuLeaseService.acquireLease('task_1', 'image');
  assert.equal(lease1.owner_task_id, 'task_1');
  assert.equal(GpuLeaseService.isAvailable(), false);
  assert.equal(GpuLeaseService.getQueueLength(), 0);

  // Second task should be enqueued
  let lease2Granted = false;
  const lease2Promise = GpuLeaseService.acquireLease('task_2', 'video').then((l) => {
    lease2Granted = true;
    return l;
  });

  assert.equal(lease2Granted, false);
  assert.equal(GpuLeaseService.getQueueLength(), 1);
  assert.equal(GpuLeaseService.getQueuePosition('task_2'), 1);

  // Release lease 1
  GpuLeaseService.releaseLease(lease1.lease_id, 'task_1');

  const lease2 = await lease2Promise;
  assert.equal(lease2Granted, true);
  assert.equal(lease2.owner_task_id, 'task_2');
  assert.equal(GpuLeaseService.getQueueLength(), 0);

  // Release lease 2
  GpuLeaseService.releaseLease(lease2.lease_id, 'task_2');
  assert.equal(GpuLeaseService.isAvailable(), true);
});

test('GpuLeaseService allows removing a queued task upon cancellation', async () => {
  GpuLeaseService.resetForTesting();

  const lease1 = await GpuLeaseService.acquireLease('task_1', 'video');
  const lease2Promise = GpuLeaseService.acquireLease('task_2', 'video');

  assert.equal(GpuLeaseService.getQueueLength(), 1);
  GpuLeaseService.releaseLease('nonexistent_lease', 'task_2');
  assert.equal(GpuLeaseService.getQueueLength(), 0);

  GpuLeaseService.releaseLease(lease1.lease_id, 'task_1');
  assert.equal(GpuLeaseService.isAvailable(), true);
});
