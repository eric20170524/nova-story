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
    normalizeImageModelFamily,
    resolveGenerationPlan,
    type ImageModelFamily
} from './image_generation_policy';
import {
    mergeAppearanceIntoPrompt,
    planReferenceGeneration,
    resolveReferenceImg2ImgPolicy,
    resolveReferenceUrls,
    type AdapterAvailability
} from './reference_generation_policy';
import {
    injectTierBAdapters,
    probeTierBCapability,
    resolveTierBFromSettings,
    type TierBCapability
} from './tier_b_adapters';
import { parseProjectSettings, resolveEffectiveNsfw } from './project_settings';
import { ensureSceneVersionBaseline, syncActiveVersionAssets } from './scene_versions';

// Re-export for tests and callers that imported from generation_service
export { resolveReferenceImg2ImgPolicy, planReferenceGeneration, resolveReferenceUrls };

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
    modelType: ImageModelFamily
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
            _meta: { title: modelType === 'sd15' ? 'NovaStory SD1.5 LoRA' : 'NovaStory Pony LoRA' }
        };
    }

    for (const node of Object.values(workflow) as any[]) {
        if (node?.class_type?.includes('KSampler') && node.inputs) {
            node.inputs.model = [loraNodeId, 0];
        }
        // Pony + SD1.5 both use CLIP-aware LoraLoader
        if (
            modelType !== 'flux'
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

/** @deprecated use resolveReferenceImg2ImgPolicy */
export const resolveImg2ImgDenoise = (workflowData: any): number =>
    resolveReferenceImg2ImgPolicy(workflowData).denoise;

export const compileComfyWorkflow = async (
    workflowData: any,
    finalPrompt: string,
    mode: string,
    generationParams?: any,
    runtimeSettings: any = SettingsManager.loadSettings(),
    /** Pre-probed Tier B capability; when omitted, filesystem-only probe is used */
    adapterCapability?: AdapterAvailability | TierBCapability | null
) => {
    let workflow: any;
    const requestedModel = String(
        workflowData?.model_type
        || workflowData?.reference_model_type
        || ''
    ).toLowerCase();

    if (isComfyWorkflow(workflowData)) {
        workflow = parseWorkflowContent(workflowData);
    } else {
        const selectedWorkflowFile = runtimeSettings.comfyui?.selected_workflow_file
            || runtimeSettings.comfyui?.default_workflow;
        const selectedWorkflowName = selectedWorkflowFile
            ? path.basename(String(selectedWorkflowFile), '.json')
            : null;
        const modelKey = requestedModel || 'pony';
        // FLUX.1-dev GGUF retired (2026-08). Prefer SD1.5 draft or Pony XL.
        const preferredName =
            normalizeImageModelFamily(modelKey) === 'sd15'
                ? 'sd15_draft_12gb'
                : 'pony_xl_12gb';
        const fallbackName = 'pony_xl_12gb';
        // Explicit model_type on the request must win over a global UI default.
        const explicitModel =
            Boolean(workflowData?.model_type || workflowData?.reference_model_type);

        let row = null as any;
        if (explicitModel) {
            row = await db.get('SELECT content FROM workflow WHERE name = ?', preferredName);
        }
        if (!row && selectedWorkflowName) {
            row = await db.get('SELECT content FROM workflow WHERE name = ?', selectedWorkflowName);
        }
        if (!row) {
            row = await db.get('SELECT content FROM workflow WHERE name = ?', preferredName);
        }
        if (!row && preferredName !== fallbackName) {
            row = await db.get('SELECT content FROM workflow WHERE name = ?', fallbackName);
        }
        if (!row) {
            throw new Error(`No ComfyUI workflow is configured for model '${modelKey}'`);
        }
        workflow = parseWorkflowContent(row.content);
        logger.info(
            `Comfy workflow resolved: name preference=${preferredName} explicitModel=${explicitModel} `
            + `(request model_type=${modelKey})`
        );
    }

    const isFlux = Boolean(findNodeId(workflow, (node) =>
        node?.class_type === 'UnetLoaderGGUF'
        || (
            node?.class_type === 'CheckpointLoaderSimple'
            && /flux/i.test(node.inputs?.ckpt_name || '')
        )
    ));
    const ckptLooksSd15 = Boolean(findNodeId(workflow, (node) =>
        node?.class_type === 'CheckpointLoaderSimple'
        && /sd\s*1\.?5|anything|counterfeit|meina|chillout|sd15/i.test(
            String(node.inputs?.ckpt_name || '')
        )
    ));
    // Graph detection wins for FLUX custom graphs; otherwise honor request / SD1.5 ckpt.
    const modelFamily: ImageModelFamily = isFlux
        ? 'flux'
        : normalizeImageModelFamily(
            requestedModel
            || (ckptLooksSd15 ? 'sd15' : 'pony')
        );
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
    const preserveTemplateConditioning =
        modelFamily === 'pony' && /pony/i.test(JSON.stringify(workflow));

    const negativeParts = [
        workflowData?.negative_prompt || '',
        plan.enhancement.negativeExtra
    ];
    const negativePrompt = negativeParts.filter(Boolean).join(', ');

    // FLUX prefers lower CFG; SD1.5 draft prefers fewer steps; Pony defaults otherwise
    const defaultSteps = Number(
        generationParams?.steps
        || (modelFamily === 'flux' ? 24 : modelFamily === 'sd15' ? 20 : 25)
    );
    const defaultCfg = Number(
        generationParams?.cfg
        || (modelFamily === 'flux' ? 3.5 : 7)
    );

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
    let width = mode === 'cinematic_grid' ? 1024 : (isTurnaround ? 1152 : 768);
    let height = mode === 'cinematic_grid' ? 1024 : (isTurnaround ? 768 : 1024);
    if (modelFamily === 'sd15' && mode !== 'cinematic_grid') {
        // Match sd15_draft_12gb latent defaults for fast iteration
        width = isTurnaround ? 768 : 512;
        height = isTurnaround ? 512 : 768;
    }

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
            + 'Install Incase_Style_PonyXL (Pony) or set advanced.pony_nsfw_lora.'
        );
    }

    // Resolve Tier B capability (caller may pass live probe; else filesystem-only)
    const comfyCfg = runtimeSettings?.comfyui || {};
    const tierBCfg = comfyCfg.tier_b || {};
    let capability: AdapterAvailability | TierBCapability =
        adapterCapability
        || probeTierBCapability(comfyCfg.install_path, {
            enabled: tierBCfg.enabled !== false && comfyCfg.tier_b_enabled !== false,
            configured: {
                ipadapter: tierBCfg.ipadapter_model || comfyCfg.ipadapter_model,
                clipVision: tierBCfg.clip_vision_model || comfyCfg.clip_vision_model,
                controlnet: tierBCfg.controlnet_model || comfyCfg.controlnet_model
            }
        });

    // Tier B adapters are Pony/SDXL only
    if (modelFamily !== 'pony') {
        capability = {
            ...capability,
            characterAdapter: false,
            compositionControl: false
        };
    }

    const refPlan = planReferenceGeneration(workflowData, effectivePrompt, capability);
    for (const note of refPlan.notes) {
        logger.info(`[ref-policy ${refPlan.tier}] ${note}`);
    }

    // Tier B: inject IP-Adapter + ControlNet when planned
    if (refPlan.useCharacterAdapter || refPlan.useCompositionControl) {
        const fullCap = capability as TierBCapability;
        // Ensure we have model paths for inject (probe result)
        const injectCap: TierBCapability = fullCap.models
            ? fullCap
            : probeTierBCapability(comfyCfg.install_path, {
                enabled: true,
                configured: {
                    ipadapter: tierBCfg.ipadapter_model || comfyCfg.ipadapter_model,
                    clipVision: tierBCfg.clip_vision_model || comfyCfg.clip_vision_model,
                    controlnet: tierBCfg.controlnet_model || comfyCfg.controlnet_model
                }
            });

        // Align inject flags with plan
        injectCap.characterAdapter = refPlan.useCharacterAdapter;
        injectCap.compositionControl = refPlan.useCompositionControl;
        injectCap.characterKind =
            refPlan.characterAdapterType === 'ip_adapter_unified'
                ? 'ip_adapter_unified'
                : refPlan.useCharacterAdapter
                    ? 'ip_adapter'
                    : 'none';
        injectCap.compositionKind = refPlan.compositionControlType;

        const charWeight = Number(
            workflowData?.character_adapter_weight
            ?? tierBCfg.character_weight
            ?? 0.75
        );
        const compStrength = Number(
            workflowData?.composition_control_strength
            ?? tierBCfg.composition_strength
            ?? 0.55
        );

        const wired = injectTierBAdapters(workflow, {
            characterImageFilename: refPlan.refs.characterRefUrl
                ? path.basename(String(refPlan.refs.characterRefUrl))
                : null,
            compositionImageFilename: refPlan.refs.compositionRefUrl
                ? path.basename(String(refPlan.refs.compositionRefUrl))
                : null,
            characterWeight: charWeight,
            compositionStrength: compStrength,
            isFlux,
            capability: injectCap
        });
        for (const n of wired.notes) {
            logger.info(`[tier-b] ${n}`);
        }
        if (refPlan.useCharacterAdapter && !wired.characterWired) {
            logger.warn('[tier-b] character adapter planned but inject failed — falling back to Tier A identity');
        }
        if (refPlan.useCompositionControl && !wired.compositionWired) {
            logger.warn('[tier-b] composition control planned but inject failed — text composition only');
        }
    }

    // Tier A img2img (only when character adapter is NOT handling identity)
    const characterRefUrl = refPlan.refs.characterRefUrl;
    if (characterRefUrl) {
        const referenceFilename = path.basename(String(characterRefUrl));
        for (const node of Object.values(workflow) as any[]) {
            if (node?.class_type === 'LoadImage' && node.inputs && !node._meta?.title?.includes('NovaStory')) {
                node.inputs.image = referenceFilename;
            }
        }
        if (refPlan.img2img.useImg2Img) {
            injectImg2ImgReference(
                workflow,
                referenceFilename,
                refPlan.img2img.denoise,
                width,
                height,
                isFlux
            );
        } else if (!refPlan.useCharacterAdapter) {
            logger.info(
                `Skipping img2img (${refPlan.img2img.reason}); `
                + `character_ref ${referenceFilename} kept for future adapters only`
            );
            for (const node of Object.values(workflow) as any[]) {
                if (node?.class_type?.includes('KSampler') && node.inputs) {
                    node.inputs.denoise = 1;
                }
            }
        } else {
            // Adapter path: ensure pure noise latent
            for (const node of Object.values(workflow) as any[]) {
                if (node?.class_type?.includes('KSampler') && node.inputs) {
                    node.inputs.denoise = 1;
                }
            }
        }
    }

    return workflow;
};

