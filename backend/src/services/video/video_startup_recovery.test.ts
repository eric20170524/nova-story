import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/database';
import { GpuLeaseService } from '../gpu_lease_service';
import {
  VIDEO_ORPHAN_RECOVERY_TASK_ID,
  VideoStartupRecoveryService,
  type ComfyRecoveryProvider
} from './video_startup_recovery';

test('startup recovery holds GPU until an active orphan Comfy prompt is confirmed stopped', async () => {
  GpuLeaseService.resetForTesting();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const taskId = `test_video_orphan_${suffix}`;
  const promptId = `prompt_${suffix}`;
  const now = new Date().toISOString();

  let resolveCancel!: (value: boolean) => void;
  const cancelGate = new Promise<boolean>((resolve) => {
    resolveCancel = resolve;
  });

  const provider: ComfyRecoveryProvider = {
    async getQueue() {
      return {
        running: [[1, promptId, {}]],
        pending: []
      };
    },
    async cancelPrompt() {
      return cancelGate;
    }
  };

  try {
    await db.run(
      `INSERT INTO generation_task (
        task_id, scene_id, kind, status, stage, comfy_prompt_id, created_at, updated_at
      ) VALUES (?, 0, 'video', 'processing', 'generating', ?, ?, ?)`,
      taskId,
      promptId,
      now,
      now
    );

    const recovered = await VideoStartupRecoveryService.reconcileActivePromptsOnStartup(provider);
    assert.equal(recovered, 1);

    const row = await db.get('SELECT status, stage, error FROM generation_task WHERE task_id = ?', taskId);
    assert.equal(row.status, 'interrupted');
    assert.equal(row.stage, 'interrupted');
    assert.match(String(row.error || ''), new RegExp(promptId));

    const heldLease = GpuLeaseService.getCurrentLease();
    assert.equal(heldLease?.owner_task_id, VIDEO_ORPHAN_RECOVERY_TASK_ID);
    assert.equal(GpuLeaseService.isAvailable(), false);

    resolveCancel(true);
    await VideoStartupRecoveryService.waitForIdleForTesting();

    assert.equal(GpuLeaseService.getCurrentLease(), null);
    assert.equal(GpuLeaseService.isAvailable(), true);
  } finally {
    resolveCancel(true);
    await VideoStartupRecoveryService.waitForIdleForTesting();
    GpuLeaseService.resetForTesting();
    await db.run('DELETE FROM generation_task WHERE task_id = ?', taskId);
  }
});

test('startup reconciliation leaves inactive prompts processing so history/raw recovery can decide them', async () => {
  GpuLeaseService.resetForTesting();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const taskId = `test_video_history_candidate_${suffix}`;
  const promptId = `prompt_${suffix}`;
  const now = new Date().toISOString();

  const provider: ComfyRecoveryProvider = {
    async getQueue() {
      return { running: [], pending: [] };
    },
    async cancelPrompt() {
      throw new Error('cancelPrompt should not run for an inactive prompt');
    }
  };

  try {
    await db.run(
      `INSERT INTO generation_task (
        task_id, scene_id, kind, status, stage, comfy_prompt_id, created_at, updated_at
      ) VALUES (?, 0, 'video', 'processing', 'generating', ?, ?, ?)`,
      taskId,
      promptId,
      now,
      now
    );

    const recovered = await VideoStartupRecoveryService.reconcileActivePromptsOnStartup(provider);
    assert.equal(recovered, 0);

    const row = await db.get('SELECT status, stage FROM generation_task WHERE task_id = ?', taskId);
    assert.equal(row.status, 'processing');
    assert.equal(row.stage, 'generating');
    assert.equal(GpuLeaseService.getCurrentLease(), null);
  } finally {
    GpuLeaseService.resetForTesting();
    await db.run('DELETE FROM generation_task WHERE task_id = ?', taskId);
  }
});
