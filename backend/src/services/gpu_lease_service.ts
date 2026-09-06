import { randomUUID } from 'node:crypto';
import { logger } from '../core/logging';
import { VramService } from './vram_service';

export interface GpuLease {
  lease_id: string;
  owner_task_id: string;
  kind: 'image' | 'video';
  acquired_at: string;
  heartbeat_at: string;
  timeout_ms: number;
}

export class GpuLeaseService {
  private static currentLease: GpuLease | null = null;
  private static waitQueue: Array<{
    taskId: string;
    kind: 'image' | 'video';
    timeoutMs: number;
    resolve: (lease: GpuLease) => void;
    reject: (err: Error) => void;
  }> = [];

  static isAvailable(): boolean {
    if (!this.currentLease) return true;
    const now = Date.now();
    const lastHeartbeat = new Date(this.currentLease.heartbeat_at).getTime();
    if (now - lastHeartbeat > this.currentLease.timeout_ms) {
      logger.warn(`GPU lease for task ${this.currentLease.owner_task_id} timed out; reclaiming.`);
      this.currentLease = null;
      return true;
    }
    return false;
  }

  static getCurrentLease(): GpuLease | null {
    if (this.currentLease && !this.isAvailable()) {
      return this.currentLease;
    }
    return null;
  }

  static getQueueLength(): number {
    return this.waitQueue.length;
  }

  static getQueuePosition(taskId: string): number {
    const idx = this.waitQueue.findIndex((item) => item.taskId === taskId);
    return idx >= 0 ? idx + 1 : 0;
  }

  static async prepareGpuForTask(kind: 'image' | 'video'): Promise<{ ok: boolean; message: string }> {
    try {
      if (kind === 'video') {
        // For heavy video models (MiniMax H3), free both resident Ollama LLMs and any previous Comfy cached graphs
        await VramService.releaseLlm({ includeConfiguredModel: false });
        await VramService.freeComfy();
        return { ok: true, message: 'GPU prepared for H3 video generation' };
      } else {
        // Image generation
        const res = await VramService.prepareForImageGeneration();
        return { ok: res.ok, message: res.message };
      }
    } catch (err: any) {
      logger.warn(`GPU preparation notice: ${err?.message || err}`);
      return { ok: true, message: 'GPU preparation skipped or failed softly' };
    }
  }

  static async acquireLease(
    taskId: string,
    kind: 'image' | 'video' = 'video',
    timeoutMs?: number
  ): Promise<GpuLease> {
    const defaultTimeout = kind === 'video' ? 25 * 60 * 1000 : 5 * 60 * 1000;
    const effectiveTimeout = timeoutMs || defaultTimeout;

    if (this.isAvailable()) {
      const now = new Date().toISOString();
      const lease: GpuLease = {
        lease_id: randomUUID(),
        owner_task_id: taskId,
        kind,
        acquired_at: now,
        heartbeat_at: now,
        timeout_ms: effectiveTimeout
      };
      this.currentLease = lease;
      logger.info(`GPU lease acquired by ${kind} task: ${taskId} (leaseId=${lease.lease_id})`);
      return lease;
    }

    // Otherwise enqueue
    logger.info(`GPU busy (owner=${this.currentLease?.owner_task_id}). Enqueuing task ${taskId} (queue position ${this.waitQueue.length + 1})`);
    return new Promise<GpuLease>((resolve, reject) => {
      this.waitQueue.push({
        taskId,
        kind,
        timeoutMs: effectiveTimeout,
        resolve,
        reject
      });
    });
  }

  static releaseLease(leaseId: string, taskId: string): void {
    if (this.currentLease && (this.currentLease.lease_id === leaseId || this.currentLease.owner_task_id === taskId)) {
      logger.info(`GPU lease released by task ${taskId} (leaseId=${leaseId})`);
      this.currentLease = null;
      this.processNextInQueue();
    } else {
      // Also remove from waitQueue if cancelled while queued
      const initialLen = this.waitQueue.length;
      this.waitQueue = this.waitQueue.filter((item) => item.taskId !== taskId);
      if (this.waitQueue.length < initialLen) {
        logger.info(`Removed task ${taskId} from GPU wait queue.`);
      }
    }
  }

  static heartbeat(leaseId: string, taskId: string): void {
    if (this.currentLease && this.currentLease.lease_id === leaseId && this.currentLease.owner_task_id === taskId) {
      this.currentLease.heartbeat_at = new Date().toISOString();
    }
  }

  private static processNextInQueue(): void {
    if (this.waitQueue.length === 0) return;
    const next = this.waitQueue.shift();
    if (!next) return;

    const now = new Date().toISOString();
    const lease: GpuLease = {
      lease_id: randomUUID(),
      owner_task_id: next.taskId,
      kind: next.kind,
      acquired_at: now,
      heartbeat_at: now,
      timeout_ms: next.timeoutMs
    };
    this.currentLease = lease;
    logger.info(`GPU lease granted to queued ${next.kind} task: ${next.taskId} (leaseId=${lease.lease_id})`);
    next.resolve(lease);
  }

  static resetForTesting(): void {
    this.currentLease = null;
    this.waitQueue = [];
  }
}
