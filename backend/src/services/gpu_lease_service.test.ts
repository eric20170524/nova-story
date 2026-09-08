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

test('GpuLeaseService rejects a queued waiter only through explicit queued cancellation', async () => {
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

test('fabricated release calls cannot cancel a queued task', async () => {
  GpuLeaseService.resetForTesting();

  const lease1 = await GpuLeaseService.acquireLease('task_1', 'video');
  const queued = GpuLeaseService.acquireLease('task_2', 'video');

  GpuLeaseService.releaseLease('nonexistent_lease', 'task_2');
  assert.equal(GpuLeaseService.getQueueLength(), 1);
  assert.equal(GpuLeaseService.getQueuePosition('task_2'), 1);

  assert.equal(GpuLeaseService.cancelQueuedTask('task_2'), true);
  await assert.rejects(queued, /GPU lease request cancelled/);

  GpuLeaseService.releaseLease(lease1.lease_id, 'task_1');
  assert.equal(GpuLeaseService.isAvailable(), true);
});

test('GpuLeaseService defers exact image release until a guarded Comfy prompt is confirmed stopped', async () => {
  GpuLeaseService.resetForTesting();

  const lease1 = await GpuLeaseService.acquireLease('task_guarded', 'image');
  let lease2Granted = false;
  const lease2Promise = GpuLeaseService.acquireLease('task_next', 'video').then((lease) => {
    lease2Granted = true;
    return lease;
  });

  assert.equal(GpuLeaseService.guardLeaseForPrompt('task_guarded', 'prompt_guarded'), true);
  assert.equal(GpuLeaseService.getGuardedPromptId('task_guarded'), 'prompt_guarded');

  GpuLeaseService.releaseLease(lease1.lease_id, 'task_guarded');
  assert.equal(GpuLeaseService.getCurrentLease()?.owner_task_id, 'task_guarded');
  assert.equal(lease2Granted, false);

  GpuLeaseService.confirmPromptStopped('prompt_guarded');
  const lease2 = await lease2Promise;
  assert.equal(lease2.owner_task_id, 'task_next');
  assert.equal(lease2Granted, true);
  assert.equal(GpuLeaseService.getGuardedPromptId('task_guarded'), null);

  GpuLeaseService.releaseLease(lease2.lease_id, 'task_next');
  assert.equal(GpuLeaseService.isAvailable(), true);
});

test('blank release calls never preempt active video ownership or reject a queued waiter', async () => {
  GpuLeaseService.resetForTesting();

  const lease1 = await GpuLeaseService.acquireLease('task_active', 'video');
  const queued = GpuLeaseService.acquireLease('task_queued', 'video');

  GpuLeaseService.releaseLease('', 'task_active');
  assert.equal(GpuLeaseService.getCurrentLease()?.owner_task_id, 'task_active');

  GpuLeaseService.releaseLease('', 'task_queued');
  assert.equal(GpuLeaseService.getQueueLength(), 1);

  GpuLeaseService.releaseLease(lease1.lease_id, 'task_active');
  const lease2 = await queued;
  assert.equal(lease2.owner_task_id, 'task_queued');
  GpuLeaseService.releaseLease(lease2.lease_id, 'task_queued');
});

test('blank release calls never preempt active image ownership', async () => {
  GpuLeaseService.resetForTesting();

  const imageLease = await GpuLeaseService.acquireLease('image_owner', 'image');
  let nextGranted = false;
  const queued = GpuLeaseService.acquireLease('video_next', 'video').then((lease) => {
    nextGranted = true;
    return lease;
  });

  GpuLeaseService.releaseLease('', 'image_owner');
  assert.equal(GpuLeaseService.getCurrentLease()?.lease_id, imageLease.lease_id);
  assert.equal(nextGranted, false);
  assert.equal(GpuLeaseService.getQueueLength(), 1);

  GpuLeaseService.releaseLease(imageLease.lease_id, 'image_owner');
  const next = await queued;
  assert.equal(next.owner_task_id, 'video_next');
  GpuLeaseService.releaseLease(next.lease_id, 'video_next');
});

test('release requires both exact lease id and exact owner task id', async () => {
  GpuLeaseService.resetForTesting();

  const lease = await GpuLeaseService.acquireLease('image_owner', 'image');

  GpuLeaseService.releaseLease('stale_or_fake_lease', 'image_owner');
  assert.equal(GpuLeaseService.getCurrentLease()?.lease_id, lease.lease_id);

  GpuLeaseService.releaseLease(lease.lease_id, 'foreign_task');
  assert.equal(GpuLeaseService.getCurrentLease()?.lease_id, lease.lease_id);

  GpuLeaseService.releaseLease(lease.lease_id, 'image_owner');
  assert.equal(GpuLeaseService.isAvailable(), true);
});
