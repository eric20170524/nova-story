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

export class GpuLeaseCancelledError extends Error {
  constructor(taskId: string) {
    super(`GPU lease request cancelled for task ${taskId}`);
    this.name = 'GpuLeaseCancelledError';
  }
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
      this.processNextInQueue();
      return this.currentLease == null;
    }
    return false;
  }

  static getCurrentLease(): GpuLease | null {
    if (this.currentLease && !this.isAvailable()) return this.currentLease;
    return this.currentLease;
  }

  static getQueueLength(): number {
    return this.waitQueue.length;
  }

  static getQueuePosition(taskId: string): number {
    const idx = this.waitQueue.findIndex((item) => item.taskId === taskId);
    return idx >= 0 ? idx + 1 : 0;
  }

  static isQueued(taskId: string): boolean {
    return this.waitQueue.some((item) => item.taskId === taskId);
  }

  static async prepareGpuForTask(kind: 'image' | 'video'): Promise<{ ok: boolean; message: string }> {
    try {
      if (kind === 'video') {
        await VramService.releaseLlm({ includeConfiguredModel: false });
        await VramService.freeComfy();
        return { ok: true, message: 'GPU prepared for H3 video generation' };
      }
      const res = await VramService.prepareForImageGeneration();
      return { ok: res.ok, message: res.message };
    } catch (err: any) {
      logger.warn(`GPU preparation notice: ${err?.message || err}`);
      return { ok: true, message: 'GPU preparation skipped or failed softly' };
    }
  }

  /**
   * Important: this method mutates the current lease / wait queue synchronously
   * before returning its Promise. Callers can therefore start `acquireLease()` and
   * immediately read `getQueuePosition(taskId)` for an accurate submission snapshot.
   */
  static async acquireLease(
    taskId: string,
    kind: 'image' | 'video' = 'video',
    timeoutMs?: number
  ): Promise<GpuLease> {
    const defaultTimeout = kind === 'video' ? 25 * 60 * 1000 : 5 * 60 * 1000;
    const effectiveTimeout = timeoutMs || defaultTimeout;

    // Idempotent protection: the same task must not occupy multiple queue slots.
    if (this.currentLease?.owner_task_id === taskId) return this.currentLease;
    const existing = this.waitQueue.find((item) => item.taskId === taskId);
    if (existing) {
      return new Promise<GpuLease>((resolve, reject) => {
        const originalResolve = existing.resolve;
        const originalReject = existing.reject;
        existing.resolve = (lease) => {
          originalResolve(lease);
          resolve(lease);
        };
        existing.reject = (err) => {
          originalReject(err);
          reject(err);
        };
      });
    }

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

  static cancelQueuedTask(taskId: string): boolean {
    const index = this.waitQueue.findIndex((item) => item.taskId === taskId);
    if (index < 0) return false;
    const [queued] = this.waitQueue.splice(index, 1);
    queued?.reject(new GpuLeaseCancelledError(taskId));
    logger.info(`Cancelled queued GPU lease request for task ${taskId}.`);
    return true;
  }

  static releaseLease(leaseId: string, taskId: string): void {
    if (this.currentLease && (this.currentLease.lease_id === leaseId || this.currentLease.owner_task_id === taskId)) {
      logger.info(`GPU lease released by task ${taskId} (leaseId=${leaseId})`);
      this.currentLease = null;
      this.processNextInQueue();
      return;
    }

    // Backward-compatible cleanup for callers that use releaseLease to cancel a
    // queued request. Unlike the old filter-only path, the waiting Promise is now
    // rejected so no worker remains suspended forever.
    this.cancelQueuedTask(taskId);
  }

  static heartbeat(leaseId: string, taskId: string): void {
    if (this.currentLease && this.currentLease.lease_id === leaseId && this.currentLease.owner_task_id === taskId) {
      this.currentLease.heartbeat_at = new Date().toISOString();
    }
  }

  private static processNextInQueue(): void {
    if (this.waitQueue.length === 0 || this.currentLease) return;
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
    for (const queued of this.waitQueue) {
      queued.reject(new GpuLeaseCancelledError(queued.taskId));
    }
    this.currentLease = null;
    this.waitQueue = [];
  }
}
