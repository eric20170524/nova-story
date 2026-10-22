import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { logger } from '../../core/logging';
import {
    ComfyPromptOwnershipService,
    type ComfyPromptCancelResult
} from './comfy_prompt_ownership_service';
import { GpuLeaseService } from '../gpu_lease_service';
import { AssetTaskStore } from '../task_store';
import { getDataDirectory } from '../../core/paths';
import { ComfyStartupCoordinator } from './comfy_startup';
const startupCoordinator=new ComfyStartupCoordinator();

export interface ComfyUIAuthConfig {
    username?: string;
    password?: string;
}

export interface ComfyUIServiceOptions {
    auth?: ComfyUIAuthConfig;
    isRemote?: boolean;
}

/** A dropped download can be repeated. A real ComfyUI 4xx cannot. */
export function comfyDownloadShouldRetry(status: number | null, message: string, attempt: number, limit = 3): boolean {
    if (attempt >= limit) return false;
    if (status === 502 || status === 522 || status === 524 || status === 525) return true;
    return /\bterminated\b|\b52[245]\b|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message || '');
}

/** EdgeOne/Cloudflare handshake and origin timeouts. A real ComfyUI 4xx is not retried. */
export function comfyPromptGiveUp(status: number, attempt: number, limit = 3): boolean {
    const gateway = status === 522 || status === 524 || status === 525;
    return !gateway || attempt >= limit;
}

/** LoadImage stores a basename, while project plates live under static/generated/. */
export function resolveComfyReferenceFile(staticDir: string, imageName: string): string | null {
    const raw = String(imageName || '').trim();
    if (!raw || !staticDir) return null;
    const base = path.basename(raw);
    const relative = raw.replace(/^\/static\//, '').replace(/^static\//, '');
    const candidates = [
        path.isAbsolute(raw) ? raw : '',
        path.join(staticDir, relative),
        path.join(staticDir, base),
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        } catch {
            /* try the next candidate */
        }
    }
    const seen = new Set<string>();
    const stack = [staticDir];
    while (stack.length) {
        const dir = stack.pop()!;
        if (seen.has(dir)) continue;
        seen.add(dir);
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile() && entry.name === base) return full;
        }
    }
    return null;
}

