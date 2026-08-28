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
    mergeClipPositivePrompt,
    normalizeImageModelFamily,
    resolveGenerationPlan,
    sanitizeNegativePromptForSubject,
    sanitizePromptForSubject,
    type ImageModelFamily
} from './image_generation_policy';
import {
    buildCharacterAppearanceSnippet,
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
import {
    createProgressPublisher,
    runVramHandoffForImageGen,
} from './generation_progress';
import {
    normalizeGeneratedImage,
    resolveImageOutputTarget,
    type ImageOutputTarget,
} from './image_output_spec';

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

const NONHUMAN_PROMPT_RE =
    /\b(animal|creature|furry|furred|quadruped|paw|paws|paw pads?|whiskers?|muzzle|snout|tail|kitten|cat|puppy|dog|fox|rabbit|bunny|wolf|bear|otter|hamster|mouse|deer|bird)\b/i;
const HUMAN_PROMPT_RE =
    /\b(1girl|2girls|3girls|1boy|2boys|3boys|girl|woman|women|female|boy|man|men|male|person|people|heroine|swordswoman|swordsman|princess|prince)\b/i;
const ENVIRONMENT_PROMPT_RE =
    /\b(wide shot|long shot|extreme long|establishing|panoramic|landscape|environment|overview|overhead shot|aerial shot|bird'?s[- ]eye|plaza|square|amusement park|theme park|corridor|hallway|cityscape)\b/i;

export const shouldSuppressAppearanceForDetailShot = (
    shotType?: string | null,
    prompt?: string | null
): boolean => {
    const shot = String(shotType || '');
    const text = String(prompt || '');
    if (!/\b(insert shot|detail shot|macro shot|object close-up|prop close-up)\b/i.test(shot)) {
        return false;
    }
    return /\b(paw|paws|paw pad|nose|whisker|ticket|cup|steam|machine|button|dispenser|floor|tile|light patch|object|prop)\b/i.test(text);
};

const parseSceneShotSpec = (raw: unknown): Record<string, unknown> | null => {
    if (!raw) return null;
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    try {
        const parsed = JSON.parse(String(raw));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
    } catch {
        return null;
    }
};

/** Restore scene-authored fields when a direct generation request only sends
 * model/style settings. The database is the source of truth for both prompts. */
export const mergeSceneGenerationContext = (
    workflowData: any,
    sceneRow: any
): any => {
    const shotSpec =
        workflowData?.shot_spec
        || parseSceneShotSpec(sceneRow?.shot_spec)
        || null;
    const shotIntent =
        workflowData?.shot_intent
        || shotSpec?.shot_intent
        || null;
    return {
        ...workflowData,
        prompt:
            workflowData?.prompt
            || workflowData?.text
            || workflowData?.description
            || sceneRow?.visual_prompt
            || '',
        negative_prompt:
            workflowData?.negative_prompt
            || sceneRow?.negative_prompt
            || '',
        shot_type: workflowData?.shot_type || sceneRow?.shot_type || null,
        camera_movement:
            workflowData?.camera_movement || sceneRow?.camera_movement || null,
        camera_angle: workflowData?.camera_angle || sceneRow?.camera_angle || null,
        shot_spec: shotSpec,
        shot_intent: shotIntent,
    };
};

const parseCharacterVisualTags = (value: unknown): any => {
    if (!value || typeof value === 'object') return value || {};
    try {
        return JSON.parse(String(value));
    } catch {
        return {};
    }
};

const characterLooksNonhuman = (character: any): boolean => {
    const visualTags = parseCharacterVisualTags(character?.visual_tags);
    return NONHUMAN_PROMPT_RE.test(
        `${character?.description || ''} ${JSON.stringify(visualTags)}`
    );
};

const characterMentioned = (prompt: string, character: any): boolean => {
    const lower = String(prompt || '').toLowerCase();
    const compact = lower.replace(/[\s_-]/g, '');
    const name = String(character?.name || '').trim().toLowerCase();
    if (name && (lower.includes(name) || compact.includes(name.replace(/[\s_-]/g, '')))) {
        return true;
    }
    const visualTags = parseCharacterVisualTags(character?.visual_tags);
    const aliases = Array.isArray(visualTags?.aliases)
        ? visualTags.aliases
        : (Array.isArray(character?.aliases) ? character.aliases : []);
    return aliases.some((raw: unknown) => {
        const alias = String(raw || '').trim().toLowerCase();
        return Boolean(alias) && (
            lower.includes(alias) || compact.includes(alias.replace(/[\s_-]/g, ''))
        );
    });
};

/**
 * Resolve database character rows for a scene when the caller omitted appearance
 * snippets. This keeps direct API and UI generation semantically equivalent.
 */
export const selectSceneCharacterAppearance = (
    characters: any[],
    prompt: string,
    options: { chapterId?: string | number | null; shotType?: string | null } = {}
): { snippets: string[]; subjectType: 'nonhuman' | 'human' | 'mixed' | 'environment' | null } => {
    const normalized = (characters || []).map((character) => ({
        ...character,
        visual_tags: parseCharacterVisualTags(character?.visual_tags)
    }));
    const mentioned = normalized.filter((character) => characterMentioned(prompt, character));
    let selected = mentioned;

    if (selected.length === 0 && NONHUMAN_PROMPT_RE.test(prompt)) {
        const nonhuman = normalized.filter(characterLooksNonhuman);
        if (nonhuman.length === 1) selected = nonhuman;
    }
    if (selected.length === 0 && HUMAN_PROMPT_RE.test(prompt)) {
        const human = normalized.filter((character) => !characterLooksNonhuman(character));
        if (human.length === 1) selected = human;
    }
    if (
        selected.length === 0
        && normalized.length === 1
        && /\b(protagonist|main character|the character|hero|heroine)\b/i.test(prompt)
    ) {
        selected = normalized;
    }

    const wideShot = /wide|long shot|extreme long|establishing|panoramic|overhead|aerial|bird'?s[- ]eye/i.test(
        `${options.shotType || ''} ${prompt}`
    );
    const snippets = selected
        .map((character) => buildCharacterAppearanceSnippet(character, {
            chapterId: options.chapterId,
            wideShot
        }))
        .filter(Boolean);

    const selectedNonhumanCount = selected.filter(characterLooksNonhuman).length;
    if (selectedNonhumanCount > 0 && selectedNonhumanCount < selected.length) {
        return { snippets, subjectType: 'mixed' };
    }
    if (selectedNonhumanCount > 0) return { snippets, subjectType: 'nonhuman' };
    if (selected.length > 0) return { snippets, subjectType: 'human' };
    if (ENVIRONMENT_PROMPT_RE.test(`${options.shotType || ''} ${prompt}`)) {
        return { snippets, subjectType: 'environment' };
    }
    return { snippets, subjectType: null };
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
    const subjectSafePrompt = sanitizePromptForSubject(
        finalPrompt,
        enrichedWorkflowData.subject_type
    );
    const plan = resolveGenerationPlan({
        modelFamily,
        nsfwEnabled,
        runtimeSettings,
        workflowData: enrichedWorkflowData,
        basePrompt: subjectSafePrompt
    });

    const effectivePrompt = applyPromptEnhancement(subjectSafePrompt, plan.enhancement);
    const preserveTemplateConditioning =
        modelFamily === 'pony' && /pony/i.test(JSON.stringify(workflow));

    const negativeParts = [
        sanitizeNegativePromptForSubject(
            workflowData?.negative_prompt || '',
            enrichedWorkflowData.subject_type
        ),
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
            // Scene action owns the CLIP front window; template quality/framing tokens merge after.
            workflow[positiveId].inputs.text = preserveTemplateConditioning && templateText
                ? mergeClipPositivePrompt({
                    scene: subjectSafePrompt,
                    framing: [
                      plan.enhancement.prefix,
                      plan.enhancement.suffix,
                    ].filter(Boolean).join(', '),
                    templateText,
                  })
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

    const outputTarget = resolveImageOutputTarget({
        workflowData,
        generationParams,
        mode,
        modelFamily,
        finalPrompt,
    });
    const { width, height } = outputTarget;
    logger.info(
        `Resolved image canvas ${width}x${height} ratio=${outputTarget.resolved_aspect_ratio} `
        + `resolution=${outputTarget.resolution} source=${outputTarget.source}`
    );

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
        await AssetTaskStore.processing(taskId, sceneId);

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
                const publish = createProgressPublisher(taskId, redis);

                try {
                    // Plan 1: free LLM VRAM before multi-panel ComfyUI work
                    await runVramHandoffForImageGen(publish);

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
                    await AssetTaskStore.completed(taskId, sceneId, assetUrl);
                    await publish('complete', {
                        status: 'completed',
                        image_url: assetUrl,
                        panel_urls: result.panelUrls
                    });
                    logger.info(`[Task ${taskId}] Turnaround composite completed: ${assetUrl}`);
                    return;
                } catch (error: any) {
                    logger.error(`[Task ${taskId}] Turnaround composite failed: ${error?.message || error}`);
                    await AssetTaskStore.failed(taskId, sceneId, error?.message || String(error));
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
                    await publish('complete', {
                        status: 'failed',
                        error: error?.message || String(error)
                    });
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

        const progressHandler = createProgressPublisher(taskId, redis);

        try {
            const settings = SettingsManager.loadSettings();
            const comfySettings = settings.comfyui || {};
            const useComfy = comfySettings.enabled || false;

            let result: any = null;
            let finalPrompt = "";

            // Attach project settings from scene → chapter → project when available
            let effectiveWorkflowData = { ...workflowData };
            let sceneProjectId: number | null = null;
            let sceneChapterId: string | null = null;
            try {
                const sceneRow = await db.get(
                    `SELECT chapter_id, visual_prompt, negative_prompt, shot_type, camera_movement, camera_angle, shot_spec
                     FROM scene WHERE id = ?`,
                    sceneId
                );
                if (sceneRow?.chapter_id) {
                    sceneChapterId = sceneRow.chapter_id;
                    effectiveWorkflowData = mergeSceneGenerationContext(
                        effectiveWorkflowData,
                        sceneRow
                    );
                    const chapterRow = await db.get(
                        'SELECT project_id FROM chapter WHERE id = ?',
                        sceneRow.chapter_id
                    );
                    if (chapterRow?.project_id) {
                        sceneProjectId = Number(chapterRow.project_id);
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

            const cameraDetails = [
                effectiveWorkflowData?.shot_type,
                effectiveWorkflowData?.camera_movement,
                effectiveWorkflowData?.camera_angle
            ].filter(Boolean).map(String);
            if (
                cameraDetails.length > 0
                && !cameraDetails.every((detail) => finalPrompt.toLowerCase().includes(detail.toLowerCase()))
            ) {
                finalPrompt = `(${cameraDetails.join(', ')}), ${finalPrompt}`;
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
            if (appearanceSnippets.length === 0 && sceneProjectId != null) {
                try {
                    if (shouldSuppressAppearanceForDetailShot(
                        effectiveWorkflowData?.shot_type,
                        finalPrompt
                    )) {
                        logger.info(
                            `[Task ${taskId}] Detail/insert shot: skipped full character appearance injection`
                        );
                    } else {
                        const characters = await db.all(
                            'SELECT id, name, role, description, visual_tags FROM character WHERE project_id = ?',
                            sceneProjectId
                        );
                        const resolved = selectSceneCharacterAppearance(characters, finalPrompt, {
                            chapterId: sceneChapterId,
                            shotType: effectiveWorkflowData?.shot_type
                        });
                        appearanceSnippets.push(...resolved.snippets);
                        if (!effectiveWorkflowData?.subject_type && resolved.subjectType) {
                            effectiveWorkflowData.subject_type = resolved.subjectType;
                        }
                        if (resolved.snippets.length > 0) {
                            logger.info(
                                `[Task ${taskId}] Restored ${resolved.snippets.length} character appearance snippet(s) from project data`
                            );
                        }
                    }
                } catch (e) {
                    logger.warn(`[Task ${taskId}] Could not restore character appearance data: ${e}`);
                }
            }
            if (appearanceSnippets.length > 0) {
                finalPrompt = mergeAppearanceIntoPrompt(finalPrompt, appearanceSnippets);
                // Keep workflow.prompt in sync so policy heuristics see the full text
                effectiveWorkflowData = { ...effectiveWorkflowData, prompt: finalPrompt };
            }

            const outputModelFamily = normalizeImageModelFamily(
                effectiveWorkflowData?.model_type
                || effectiveWorkflowData?.reference_model_type
                || 'pony'
            );
            const outputTarget: ImageOutputTarget = resolveImageOutputTarget({
                workflowData: effectiveWorkflowData,
                generationParams,
                mode,
                modelFamily: outputModelFamily,
                finalPrompt,
            });
            logger.info(
                `[Task ${taskId}] Output contract ${outputTarget.width}x${outputTarget.height} `
                + `ratio=${outputTarget.resolved_aspect_ratio} resolution=${outputTarget.resolution} `
                + `source=${outputTarget.source}`
            );

            if (useComfy) {
                logger.info(`[Task ${taskId}] Using ComfyUI`);

                // Plan 1: auto VRAM handoff — unload Ollama before Pony/SDXL claims GPU
                await runVramHandoffForImageGen(progressHandler);

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

                result = await comfyService.generateImage(finalWorkflow, progressHandler, {
                    onPromptQueued: async (promptId) => {
                        await AssetTaskStore.setComfyPromptId(taskId, promptId);
                    }
                });
            } else {
                logger.info(`[Task ${taskId}] Using configured cloud image provider`);
                const aiProvider = MediaService.getProvider();
                const apiRes = await aiProvider.generateImage(finalPrompt, {
                    width: outputTarget.width,
                    height: outputTarget.height,
                    aspectRatio: outputTarget.resolved_aspect_ratio,
                    imageSize: outputTarget.image_size,
                }, userToken);
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
                let imageData: Buffer | null = img.data ? Buffer.from(img.data) : null;
                if (!imageData && img.url) {
                    const remoteResponse = await fetch(String(img.url), {
                        signal: AbortSignal.timeout(60_000),
                    });
                    if (!remoteResponse.ok) {
                        throw new Error(`Could not download generated image: HTTP ${remoteResponse.status}`);
                    }
                    imageData = Buffer.from(await remoteResponse.arrayBuffer());
                }

                if (imageData) {
                    const normalizedImage = await normalizeGeneratedImage(imageData, outputTarget);
                    const filename = `${sceneId}_${taskId}.png`;
                    const filepath = path.join(staticDir, filename);
                    fs.writeFileSync(filepath, normalizedImage.buffer);
                    assetUrl = `/static/generated/${filename}`;
                    finalStatus = "completed";
                    if (normalizedImage.normalized) {
                        logger.warn(
                            `[Task ${taskId}] Provider returned ${normalizedImage.sourceWidth}x${normalizedImage.sourceHeight}; `
                            + `normalized to ${normalizedImage.width}x${normalizedImage.height}`
                        );
                    }
                    logger.info(
                        `[Task ${taskId}] Image saved to ${filepath} `
                        + `(${normalizedImage.width}x${normalizedImage.height})`
                    );
                }

                if (finalStatus === "completed" && sceneId < 90_000_000) {
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
                await AssetTaskStore.completed(taskId, sceneId, assetUrl!);
                await progressHandler('complete', {
                    status: 'completed',
                    image_url: assetUrl,
                    width: outputTarget.width,
                    height: outputTarget.height,
                    aspect_ratio: outputTarget.resolved_aspect_ratio,
                });
            } else {
                const errMsg = result?.message || "Unknown error";
                logger.error(`[Task ${taskId}] Generation failed: ${errMsg}`);
                await AssetTaskStore.failed(taskId, sceneId, errMsg);
                if (sceneId < 90_000_000) {
                    await db.run('UPDATE scene SET asset_status = ?, task_id = ? WHERE id = ?', "failed", taskId, sceneId);
                    await ensureSceneVersionBaseline(sceneId);
                    await syncActiveVersionAssets(sceneId, {
                        asset_status: 'failed',
                        task_id: taskId
                    });
                }
                await progressHandler('complete', {
                    status: 'failed',
                    error: errMsg
                });
            }

        } catch (error: any) {
            logger.error(`[Task ${taskId}] Unexpected error in async service: ${error.message}`);
            await AssetTaskStore.failed(taskId, sceneId, error.message);
            try {
                if (sceneId < 90_000_000) {
                    await db.run('UPDATE scene SET asset_status = ?, task_id = ? WHERE id = ?', "failed", taskId, sceneId);
                    await ensureSceneVersionBaseline(sceneId);
                    await syncActiveVersionAssets(sceneId, {
                        asset_status: 'failed',
                        task_id: taskId
                    });
                }
                await progressHandler('complete', {
                    status: 'failed',
                    error: error.message
                });
            } catch (e) {}
        } finally {
            if (redis) redis.disconnect();
        }
    }
}
