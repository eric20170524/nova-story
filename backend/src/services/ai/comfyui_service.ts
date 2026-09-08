import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../../core/logging';
import { GpuLeaseService } from '../gpu_lease_service';
import { AssetTaskStore } from '../task_store';

const queueEntryContainsPromptId = (entry: unknown, promptId: string): boolean => {
    if (entry === promptId) return true;
    if (Array.isArray(entry)) {
        return entry.some((value) => queueEntryContainsPromptId(value, promptId));
    }
    if (entry && typeof entry === 'object') {
        return Object.values(entry as Record<string, unknown>).some(
            (value) => queueEntryContainsPromptId(value, promptId)
        );
    }
    return false;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ComfyUIService {
    private static promptStopWatchers = new Set<string>();

    private baseUrl: string;
    private clientId: string;
    private wsUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.clientId = randomUUID();
        this.wsUrl = this.baseUrl.replace('http://', 'ws://').replace('https://', 'wss://') + `/ws?clientId=${this.clientId}`;
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

    private async getQueue(timeoutMs: number = 3000): Promise<{ running: any[]; pending: any[] } | null> {
        try {
            const response = await this.fetchWithTimeout(`${this.baseUrl}/queue`, {}, timeoutMs);
            if (!response.ok) return null;
            const data = await response.json() as any;
            return {
                running: data.queue_running || [],
                pending: data.queue_pending || []
            };
        } catch {
            return null;
        }
    }

    private promptIsActive(queue: { running: any[]; pending: any[] }, promptId: string): boolean {
        return queue.running.some((entry) => queueEntryContainsPromptId(entry, promptId))
            || queue.pending.some((entry) => queueEntryContainsPromptId(entry, promptId));
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

    private watchPromptUntilStopped(promptId: string): void {
        if (ComfyUIService.promptStopWatchers.has(promptId)) return;
        ComfyUIService.promptStopWatchers.add(promptId);
        logger.warn(`Image Comfy prompt ${promptId} stop is not confirmed; retaining GPU lease guard.`);

        void (async () => {
            try {
                while (true) {
                    const queue = await this.getQueue(3000);
                    if (queue && !this.promptIsActive(queue, promptId)) {
                        GpuLeaseService.confirmPromptStopped(promptId);
                        logger.info(`Image Comfy prompt ${promptId} stopped; GPU guard cleared.`);
                        return;
                    }
                    await sleep(2000);
                }
            } finally {
                ComfyUIService.promptStopWatchers.delete(promptId);
            }
        })();
    }

    async checkStatus(): Promise<boolean> {
        try {
            const response = await this.fetchWithTimeout(`${this.baseUrl}/system_stats`, {}, 2000);
            return response.ok;
        } catch (error) {
            return false;
        }
    }

    async ensureRunning(installPath?: string, timeoutMs: number = 45_000): Promise<boolean> {
        if (await this.checkStatus()) return true;
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
        const process = spawn(
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
                stdio: 'ignore',
                windowsHide: true
            }
        );
        process.unref();

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (await this.checkStatus()) return true;
        }
        logger.error(`ComfyUI did not become ready within ${timeoutMs}ms`);
        return false;
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
            ws = new WebSocket(this.wsUrl);

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

            const response = await this.fetchWithTimeout(`${this.baseUrl}/prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: workflow, client_id: this.clientId })
            }, 10_000);

            if (!response.ok) {
                const errText = await response.text();
                logger.error(`ComfyUI /prompt Error: ${response.status} - ${errText}`);
                ws.close();
                return { status: 'error', message: `Queue failed: ${errText}` };
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
                // scoped by id and fail closed; if stop cannot be confirmed, the
                // provider watcher continues observing it.
                const cancellation = await this.cancelExecution(promptId, 5000);
                if (!cancellation.ok) this.watchPromptUntilStopped(promptId);
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
                if (!cancellation.ok) this.watchPromptUntilStopped(promptId);
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
            const timeoutMs = options?.timeoutMs ?? 15 * 60 * 1000;

            return new Promise((resolve) => {
                let checkHistoryInterval: NodeJS.Timeout | null = null;
                let deadlineTimer: NodeJS.Timeout | null = null;
                let isFinished = false;

                const finish = async (
                    customResult?: { status: string; message: string },
                    promptStopped: boolean = true
                ) => {
                    if (isFinished) return;
                    isFinished = true;
                    if (checkHistoryInterval) clearInterval(checkHistoryInterval);
                    if (deadlineTimer) clearTimeout(deadlineTimer);

                    if (promptId) {
                        if (promptStopped) GpuLeaseService.confirmPromptStopped(promptId);
                        else this.watchPromptUntilStopped(promptId);
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

                    if (generatedImages.length === 0 && promptId) {
                        try {
                            const histRes = await this.fetchWithTimeout(
                                `${this.baseUrl}/history/${promptId}`,
                                {},
                                5000
                            );
                            if (histRes.ok) {
                                const historyData = await histRes.json() as Record<string, any>;
                                const promptOutput = historyData[promptId]?.outputs || {};
                                for (const nodeId of Object.keys(promptOutput)) {
                                    const nodeOut = promptOutput[nodeId];
                                    if (nodeOut.images) {
                                        for (const imgInfo of nodeOut.images) {
                                            const imgData = await this.downloadImage(
                                                imgInfo.filename,
                                                imgInfo.subfolder,
                                                imgInfo.type
                                            );
                                            if (imgData) {
                                                generatedImages.push({ filename: imgInfo.filename, data: imgData });
                                            }
                                        }
                                    }
                                }
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
                            if (!result.ok) this.watchPromptUntilStopped(promptId!);
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
                                    const imgData = await this.downloadImage(
                                        imgInfo.filename,
                                        imgInfo.subfolder || '',
                                        imgInfo.type || 'output'
                                    );
                                    if (imgData) {
                                        generatedImages.push({ filename: imgInfo.filename, data: imgData });
                                    }
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
                        const stopped = await this.waitForPromptToStop(promptId, 1500);
                        if (stopped) {
                            await finish(undefined, true);
                        } else {
                            await finish(
                                {
                                    status: 'error',
                                    message: 'ComfyUI connection closed while prompt state is still active or unknown'
                                },
                                false
                            );
                        }
                    }, 1500);
                });

                // Fallback check history in case WS missed completion.
                checkHistoryInterval = setInterval(async () => {
                    try {
                        const hRes = await this.fetchWithTimeout(
                            `${this.baseUrl}/history/${promptId}`,
                            {},
                            5000
                        );
                        if (hRes.ok) {
                            const hData = await hRes.json() as Record<string, any>;
                            if (hData[promptId!]) {
                                logger.info(`Prompt ${promptId} confirmed completed via polling.`);
                                await finish(undefined, true);
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
     * Cancel only the owned prompt. `/interrupt` is global in ComfyUI, therefore it
     * is allowed only when the target prompt is confirmed to be the sole running
     * prompt. Missing ownership fails closed and never interrupts unrelated H3 work.
     */
    async cancelExecution(promptId?: string | null, timeoutMs: number = 5000): Promise<{
        ok: boolean;
        deleted_from_queue: boolean;
        interrupted: boolean;
        message: string;
    }> {
        if (!promptId) {
            return {
                ok: false,
                deleted_from_queue: false,
                interrupted: false,
                message: 'Refusing unscoped ComfyUI cancel: prompt_id is required'
            };
        }

        const deadline = Date.now() + Math.max(1, timeoutMs);
        const remaining = () => Math.max(0, deadline - Date.now());
        let deletedFromQueue = false;
        let interrupted = false;
        const notes: string[] = [];

        try {
            const queue = await this.getQueue(Math.min(2000, Math.max(1, remaining())));
            if (!queue || remaining() <= 0) {
                return {
                    ok: false,
                    deleted_from_queue: false,
                    interrupted: false,
                    message: 'Could not confirm ComfyUI queue state; cancellation failed closed'
                };
            }

            const pendingMatch = queue.pending.some(
                (entry) => queueEntryContainsPromptId(entry, promptId)
            );
            const runningMatches = queue.running.filter(
                (entry) => queueEntryContainsPromptId(entry, promptId)
            );

            if (pendingMatch) {
                const delRes = await this.fetchWithTimeout(`${this.baseUrl}/queue`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ delete: [promptId] })
                }, Math.max(1, remaining()));
                deletedFromQueue = delRes.ok;
                notes.push(deletedFromQueue
                    ? `queue delete ${promptId}`
                    : `queue delete failed ${delRes.status}`);
                if (!deletedFromQueue || remaining() <= 0) {
                    return {
                        ok: false,
                        deleted_from_queue: deletedFromQueue,
                        interrupted: false,
                        message: notes.join('; ')
                    };
                }

                const stopped = await this.waitForPromptToStop(promptId, remaining());
                if (stopped) GpuLeaseService.confirmPromptStopped(promptId);
                else this.watchPromptUntilStopped(promptId);
                notes.push(stopped ? 'prompt stop confirmed' : 'prompt stop not yet confirmed');
                return {
                    ok: stopped,
                    deleted_from_queue: deletedFromQueue,
                    interrupted: false,
                    message: notes.join('; ')
                };
            }

            if (runningMatches.length > 0) {
                if (queue.running.length !== 1) {
                    logger.warn(
                        `Refusing global ComfyUI interrupt for image prompt ${promptId}: `
                        + `${queue.running.length} prompts are reported running.`
                    );
                    return {
                        ok: false,
                        deleted_from_queue: false,
                        interrupted: false,
                        message: `Refusing global interrupt: ${queue.running.length} prompts are running`
                    };
                }

                const interruptRes = await this.fetchWithTimeout(
                    `${this.baseUrl}/interrupt`,
                    { method: 'POST' },
                    Math.max(1, remaining())
                );
                interrupted = interruptRes.ok;
                notes.push(interrupted ? 'interrupt ok' : `interrupt failed ${interruptRes.status}`);
                if (!interrupted || remaining() <= 0) {
                    return {
                        ok: false,
                        deleted_from_queue: false,
                        interrupted,
                        message: notes.join('; ')
                    };
                }

                const stopped = await this.waitForPromptToStop(promptId, remaining());
                if (stopped) GpuLeaseService.confirmPromptStopped(promptId);
                else this.watchPromptUntilStopped(promptId);
                notes.push(stopped ? 'prompt stop confirmed' : 'prompt stop not yet confirmed');
                return {
                    ok: stopped,
                    deleted_from_queue: false,
                    interrupted,
                    message: notes.join('; ')
                };
            }

            // Queue evidence says the prompt is already absent. This is a successful
            // idempotent cancellation and does not require a blind global interrupt.
            GpuLeaseService.confirmPromptStopped(promptId);
            return {
                ok: true,
                deleted_from_queue: false,
                interrupted: false,
                message: `Prompt ${promptId} is already absent from ComfyUI queue`
            };
        } catch (error) {
            logger.error(`Failed to cancel ComfyUI prompt ${promptId}: ${error}`);
            return {
                ok: false,
                deleted_from_queue: deletedFromQueue,
                interrupted,
                message: `Cancellation error: ${error}`
            };
        }
    }

    private async downloadImage(filename: string, subfolder: string, type: string): Promise<Buffer | null> {
        const url = `${this.baseUrl}/view?filename=${filename}&subfolder=${subfolder}&type=${type}`;
        try {
            const res = await this.fetchWithTimeout(url, {}, 30_000);
            if (res.ok) {
                const arrayBuffer = await res.arrayBuffer();
                return Buffer.from(arrayBuffer);
            } else {
                logger.error(`Failed to download image ${filename}: ${res.status}`);
            }
        } catch (error) {
            logger.error(`Download exception for ${filename}: ${error}`);
        }
        return null;
    }
}
