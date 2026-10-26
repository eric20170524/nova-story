import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import http from 'http';
import https from 'https';
import { logger } from '../../core/logging';
import { SettingsManager } from '../../core/settings_manager';
import { ComfyPromptOwnershipService } from '../ai/comfy_prompt_ownership_service';
import { ComfyUIService, type ComfyUIAuthConfig } from '../ai/comfyui_service';
import { GpuLeaseService } from '../gpu_lease_service';

export interface ComfyH3ProviderOptions {
  baseUrl?: string;
  clientId?: string;
  auth?: ComfyUIAuthConfig;
  isRemote?: boolean;
  comfyService?: ComfyUIService;
}

export interface ComfyVideoOutput {
  filename: string;
  subfolder?: string;
  type?: string;
  buffer: Buffer;
}

export class ComfyH3Provider {
  private baseUrl: string;
  private clientId: string;
  private wsUrl: string;
  private origin: string;
  public readonly comfyService: ComfyUIService;
  private promptOwnership: ComfyPromptOwnershipService;

  constructor(options: ComfyH3ProviderOptions = {}) {
    const settings = SettingsManager.loadSettings();
    const comfySettings = settings.comfyui || {};
    const mode = comfySettings.mode === 'remote' ? 'remote' : 'local';
    const isLoopback = (url: string) => {
      try {
        const h = new URL(url).hostname.toLowerCase();
        return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1';
      } catch {
        return false;
      }
    };
    const isRemote = options.isRemote ?? (
      options.baseUrl ? (!isLoopback(options.baseUrl) && mode === 'remote') : (mode === 'remote')
    );

    let configuredBase: string;
    if (options.baseUrl) {
      configuredBase = options.baseUrl;
    } else if (isRemote) {
      configuredBase = comfySettings.remote_base_url || comfySettings.base_url || process.env.COMFYUI_REMOTE_URL || '';
    } else {
      configuredBase = comfySettings.local_base_url || comfySettings.base_url || 'http://127.0.0.1:8188';
    }

    this.baseUrl = configuredBase.replace(/\/$/, '');
    this.clientId = options.clientId || randomUUID();
    this.wsUrl = this.baseUrl.replace('http://', 'ws://').replace('https://', 'wss://') + `/ws?clientId=${this.clientId}`;
    try {
      this.origin = new URL(this.baseUrl).origin;
    } catch {
      this.origin = this.baseUrl;
    }

    const auth = options.auth ?? (isRemote ? {
      username: comfySettings.remote_username || process.env.COMFYUI_REMOTE_USERNAME || '',
      password: comfySettings.remote_password || process.env.COMFYUI_REMOTE_PASSWORD || ''
    } : undefined);

    this.comfyService = options.comfyService || new ComfyUIService(this.baseUrl, { auth, isRemote });
    this.promptOwnership = new ComfyPromptOwnershipService(this.baseUrl, this.comfyService);
  }

  static fromSettings(comfySettings?: any): ComfyH3Provider {
    const settings = comfySettings || SettingsManager.loadSettings().comfyui || {};
    const mode = settings.mode === 'remote' ? 'remote' : 'local';
    const isRemote = mode === 'remote';

    if (isRemote) {
      const baseUrl = settings.remote_base_url || settings.base_url || process.env.COMFYUI_REMOTE_URL || '';
      return new ComfyH3Provider({
        baseUrl,
        isRemote: true,
        auth: {
          username: settings.remote_username || process.env.COMFYUI_REMOTE_USERNAME || '',
          password: settings.remote_password || process.env.COMFYUI_REMOTE_PASSWORD || ''
        }
      });
    }

    const baseUrl = settings.local_base_url || settings.base_url || 'http://127.0.0.1:8188';
    return new ComfyH3Provider({
      baseUrl,
      isRemote: false
    });
  }

