import { ComfyUIService } from './ai/comfyui_service';
import { MediaService } from './media_service';
import { SettingsManager } from '../core/settings_manager';
import { db } from '../db/database';
import Redis from 'ioredis';
import path from 'path';
import fs from 'fs';
import { logger } from '../core/logging';
import { Prompts } from './prompts';
import { AssetTaskStore } from './task_store';
import { getGeneratedDirectory } from '../core/paths';

const isComfyWorkflow = (value: any) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value).some((node: any) => node && typeof node === 'object' && typeof node.class_type === 'string');
};

const parseWorkflowContent = (content: unknown) => {
    if (typeof content === 'string') return JSON.parse(content);
    return JSON.parse(JSON.stringify(content));
};

const findNodeId = (workflow: any, predicate: (node: any) => boolean) =>
    Object.keys(workflow).find((nodeId) => predicate(workflow[nodeId]));

const nextNodeId = (workflow: any) => {
    const numericIds = Object.keys(workflow)
        .map((nodeId) => Number(nodeId))
        .filter(Number.isFinite);
    return String((numericIds.length > 0 ? Math.max(...numericIds) : 0) + 1);
};

const injectLora = (
    workflow: any,
    loraName: string,
    strength: number,
    modelType: 'pony' | 'flux'
) => {
    if (!loraName) return;
    const alreadyPresent = Object.values(workflow).some(
        (node: any) => node?.inputs?.lora_name === loraName
    );
    if (alreadyPresent) return;

    const modelLoaderId = findNodeId(workflow, (node) =>
        modelType === 'flux'
            ? node?.class_type === 'UnetLoaderGGUF'
            : node?.class_type === 'CheckpointLoaderSimple'
    );
    if (!modelLoaderId) return;

    const samplerNode = Object.values(workflow).find(
        (node: any) => node?.class_type?.includes('KSampler')
    ) as any;
    const textEncoderNode = Object.values(workflow).find(
        (node: any) => node?.class_type === 'CLIPTextEncode'
    ) as any;
    const currentModel = Array.isArray(samplerNode?.inputs?.model)
        ? samplerNode.inputs.model
        : [modelLoaderId, 0];
    const currentClip = Array.isArray(textEncoderNode?.inputs?.clip)
        ? textEncoderNode.inputs.clip
        : [modelLoaderId, 1];
    const loraNodeId = nextNodeId(workflow);
    if (modelType === 'flux') {
        workflow[loraNodeId] = {
            inputs: {
                lora_name: loraName,
                strength_model: strength,
                model: currentModel
            },
            class_type: 'LoraLoaderModelOnly',
            _meta: { title: 'NovaStory FLUX LoRA' }
        };
    } else {
        workflow[loraNodeId] = {
            inputs: {
                lora_name: loraName,
                strength_model: strength,
                strength_clip: strength,
                model: currentModel,
                clip: currentClip
            },
            class_type: 'LoraLoader',
            _meta: { title: 'NovaStory Pony LoRA' }
        };
    }

    for (const node of Object.values(workflow) as any[]) {
        if (node?.class_type?.includes('KSampler') && node.inputs) {
            node.inputs.model = [loraNodeId, 0];
        }
        if (
            modelType === 'pony'
            && node?.class_type === 'CLIPTextEncode'
            && node.inputs
        ) {
            node.inputs.clip = [loraNodeId, 1];
        }
    }
};

const findFluxStyleLora = (runtimeSettings: any) => {
    const comfySettings = runtimeSettings.comfyui || {};
    const installPath = comfySettings.install_path;
    if (!installPath) return null;

    const loraDirectory = path.join(String(installPath), 'models', 'loras');
    if (!fs.existsSync(loraDirectory)) return null;

    const configuredLora = comfySettings.flux_lora;
    if (
        configuredLora
        && fs.existsSync(path.join(loraDirectory, path.basename(String(configuredLora))))
    ) {
        return path.basename(String(configuredLora));
    }

    const candidates = fs.readdirSync(loraDirectory)
        .filter((filename) => /\.(safetensors|ckpt)$/i.test(filename))
        .sort((left, right) => left.localeCompare(right));
    return candidates.find((filename) =>
        /(asian|guofeng|east[_-]?asian|flux[_-]?asian)/i.test(filename)
    ) || candidates[0] || null;
};

