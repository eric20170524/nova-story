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
import {
    applyPromptEnhancement,
    resolveGenerationPlan,
    type ImageModelFamily
} from './image_generation_policy';
import { parseProjectSettings, resolveEffectiveNsfw } from './project_settings';

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

/**
 * Wire a real img2img path when a reference image is provided.
 * The base Pony/FLUX templates only do text2img — previously ref_image_url was
 * copied to ComfyUI/input but never connected (no LoadImage node), so turnaround
 * and scene consistency never used the portrait.
 */
const injectImg2ImgReference = (
    workflow: any,
    imageFilename: string,
    denoise: number,
    width: number,
    height: number,
    isFlux: boolean
) => {
    const vaeSourceId = isFlux
        ? findNodeId(workflow, (node) => node?.class_type === 'VAELoader')
        : findNodeId(workflow, (node) => node?.class_type === 'CheckpointLoaderSimple');
    if (!vaeSourceId) {
        logger.warn('Cannot inject img2img: no VAE source node found');
        return false;
    }
    const vaeOutputIndex = isFlux ? 0 : 2;

    const loadId = nextNodeId(workflow);
    workflow[loadId] = {
        inputs: { image: imageFilename },
        class_type: 'LoadImage',
        _meta: { title: 'NovaStory Character Reference' }
    };

    const scaleId = nextNodeId(workflow);
    workflow[scaleId] = {
        inputs: {
            image: [loadId, 0],
            upscale_method: 'lanczos',
            width,
            height,
            crop: 'center'
        },
        class_type: 'ImageScale',
        _meta: { title: 'NovaStory Scale Reference' }
    };

    const encodeId = nextNodeId(workflow);
    workflow[encodeId] = {
        inputs: {
            pixels: [scaleId, 0],
            vae: [vaeSourceId, vaeOutputIndex]
        },
        class_type: 'VAEEncode',
        _meta: { title: 'NovaStory VAE Encode Reference' }
    };

    let wired = false;
    for (const node of Object.values(workflow) as any[]) {
        if (node?.class_type?.includes('KSampler') && node.inputs) {
            node.inputs.latent_image = [encodeId, 0];
            node.inputs.denoise = Math.min(1, Math.max(0.05, denoise));
            wired = true;
        }
    }
    if (wired) {
        logger.info(
            `Injected img2img reference ${imageFilename} denoise=${denoise} size=${width}x${height}`
        );
    }
    return wired;
};

/**
 * Decide whether a reference image should drive img2img.
 * Portrait latents collapse multi-person / story shots into single-character portraits
 * when denoise is moderate — so narrative scenes stay pure txt2img + appearance tags.
 */
export const resolveReferenceImg2ImgPolicy = (
    workflowData: any,
    finalPrompt: string = ''
): { useImg2Img: boolean; denoise: number; reason: string } => {
    const genType = String(workflowData?.gen_type || '').toLowerCase();
    const explicit = workflowData?.denoise;
    const hasExplicitDenoise = typeof explicit === 'number' && Number.isFinite(explicit);

    if (genType === 'turnaround') {
        return {
            useImg2Img: true,
            denoise: hasExplicitDenoise ? Number(explicit) : 0.55,
            reason: 'turnaround'
        };
    }
    if (genType === 'portrait') {
        return {
            useImg2Img: true,
            denoise: hasExplicitDenoise ? Number(explicit) : 0.42,
            reason: 'portrait'
        };
    }

    const prompt = `${finalPrompt} ${workflowData?.prompt || ''} ${workflowData?.visual_prompt || ''}`;
    const multiPerson =
        /\b[23]girls?\b|\b[23]boys?\b|\bmultiple\b|\bgroup\b|yuri|threesome|sandwich|三人|两人| entwined|intertwined/i.test(
            prompt
        );
    const storyWide =
        /extreme long|establishing|wide shot|long shot|full body|environment|cloud sea|palace|inner hall|overview|bird.?s eye|high angle overview/i.test(
            prompt
        );
    const storyAction =
        /\b(embrac|kiss|sitting|lying|straddl|press|hold|whisper|kneel|behind|from behind|on (the )?(bed|couch)|between|climax|tendril|tentacle|cuddling|afterglow|walking toward|reaching)\b/i.test(
            prompt
        );
    const singleClose =
        /\b(close-?up|portrait|medium close|upper body|face shot)\b/i.test(prompt)
        && !multiPerson
        && /\b1girl\b|\b1boy\b|solo/i.test(prompt);

    // Force skip when caller sets denoise >= 0.95 (pure txt2img)
    if (hasExplicitDenoise && Number(explicit) >= 0.95) {
        return { useImg2Img: false, denoise: 1, reason: 'explicit_txt2img' };
    }

    if (multiPerson || storyWide || storyAction) {
        return {
            useImg2Img: false,
            denoise: 1,
            reason: multiPerson ? 'multi_person_story' : storyWide ? 'wide_story' : 'action_story'
        };
    }

    if (singleClose) {
        return {
            useImg2Img: true,
            denoise: hasExplicitDenoise ? Number(explicit) : 0.62,
            reason: 'single_closeup'
        };
    }

    // Generic single-subject medium shot: very high denoise if ref used at all
    if (hasExplicitDenoise && Number(explicit) < 0.95) {
        // Still honor low explicit denoise only for non-story; clamp up for safety
        const d = Math.max(Number(explicit), 0.82);
        return { useImg2Img: d < 0.95, denoise: d, reason: 'generic_scene_clamped' };
    }

    return { useImg2Img: false, denoise: 1, reason: 'scene_txt2img_default' };
};

