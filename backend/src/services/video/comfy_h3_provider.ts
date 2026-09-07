import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { logger } from '../../core/logging';
import { SettingsManager } from '../../core/settings_manager';
import { GpuLeaseService } from '../gpu_lease_service';

export interface ComfyH3ProviderOptions {
  baseUrl?: string;
  clientId?: string;
}

export interface ComfyVideoOutput {
  filename: string;
  subfolder?: string;
  type?: string;
  buffer: Buffer;
}

const queueEntryContainsPromptId = (entry: unknown, promptId: string): boolean => {
  if (entry === promptId) return true;
  if (Array.isArray(entry)) return entry.some((value) => queueEntryContainsPromptId(value, promptId));
  if (entry && typeof entry === 'object') {
    return Object.values(entry as Record<string, unknown>).some(
      (value) => queueEntryContainsPromptId(value, promptId)
    );
  }
  return false;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ComfyH3Provider {
  private static promptStopWatchers = new Set<string>();

  private baseUrl: string;
  private clientId: string;
  private wsUrl: string;

  constructor(options: ComfyH3ProviderOptions = {}) {
    const settings = SettingsManager.loadSettings();
    const configuredBase = options.baseUrl || settings.comfyui?.base_url || 'http://127.0.0.1:8188';
    this.baseUrl = configuredBase.replace(/\/$/, '');
    this.clientId = options.clientId || randomUUID();
    this.wsUrl = this.baseUrl.replace('http://', 'ws://').replace('https://', 'wss://') + `/ws?clientId=${this.clientId}`;
  }

  private async fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private promptIsActive(queue: { running: any[]; pending: any[] }, promptId: string): boolean {
    return queue.running.some((entry) => queueEntryContainsPromptId(entry, promptId))
      || queue.pending.some((entry) => queueEntryContainsPromptId(entry, promptId));
  }

  private watchPromptUntilStopped(promptId: string): void {
    if (ComfyH3Provider.promptStopWatchers.has(promptId)) return;
    ComfyH3Provider.promptStopWatchers.add(promptId);

    logger.warn(`Comfy prompt ${promptId} stop is not yet confirmed; retaining GPU lease guard.`);
    void (async () => {
      try {
        while (true) {
          const queue = await this.getQueue(3000);
          if (queue && !this.promptIsActive(queue, promptId)) {
            GpuLeaseService.confirmPromptStopped(promptId);
            logger.info(`Confirmed Comfy prompt ${promptId} stopped; GPU guard can be released.`);
            return;
          }
          await sleep(2000);
        }
      } finally {
        ComfyH3Provider.promptStopWatchers.delete(promptId);
      }
    })();
  }

  private async waitForPromptToStop(promptId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const queue = await this.getQueue(Math.min(1000, remaining));
      if (queue && !this.promptIsActive(queue, promptId)) return true;
      if (Date.now() < deadline) {
        await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      }
    }
    return false;
  }

  async checkStatus(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/system_stats`, {}, 2500);
      return res.ok;
    } catch {
      return false;
    }
  }

  async getObjectInfo(): Promise<Record<string, any> | null> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/object_info`, {}, 3000);
      if (res.ok) return (await res.json()) as Record<string, any>;
    } catch {
      /* ComfyUI offline or unreachable */
    }
    return null;
  }

  async getQueue(timeoutMs = 3000): Promise<{ running: any[]; pending: any[] } | null> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/queue`, {}, timeoutMs);
      if (res.ok) {
        const data = await res.json() as any;
        return {
          running: data.queue_running || [],
          pending: data.queue_pending || []
        };
      }
    } catch {
      /* offline */
    }
    return null;
  }

  async getHistory(promptId: string): Promise<Record<string, any> | null> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/history/${promptId}`, {}, 5000);
      if (res.ok) return (await res.json()) as Record<string, any>;
    } catch {
      /* offline */
    }
    return null;
  }

  async downloadFile(filename: string, subfolder = '', type = 'output'): Promise<Buffer | null> {
    const url = `${this.baseUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const ab = await res.arrayBuffer();
        return Buffer.from(ab);
      }
    } catch (err) {
      logger.warn(`Failed to download output ${filename} from ComfyUI: ${err}`);
    }
    return null;
  }

  async executeWorkflow(
    workflow: Record<string, any>,
    options: {
      onPromptQueued?: (promptId: string) => void | Promise<void>;
      onProgress?: (data: { stage: string; current?: number; total?: number; message?: string }) => void;
      timeoutMs?: number;
    } = {}
  ): Promise<{ status: 'completed' | 'error' | 'cancelled'; videos: ComfyVideoOutput[]; prompt_id?: string; error?: string }> {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(this.wsUrl);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000);
        ws!.on('open', () => {
          clearTimeout(timer);
          resolve();
        });
        ws!.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      logger.info('Connected to ComfyUI WebSocket for H3 generation');
    } catch (err) {
      logger.error(`Failed to connect ComfyUI WebSocket: ${err}`);
      return { status: 'error', videos: [], error: `ComfyUI WebSocket connection failed: ${err}` };
    }

    try {
      const submitRes = await this.fetchWithTimeout(`${this.baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: this.clientId })
      }, 10_000);

      if (!submitRes.ok) {
        const errText = await submitRes.text();
        ws.close();
        return { status: 'error', videos: [], error: `ComfyUI prompt queue error (${submitRes.status}): ${errText}` };
      }

      const resJson = await submitRes.json() as Record<string, any>;
      const promptId = String(resJson.prompt_id || '');
      if (!promptId) {
        ws.close();
        return { status: 'error', videos: [], error: 'No prompt_id returned from ComfyUI' };
      }

      const activeLease = GpuLeaseService.getCurrentLease();
      if (activeLease?.kind === 'video') {
        GpuLeaseService.guardLeaseForPrompt(activeLease.owner_task_id, promptId);
      }

      if (options.onPromptQueued) {
        try {
          await options.onPromptQueued(promptId);
        } catch (err) {
          // The Comfy prompt already exists. Do not abandon it because a metadata
          // callback failed; retain the guard and let normal execution/cancellation
          // determine when GPU ownership can end.
          logger.warn(`H3 onPromptQueued callback failed for ${promptId}: ${err}`);
        }
      }

      const collectedVideos: ComfyVideoOutput[] = [];
      const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;

      return new Promise((resolve) => {
        let isDone = false;
        let pollInterval: NodeJS.Timeout | null = null;
        let deadlineTimer: NodeJS.Timeout | null = null;

        const cleanup = (result: {
          status: 'completed' | 'error' | 'cancelled';
          error?: string;
          promptStopped?: boolean;
        }) => {
          if (isDone) return;
          isDone = true;
          if (pollInterval) clearInterval(pollInterval);
          if (deadlineTimer) clearTimeout(deadlineTimer);

          if (result.promptStopped) {
            GpuLeaseService.confirmPromptStopped(promptId);
          } else {
            this.watchPromptUntilStopped(promptId);
          }

          try {
            ws?.removeAllListeners();
            ws?.close();
          } catch {}
          resolve({
            status: result.status,
            videos: collectedVideos,
            prompt_id: promptId,
            error: result.error
          });
        };

        const fetchHistoryFallback = async () => {
          try {
            const histRes = await this.fetchWithTimeout(`${this.baseUrl}/history/${promptId}`, {}, 5000);
            if (!histRes.ok) return;
            const histData = await histRes.json() as Record<string, any>;
            const promptOutputs = histData[promptId]?.outputs || {};
            for (const nodeId of Object.keys(promptOutputs)) {
              const nodeOut = promptOutputs[nodeId];
              const list = nodeOut.videos || nodeOut.gifs || nodeOut.images || [];
              for (const item of list) {
                if (collectedVideos.some((video) => video.filename === item.filename && video.subfolder === item.subfolder)) {
                  continue;
                }
                const buf = await this.downloadFile(item.filename, item.subfolder, item.type);
                if (buf) {
                  collectedVideos.push({
                    filename: item.filename,
                    subfolder: item.subfolder,
                    type: item.type,
                    buffer: buf
                  });
                }
              }
            }
          } catch (err) {
            logger.warn(`History fetch error: ${err}`);
          }
        };

        deadlineTimer = setTimeout(() => {
          // The task deadline itself stays hard-bounded: return immediately and let
          // cancellation run independently. The GPU lease remains guarded until the
          // prompt is later confirmed absent from ComfyUI's queue.
          cleanup({
            status: 'error',
            error: `ComfyUI H3 execution exceeded deadline (${Math.round(timeoutMs / 1000)}s)`,
            promptStopped: false
          });
          void this.cancelPrompt(promptId, 5000).then((stopped) => {
            if (!stopped) this.watchPromptUntilStopped(promptId);
          });
        }, timeoutMs);

        ws!.on('message', async (raw: any) => {
          try {
            const msg = JSON.parse(raw.toString());
            const msgType = msg.type;
            const data = msg.data || {};

            if (msgType === 'execution_start' && data.prompt_id === promptId) {
              options.onProgress?.({ stage: 'generating', message: 'H3 execution started in ComfyUI' });
            } else if (msgType === 'progress' && data.value != null && data.max != null) {
              options.onProgress?.({ stage: 'generating', current: data.value, total: data.max });
            } else if (msgType === 'executing') {
              if (!data.node && (!data.prompt_id || data.prompt_id === promptId)) {
                setTimeout(async () => {
                  if (collectedVideos.length === 0) await fetchHistoryFallback();
                  cleanup({
                    status: collectedVideos.length > 0 ? 'completed' : 'error',
                    error: collectedVideos.length === 0 ? 'No video outputs collected' : undefined,
                    promptStopped: true
                  });
                }, 1000);
              }
            } else if (msgType === 'executed' && data.prompt_id === promptId) {
              const output = data.output || {};
              const videoList = output.videos || output.gifs || output.images || [];
              for (const item of videoList) {
                const buffer = await this.downloadFile(item.filename, item.subfolder, item.type);
                if (buffer) {
                  collectedVideos.push({
                    filename: item.filename,
                    subfolder: item.subfolder,
                    type: item.type,
                    buffer
                  });
                }
              }
            } else if (msgType === 'execution_error' && (!data.prompt_id || data.prompt_id === promptId)) {
              cleanup({
                status: 'error',
                error: `ComfyUI Execution Error: ${data.exception_message || 'unknown'}`,
                promptStopped: true
              });
            } else if (msgType === 'execution_interrupted' && (!data.prompt_id || data.prompt_id === promptId)) {
              cleanup({ status: 'cancelled', error: 'ComfyUI execution interrupted', promptStopped: true });
            }
          } catch {
            // Ignore unrelated/non-JSON websocket messages.
          }
        });

        pollInterval = setInterval(async () => {
          try {
            const histRes = await this.fetchWithTimeout(`${this.baseUrl}/history/${promptId}`, {}, 5000);
            if (!histRes.ok) return;
            const histData = await histRes.json() as Record<string, any>;
            if (histData[promptId]) {
              await fetchHistoryFallback();
              cleanup({
                status: collectedVideos.length > 0 ? 'completed' : 'error',
                error: collectedVideos.length === 0 ? 'ComfyUI history completed without video outputs' : undefined,
                promptStopped: true
              });
            }
          } catch {}
        }, 5000);

        ws!.on('close', () => {
          setTimeout(async () => {
            if (!isDone) {
              await fetchHistoryFallback();
              const stopped = await this.waitForPromptToStop(promptId, 1500);
              cleanup({
                status: collectedVideos.length > 0 ? 'completed' : 'error',
                error: collectedVideos.length === 0 ? 'ComfyUI connection closed before video output was available' : undefined,
                promptStopped: stopped
              });
            }
          }, 1500);
        });
      });
    } catch (err: any) {
      if (ws) ws.close();
      return { status: 'error', videos: [], error: String(err?.message || err) };
    }
  }

  /**
   * Cancel only the owned prompt. Every network call is bounded by the caller's
   * cancellation budget. A return value of true means the prompt is confirmed absent
   * from ComfyUI's running/pending queue; false means GPU ownership must be retained.
   */
  async cancelPrompt(promptId: string, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const remaining = () => Math.max(0, deadline - Date.now());

    try {
      const queue = await this.getQueue(Math.min(2000, Math.max(1, remaining())));
      if (!queue || remaining() <= 0) return false;

      const pendingMatch = queue.pending.some((entry) => queueEntryContainsPromptId(entry, promptId));
      const runningMatches = queue.running.filter((entry) => queueEntryContainsPromptId(entry, promptId));

      if (pendingMatch) {
        const deleteRes = await this.fetchWithTimeout(`${this.baseUrl}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: [promptId] })
        }, Math.max(1, remaining()));
        if (!deleteRes.ok || remaining() <= 0) return false;

        const stopped = await this.waitForPromptToStop(promptId, remaining());
        if (stopped) GpuLeaseService.confirmPromptStopped(promptId);
        return stopped;
      }

      if (runningMatches.length > 0) {
        const runningCount = queue.running.length;
        if (runningCount !== 1) {
          logger.warn(
            `Refusing global ComfyUI interrupt for ${promptId}: ${runningCount} prompts are reported running.`
          );
          return false;
        }

        const interruptRes = await this.fetchWithTimeout(
          `${this.baseUrl}/interrupt`,
          { method: 'POST' },
          Math.max(1, remaining())
        );
        if (!interruptRes.ok || remaining() <= 0) return false;

        const stopped = await this.waitForPromptToStop(promptId, remaining());
        if (stopped) GpuLeaseService.confirmPromptStopped(promptId);
        return stopped;
      }

      // The queue is authoritative for ownership. If the prompt is no longer pending
      // or running, it is safe to clear the lease guard without a blind interrupt.
      GpuLeaseService.confirmPromptStopped(promptId);
      return true;
    } catch (err) {
      logger.warn(`Failed to cancel ComfyUI prompt ${promptId}: ${err}`);
      return false;
    }
  }
}
