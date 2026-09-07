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

type GpuLeaseWaiter = {
  taskId: string;
  kind: 'image' | 'video';
  timeoutMs: number;
  promise: Promise<GpuLease>;
  resolve: (lease: GpuLease) => void;
  reject: (err: Error) => void;
};

export class GpuLeaseService {
  private static currentLease: GpuLease | null = null;
  private static waitQueue: GpuLeaseWaiter[] = [];

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
    this.isAvailable();
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
   * Mutates the lease/queue synchronously before returning. Repeated acquisition by
   * the same task is idempotent: the current lease or the exact same queued Promise
   * is returned instead of creating duplicate queue entries.
   */
  static async acquireLease(
    taskId: string,
    kind: 'image' | 'video' = 'video',
    timeoutMs?: number
  ): Promise<GpuLease> {
    const defaultTimeout = kind === 'video' ? 25 * 60 * 1000 : 5 * 60 * 1000;
    const effectiveTimeout = timeoutMs || defaultTimeout;

    if (this.currentLease?.owner_task_id === taskId) {
      return this.currentLease;
    }

    const existing = this.waitQueue.find((item) => item.taskId === taskId);
    if (existing) return existing.promise;

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

    let resolveWaiter!: (lease: GpuLease) => void;
    let rejectWaiter!: (err: Error) => void;
    const promise = new Promise<GpuLease>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    this.waitQueue.push({
      taskId,
      kind,
      timeoutMs: effectiveTimeout,
      promise,
      resolve: resolveWaiter,
      reject: rejectWaiter
    });
    logger.info(
      `GPU busy (owner=${this.currentLease?.owner_task_id}). Enqueuing task ${taskId} `
      + `(queue position ${this.waitQueue.length})`
    );
    return promise;
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

    // Backward-compatible cancellation for callers that historically used
    // releaseLease() to remove a queued task. Rejecting the waiter prevents a worker
    // from remaining suspended forever.
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
    const queued = this.waitQueue;
    this.currentLease = null;
    this.waitQueue = [];
    for (const waiter of queued) {
      waiter.reject(new GpuLeaseCancelledError(waiter.taskId));
    }
  }
}
