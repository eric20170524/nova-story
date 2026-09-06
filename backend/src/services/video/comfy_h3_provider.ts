import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../core/logging';
import { SettingsManager } from '../../core/settings_manager';

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

export class ComfyH3Provider {
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

  async checkStatus(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`${this.baseUrl}/system_stats`, { signal: controller.signal });
      clearTimeout(id);
      return res.ok;
    } catch {
      return false;
    }
  }

  async getObjectInfo(): Promise<Record<string, any> | null> {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${this.baseUrl}/object_info`, { signal: controller.signal });
      clearTimeout(id);
      if (res.ok) {
        return (await res.json()) as Record<string, any>;
      }
    } catch {
      /* ComfyUI offline or unreachable */
    }
    return null;
  }

  async getQueue(): Promise<{ running: any[]; pending: any[] } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/queue`);
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
      const res = await fetch(`${this.baseUrl}/history/${promptId}`);
      if (res.ok) {
        return (await res.json()) as Record<string, any>;
      }
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
      const submitRes = await fetch(`${this.baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: this.clientId })
      });

      if (!submitRes.ok) {
        const errText = await submitRes.text();
        ws.close();
        return { status: 'error', videos: [], error: `ComfyUI prompt queue error (${submitRes.status}): ${errText}` };
      }

      const resJson = await submitRes.json() as Record<string, any>;
      const promptId = resJson.prompt_id;
      if (!promptId) {
        ws.close();
        return { status: 'error', videos: [], error: 'No prompt_id returned from ComfyUI' };
      }

      if (options.onPromptQueued) {
        await options.onPromptQueued(promptId);
      }

      const collectedVideos: ComfyVideoOutput[] = [];

      return new Promise((resolve) => {
        let isDone = false;
        let pollInterval: any = null;

        const cleanup = (result: { status: 'completed' | 'error' | 'cancelled'; error?: string }) => {
          if (isDone) return;
          isDone = true;
          if (pollInterval) clearInterval(pollInterval);
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

        ws!.on('message', async (raw: any) => {
          try {
            const msg = JSON.parse(raw.toString());
            const msgType = msg.type;
            const data = msg.data || {};

            if (msgType === 'execution_start' && data.prompt_id === promptId) {
              options.onProgress?.({ stage: 'generating', message: 'H3 execution started in ComfyUI' });
            } else if (msgType === 'progress' && data.value && data.max) {
              options.onProgress?.({ stage: 'generating', current: data.value, total: data.max });
            } else if (msgType === 'executing') {
              if (!data.node && (!data.prompt_id || data.prompt_id === promptId)) {
                setTimeout(async () => {
                  // Fallback query history if no outputs received directly
                  if (collectedVideos.length === 0) {
                    await fetchHistoryFallback();
                  }
                  cleanup({ status: collectedVideos.length > 0 ? 'completed' : 'error', error: collectedVideos.length === 0 ? 'No video outputs collected' : undefined });
                }, 1000);
              }
            } else if (msgType === 'executed' && data.prompt_id === promptId) {
              const output = data.output || {};
              const videoList = output.videos || output.gifs || output.images || [];
              for (const v of videoList) {
                const buffer = await this.downloadFile(v.filename, v.subfolder, v.type);
                if (buffer) {
                  collectedVideos.push({
                    filename: v.filename,
                    subfolder: v.subfolder,
                    type: v.type,
                    buffer
                  });
                }
              }
            } else if (msgType === 'execution_error' && (!data.prompt_id || data.prompt_id === promptId)) {
              cleanup({ status: 'error', error: `ComfyUI Execution Error: ${data.exception_message || 'unknown'}` });
            } else if (msgType === 'execution_interrupted' && (!data.prompt_id || data.prompt_id === promptId)) {
              cleanup({ status: 'cancelled', error: 'ComfyUI execution interrupted' });
            }
          } catch (e) {
            // Ignore parse errors
          }
        });

        const fetchHistoryFallback = async () => {
          try {
            const histRes = await fetch(`${this.baseUrl}/history/${promptId}`);
            if (histRes.ok) {
              const histData = await histRes.json() as Record<string, any>;
              const promptOutputs = histData[promptId]?.outputs || {};
              for (const nodeId of Object.keys(promptOutputs)) {
                const nodeOut = promptOutputs[nodeId];
                const list = nodeOut.videos || nodeOut.gifs || nodeOut.images || [];
                for (const item of list) {
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
            }
          } catch (e) {
            logger.warn(`History fetch error: ${e}`);
          }
        };

        pollInterval = setInterval(async () => {
          try {
            const histRes = await fetch(`${this.baseUrl}/history/${promptId}`);
            if (histRes.ok) {
              const histData = await histRes.json() as Record<string, any>;
              if (histData[promptId]) {
                await fetchHistoryFallback();
                cleanup({ status: collectedVideos.length > 0 ? 'completed' : 'error' });
              }
            }
          } catch {}
        }, 5000);

        ws!.on('close', () => {
          setTimeout(async () => {
            if (!isDone) {
              await fetchHistoryFallback();
              cleanup({ status: collectedVideos.length > 0 ? 'completed' : 'error' });
            }
          }, 1500);
        });
      });
    } catch (err: any) {
      if (ws) ws.close();
      return { status: 'error', videos: [], error: String(err?.message || err) };
    }
  }

  async cancelPrompt(promptId: string): Promise<boolean> {
    try {
      await fetch(`${this.baseUrl}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] })
      });
      await fetch(`${this.baseUrl}/interrupt`, { method: 'POST' });
      return true;
    } catch {
      return false;
    }
  }
}