/** @deprecated use resolveReferenceImg2ImgPolicy */
export const resolveImg2ImgDenoise = (workflowData: any): number =>
    resolveReferenceImg2ImgPolicy(workflowData).denoise;

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
    const modelFamily: ImageModelFamily = isFlux ? 'flux' : 'pony';
    const advancedSettings = runtimeSettings.advanced || {};

    // Request override → project nsfw_mode → system advanced.nsfw_enabled
    const projectSettings = parseProjectSettings(workflowData?.project_settings);
    const nsfwEnabled = resolveEffectiveNsfw({
        systemNsfwEnabled: Boolean(advancedSettings.nsfw_enabled),
        projectSettings,
        requestOverride:
            typeof workflowData?.nsfw_enabled === 'boolean'
                ? workflowData.nsfw_enabled
                : null
    });

    // Prefer explicit style_preset; fall back to project default_style
    const enrichedWorkflowData = {
        ...workflowData,
        style_preset:
            workflowData?.style_preset
            || workflowData?.style
            || workflowData?.visual_style
            || projectSettings.default_style
            || null,
        nsfw_enabled: nsfwEnabled
    };

    // Unified policy: LoRA stack (character → style → nsfw) + SFW/NSFW prompt boosters
    const plan = resolveGenerationPlan({
        modelFamily,
        nsfwEnabled,
        runtimeSettings,
        workflowData: enrichedWorkflowData,
        basePrompt: finalPrompt
    });

    const effectivePrompt = applyPromptEnhancement(finalPrompt, plan.enhancement);
    const preserveTemplateConditioning = !isFlux && /pony/i.test(JSON.stringify(workflow));

    const negativeParts = [
        workflowData?.negative_prompt || '',
        plan.enhancement.negativeExtra
    ];
    const negativePrompt = negativeParts.filter(Boolean).join(', ');

    // FLUX prefers lower CFG; keep Pony defaults unless the client overrides
    const defaultSteps = Number(generationParams?.steps || (isFlux ? 24 : 25));
    const defaultCfg = Number(generationParams?.cfg || (isFlux ? 3.5 : 7));

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
        sampler.inputs.steps = defaultSteps;
        sampler.inputs.cfg = defaultCfg;
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

    for (const slot of plan.loras) {
        injectLora(workflow, slot.name, slot.strength, modelFamily);
        logger.info(
            `Injected ${slot.role} LoRA for ${modelFamily}: ${slot.name} @ ${slot.strength}`
        );
    }

    if (nsfwEnabled && !plan.loras.some((l) => l.role === 'nsfw')) {
        logger.warn(
            `NSFW mode is enabled but no ${modelFamily} NSFW LoRA was found under models/loras. `
            + 'Install Incase_Style_PonyXL (Pony) or aidmaNSFWunlock (FLUX), or set advanced.*_nsfw_lora.'
        );
    }

    // After LoRAs: optional img2img. Story / multi-person shots stay pure txt2img
    // so composition follows the narrative prompt instead of a portrait latent.
    const referenceImageUrl = workflowData?.ref_image_url || workflowData?.init_image_url;
    if (referenceImageUrl) {
        const referenceFilename = path.basename(String(referenceImageUrl));
        for (const node of Object.values(workflow) as any[]) {
            if (node?.class_type === 'LoadImage' && node.inputs && !node._meta?.title?.includes('NovaStory')) {
                node.inputs.image = referenceFilename;
            }
        }
        const policy = resolveReferenceImg2ImgPolicy(workflowData, effectivePrompt);
        if (policy.useImg2Img) {
            injectImg2ImgReference(
                workflow,
                referenceFilename,
                policy.denoise,
                width,
                height,
                isFlux
            );
        } else {
            logger.info(
                `Skipping img2img for narrative composition (${policy.reason}); `
                + `ref ${referenceFilename} kept for future adapters only`
            );
            // Ensure pure txt2img denoise
            for (const node of Object.values(workflow) as any[]) {
                if (node?.class_type?.includes('KSampler') && node.inputs) {
                    node.inputs.denoise = 1;
                }
            }
        }
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
    const candidates = [
        path.join(staticDir, filename),
        // Allow absolute filesystem paths passed as ref_image_url
        String(referenceImageUrl).startsWith('/') || /^[A-Za-z]:[\\/]/.test(String(referenceImageUrl))
            ? String(referenceImageUrl).replace(/^\/static\/generated\//, '')
            : '',
        path.join(staticDir, '..', filename)
    ].filter(Boolean);

    // Resolve /static/generated/foo.png style URLs against staticDir
    if (String(referenceImageUrl).includes('/static/generated/')) {
        candidates.unshift(path.join(staticDir, filename));
    }

    let sourcePath: string | null = null;
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            sourcePath = candidate;
            break;
        }
    }
    if (!sourcePath) {
        logger.warn(`Reference image not found for ComfyUI input: ${referenceImageUrl}`);
        return;
    }

    const inputDirectory = path.join(comfyInstallPath, 'input');
    fs.mkdirSync(inputDirectory, { recursive: true });
    fs.copyFileSync(sourcePath, path.join(inputDirectory, filename));
    logger.info(`Copied reference image to ComfyUI input: ${filename}`);
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

            // Attach project settings from scene → chapter → project when available
            let effectiveWorkflowData = { ...workflowData };
            try {
                const sceneRow = await db.get('SELECT chapter_id FROM scene WHERE id = ?', sceneId);
                if (sceneRow?.chapter_id) {
                    const chapterRow = await db.get(
                        'SELECT project_id FROM chapter WHERE id = ?',
                        sceneRow.chapter_id
                    );
                    if (chapterRow?.project_id) {
                        const projectRow = await db.get(
                            'SELECT settings FROM project WHERE id = ?',
                            chapterRow.project_id
                        );
                        if (projectRow) {
                            const projectSettings = parseProjectSettings(projectRow.settings);
                            effectiveWorkflowData = {
                                ...effectiveWorkflowData,
                                project_settings: {
                                    ...projectSettings,
                                    ...(effectiveWorkflowData.project_settings || {})
                                },
                                style_preset:
                                    effectiveWorkflowData.style_preset
                                    || projectSettings.default_style
                                    || null
                            };
                        }
                    }
                }
            } catch (e) {
                logger.warn(`[Task ${taskId}] Could not load project settings for scene ${sceneId}: ${e}`);
            }

            const nsfwEnabled = resolveEffectiveNsfw({
                systemNsfwEnabled: Boolean(settings.advanced?.nsfw_enabled),
                projectSettings: parseProjectSettings(effectiveWorkflowData.project_settings),
                requestOverride:
                    typeof effectiveWorkflowData.nsfw_enabled === 'boolean'
                        ? effectiveWorkflowData.nsfw_enabled
                        : null
            });
            effectiveWorkflowData.nsfw_enabled = nsfwEnabled;
            logger.info(
                `[Task ${taskId}] Effective NSFW=${nsfwEnabled}, style_preset=${effectiveWorkflowData.style_preset || 'none'}`
            );

            if (mode === "cinematic_grid") {
                const rawPrompt = effectiveWorkflowData?.prompt || effectiveWorkflowData?.text || effectiveWorkflowData?.description || JSON.stringify(effectiveWorkflowData);
                finalPrompt = Prompts.buildCinematicGridImagePrompt(rawPrompt);
            } else {
                finalPrompt = effectiveWorkflowData?.prompt || effectiveWorkflowData?.text || effectiveWorkflowData?.description || JSON.stringify(effectiveWorkflowData);
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
                    effectiveWorkflowData,
                    staticDir,
                    comfySettings.install_path
                );

                const finalWorkflow = await compileComfyWorkflow(
                    effectiveWorkflowData,
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