const copyOneReferenceImageToComfy = (
    referenceImageUrl: string,
    staticDir: string,
    comfyInstallPath: string
) => {
    const filename = path.basename(String(referenceImageUrl));
    const candidates = [
        path.join(staticDir, filename),
        // Allow absolute filesystem paths passed as ref_image_url
        String(referenceImageUrl).startsWith('/') || /^[A-Za-z]:[\\/]/.test(String(referenceImageUrl))
            ? String(referenceImageUrl).replace(/^\/static\/generated\//, '')
            : '',
        path.join(staticDir, '..', filename)
    ].filter(Boolean);

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

/** Copy character + composition refs (Tier A/B) into ComfyUI/input. */
export const copyReferenceImageToComfy = (
    workflowData: any,
    staticDir: string,
    comfyInstallPath?: string
) => {
    if (!comfyInstallPath) return;
    const refs = resolveReferenceUrls(workflowData);
    for (const url of refs.urlsToCopy) {
        copyOneReferenceImageToComfy(url, staticDir, comfyInstallPath);
    }
};

export class GenerationService {
    static async generateAssets(taskId: string, workflowData: any, sceneId: number, userToken?: string, mode: string = "standard", generationParams?: any) {
        logger.info(`[Task ${taskId}] Asset generation started for Scene ${sceneId} (Mode: ${mode})`);
        AssetTaskStore.processing(taskId, sceneId);

        // Character turnaround: 3 full-body views + stitch (reliable multi-angle sheet)
        try {
            const { shouldUseTurnaroundComposite, generateTurnaroundComposite } = await import(
                './turnaround_composite'
            );
            if (shouldUseTurnaroundComposite(workflowData)) {
                const settings = SettingsManager.loadSettings();
                if (!settings.comfyui?.enabled) {
                    throw new Error('Turnaround composite requires ComfyUI enabled');
                }

                let redis: Redis | null = null;
                const redisUrl = process.env.REDIS_URL;
                if (redisUrl) {
                    try {
                        redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, retryStrategy: () => null });
                    } catch {
                        redis = null;
                    }
                }
                const publish = async (msgType: string, data: any) => {
                    if (redis && redis.status === 'ready') {
                        try {
                            await redis.publish(
                                `task_progress:${taskId}`,
                                JSON.stringify({ type: msgType, data })
                            );
                        } catch {
                            /* ignore */
                        }
                    }
                    logger.info(`[Task ${taskId}] Progress: ${msgType}`);
                };

                try {
                    const finalPrompt =
                        workflowData?.prompt
                        || workflowData?.text
                        || workflowData?.description
                        || '';
                    const result = await generateTurnaroundComposite({
                        taskId,
                        sceneId,
                        prompt: String(finalPrompt),
                        negative_prompt: workflowData?.negative_prompt
                            ? String(workflowData.negative_prompt)
                            : undefined,
                        workflowData,
                        generationParams,
                        onProgress: publish
                    });

                    const assetUrl = result.sheetUrl;
                    if (sceneId < 90_000_000) {
                        await db.run(
                            'UPDATE scene SET asset_status = ?, asset_url = ?, task_id = ? WHERE id = ?',
                            'completed',
                            assetUrl,
                            taskId,
                            sceneId
                        );
                        await ensureSceneVersionBaseline(sceneId);
                        await syncActiveVersionAssets(sceneId, {
                            asset_status: 'completed',
                            asset_url: assetUrl,
                            task_id: taskId
                        });
                    }
                    AssetTaskStore.completed(taskId, sceneId, assetUrl);
                    if (redis && redis.status === 'ready') {
                        try {
                            await redis.publish(
                                `task_progress:${taskId}`,
                                JSON.stringify({
                                    type: 'complete',
                                    status: 'completed',
                                    image_url: assetUrl,
                                    panel_urls: result.panelUrls
                                })
                            );
                        } catch {
                            /* ignore */
                        }
                    }
                    logger.info(`[Task ${taskId}] Turnaround composite completed: ${assetUrl}`);
                    return;
                } catch (error: any) {
                    logger.error(`[Task ${taskId}] Turnaround composite failed: ${error?.message || error}`);
                    AssetTaskStore.failed(taskId, sceneId, error?.message || String(error));
                    if (sceneId < 90_000_000) {
                        try {
                            await db.run(
                                'UPDATE scene SET asset_status = ?, task_id = ? WHERE id = ?',
                                'failed',
                                taskId,
                                sceneId
                            );
                        } catch {
                            /* ignore */
                        }
                    }
                    if (redis && redis.status === 'ready') {
                        try {
                            await redis.publish(
                                `task_progress:${taskId}`,
                                JSON.stringify({
                                    type: 'complete',
                                    status: 'failed',
                                    error: error?.message || String(error)
                                })
                            );
                        } catch {
                            /* ignore */
                        }
                    }
                    return;
                } finally {
                    if (redis) redis.disconnect();
                }
            }
        } catch (importErr: any) {
            logger.warn(
                `[Task ${taskId}] Turnaround composite path unavailable, falling back: ${importErr?.message || importErr}`
            );
        }

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

            // Tier A: ensure character appearance tags survive even if a client omitted them
            const appearanceSnippets: string[] = [];
            if (effectiveWorkflowData?.character_appearance_prompt) {
                appearanceSnippets.push(String(effectiveWorkflowData.character_appearance_prompt));
            }
            if (Array.isArray(effectiveWorkflowData?.character_appearance_snippets)) {
                for (const s of effectiveWorkflowData.character_appearance_snippets) {
                    if (s) appearanceSnippets.push(String(s));
                }
            }
            if (appearanceSnippets.length > 0) {
                finalPrompt = mergeAppearanceIntoPrompt(finalPrompt, appearanceSnippets);
                // Keep workflow.prompt in sync so policy heuristics see the full text
                effectiveWorkflowData = { ...effectiveWorkflowData, prompt: finalPrompt };
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

                // Live Tier B probe (object_info + models) before compile — Pony/SDXL only
                const requestFamily = normalizeImageModelFamily(
                    effectiveWorkflowData?.model_type
                    || effectiveWorkflowData?.reference_model_type
                    || 'pony'
                );
                const tierBCapability = await resolveTierBFromSettings(settings, {
                    isFlux: requestFamily !== 'pony'
                });
                logger.info(
                    `[Task ${taskId}] Tier B probe: character=${tierBCapability.characterAdapter} `
                    + `composition=${tierBCapability.compositionControl} `
                    + `missing=${tierBCapability.missing.join(',') || 'none'}`
                );

                const finalWorkflow = await compileComfyWorkflow(
                    effectiveWorkflowData,
                    finalPrompt,
                    mode,
                    generationParams,
                    settings,
                    tierBCapability
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
                    await ensureSceneVersionBaseline(sceneId);
                    await syncActiveVersionAssets(sceneId, {
                        asset_status: 'completed',
                        asset_url: assetUrl,
                        task_id: taskId
                    });
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
                await ensureSceneVersionBaseline(sceneId);
                await syncActiveVersionAssets(sceneId, {
                    asset_status: 'failed',
                    task_id: taskId
                });
                if (redis && redis.status === 'ready') {
                    try { await redis.publish(`task_progress:${taskId}`, JSON.stringify({ type: "complete", status: "failed", error: errMsg })); } catch(e) {}
                }
            }

        } catch (error: any) {
            logger.error(`[Task ${taskId}] Unexpected error in async service: ${error.message}`);
            AssetTaskStore.failed(taskId, sceneId, error.message);
            try {
                await db.run('UPDATE scene SET asset_status = ?, task_id = ? WHERE id = ?', "failed", taskId, sceneId);
                await ensureSceneVersionBaseline(sceneId);
                await syncActiveVersionAssets(sceneId, {
                    asset_status: 'failed',
                    task_id: taskId
                });
                if (redis && redis.status === 'ready') {
                    await redis.publish(`task_progress:${taskId}`, JSON.stringify({ type: "complete", status: "failed", error: error.message }));
                }
            } catch (e) {}
        } finally {
            if (redis) redis.disconnect();
        }
    }
}
