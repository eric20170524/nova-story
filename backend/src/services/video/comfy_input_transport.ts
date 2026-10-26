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
  comfyEnabled?: boolean;
}): boolean => {
  if (options.mode === 'http') return true;
  if (options.mode === 'filesystem') return false;
  if (options.filesystemAvailable) return false;

  // Remote hosts cannot see NovaStory's local staging directory, so auto mode must
  // upload. For loopback, HTTP is used when Comfy is explicitly enabled; when it is
  // disabled (notably unit tests/offline development) retain the legacy local staging
  // path without injecting a network wait into unrelated flows.
  return !isLoopbackComfyUrl(options.baseUrl) || Boolean(options.comfyEnabled);
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
    auth?: { username?: string; password?: string };
    isRemote?: boolean;
    comfyService?: { authenticatedFetch: (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response> };
  }): Promise<ComfyInputUploadResult> {
    const baseUrl = options.baseUrl.replace(/\/$/, '');
    const timeoutMs = Math.max(500, options.timeoutMs ?? 60_000);
    const subfolder = String(options.subfolder ?? 'novastory').replace(/^\/+|\/+$/g, '');

    let uploadBuffer = options.buffer;
    let uploadMime = options.mimeType || 'application/octet-stream';
    if (options.isRemote && uploadBuffer.length > 400_000) {
      try {
        const sharp = (await import('sharp')).default;
        if (options.filename.toLowerCase().endsWith('.png')) {
          uploadBuffer = await sharp(uploadBuffer).png({ compressionLevel: 9, effort: 7 }).toBuffer();
          uploadMime = 'image/png';
        } else if (options.filename.toLowerCase().endsWith('.jpg') || options.filename.toLowerCase().endsWith('.jpeg')) {
          uploadBuffer = await sharp(uploadBuffer).jpeg({ quality: 95 }).toBuffer();
          uploadMime = 'image/jpeg';
        }
      } catch (err) {
        logger.warn(`Failed to optimize upload buffer with sharp: ${err}`);
      }
    }

    let lastError: any = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const form = new FormData();
        const blob = new Blob([uploadBuffer], {
          type: uploadMime
        });
        form.append('image', blob, options.filename);
        form.append('type', 'input');
        form.append('overwrite', 'true');
        if (subfolder && !options.isRemote) form.append('subfolder', subfolder);

        let response: Response;
        if (options.comfyService) {
          response = await options.comfyService.authenticatedFetch('/upload/image', {
            method: 'POST',
            body: form
          }, timeoutMs);
        } else if (options.isRemote || options.auth?.username) {
          const { ComfyUIService } = await import('../ai/comfyui_service');
          const svc = new ComfyUIService(baseUrl, {
            auth: options.auth,
            isRemote: options.isRemote
          });
          const assignedName = await svc.uploadImage(uploadBuffer, options.filename);
          return {
            name: assignedName,
            subfolder: '',
            type: 'input',
            inputName: assignedName
          };
        } else {
          response = await withTimeout(timeoutMs, async (signal) => {
            return fetch(`${baseUrl}/upload/image`, {
              method: 'POST',
              body: form,
              signal
            });
          });
        }

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(
            `ComfyUI reference upload failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`
          );
        }

        const payload = await response.json() as Record<string, unknown>;
        const name = String(payload.name || '').trim();
        const returnedSubfolder = typeof payload.subfolder === 'string'
          ? payload.subfolder.replace(/^\/+|\/+$/g, '')
          : String(subfolder || '').replace(/^\/+|\/+$/g, '');
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
      } catch (err: any) {
        lastError = err;
        logger.warn(`Reference upload attempt ${attempt}/3 failed: ${err.message}`);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
    throw lastError;
  }
}
