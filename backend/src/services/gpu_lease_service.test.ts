import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GpuLeaseCancelledError,
  GpuLeaseService
} from './gpu_lease_service';

test('GpuLeaseService enforces concurrency of 1 and queues subsequent requests', async () => {
  GpuLeaseService.resetForTesting();

  const lease1 = await GpuLeaseService.acquireLease('task_1', 'image');
  assert.equal(lease1.owner_task_id, 'task_1');
  assert.equal(GpuLeaseService.isAvailable(), false);
  assert.equal(GpuLeaseService.getQueueLength(), 0);

  let lease2Granted = false;
  const lease2Promise = GpuLeaseService.acquireLease('task_2', 'video').then((lease) => {
    lease2Granted = true;
    return lease;
  });

  assert.equal(lease2Granted, false);
  assert.equal(GpuLeaseService.getQueueLength(), 1);
  assert.equal(GpuLeaseService.getQueuePosition('task_2'), 1);

  GpuLeaseService.releaseLease(lease1.lease_id, 'task_1');

  const lease2 = await lease2Promise;
  assert.equal(lease2Granted, true);
  assert.equal(lease2.owner_task_id, 'task_2');
  assert.equal(GpuLeaseService.getQueueLength(), 0);

  GpuLeaseService.releaseLease(lease2.lease_id, 'task_2');
  assert.equal(GpuLeaseService.isAvailable(), true);
});

test('GpuLeaseService returns the same queued Promise for repeated acquisition by one task', async () => {
  GpuLeaseService.resetForTesting();

  const lease1 = await GpuLeaseService.acquireLease('task_1', 'video');
  const queuedA = GpuLeaseService.acquireLease('task_2', 'video');
  const queuedB = GpuLeaseService.acquireLease('task_2', 'video');

  assert.equal(GpuLeaseService.getQueueLength(), 1);
  assert.equal(GpuLeaseService.getQueuePosition('task_2'), 1);

  GpuLeaseService.releaseLease(lease1.lease_id, 'task_1');
  const [leaseA, leaseB] = await Promise.all([queuedA, queuedB]);
  assert.equal(leaseA.lease_id, leaseB.lease_id);
  assert.equal(leaseA.owner_task_id, 'task_2');
  GpuLeaseService.releaseLease(leaseA.lease_id, 'task_2');
});

test('GpuLeaseService rejects a queued waiter when the task is cancelled', async () => {
  GpuLeaseService.resetForTesting();

  const lease1 = await GpuLeaseService.acquireLease('task_1', 'video');
  const lease2Promise = GpuLeaseService.acquireLease('task_2', 'video');

  assert.equal(GpuLeaseService.getQueueLength(), 1);
  assert.equal(GpuLeaseService.cancelQueuedTask('task_2'), true);
  assert.equal(GpuLeaseService.getQueueLength(), 0);
  await assert.rejects(
    lease2Promise,
    (error: unknown) => error instanceof GpuLeaseCancelledError
  );

  GpuLeaseService.releaseLease(lease1.lease_id, 'task_1');
  assert.equal(GpuLeaseService.isAvailable(), true);
});

test('releaseLease remains backward-compatible for cancelling a queued task', async () => {
  GpuLeaseService.resetForTesting();

  const lease1 = await GpuLeaseService.acquireLease('task_1', 'video');
  const queued = GpuLeaseService.acquireLease('task_2', 'video');

  GpuLeaseService.releaseLease('nonexistent_lease', 'task_2');
  await assert.rejects(queued, /GPU lease request cancelled/);
  assert.equal(GpuLeaseService.getQueueLength(), 0);

  GpuLeaseService.releaseLease(lease1.lease_id, 'task_1');
  assert.equal(GpuLeaseService.isAvailable(), true);
});