export const compileComfyWorkflow = async (
    workflowData: any,
    finalPrompt: string,
    mode: string,
    generationParams?: any,
    runtimeSettings: any = SettingsManager.loadSettings()
) => {
    let workflow: any;

    if (isComfyWorkflow(workflowData)) {
        workflow = parseWorkflowContent(workflowData);
    } else {
        const selectedWorkflowFile = runtimeSettings.comfyui?.selected_workflow_file
            || runtimeSettings.comfyui?.default_workflow;
        const selectedWorkflowName = selectedWorkflowFile
            ? path.basename(String(selectedWorkflowFile), '.json')
            : null;
        const requestedModel = String(
            workflowData?.model_type
            || workflowData?.reference_model_type
            || 'pony'
        ).toLowerCase();
        const preferredName = requestedModel.includes('flux')
            ? 'flux_dev_gguf_12gb'
            : 'pony_xl_12gb';
        const fallbackName = 'pony_xl_12gb';

        let row = selectedWorkflowName
            ? await db.get('SELECT content FROM workflow WHERE name = ?', selectedWorkflowName)
            : null;
        if (!row) {
            row = await db.get('SELECT content FROM workflow WHERE name = ?', preferredName);
        }
        if (!row && preferredName !== fallbackName) {
            row = await db.get('SELECT content FROM workflow WHERE name = ?', fallbackName);
        }
        if (!row) {
            throw new Error(`No ComfyUI workflow is configured for model '${requestedModel}'`);
        }
        workflow = parseWorkflowContent(row.content);
    }

    const isFlux = Boolean(findNodeId(workflow, (node) =>
        node?.class_type === 'UnetLoaderGGUF'
        || (
            node?.class_type === 'CheckpointLoaderSimple'
            && /flux/i.test(node.inputs?.ckpt_name || '')
        )
    ));
    const preserveTemplateConditioning = !isFlux && /pony/i.test(JSON.stringify(workflow));
    let effectivePrompt = finalPrompt;
    if (
        isFlux
        && !/(east asian|chinese|japanese|asian|guofeng|xianxia)/i.test(effectivePrompt)
    ) {
        effectivePrompt = `${effectivePrompt}, East Asian facial features, soft facial contour, East Asian beauty`;
    }

    const advancedSettings = runtimeSettings.advanced || {};
    const negativeParts = [
        workflowData?.negative_prompt || '',
        'low quality, worst quality, bad anatomy, extra limbs, text, watermark'
    ];
    if (isFlux && !/(western face|caucasian)/i.test(negativeParts.join(', '))) {
        negativeParts.push('western face, caucasian');
    }
    if (!advancedSettings.nsfw_enabled) {
        negativeParts.push(
            'nsfw, nude, explicit sexual content, exposed breasts, genitalia, sexual act'
        );
    }
    const negativePrompt = negativeParts.filter(Boolean).join(', ');

    const samplerNodes = Object.values(workflow).filter(
        (node: any) => node?.class_type?.includes('KSampler')
    ) as any[];

    for (const sampler of samplerNodes) {
        const positiveId = Array.isArray(sampler.inputs?.positive) ? String(sampler.inputs.positive[0]) : null;
        const negativeId = Array.isArray(sampler.inputs?.negative) ? String(sampler.inputs.negative[0]) : null;

        if (positiveId && workflow[positiveId]?.inputs) {
            const templateText = String(workflow[positiveId].inputs.text || '').trim();
            workflow[positiveId].inputs.text = preserveTemplateConditioning && templateText
                ? `${templateText}, ${effectivePrompt}`
                : effectivePrompt;
        }
        if (negativeId && workflow[negativeId]?.inputs && negativeId !== positiveId) {
            const templateText = String(workflow[negativeId].inputs.text || '').trim();
            workflow[negativeId].inputs.text = preserveTemplateConditioning && templateText
                ? `${templateText}, ${negativePrompt}`
                : negativePrompt;
        }

        sampler.inputs.seed = Math.floor(Math.random() * 1_000_000_000);
        sampler.inputs.steps = Number(generationParams?.steps || 20);
        sampler.inputs.cfg = Number(generationParams?.cfg || 7);
        if (generationParams?.sampler_name) sampler.inputs.sampler_name = generationParams.sampler_name;
        if (generationParams?.scheduler) sampler.inputs.scheduler = generationParams.scheduler;
    }

    const isTurnaround = workflowData?.gen_type === 'turnaround';
    const width = mode === 'cinematic_grid' ? 1024 : (isTurnaround ? 1152 : 768);
    const height = mode === 'cinematic_grid' ? 1024 : (isTurnaround ? 768 : 1024);

    for (const node of Object.values(workflow) as any[]) {
        if (node?.class_type === 'EmptyLatentImage' && node.inputs) {
            node.inputs.width = width;
            node.inputs.height = height;
            node.inputs.batch_size = 1;
        }
    }

    const referenceImageUrl = workflowData?.ref_image_url || workflowData?.init_image_url;
    if (referenceImageUrl) {
        const referenceFilename = path.basename(String(referenceImageUrl));
        for (const node of Object.values(workflow) as any[]) {
            if (node?.class_type === 'LoadImage' && node.inputs) {
                node.inputs.image = referenceFilename;
            }
        }
    }

    if (isFlux) {
        const styleLora = findFluxStyleLora(runtimeSettings);
        if (styleLora) {
            injectLora(
                workflow,
                styleLora,
                Number(runtimeSettings.comfyui?.flux_lora_strength || 0.8),
                'flux'
            );
        }
    }

    if (advancedSettings.nsfw_enabled) {
        injectLora(
            workflow,
            isFlux
                ? advancedSettings.flux_nsfw_lora
                : advancedSettings.pony_nsfw_lora,
            Number(advancedSettings.nsfw_lora_strength || 0.8),
            isFlux ? 'flux' : 'pony'
        );
    }

    return workflow;
};