  private async fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
    return this.comfyService.authenticatedFetch(url, init, timeoutMs);
  }

  private static objectInfoCache = new Map<string, { data: Record<string, any>; expiresAt: number }>();

  async checkStatus(): Promise<boolean> {
    return this.comfyService.checkStatus();
  }

  async getObjectInfo(timeoutMs = 30000): Promise<Record<string, any> | null> {
    const canCache = this.comfyService.isRemote && process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test';
    if (canCache) {
      const cached = ComfyH3Provider.objectInfoCache.get(this.baseUrl);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
      }
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.comfyService.authenticatedFetch('/object_info', {}, timeoutMs);
        if (res.ok) {
          const data = (await res.json()) as Record<string, any>;
          if (canCache) {
            ComfyH3Provider.objectInfoCache.set(this.baseUrl, { data, expiresAt: Date.now() + 60_000 });
          }
          return data;
        }
      } catch {
        if (attempt === 1) await new Promise(r => setTimeout(r, 1000));
      }
    }
    return null;
  }

  async getQueue(timeoutMs = 3000): Promise<{ running: any[]; pending: any[] } | null> {
    return this.promptOwnership.getQueue(timeoutMs);
  }

  async getHistory(promptId: string): Promise<Record<string, any> | null> {
    try {
      const res = await this.comfyService.authenticatedFetch(`/history/${promptId}`, {}, 20000);
      if (res.ok) return (await res.json()) as Record<string, any>;
    } catch {
      /* offline */
    }
    return null;
  }

  async downloadFile(filename: string, subfolder = '', type = 'output'): Promise<Buffer | null> {
    const url = `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await this.comfyService.authenticatedFetch(url, {}, 30_000);
        if (res.ok) {
          const ab = await res.arrayBuffer();
          return Buffer.from(ab);
        }
        logger.warn(`Failed to download output ${filename} from ComfyUI (HTTP ${res.status}), attempt ${attempt}/3`);
      } catch (err) {
        logger.warn(`Failed to download output ${filename} from ComfyUI: ${err}, attempt ${attempt}/3`);
      }
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
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
      const isHttps = this.baseUrl.startsWith('https');
      class WsHeaderAgent extends (isHttps ? https.Agent : http.Agent) {
        addRequest(req: any, opt: any) {
          req.setHeader('Upgrade', 'WebSocket');
          return ((isHttps ? https.Agent.prototype : http.Agent.prototype) as any).addRequest.call(this, req, opt);
        }
      }

      let cookie: string | null = null;
      if (this.comfyService.isRemote) {
        cookie = await this.comfyService.authenticate(false).catch(() => null);
      }

      const wsHeaders: Record<string, string> = {};
      if (cookie) {
        wsHeaders['Cookie'] = cookie;
      }
      if (this.comfyService.isRemote) {
        wsHeaders['Origin'] = this.origin;
      }

      const wsOptions: any = { headers: wsHeaders };
      if (this.comfyService.isRemote) {
        wsOptions.agent = new WsHeaderAgent();
      }

      ws = new WebSocket(this.wsUrl, wsOptions);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 8000);
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

    let promptId = '';
    try {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          const submitRes = await this.fetchWithTimeout(`${this.baseUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow, client_id: this.clientId })
          }, 20_000);

          if (submitRes.ok) {
            const resJson = await submitRes.json() as Record<string, any>;
            promptId = String(resJson.prompt_id || '');
            if (promptId) break;
          }

          const errText = await submitRes.text().catch(() => '');
          logger.warn(`ComfyUI /prompt submit attempt ${attempt}/4 failed (${submitRes.status}): ${errText}`);
          if (attempt === 4) {
            ws.close();
            return { status: 'error', videos: [], error: `ComfyUI prompt queue error (${submitRes.status}): ${errText}` };
          }
        } catch (err: any) {
          logger.warn(`ComfyUI /prompt submit attempt ${attempt}/4 threw: ${err.message}`);
          if (attempt === 4) {
            ws.close();
            return { status: 'error', videos: [], error: `ComfyUI prompt queue error: ${err.message}` };
          }
        }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }

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
      const timeoutMs = options.timeoutMs ?? 6 * 60 * 60 * 1000;

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
            this.promptOwnership.confirmPromptStopped(promptId);
          } else {
            this.promptOwnership.watchPromptUntilStopped(promptId, 'H3');
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

        const fetchHistoryFallback = async (existingEntry?: Record<string, any>) => {
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              let entry = existingEntry;
              if (!entry) {
                const histRes = await this.fetchWithTimeout(`${this.baseUrl}/history/${promptId}`, {}, 20000);
                if (histRes.ok) {
                  const histData = await histRes.json() as Record<string, any>;
                  entry = histData[promptId];
                }
              }
              if (!entry) {
                if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
                continue;
              }
              const promptOutputs = entry.outputs || {};
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
              if (collectedVideos.length > 0) return;
            } catch (err) {
              logger.warn(`History fetch error attempt ${attempt}/3: ${err}`);
              if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
            }
          }
        };

        deadlineTimer = setTimeout(() => {
          // The task deadline itself stays hard-bounded: return immediately and let
          // cancellation run independently. The shared prompt ownership service keeps
          // the GPU lease guarded until queue absence is later proven.
          cleanup({
            status: 'error',
            error: `ComfyUI H3 execution exceeded deadline (${Math.round(timeoutMs / 1000)}s)`,
            promptStopped: false
          });
          void this.cancelPrompt(promptId, 5000);
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
                  if (collectedVideos.length > 0) {
                    cleanup({
                      status: 'completed',
                      promptStopped: true
                    });
                  }
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
            const histRes = await this.fetchWithTimeout(`${this.baseUrl}/history/${promptId}`, {}, 15000);
            if (!histRes.ok) return;
            const histData = await histRes.json() as Record<string, any>;
            if (histData[promptId]) {
              await fetchHistoryFallback(histData[promptId]);
              if (collectedVideos.length > 0) {
                cleanup({
                  status: 'completed',
                  promptStopped: true
                });
              } else {
                logger.warn(`Prompt ${promptId} present in ComfyUI history but video output not yet collected; will retry next cycle`);
              }
            }
          } catch {}
        }, 5000);

        ws!.on('close', () => {
          setTimeout(async () => {
            if (!isDone) {
              await fetchHistoryFallback();
              if (collectedVideos.length > 0) {
                cleanup({
                  status: 'completed',
                  promptStopped: true
                });
                return;
              }
              const stopped = await this.promptOwnership.waitForPromptToStop(promptId, 3000);
              if (!stopped) {
                logger.warn(
                  `ComfyUI H3 websocket closed while prompt ${promptId} is still active; waiting on history poll`
                );
                return;
              }
              await fetchHistoryFallback();
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
   * Backward-compatible boolean wrapper over the shared prompt ownership primitive.
   * true means the prompt is proven absent; false means GPU ownership remains guarded.
   */
  async cancelPrompt(promptId: string, timeoutMs = 5000): Promise<boolean> {
    const result = await this.promptOwnership.cancelPrompt(promptId, timeoutMs, 'H3');
    return result.ok;
  }
}
