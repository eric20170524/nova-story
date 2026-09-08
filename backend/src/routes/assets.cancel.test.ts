import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server';
import { db } from '../db/database';
import { AssetTaskStore } from '../services/task_store';
import { ComfyUIService } from '../services/ai/comfyui_service';
import { GpuLeaseService } from '../services/gpu_lease_service';

const taskId = (name: string) =>
  `test_asset_cancel_${name}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

test('assets cancel is ownership-scoped and never falls back to blind Comfy interrupt', async () => {
  const app = await buildApp({ logger: false });
  const originalCancelExecution = ComfyUIService.prototype.cancelExecution;
  const createdTaskIds: string[] = [];
  let cancelCalls = 0;

  try {
    ComfyUIService.prototype.cancelExecution = async function (promptId?: string | null) {
      cancelCalls += 1;
      return {
        ok: true,
        deleted_from_queue: false,
        interrupted: true,
        message: `mock cancelled ${promptId}`
      };
    };

    // No task/prompt ownership: fail before touching ComfyUI.
    const unscoped = await app.inject({
      method: 'POST',
      url: '/api/assets/cancel',
      payload: {}
    });
    assert.equal(unscoped.statusCode, 400);
    assert.equal(cancelCalls, 0);

    // A task row alone is not enough before prompt submission: the task must own a
    // queued or active image lease, otherwise the route cannot prove what to cancel.
    const orphanTask = taskId('orphan');
    createdTaskIds.push(orphanTask);
    await AssetTaskStore.processing(orphanTask, 0);
    const noLease = await app.inject({
      method: 'POST',
      url: '/api/assets/cancel',
      payload: { task_id: orphanTask }
    });
    assert.equal(noLease.statusCode, 409);
    assert.equal(cancelCalls, 0);
    assert.equal((await AssetTaskStore.get(orphanTask))?.status, 'processing');

    // Active pre-prompt image ownership can be cancelled without any Comfy call and
    // releases the exact image lease for the next GPU task.
    GpuLeaseService.resetForTesting();
    const activeTask = taskId('active');
    createdTaskIds.push(activeTask);
    await AssetTaskStore.processing(activeTask, 0);
    const activeLease = await GpuLeaseService.acquireLease(activeTask, 'image');
    assert.equal(activeLease.owner_task_id, activeTask);

    const prePrompt = await app.inject({
      method: 'POST',
      url: '/api/assets/cancel',
      payload: { task_id: activeTask }
    });
    assert.equal(prePrompt.statusCode, 200);
    assert.equal(cancelCalls, 0);
    assert.equal((await AssetTaskStore.get(activeTask))?.status, 'cancelled');
    assert.equal(GpuLeaseService.getCurrentLease(), null);

    // Prompt id supplied alongside task id must match the canonical task ownership.
    const mismatchTask = taskId('mismatch');
    createdTaskIds.push(mismatchTask);
    await AssetTaskStore.processing(mismatchTask, 0);
    await AssetTaskStore.setComfyPromptId(mismatchTask, 'owned_prompt');
    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/assets/cancel',
      payload: { task_id: mismatchTask, prompt_id: 'foreign_prompt' }
    });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(cancelCalls, 0);
    assert.equal((await AssetTaskStore.get(mismatchTask))?.status, 'processing');

    // A confirmed prompt-scoped cancellation may transition the task to cancelled.
    const promptTask = taskId('prompt');
    createdTaskIds.push(promptTask);
    await AssetTaskStore.processing(promptTask, 0);
    await AssetTaskStore.setComfyPromptId(promptTask, 'image_prompt');
    const scoped = await app.inject({
      method: 'POST',
      url: '/api/assets/cancel',
      payload: { task_id: promptTask }
    });
    assert.equal(scoped.statusCode, 200);
    assert.equal(cancelCalls, 1);
    assert.equal((await AssetTaskStore.get(promptTask))?.status, 'cancelled');

    // If the provider cannot confirm prompt stop, the canonical task remains
    // processing. This prevents the UI request from freeing GPU ownership early.
    ComfyUIService.prototype.cancelExecution = async function () {
      cancelCalls += 1;
      return {
        ok: false,
        deleted_from_queue: false,
        interrupted: false,
        message: 'prompt stop not confirmed'
      };
    };
    const uncertainTask = taskId('uncertain');
    createdTaskIds.push(uncertainTask);
    await AssetTaskStore.processing(uncertainTask, 0);
    await AssetTaskStore.setComfyPromptId(uncertainTask, 'uncertain_prompt');
    const uncertain = await app.inject({
      method: 'POST',
      url: '/api/assets/cancel',
      payload: { task_id: uncertainTask }
    });
    assert.equal(uncertain.statusCode, 409);
    assert.equal((await AssetTaskStore.get(uncertainTask))?.status, 'processing');
  } finally {
    ComfyUIService.prototype.cancelExecution = originalCancelExecution;
    GpuLeaseService.resetForTesting();
    if (createdTaskIds.length > 0) {
      const placeholders = createdTaskIds.map(() => '?').join(',');
      await db.run(
        `DELETE FROM generation_task WHERE task_id IN (${placeholders})`,
        ...createdTaskIds
      );
    }
    await app.close();
  }
});