const copyReferenceImageToComfy = (
    workflowData: any,
    staticDir: string,
    comfyInstallPath?: string
) => {
    const referenceImageUrl = workflowData?.ref_image_url || workflowData?.init_image_url;
    if (!referenceImageUrl || !comfyInstallPath) return;

    const filename = path.basename(String(referenceImageUrl));
    const sourcePath = path.join(staticDir, filename);
    if (!fs.existsSync(sourcePath)) return;

    const inputDirectory = path.join(comfyInstallPath, 'input');
    fs.mkdirSync(inputDirectory, { recursive: true });
    fs.copyFileSync(sourcePath, path.join(inputDirectory, filename));
};

export class GenerationService {
    static async generateAssets(taskId: string, workflowData: any, sceneId: number, userToken?: string, mode: string = "standard", generationParams?: any) {
        logger.info(`[Task ${taskId}] Asset generation started for Scene ${sceneId} (Mode: ${mode})`);
        AssetTaskStore.processing(taskId, sceneId);

        const staticDir = getGeneratedDirectory();
        if (!fs.existsSync(staticDir)) {
            fs.mkdirSync(staticDir, { recursive: true });
        }

        let redis: Redis | null = null;
        const redisUrl = process.env.REDIS_URL;
        if (redisUrl) {
            try {
                redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, retryStrategy: () => null });
            } catch(e) {
                logger.error(`Redis connection failed in GenerationService: ${e}`);
            }
        }

        const progressHandler = async (msgType: string, data: any) => {
            const channel = `task_progress:${taskId}`;
            if (redis && redis.status === 'ready') {
                try {
                    await redis.publish(channel, JSON.stringify({ type: msgType, data }));
                } catch(e) {}
            }
            logger.info(`[Task ${taskId}] Progress: ${msgType}`);
        };

        try {
            const settings = SettingsManager.loadSettings();
            const comfySettings = settings.comfyui || {};
            const useComfy = comfySettings.enabled || false;

            let result: any = null;
            let finalPrompt = "";

            if (mode === "cinematic_grid") {
                const rawPrompt = workflowData?.prompt || workflowData?.text || workflowData?.description || JSON.stringify(workflowData);
                finalPrompt = Prompts.buildCinematicGridImagePrompt(rawPrompt);
            } else {
                finalPrompt = workflowData?.prompt || workflowData?.text || workflowData?.description || JSON.stringify(workflowData);
            }

            if (useComfy) {
                logger.info(`[Task ${taskId}] Using ComfyUI`);
                const baseUrl = comfySettings.base_url || "http://127.0.0.1:8188";
                const comfyService = new ComfyUIService(baseUrl);
                const isRunning = await comfyService.ensureRunning(
                    comfySettings.install_path
                );
                if (!isRunning) {
                    throw new Error('Failed to start or connect to ComfyUI');
                }

                copyReferenceImageToComfy(
                    workflowData,
                    staticDir,
                    comfySettings.install_path
                );

                const finalWorkflow = await compileComfyWorkflow(
                    workflowData,
                    finalPrompt,
                    mode,
                    generationParams,
                    settings
                );

                result = await comfyService.generateImage(finalWorkflow, progressHandler);
            } else {
                logger.info(`[Task ${taskId}] Using configured cloud image provider`);
                const aiProvider = MediaService.getProvider();
                const apiRes = await aiProvider.generateImage(finalPrompt, "1024x1024", userToken);
                result = {
                    status: apiRes.error ? "failed" : "completed",
                    message: apiRes.error,
                    images: [{ url: apiRes.url, data: apiRes.data }]
                };
            }

            let finalStatus = "failed";
            let assetUrl: string | null = null;

            if (result?.status === "completed" && result.images && result.images.length > 0) {
                const img = result.images[0];
                if (img.data) {
                    const filename = `${sceneId}_${taskId}.png`;
                    const filepath = path.join(staticDir, filename);
                    fs.writeFileSync(filepath, img.data);
                    assetUrl = `/static/generated/${filename}`;
                    finalStatus = "completed";
                    logger.info(`[Task ${taskId}] Image saved to ${filepath}`);
                } else if (img.url) {
                    assetUrl = img.url;
                    finalStatus = "completed";
                    logger.info(`[Task ${taskId}] Using remote image URL: ${assetUrl}`);
                }

                if (finalStatus === "completed") {
                    await db.run('UPDATE scene SET asset_status = ?, asset_url = ?, task_id = ? WHERE id = ?', "completed", assetUrl, taskId, sceneId);
                }
            }

            if (finalStatus === "completed") {
                AssetTaskStore.completed(taskId, sceneId, assetUrl!);
                if (redis && redis.status === 'ready') {
                    try { await redis.publish(`task_progress:${taskId}`, JSON.stringify({ type: "complete", status: "completed", image_url: assetUrl })); } catch(e) {}
                }
            } else {
                const errMsg = result?.message || "Unknown error";
                logger.error(`[Task ${taskId}] Generation failed: ${errMsg}`);
                AssetTaskStore.failed(taskId, sceneId, errMsg);
                await db.run('UPDATE scene SET asset_status = ?, task_id = ? WHERE id = ?', "failed", taskId, sceneId);
                if (redis && redis.status === 'ready') {
                    try { await redis.publish(`task_progress:${taskId}`, JSON.stringify({ type: "complete", status: "failed", error: errMsg })); } catch(e) {}
                }
            }

        } catch (error: any) {
            logger.error(`[Task ${taskId}] Unexpected error in async service: ${error.message}`);
            AssetTaskStore.failed(taskId, sceneId, error.message);
            try {
                await db.run('UPDATE scene SET asset_status = ?, task_id = ? WHERE id = ?', "failed", taskId, sceneId);
                if (redis && redis.status === 'ready') {
                    await redis.publish(`task_progress:${taskId}`, JSON.stringify({ type: "complete", status: "failed", error: error.message }));
                }
            } catch (e) {}
        } finally {
            if (redis) redis.disconnect();
        }
    }
}
