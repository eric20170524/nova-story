import { Blob } from 'node:buffer';
import { logger } from '../../core/logging';

export type ComfyReferenceTransportMode = 'auto' | 'filesystem' | 'http';

export type ComfyInputUploadResult = {
  name: string;
  subfolder: string;
  type: string;
  inputName: string;
};

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]'
]);

export const normalizeReferenceTransportMode = (value: unknown): ComfyReferenceTransportMode => {
  const normalized = String(value || 'auto').trim().toLowerCase();
  if (normalized === 'filesystem' || normalized === 'http') return normalized;
  return 'auto';
};

export const isLoopbackComfyUrl = (baseUrl: string): boolean => {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
};

export const shouldUseHttpReferenceTransport = (options: {
  mode: ComfyReferenceTransportMode;
  baseUrl: string;
  filesystemAvailable: boolean;
}): boolean => {
  if (options.mode === 'http') return true;
  if (options.mode === 'filesystem') return false;
  return !options.filesystemAvailable && !isLoopbackComfyUrl(options.baseUrl);
};

const withTimeout = async <T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * ComfyUI exposes reference/input uploads through POST /upload/image. Despite the
 * historical endpoint name, the server stores the multipart file bytes in the
 * selected input directory, which also makes it usable for VHS video references.
 */
export class ComfyInputTransport {
  static async uploadInput(options: {
    baseUrl: string;
    filename: string;
    buffer: Buffer;
    mimeType?: string | null;
    subfolder?: string;
    timeoutMs?: number;
  }): Promise<ComfyInputUploadResult> {
    const baseUrl = options.baseUrl.replace(/\/$/, '');
    const timeoutMs = Math.max(500, options.timeoutMs ?? 15_000);
    const subfolder = String(options.subfolder ?? 'novastory').replace(/^\/+|\/+$/g, '');

    const response = await withTimeout(timeoutMs, async (signal) => {
      const form = new FormData();
      const blob = new Blob([options.buffer], {
        type: options.mimeType || 'application/octet-stream'
      });
      form.append('image', blob, options.filename);
      form.append('type', 'input');
      form.append('overwrite', 'true');
      if (subfolder) form.append('subfolder', subfolder);

      return fetch(`${baseUrl}/upload/image`, {
        method: 'POST',
        body: form,
        signal
      });
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `ComfyUI reference upload failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`
      );
    }

    const payload = await response.json() as Record<string, unknown>;
    const name = String(payload.name || '').trim();
    const returnedSubfolder = String(payload.subfolder || subfolder || '').replace(/^\/+|\/+$/g, '');
    const type = String(payload.type || 'input');
    if (!name) {
      throw new Error('ComfyUI reference upload did not return a file name');
    }

    const inputName = returnedSubfolder ? `${returnedSubfolder}/${name}` : name;
    logger.info(`Uploaded NovaStory reference to ComfyUI input: ${inputName}`);
    return {
      name,
      subfolder: returnedSubfolder,
      type,
      inputName
    };
  }
}
