import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../../core/logging';

export class ComfyUIService {
    private baseUrl: string;
    private clientId: string;
    private wsUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.clientId = randomUUID();
        this.wsUrl = this.baseUrl.replace('http://', 'ws://').replace('https://', 'wss://') + `/ws?clientId=${this.clientId}`;
    }

    async checkStatus(): Promise<boolean> {
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 2000);
            const response = await fetch(`${this.baseUrl}/system_stats`, { signal: controller.signal });
            clearTimeout(id);
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
        options?: { onPromptQueued?: (promptId: string) => void | Promise<void> }
    ): Promise<{ status: string; message?: string; images?: any[]; prompt_id?: string }> {
        logger.info(`Generating image via ComfyUI with workflow: ${JSON.stringify(workflow).substring(0, 50)}...`);

        let ws: WebSocket | null = null;
        try {
            ws = new WebSocket(this.wsUrl);

            await new Promise<void>((resolve, reject) => {
                ws!.on('open', resolve);
                ws!.on('error', reject);
            });
            logger.info("Connected to ComfyUI WebSocket");
        } catch (error) {
            logger.error(`Failed to connect to ComfyUI WebSocket: ${error}`);
            return { status: "error", message: `Connection Refused: ${error}` };
        }

        try {
            let promptId: string | null = null;

            const response = await fetch(`${this.baseUrl}/prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: workflow, client_id: this.clientId })
            });

            if (!response.ok) {
                const errText = await response.text();
                logger.error(`ComfyUI /prompt Error: ${response.status} - ${errText}`);
                ws.close();
                return { status: "error", message: `Queue failed: ${errText}` };
            }

            const respData = await response.json() as Record<string, any>;
            promptId = respData.prompt_id;
            logger.info(`Workflow queued. Prompt ID: ${promptId}`);

            if (!promptId) {
                ws.close();
                return { status: "error", message: "No prompt_id received" };
            }

            try {
                await options?.onPromptQueued?.(promptId);
            } catch (e) {
                logger.warn(`onPromptQueued hook failed: ${e}`);
            }

            const generatedImages: any[] = [];

            return new Promise((resolve) => {
                let checkHistoryInterval: any = null;

                const finish = async () => {
                    if (checkHistoryInterval) clearInterval(checkHistoryInterval);
                    ws!.close();

                    if (generatedImages.length === 0 && promptId) {
                        try {
                            const histRes = await fetch(`${this.baseUrl}/history/${promptId}`);
                            if (histRes.ok) {
                                const historyData = await histRes.json() as Record<string, any>;
                                const promptOutput = historyData[promptId]?.outputs || {};
                                for (const nodeId of Object.keys(promptOutput)) {
                                    const nodeOut = promptOutput[nodeId];
                                    if (nodeOut.images) {
                                        for (const imgInfo of nodeOut.images) {
                                            const imgData = await this.downloadImage(imgInfo.filename, imgInfo.subfolder, imgInfo.type);
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
                    resolve({ status: "completed", images: generatedImages, prompt_id: promptId || undefined });
                };

                ws!.on('message', async (data: any) => {
                    try {
                        const message = JSON.parse(data.toString());
                        const msgType = message.type;
                        const msgData = message.data || {};

                        if (msgType === "execution_start" && msgData.prompt_id === promptId) {
                            logger.info("ComfyUI Execution Started");
                            if (progressCallback) progressCallback("started", {});
                        } else if (msgType === "executing") {
                            const node = msgData.node;
                            if (node) {
                                if (progressCallback) progressCallback("progress", { node });
                            } else {
                                logger.info("ComfyUI Execution Finished (Logic)");
                                if (!msgData.prompt_id || msgData.prompt_id === promptId) {
                                    setTimeout(finish, 500);
                                }
                            }
                        } else if (msgType === "executed" && msgData.prompt_id === promptId) {
                            const output = msgData.output || {};
                            if (output.images) {
                                for (const imgInfo of output.images) {
                                    logger.info(`Image generated: ${imgInfo.filename}`);
                                    const imgData = await this.downloadImage(imgInfo.filename, imgInfo.subfolder || "", imgInfo.type || "output");
                                    if (imgData) {
                                        generatedImages.push({ filename: imgInfo.filename, data: imgData });
                                    }
                                }
                            }
                        } else if (msgType === "progress") {
                            if (progressCallback && msgData.value && msgData.max) {
                                progressCallback("progress", { current: msgData.value, total: msgData.max });
                            }
                        } else if (msgType === "execution_error") {
                            if (!msgData.prompt_id || msgData.prompt_id === promptId) {
                                const errStr = `ComfyUI Error [${msgData.node_type}]: ${msgData.exception_message}`;
                                logger.error(errStr);
                                if (checkHistoryInterval) clearInterval(checkHistoryInterval);
                                ws!.close();
                                resolve({ status: "error", message: errStr });
                            }
                        } else if (msgType === "execution_interrupted") {
                            if (!msgData.prompt_id || msgData.prompt_id === promptId) {
                                logger.info("ComfyUI Execution Interrupted");
                                if (checkHistoryInterval) clearInterval(checkHistoryInterval);
                                ws!.close();
                                resolve({ status: "error", message: "Generation interrupted" });
                            }
                        }
                    } catch (e) {
                        // ignored
                    }
                });

                ws!.on('close', () => {
                    logger.warn("WebSocket closed");
                    finish();
                });

                // Fallback check history in case WS missed completion
                checkHistoryInterval = setInterval(async () => {
                    try {
                        const hRes = await fetch(`${this.baseUrl}/history/${promptId}`);
                        if (hRes.ok) {
                            const hData = await hRes.json() as Record<string, any>;
                            if (hData[promptId!]) {
                                logger.info(`Prompt ${promptId} confirmed completed via polling.`);
                                finish();
                            }
                        }
                    } catch (e) {}
                }, 5000);
            });

        } catch (error: any) {
            logger.error(`Error during ComfyUI execution: ${error}`);
            if (ws) ws.close();
            return { status: "error", message: error.toString() };
        }
    }

    /**
     * Cancel a specific queued prompt and/or interrupt the currently running job.
     * ComfyUI: POST /queue { delete: [prompt_id] } removes queue items;
     * POST /interrupt stops the active execution (not prompt-scoped).
     */
    async cancelExecution(promptId?: string | null): Promise<{
        ok: boolean;
        deleted_from_queue: boolean;
        interrupted: boolean;
        message: string;
    }> {
        let deletedFromQueue = false;
        let interrupted = false;
        const notes: string[] = [];

        if (promptId) {
            try {
                // Prefer deleting a queued item by id (no-op if already running/done)
                const delRes = await fetch(`${this.baseUrl}/queue`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ delete: [promptId] })
                });
                deletedFromQueue = delRes.ok;
                notes.push(deletedFromQueue ? `queue delete ${promptId}` : `queue delete failed ${delRes.status}`);
            } catch (error) {
                logger.error(`Failed to delete ComfyUI queue item ${promptId}: ${error}`);
                notes.push(`queue delete error: ${error}`);
            }
        }

        try {
            // If this prompt is the active one (or client wants a hard stop), interrupt running graph
            const response = await fetch(`${this.baseUrl}/interrupt`, { method: 'POST' });
            interrupted = response.ok;
            notes.push(interrupted ? 'interrupt ok' : `interrupt failed ${response.status}`);
        } catch (error) {
            logger.error(`Failed to interrupt ComfyUI: ${error}`);
            notes.push(`interrupt error: ${error}`);
        }

        return {
            ok: deletedFromQueue || interrupted,
            deleted_from_queue: deletedFromQueue,
            interrupted,
            message: notes.join('; ')
        };
    }

    private async downloadImage(filename: string, subfolder: string, type: string): Promise<Buffer | null> {
        const url = `${this.baseUrl}/view?filename=${filename}&subfolder=${subfolder}&type=${type}`;
        try {
            const res = await fetch(url);
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