type RemoteLoraCatalogSource = {
    isRemote: boolean;
    authenticatedFetch: (endpoint: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;
};

export interface RemoteModelCatalog {
    remote_lora_names?: string[];
    remote_unet_names?: string[];
    remote_clip_names?: string[];
    remote_vae_names?: string[];
}

/**
 * Portrait and turnaround compile through different callers. Both must see the
 * live LoraLoader / UNETLoader / CLIPLoader / VAELoader lists so a missing style LoRA
 * or precision variant is reconciled before submission.
 */
export async function applyRemoteLoraCatalog<T extends { comfyui?: Record<string, unknown> }>(
    settings: T,
    service: RemoteLoraCatalogSource,
): Promise<T & { comfyui: NonNullable<T['comfyui']> & RemoteModelCatalog }> {
    if (!service.isRemote) return settings as T & { comfyui: NonNullable<T['comfyui']> & RemoteModelCatalog };
    let remoteLoraNames: string[] = [];
    let remoteUnetNames: string[] | undefined;
    let remoteClipNames: string[] | undefined;
    let remoteVaeNames: string[] | undefined;
    try {
        const infoRes = await service.authenticatedFetch('/object_info', {}, 8000);
        if (infoRes.ok) {
            const info = await infoRes.json();
            remoteLoraNames = loraNamesFromObjectInfo(info);
            remoteUnetNames = unetNamesFromObjectInfo(info);
            remoteClipNames = clipNamesFromObjectInfo(info);
            remoteVaeNames = vaeNamesFromObjectInfo(info);
        }
    } catch (error) {
        logger.warn(`Remote LoRA catalog unavailable: ${error}`);
    }
    return {
        ...settings,
        comfyui: {
            ...(settings.comfyui || {}),
            remote_lora_names: remoteLoraNames,
            ...(remoteUnetNames ? { remote_unet_names: remoteUnetNames } : {}),
            ...(remoteClipNames ? { remote_clip_names: remoteClipNames } : {}),
            ...(remoteVaeNames ? { remote_vae_names: remoteVaeNames } : {}),
        } as NonNullable<T['comfyui']> & RemoteModelCatalog,
    };
}

const loaderChoicesFromObjectInfo = (
    objectInfo: unknown,
    loaderNode: string,
    inputField: string,
): string[] => {
    const raw = (objectInfo as Record<string, { input?: { required?: Record<string, unknown[]> } }> | null | undefined)
        ?.[loaderNode]?.input?.required?.[inputField]?.[0];
    return Array.isArray(raw) ? raw.map((name) => String(name)).filter(Boolean) : [];
};

export function loraNamesFromObjectInfo(objectInfo: unknown): string[] {
    return loaderChoicesFromObjectInfo(objectInfo, 'LoraLoader', 'lora_name');
}

export function unetNamesFromObjectInfo(objectInfo: unknown): string[] {
    return loaderChoicesFromObjectInfo(objectInfo, 'UNETLoader', 'unet_name');
}

export function clipNamesFromObjectInfo(objectInfo: unknown): string[] {
    return loaderChoicesFromObjectInfo(objectInfo, 'CLIPLoader', 'clip_name');
}

export function vaeNamesFromObjectInfo(objectInfo: unknown): string[] {
    return loaderChoicesFromObjectInfo(objectInfo, 'VAELoader', 'vae_name');
}

/**
 * A proxy can close the websocket while ComfyUI is still rendering.
 * Finish only after the prompt has left the queue. Otherwise keep the history poll.
 */
export function comfySocketDropShouldFinish(promptStopped: boolean): boolean {
    return promptStopped;
}

/** A history row can exist because validation failed. That is not a finished image. */
export function comfyHistoryFailure(entry: { status?: { status_str?: string; messages?: unknown[] } } | null | undefined): string | null {
    if (!entry || entry.status?.status_str !== 'error') return null;
    const messages = Array.isArray(entry.status.messages) ? entry.status.messages : [];
    for (const message of messages) {
        const body = (Array.isArray(message) ? message[1] : message) as { node_type?: string; exception_message?: string } | undefined;
        if (body?.exception_message) {
            const node = body.node_type || 'node';
            return `ComfyUI Error [${node}]: ${String(body.exception_message).slice(0, 400)}`;
        }
    }
    return 'ComfyUI prompt failed';
}

interface SessionCacheEntry {
    cookie: string;
    expiresAt: number;
    username: string;
    baseUrl: string;
}

export class ComfyUIService {
    public readonly baseUrl: string;
    public readonly isRemote: boolean;
    private auth?: ComfyUIAuthConfig;
    private clientId: string;
    private wsUrl: string;
    private origin: string;
    private promptOwnership: ComfyPromptOwnershipService;

    private static sessionMemoryCache = new Map<string, SessionCacheEntry>();

    private static getSessionCacheFilePath(): string {
        return path.join(getDataDirectory(), 'comfy_remote_session.json');
    }

    private static loadCachedSession(cacheKey: string): SessionCacheEntry | null {
        if (ComfyUIService.sessionMemoryCache.has(cacheKey)) {
            return ComfyUIService.sessionMemoryCache.get(cacheKey)!;
        }
        try {
            const filePath = ComfyUIService.getSessionCacheFilePath();
            if (fs.existsSync(filePath)) {
                const raw = fs.readFileSync(filePath, 'utf-8');
                const data = JSON.parse(raw);
                if (data && data[cacheKey]) {
                    const entry = data[cacheKey] as SessionCacheEntry;
                    ComfyUIService.sessionMemoryCache.set(cacheKey, entry);
                    return entry;
                }
            }
        } catch {
            // ignore
        }
        return null;
    }

    private static saveCachedSession(cacheKey: string, entry: SessionCacheEntry) {
        ComfyUIService.sessionMemoryCache.set(cacheKey, entry);
        try {
            const filePath = ComfyUIService.getSessionCacheFilePath();
            let data: Record<string, any> = {};
            if (fs.existsSync(filePath)) {
                try {
                    data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) || {};
                } catch {}
            }
            data[cacheKey] = entry;
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch {
            // ignore
        }
    }

    private static clearCachedSession(cacheKey: string) {
        ComfyUIService.sessionMemoryCache.delete(cacheKey);
        try {
            const filePath = ComfyUIService.getSessionCacheFilePath();
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) || {};
                delete data[cacheKey];
                fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
            }
        } catch {}
    }

    constructor(baseUrl: string, options?: ComfyUIServiceOptions) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.clientId = randomUUID();
        this.wsUrl = this.baseUrl.replace('http://', 'ws://').replace('https://', 'wss://') + `/ws?clientId=${this.clientId}`;
        this.promptOwnership = new ComfyPromptOwnershipService(this.baseUrl, this);
        try {
            this.origin = new URL(this.baseUrl).origin;
        } catch {
            this.origin = this.baseUrl;
        }
        this.auth = options?.auth;
        this.isRemote = options?.isRemote ?? (this.baseUrl.startsWith('https://') || Boolean(this.auth?.username));
    }

    /**
     * Build service instance from comfyui settings object.
     * Respects local vs remote mode switch and configures credentials automatically.
     */
    static fromSettings(comfySettings: any): ComfyUIService {
        const settings = comfySettings || {};
        const mode = settings.mode === 'remote' ? 'remote' : 'local';
        const isRemote = mode === 'remote';

        if (isRemote) {
            const baseUrl = settings.remote_base_url || settings.base_url || process.env.COMFYUI_REMOTE_URL || '';
            return new ComfyUIService(baseUrl, {
                isRemote: true,
                auth: {
                    username: settings.remote_username || process.env.COMFYUI_REMOTE_USERNAME || '',
                    password: settings.remote_password || process.env.COMFYUI_REMOTE_PASSWORD || ''
                }
            });
        }

        const baseUrl = settings.local_base_url || settings.base_url || 'http://127.0.0.1:8188';
        return new ComfyUIService(baseUrl, {
            isRemote: false
        });
    }

    /**
     * Authenticate against remote ComfyUI instance (e.g. suanli console).
     * Uses persistent cache to avoid rate limiting (429).
     */
    async authenticate(force = false): Promise<string | null> {
        if (!this.auth?.username || !this.auth?.password) {
            return null;
        }

        const cacheKey = `${this.baseUrl}::${this.auth.username}`;

        if (!force) {
            const cached = ComfyUIService.loadCachedSession(cacheKey);
            if (cached && cached.expiresAt > Date.now()) {
                return cached.cookie;
            }
        }

        logger.info(`Authenticating with remote ComfyUI at ${this.baseUrl} (user: ${this.auth.username})...`);

        const loginUrl = `${this.baseUrl}/api/v1/auth/login`;

        const res = await fetch(loginUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': this.origin,
                'Referer': `${this.origin}/`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            body: JSON.stringify({
                username: this.auth.username,
                password: this.auth.password,
                admin_only: false
            })
        });

        if (res.status === 429) {
            throw new Error('远程 ComfyUI 登录请求过于频繁 (429 Too Many Requests)，请稍后重试');
        }

        if (res.status === 401 || res.status === 403) {
            throw new Error('远程 ComfyUI 用户名或密码错误');
        }

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`远程 ComfyUI 登录失败 (${res.status}): ${errText || res.statusText}`);
        }

        const getSetCookie = (res.headers as any).getSetCookie?.() || [];
        let cookieStr = getSetCookie[0] || res.headers.get('set-cookie') || '';
        if (!cookieStr) {
            throw new Error('远程 ComfyUI 登录未返回 Session Cookie');
        }
        const sessionCookie = cookieStr.split(';')[0].trim();

        // Expire in 13 days (server max-age is 14 days)
        const expiresAt = Date.now() + 13 * 24 * 3600 * 1000;
        ComfyUIService.saveCachedSession(cacheKey, {
            cookie: sessionCookie,
            expiresAt,
            username: this.auth.username,
            baseUrl: this.baseUrl
        });

        logger.info(`Successfully authenticated with remote ComfyUI (${this.auth.username})`);
        return sessionCookie;
    }

    private async fetchWithTimeout(
        url: string,
        init: RequestInit = {},
        timeoutMs: number = 5000
    ): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
        try {
            return await fetch(url, { ...init, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Authenticated fetch helper for ComfyUI HTTP endpoints.
     * Automatically handles cookies, origin headers, and session invalidation/retry.
     */
    async authenticatedFetch(endpointOrUrl: string, init?: RequestInit, timeoutMs: number = 10_000): Promise<Response> {
        const url = endpointOrUrl.startsWith('http://') || endpointOrUrl.startsWith('https://')
            ? endpointOrUrl
            : `${this.baseUrl}${endpointOrUrl.startsWith('/') ? '' : '/'}${endpointOrUrl}`;

        const doFetch = async (cookie?: string | null) => {
            const headers = new Headers(init?.headers);
            if (this.isRemote) {
                headers.set('Origin', this.origin);
                headers.set('Referer', `${this.origin}/`);
            }
            if (cookie) {
                headers.set('Cookie', cookie);
            }
            return this.fetchWithTimeout(url, { ...init, headers }, timeoutMs);
        };

        let cookie: string | null = null;
        if (this.auth?.username && this.auth?.password) {
            try {
                cookie = await this.authenticate(false);
            } catch (authErr) {
                logger.warn(`Remote ComfyUI auth failed before fetch: ${authErr}`);
            }
        }

        let res = await doFetch(cookie);

        if (
            this.auth?.username &&
            this.auth?.password &&
            (res.status === 401 || (res.status === 302 && (res.headers.get('location') || '').includes('/auth')))
        ) {
            logger.warn(`Remote ComfyUI session expired or invalid (HTTP ${res.status}), re-authenticating...`);
            const cacheKey = `${this.baseUrl}::${this.auth.username}`;
            ComfyUIService.clearCachedSession(cacheKey);
            cookie = await this.authenticate(true);
            res = await doFetch(cookie);
        }

        return res;
    }

    async checkStatus(): Promise<boolean> {
        try {
            const response = await this.authenticatedFetch('/system_stats', {}, 3000);
            return response.ok;
        } catch {
            return false;
        }
    }

    async fetchSystemStats(): Promise<any> {
        try {
            const res = await this.authenticatedFetch('/system_stats', {}, 8000);
            if (!res.ok) {
                throw new Error(`ComfyUI /system_stats failed with status ${res.status}`);
            }
            return await res.json();
        } catch (err) {
            throw err;
        }
    }

    // Cold start after the text model releases this 12GB GPU often takes longer than 45s.
    async ensureRunning(installPath?: string, timeoutMs: number = 300_000): Promise<boolean> {
        if (await this.checkStatus()) return true;

        if (this.isRemote) {
            // The 3s status probe often dies on an EdgeOne 522. One longer stats read is the same check the settings probe uses.
            try {
                await this.fetchSystemStats();
                return true;
            } catch (err) {
                logger.error(`Remote ComfyUI at ${this.baseUrl} is unreachable or not responding: ${err}`);
                return false;
            }
        }

        if (!installPath) return false;

        const mainFile = path.join(installPath, 'main.py');
        if (!fs.existsSync(mainFile)) {
            logger.error(`ComfyUI main.py was not found at ${mainFile}`);
            return false;
        }

        const parentDirectory = path.dirname(installPath);
        const pythonCandidates = [
            path.join(installPath, 'venv', 'Scripts', 'python.exe'),
            path.join(installPath, '.venv', 'Scripts', 'python.exe'),
            path.join(installPath, 'python_embeded', 'python.exe'),
            path.join(parentDirectory, 'python_embeded', 'python.exe')
        ];
        const pythonExecutable = pythonCandidates.find((candidate) => fs.existsSync(candidate));
        if (!pythonExecutable) {
            logger.error(`No ComfyUI Python runtime was found under ${installPath}`);
            return false;
        }

        const parsedUrl = new URL(this.baseUrl);
        return startupCoordinator.ensure(this.baseUrl,()=>this.checkStatus(),()=>{
        const logDirectory=path.join(getDataDirectory(),'logs');fs.mkdirSync(logDirectory,{recursive:true});
        const startupLog=path.join(logDirectory,'comfy-startup.log'), logFd=fs.openSync(startupLog,'a');
        let process: ReturnType<typeof spawn>;
        try { process = spawn(
            pythonExecutable,
            [
                mainFile,
                '--listen',
                parsedUrl.hostname || '127.0.0.1',
                '--port',
                parsedUrl.port || '8188',
                '--lowvram',
                '--disable-pinned-memory',
                '--cache-none'
            ],
            {
                cwd: installPath,
                detached: true,
                stdio: ['ignore',logFd,logFd],
                windowsHide: true
            }
        ); } finally { fs.closeSync(logFd); }
        let failed=false;process.on('error',error=>{failed=true;logger.error({error,startupLog},'ComfyUI startup failed');});
        process.unref();
        return {alive:()=>!failed&&process.exitCode===null&&process.signalCode===null};
        },timeoutMs);
    }

    async generateImage(
        workflow: any,
        progressCallback?: (type: string, data: any) => void,
        options?: {
            onPromptQueued?: (promptId: string) => void | Promise<void>;
            timeoutMs?: number;
        }
    ): Promise<{ status: string; message?: string; images?: any[]; prompt_id?: string }> {
        logger.info(`Generating image via ComfyUI with workflow: ${JSON.stringify(workflow).substring(0, 50)}...`);

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
            if (this.auth?.username && this.auth?.password) {
                cookie = await this.authenticate(false);
            }

            const wsHeaders: Record<string, string> = {};
            if (cookie) {
                wsHeaders['Cookie'] = cookie;
            }
            if (this.isRemote) {
                wsHeaders['Origin'] = this.origin;
            }

            const wsOptions: any = {
                headers: wsHeaders
            };
            if (this.isRemote) {
                wsOptions.agent = new WsHeaderAgent();
            }

            ws = new WebSocket(this.wsUrl, wsOptions);

            await new Promise<void>((resolve, reject) => {
                ws!.on('open', resolve);
                ws!.on('error', reject);
            });
            logger.info('Connected to ComfyUI WebSocket');
        } catch (error) {
            logger.error(`Failed to connect to ComfyUI WebSocket: ${error}`);
            return { status: 'error', message: `Connection Refused: ${error}` };
        }

        try {
            let promptId: string | null = null;

            // Image Comfy submission is only legal while a canonical processing task
            // owns the single shared GPU lease. This fails closed if a cancellation or
            // ownership handoff happened earlier in the pipeline.
            const activeLeaseBeforeSubmit = GpuLeaseService.getCurrentLease();
            if (!activeLeaseBeforeSubmit || activeLeaseBeforeSubmit.kind !== 'image') {
                ws.close();
                return {
                    status: 'error',
                    message: 'Refusing ComfyUI image prompt submission without an active image GPU lease'
                };
            }

            const ownerTaskId = activeLeaseBeforeSubmit.owner_task_id;
            const taskBeforeSubmit = await AssetTaskStore.get(ownerTaskId);
            if (!taskBeforeSubmit || taskBeforeSubmit.status !== 'processing') {
                ws.close();
                return {
                    status: 'error',
                    message: taskBeforeSubmit
                        ? `Image task ${taskBeforeSubmit.task_id} is ${taskBeforeSubmit.status}; refusing ComfyUI prompt submission`
                        : `Image GPU owner ${ownerTaskId} has no canonical generation_task; refusing ComfyUI prompt submission`
                };
            }

            const submitPrompt = () => this.authenticatedFetch('/prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: workflow, client_id: this.clientId })
            }, 30_000);

            let response = await submitPrompt();
            let attempt = 1;
            while (!response.ok && !comfyPromptGiveUp(response.status, attempt)) {
                const body = (await response.text()).trim();
                logger.error(`ComfyUI /prompt Error: ${response.status} - ${body}`);
                const stillOwner = await AssetTaskStore.get(ownerTaskId);
                if (!stillOwner || stillOwner.status !== 'processing') {
                    ws.close();
                    return { status: 'error', message: `Queue failed: ${body || `HTTP ${response.status}`}` };
                }
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
                attempt += 1;
                response = await submitPrompt();
            }

            if (!response.ok) {
                const errText = (await response.text()).trim();
                logger.error(`ComfyUI /prompt Error: ${response.status} - ${errText}`);
                ws.close();
                return { status: 'error', message: `Queue failed: ${errText || `HTTP ${response.status}`}` };
            }

            const respData = await response.json() as Record<string, any>;
            promptId = String(respData.prompt_id || '');
            logger.info(`Workflow queued. Prompt ID: ${promptId}`);

            if (!promptId) {
                ws.close();
                return { status: 'error', message: 'No prompt_id received' };
            }

            const activeLease = GpuLeaseService.getCurrentLease();
            if (
                !activeLease
                || activeLease.kind !== 'image'
                || activeLease.owner_task_id !== ownerTaskId
            ) {
                // The request reached Comfy but ownership changed before prompt_id was
                // returned. We cannot let this orphan prompt run unguarded. Cancel it
                // scoped by id and fail closed; if stop cannot be confirmed, retain a
                // background ownership observer.
                const cancellation = await this.cancelExecution(promptId, 5000);
                if (!cancellation.ok) {
                    this.promptOwnership.watchPromptUntilStopped(promptId, 'Image');
                }
                ws.close();
                return {
                    status: 'error',
                    prompt_id: promptId,
                    message: `GPU ownership changed while submitting image prompt ${promptId}; prompt cancellation ${cancellation.ok ? 'confirmed' : 'not confirmed'}`
                };
            }

            GpuLeaseService.guardLeaseForPrompt(ownerTaskId, promptId);

            try {
                await options?.onPromptQueued?.(promptId);
            } catch (e) {
                // The prompt already exists. Keep ownership guarded even if metadata
                // persistence fails; cancellation/recovery must still own the GPU.
                logger.warn(`onPromptQueued hook failed: ${e}`);
            }

            // Cancellation can land while POST /prompt is in flight, before the
            // prompt_id callback is persisted. The route intentionally retains the
            // image lease in that window. Re-check canonical lifecycle now that the
            // real prompt id is known and cancel that exact prompt if necessary.
            const taskAfterSubmit = await AssetTaskStore.get(ownerTaskId);
            if (!taskAfterSubmit || taskAfterSubmit.status !== 'processing') {
                const cancellation = await this.cancelExecution(promptId, 5000);
                if (!cancellation.ok) {
                    this.promptOwnership.watchPromptUntilStopped(promptId, 'Image');
                }
                ws.close();
                return {
                    status: 'error',
                    prompt_id: promptId,
                    message: taskAfterSubmit
                        ? `Image task ${ownerTaskId} became ${taskAfterSubmit.status} during prompt submission; prompt cancellation ${cancellation.ok ? 'confirmed' : 'not confirmed'}`
                        : `Image task ${ownerTaskId} disappeared during prompt submission; prompt cancellation ${cancellation.ok ? 'confirmed' : 'not confirmed'}`
                };
            }

            const generatedImages: any[] = [];
            const pendingDownloads: Promise<any>[] = [];
            const timeoutMs = options?.timeoutMs ?? 15 * 60 * 1000;
            let cachedHistoryEntry: Record<string, any> | null = null;
            const absorbHistoryOutputs = async (entry: Record<string, any> | null | undefined) => {
                const promptOutput = entry?.outputs || {};
                for (const nodeId of Object.keys(promptOutput)) {
                    const nodeOut = promptOutput[nodeId];
                    if (!nodeOut?.images) continue;
                    for (const imgInfo of nodeOut.images) {
                        const imgData = await this.downloadImage(
                            imgInfo.filename,
                            imgInfo.subfolder,
                            imgInfo.type
                        );
                        if (imgData) generatedImages.push({ filename: imgInfo.filename, data: imgData });
                    }
                }
            };

            return new Promise((resolve) => {
                let checkHistoryInterval: NodeJS.Timeout | null = null;
                let deadlineTimer: NodeJS.Timeout | null = null;
                let isFinished = false;

                const finish = async (
                    customResult?: { status: string; message?: string },
                    confirmedStopped = false
                ) => {
                    if (isFinished) return;
                    isFinished = true;
                    if (checkHistoryInterval) clearInterval(checkHistoryInterval);
                    if (deadlineTimer) clearTimeout(deadlineTimer);

                    // If finishing with failure/timeout before natural completion, confirm the
                    // prompt has stopped executing before leaving this method.
                    if (promptId) {
                        if (confirmedStopped || !customResult || customResult.status !== 'error') {
                            this.promptOwnership.confirmPromptStopped(promptId);
                        } else {
                            const stopped = await this.promptOwnership.waitForPromptToStop(promptId, 3000);
                            if (stopped) {
                                this.promptOwnership.confirmPromptStopped(promptId);
                            } else {
                                this.promptOwnership.watchPromptUntilStopped(promptId, 'Image');
                            }
                        }
                    }

                    try {
                        ws?.removeAllListeners();
                        ws?.close();
                    } catch {
                        /* ignore */
                    }

                    if (customResult) {
                        resolve({ ...customResult, prompt_id: promptId || undefined });
                        return;
                    }

                    if (pendingDownloads.length > 0) {
                        await Promise.allSettled(pendingDownloads);
                    }

                    if (generatedImages.length === 0 && cachedHistoryEntry) {
                        const failure = comfyHistoryFailure(cachedHistoryEntry);
                        if (failure) {
                            resolve({ status: 'error', message: failure, prompt_id: promptId || undefined });
                            return;
                        }
                        try { await absorbHistoryOutputs(cachedHistoryEntry); } catch (e) {
                            logger.error(`History output read error: ${e}`);
                        }
                    }
                    if (generatedImages.length === 0 && promptId) {
                        try {
                            const histRes = await this.authenticatedFetch(`/history/${promptId}`, {}, 20000);
                            if (histRes.ok) {
                                const historyData = await histRes.json() as Record<string, any>;
                                const entry = historyData[promptId];
                                const failure = comfyHistoryFailure(entry);
                                if (failure) {
                                    resolve({ status: 'error', message: failure, prompt_id: promptId || undefined });
                                    return;
                                }
                                await absorbHistoryOutputs(entry);
                            }
                        } catch (e) {
                            logger.error(`History fetch fallback error: ${e}`);
                        }
                    }
                    resolve({
                        status: generatedImages.length > 0 ? 'completed' : 'error',
                        message: generatedImages.length > 0 ? undefined : 'ComfyUI completed without image outputs',
                        images: generatedImages,
                        prompt_id: promptId || undefined
                    });
                };

                deadlineTimer = setTimeout(() => {
                    void finish(
                        {
                            status: 'error',
                            message: `ComfyUI image execution exceeded deadline (${Math.round(timeoutMs / 1000)}s)`
                        },
                        false
                    );
                    if (promptId) {
                        void this.cancelExecution(promptId, 5000).then((result) => {
                            if (!result.ok) {
                                this.promptOwnership.watchPromptUntilStopped(promptId!, 'Image');
                            }
                        });
                    }
                }, timeoutMs);

                ws!.on('error', (err) => {
                    logger.error(`ComfyUI WebSocket streaming error: ${err}`);
                    void finish({ status: 'error', message: `WebSocket error: ${err}` }, false);
                });

                ws!.on('message', async (data: any) => {
                    try {
                        const message = JSON.parse(data.toString());
                        const msgType = message.type;
                        const msgData = message.data || {};

                        if (msgType === 'execution_start' && msgData.prompt_id === promptId) {
                            logger.info('ComfyUI Execution Started');
                            if (progressCallback) progressCallback('started', {});
                        } else if (msgType === 'executing') {
                            const node = msgData.node;
                            if (node) {
                                if (progressCallback) progressCallback('progress', { node });
                            } else if (!msgData.prompt_id || msgData.prompt_id === promptId) {
                                logger.info('ComfyUI Execution Finished (Logic)');
                                setTimeout(() => void finish(undefined, true), 500);
                            }
                        } else if (msgType === 'executed' && msgData.prompt_id === promptId) {
                            const output = msgData.output || {};
                            if (output.images) {
                                for (const imgInfo of output.images) {
                                    logger.info(`Image generated: ${imgInfo.filename}`);
                                    const dlPromise = (async () => {
                                        const imgData = await this.downloadImage(
                                            imgInfo.filename,
                                            imgInfo.subfolder || '',
                                            imgInfo.type || 'output'
                                        );
                                        if (imgData) {
                                            generatedImages.push({ filename: imgInfo.filename, data: imgData });
                                        }
                                    })();
                                    pendingDownloads.push(dlPromise);
                                }
                            }
                        } else if (msgType === 'progress') {
                            if (progressCallback && msgData.value && msgData.max) {
                                progressCallback('progress', { current: msgData.value, total: msgData.max });
                            }
                        } else if (msgType === 'execution_error') {
                            if (!msgData.prompt_id || msgData.prompt_id === promptId) {
                                const errStr = `ComfyUI Error [${msgData.node_type}]: ${msgData.exception_message}`;
                                logger.error(errStr);
                                void finish({ status: 'error', message: errStr }, true);
                            }
                        } else if (msgType === 'execution_interrupted') {
                            if (!msgData.prompt_id || msgData.prompt_id === promptId) {
                                logger.info('ComfyUI Execution Interrupted');
                                void finish({ status: 'error', message: 'Generation interrupted' }, true);
                            }
                        }
                    } catch {
                        // Ignore unrelated / malformed websocket messages.
                    }
                });

                ws!.on('close', () => {
                    logger.warn('WebSocket closed');
                    setTimeout(async () => {
                        if (isFinished || !promptId) return;
                        const stopped = await this.promptOwnership.waitForPromptToStop(promptId, 1500);
                        if (!comfySocketDropShouldFinish(stopped)) {
                            logger.warn(
                                `ComfyUI websocket closed while prompt ${promptId} is still active; waiting on history`
                            );
                            return;
                        }
                        await finish(undefined, true);
                    }, 1500);
                });

                // Fallback check history in case WS missed completion.
                checkHistoryInterval = setInterval(async () => {
                    try {
                        const hRes = await this.authenticatedFetch(`/history/${promptId}`, {}, 5000);
                        if (hRes.ok) {
                            const hData = await hRes.json() as Record<string, any>;
                            const entry = hData[promptId!];
                            if (entry) {
                                cachedHistoryEntry = entry;
                                const failure = comfyHistoryFailure(entry);
                                if (failure) {
                                    logger.error(failure);
                                    await finish({ status: 'error', message: failure }, true);
                                } else {
                                    logger.info(`Prompt ${promptId} confirmed completed via polling.`);
                                    await finish(undefined, true);
                                }
                            }
                        }
                    } catch {
                        /* keep polling until deadline */
                    }
                }, 5000);
            });

        } catch (error: any) {
            logger.error(`Error during ComfyUI execution: ${error}`);
            if (ws) ws.close();
            return { status: 'error', message: error.toString() };
        }
    }

    /**
     * Static image compatibility wrapper over the same prompt ownership primitive
     * used by H3. This keeps queue-delete / sole-running interrupt semantics identical.
     */
    async cancelExecution(
        promptId?: string | null,
        timeoutMs: number = 5000
    ): Promise<ComfyPromptCancelResult> {
        return this.promptOwnership.cancelPrompt(promptId, timeoutMs, 'Image');
    }

    /**
     * Upload an image to ComfyUI (/upload/image) so workflows can reference it via LoadImage node.
     * Returns the remote filename assigned by ComfyUI.
     */
    async uploadImage(buffer: Buffer, filename: string): Promise<string> {
        const formData = new FormData();
        const blob = new Blob([buffer]);
        formData.append('image', blob, filename);
        formData.append('overwrite', 'true');
        formData.append('type', 'input');

        const res = await this.authenticatedFetch('/upload/image', {
            method: 'POST',
            body: formData
        }, 60_000);

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Failed to upload reference image to ComfyUI (${res.status}): ${text}`);
        }

        const data = await res.json() as { name: string; subfolder?: string; type?: string };
        logger.info(`Uploaded reference image ${filename} to ComfyUI as ${data.name}`);
        return data.name || filename;
    }

    /**
     * If remote ComfyUI, scan workflow for LoadImage nodes and upload local references to remote server.
     */
    async uploadWorkflowReferences(workflow: any, staticDir: string): Promise<any> {
        if (!this.isRemote || !workflow || typeof workflow !== 'object') {
            return workflow;
        }

        const cloned = JSON.parse(JSON.stringify(workflow));
        const uploadedCache = new Map<string, string>();

        for (const node of Object.values(cloned) as any[]) {
            if (node?.class_type === 'LoadImage' && node.inputs?.image) {
                const originalFilename = String(node.inputs.image);
                if (uploadedCache.has(originalFilename)) {
                    node.inputs.image = uploadedCache.get(originalFilename);
                    continue;
                }

                const localFilePath = resolveComfyReferenceFile(staticDir, originalFilename);
                if (localFilePath) {
                    const buf = fs.readFileSync(localFilePath);
                    let uploadedName = '';
                    let lastError: unknown;
                    for (let attempt = 1; attempt <= 3; attempt += 1) {
                        try {
                            uploadedName = await this.uploadImage(buf, path.basename(originalFilename));
                            break;
                        } catch (err) {
                            lastError = err;
                            const retryable = /524|502|503|timeout|aborted|fetch failed|terminated|socket|econnreset/i.test(String(err));
                            if (!retryable || attempt === 3) break;
                            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
                        }
                    }
                    if (!uploadedName) {
                        throw new Error(`Failed to upload reference image ${originalFilename}: ${lastError}`);
                    }
                    uploadedCache.set(originalFilename, uploadedName);
                    node.inputs.image = uploadedName;
                } else {
                    throw new Error(`Reference image ${originalFilename} was not found under ${staticDir}`);
                }
            }
            if (node?.class_type === 'TextEncodeQwenImage21' && node.inputs?.image_1 && !node.inputs['images.image_1']) {
                node.inputs['images.image_1'] = node.inputs.image_1;
                delete node.inputs.image_1;
            }
        }

        return cloned;
    }

    private async downloadImage(filename: string, subfolder: string, type: string): Promise<Buffer | null> {
        const url = `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                const res = await this.authenticatedFetch(url, {}, 30_000);
                if (res.ok) {
                    const arrayBuffer = await res.arrayBuffer();
                    return Buffer.from(arrayBuffer);
                }
                logger.error(`Failed to download image ${filename}: ${res.status}`);
                if (!comfyDownloadShouldRetry(res.status, '', attempt)) return null;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.error(`Download exception for ${filename}: ${error}`);
                if (!comfyDownloadShouldRetry(null, message, attempt)) return null;
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
        return null;
    }
}
