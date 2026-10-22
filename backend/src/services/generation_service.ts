import { ComfyUIService, applyRemoteLoraCatalog } from './ai/comfyui_service';
import { MediaService } from './media_service';
import { SettingsManager } from '../core/settings_manager';
import { db, withImmediateTransaction } from '../db/database';
import Redis from 'ioredis';
import path from 'path';
import fs from 'fs';
import { logger } from '../core/logging';
import { Prompts } from './prompts';
import { AssetTaskStore } from './task_store';
import {
    getGeneratedDirectory,
    getSceneAssetPath,
    getCharacterAssetPath,
    getLibraryAssetPath,
    resolveStaticAssetPath
} from '../core/paths';
import {
    applyPromptEnhancement,
    CHILD_SAFETY_NEGATIVE,
    ORIENTAL_REALISTIC_NEGATIVE,
    isAdultLookLoraName,
    mergeClipPositivePrompt,
    normalizeImageModelFamily,
    resolveGenerationPlan,
    sanitizeNegativePromptForSubject,
    sanitizePromptForSubject,
    stripSfwSuppressionFromNegative,
    styleLightingMaterial,
    type ImageModelFamily
} from './image_generation_policy';
import {
    buildCharacterAppearanceSnippet,
    mergeAppearanceIntoPrompt,
    planReferenceGeneration,
    visiblePeopleFromWorkflow,
    resolveReferenceImg2ImgPolicy,
    resolveReferenceUrls,
    type AdapterAvailability
} from './reference_generation_policy';
import {
    injectKrea2QwenFaceDetailStage2,
    injectTierBAdapters,
    isFaceDetailStage2Node,
    pickCatalogModel,
    probeTierBCapability,
    resolveTierBFromSettings,
    type TierBCapability
} from './tier_b_adapters';
import { getProjectImageSettings, parseProjectSettings, resolveEffectiveNsfw } from './project_settings';
import { captureShotMasterSnapshot, recordShotMasterSnapshot, type ShotMasterInputSnapshot } from './video/shot_master_snapshot';
import { ensureSceneVersionBaseline, syncActiveVersionAssets } from './scene_versions';
import { persistFormalCandidateResult, retainUnverifiedPrompt } from './formal_storyboard_request';
import { formalRenderAllowed } from './formal_storyboard_plan';
import { requireProductionReferencePin, persistProductionImageResult, type ProductionReferencePin } from './scene_production_media';
import { isSyntheticCharacterSceneId, shouldPersistSceneAsset, syntheticCharacterId } from './synthetic_scene_id';
import { resolveSceneIdentityPlate } from './character_reference_plates';
import {
    createProgressPublisher,
    runVramHandoffForImageGen,
} from './generation_progress';
import { optimizeOutboundPrompt, assetPromptForShot, composeShotImagePrompt, containsCjk, shotImageMaterialsFromSpec, UnverifiedVisualPrompt } from './english_visual_prompt';
import {
    normalizeGeneratedImage,
    resolveComfyLatentDimensions,
    resolveImageOutputTarget,
    type ImageOutputTarget,
} from './image_output_spec';
import { GpuLeaseService } from './gpu_lease_service';
import { selectComfyWorkflow } from './comfy_workflow_selection';

// Re-export for tests and callers that imported from generation_service
export { resolveReferenceImg2ImgPolicy, planReferenceGeneration, resolveReferenceUrls };

/** Draft candidates may keep an unverified prompt. Formal rendering and the active scene may not. */
async function resolvePicturePrompt(taskId: string, sceneId: number, workflow: any, produce: () => Promise<string>): Promise<string> {
    try {
        return await produce();
    } catch (error) {
        if (!(error instanceof UnverifiedVisualPrompt)) throw error;
        const candidate = workflow?.formal_candidate;
        const experimentalDraft = candidate?.publish === false && candidate?.production_stage === 'draft';
        if (candidate?.scene_version) {
            await retainUnverifiedPrompt(sceneId, Number(candidate.scene_version), error.prompt, [error.message], taskId, !experimentalDraft);
        }
        if (!experimentalDraft) throw new Error(`ENGLISH_PROMPT_NEEDS_REVIEW: ${error.message}`);
        logger.warn(`[Task ${taskId}] Unverified English prompt kept on the draft candidate and excluded from the verified cache. ${error.message}`);
        return error.prompt;
    }
}

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

export const selectCodexReferenceUrls = (workflow: any): string[] => {
    const assets = Array.isArray(workflow?.asset_references) ? workflow.asset_references : [];
    const location = assets.filter((ref: any) => ref?.kind === 'location').map((ref: any) => ref.image_url);
    const props = assets.filter((ref: any) => ref?.kind === 'prop').map((ref: any) => ref.image_url);
    const portraits = Array.isArray(workflow?.character_ref_urls) ? workflow.character_ref_urls : [];
    // Codex image generation accepts at most five references. Keep the physical
    // set and the focal identity first, then fill remaining slots in cast order.
    return [...new Set([
        location[0], props[0], workflow?.character_ref_url,
        ...portraits, ...location.slice(1), ...props.slice(1), workflow?.ref_image_url,
    ].filter(Boolean).map(String))].slice(0, 5);
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

/** Location plus a visible action. Portraits and library plates do not qualify. */
export const shotHasImageContract = (shotSpec: unknown): boolean => {
    const spec = parseSceneShotSpec(shotSpec);
    if (!spec) return false;
    return Boolean(String(spec.location || '').trim() && String(spec.primary_action || '').trim());
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
    options: { chapterId?: string | number | null; shotType?: string | null; characterId?: number | null } = {}
): { snippets: string[]; subjectType: 'nonhuman' | 'human' | 'mixed' | 'environment' | null } => {
    const normalized = (characters || []).map((character) => ({
        ...character,
        visual_tags: parseCharacterVisualTags(character?.visual_tags)
    }));
    // A casting request owns one identity. Narrative descriptions may mention
    // other people; those names must not change the character being cast.
    const explicitIdentity = options.characterId != null;
    const mentioned = normalized.filter((character) => explicitIdentity
        ? Number(character.id) === options.characterId
        : characterMentioned(prompt, character));
    let selected = mentioned;

    if (!explicitIdentity && selected.length === 0 && NONHUMAN_PROMPT_RE.test(prompt)) {
        const nonhuman = normalized.filter(characterLooksNonhuman);
        if (nonhuman.length === 1) selected = nonhuman;
    }
    if (!explicitIdentity && selected.length === 0 && HUMAN_PROMPT_RE.test(prompt)) {
        const human = normalized.filter((character) => !characterLooksNonhuman(character));
        if (human.length === 1) selected = human;
    }
    if (
        !explicitIdentity && selected.length === 0
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

    const diffusionOnly = modelType === 'flux' || modelType === 'redcraft_krea2' || modelType === 'qwen_image';
    const modelLoaderId = findNodeId(workflow, (node) =>
        modelType === 'flux'
            ? node?.class_type === 'UnetLoaderGGUF'
            : diffusionOnly
                ? (node?.class_type === 'UNETLoader' || node?.class_type === 'DiffusionModelLoader' || node?.class_type === 'CheckpointLoaderSimple')
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
    if (diffusionOnly) {
        workflow[loraNodeId] = {
            inputs: {
                lora_name: loraName,
                strength_model: strength,
                model: currentModel
            },
            class_type: 'LoraLoaderModelOnly',
            _meta: { title: modelType === 'qwen_image' ? 'NovaStory Qwen-Image LoRA' : modelType === 'redcraft_krea2' ? 'NovaStory RedCraft Krea2 LoRA' : 'NovaStory FLUX LoRA' }
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
            !diffusionOnly
            && node?.class_type === 'CLIPTextEncode'
            && node.inputs
        ) {
            node.inputs.clip = [loraNodeId, 1];
        }
    }
};

const LORA_LOADER_CLASS_TYPES = new Set(['LoraLoader', 'LoraLoaderModelOnly']);

/**
 * Custom graphs can ship with ExpressiveH / Incase already wired.
 * The planner only adds LoRAs, so SFW compiles must unhook those loaders
 * and point model/clip consumers at whatever fed the loader.
 */
const detachAdultLookLoras = (workflow: Record<string, any>) => {
    const adultIds = Object.keys(workflow).filter((nodeId) => {
        const node = workflow[nodeId];
        return LORA_LOADER_CLASS_TYPES.has(node?.class_type)
            && isAdultLookLoraName(String(node?.inputs?.lora_name || ''));
    });

    for (const nodeId of adultIds) {
        const node = workflow[nodeId];
        if (!node) continue;
        const loraName = String(node.inputs?.lora_name || '');
        const modelLink = Array.isArray(node.inputs?.model) ? [...node.inputs.model] : null;
        const clipLink = Array.isArray(node.inputs?.clip) ? [...node.inputs.clip] : null;
        const replacements = new Map<number, unknown[]>();
        if (modelLink) replacements.set(0, modelLink);
        if (clipLink) replacements.set(1, clipLink);

        const edits: Array<{ owner: any; key: string; next: unknown[] }> = [];
        let unresolved = false;
        for (const other of Object.values(workflow) as any[]) {
            if (!other?.inputs || other === node || typeof other.inputs !== 'object') continue;
            for (const key of Object.keys(other.inputs)) {
                const value = other.inputs[key];
                if (!Array.isArray(value) || String(value[0]) !== nodeId) continue;
                const next = replacements.get(Number(value[1]));
                if (!next) {
                    unresolved = true;
                    break;
                }
                edits.push({ owner: other, key, next: [...next] });
            }
            if (unresolved) break;
        }
        if (unresolved) {
            logger.warn(`Left prewired adult LoRA connected; no upstream output for ${loraName}`);
            continue;
        }
        for (const edit of edits) {
            edit.owner.inputs[edit.key] = edit.next;
        }
        delete workflow[nodeId];
        logger.info(`Detached prewired adult LoRA while NSFW is off: ${loraName}`);
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
    isSeparateVae: boolean
) => {
    const vaeSourceId = isSeparateVae
        ? findNodeId(workflow, (node) => node?.class_type === 'VAELoader')
        : findNodeId(workflow, (node) => node?.class_type === 'CheckpointLoaderSimple');
    if (!vaeSourceId) {
        logger.warn('Cannot inject img2img: no VAE source node found');
        return false;
    }
    const vaeOutputIndex = isSeparateVae ? 0 : 2;

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
        if (node?.class_type?.includes('KSampler') && node.inputs && !isFaceDetailStage2Node(node)) {
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

/** Character sheets and shots with a visible person keep the oriental face negative. Empty shots do not. */
export function shotUsesOrientalFaceNegative(workflowData: any): boolean {
    const gen = String(workflowData?.gen_type || '');
    if (/portrait|turnaround|face/i.test(gen)) return true;
    return visiblePeopleFromWorkflow(workflowData).length > 0;
}

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
    let selectedWorkflowFamily: ImageModelFamily | null = null;
    const requestedModel = String(
        workflowData?.model_type
        || workflowData?.reference_model_type
        || ''
    ).toLowerCase();

    if (isComfyWorkflow(workflowData)) {
        workflow = parseWorkflowContent(workflowData);
    } else {
        const selected = await selectComfyWorkflow(workflowData, runtimeSettings, {
            byId: async (id) => (await db.get('SELECT id, name, content FROM workflow WHERE id = ?', id)) || null,
            byName: async (name) => (await db.get('SELECT id, name, content FROM workflow WHERE name = ?', name)) || null
        });
        workflow = parseWorkflowContent(selected.row.content);
        selectedWorkflowFamily = selected.family;
        for (const note of selected.notes) logger.warn(note);
        const checkpoint = Object.values(workflow).find(
            (node: any) => node?.class_type === 'CheckpointLoaderSimple'
        ) as any;
        logger.info(
            `Comfy workflow resolved: id=${selected.row.id} name=${selected.row.name} `
            + `source=${selected.source} model=${selected.family} `
            + `checkpoint=${checkpoint?.inputs?.ckpt_name || 'custom'}`
        );
    }

    const isFlux = Boolean(findNodeId(workflow, (node) =>
        node?.class_type === 'UnetLoaderGGUF'
        || (
            node?.class_type === 'CheckpointLoaderSimple'
            && /flux/i.test(node.inputs?.ckpt_name || '')
        )
    ));
    const isRedCraftKrea2 = Boolean(findNodeId(workflow, (node) =>
        (node?.class_type === 'UNETLoader' && /krea|redcraft/i.test(node.inputs?.unet_name || ''))
        || (node?.class_type === 'CLIPLoader' && /krea/i.test(node.inputs?.type || node.inputs?.clip_name || ''))
        || /redcraft|krea2/i.test(JSON.stringify(node))
    ));
    const isQwenImage = !isRedCraftKrea2 && Boolean(findNodeId(workflow, (node) =>
        node?.class_type === 'TextEncodeQwenImage21'
        || (node?.class_type === 'UNETLoader' && /qwen[_-]?image/i.test(String(node.inputs?.unet_name || '')))
        || (node?.class_type === 'CLIPLoader' && String(node.inputs?.type || '') === 'qwen_image')
    ));
    const isAnimagineXl = Boolean(findNodeId(workflow, (node) =>
        node?.class_type === 'CheckpointLoaderSimple'
        && /animagine/i.test(String(node.inputs?.ckpt_name || ''))
    ));
    const ckptLooksSd15 = Boolean(findNodeId(workflow, (node) =>
        node?.class_type === 'CheckpointLoaderSimple'
        && /sd\s*1\.?5|anything|counterfeit|meina|chillout|sd15/i.test(
            String(node.inputs?.ckpt_name || '')
        )
    ));
    // Graph detection wins for FLUX/RedCraft custom graphs; otherwise honor request / SD1.5 ckpt.
    const modelFamily: ImageModelFamily = isQwenImage
        ? 'qwen_image'
        : isFlux
        ? 'flux'
        : isRedCraftKrea2
            ? 'redcraft_krea2'
            : selectedWorkflowFamily
                || normalizeImageModelFamily(
                    requestedModel
                    || (ckptLooksSd15 ? 'sd15' : 'pony')
                );
    const advancedSettings = runtimeSettings.advanced || {};

    // Request override → project nsfw_mode → system advanced.nsfw_enabled
    const projectSettings = parseProjectSettings(workflowData?.project_settings);
    const nsfwEnabled = resolveEffectiveNsfw({
        systemNsfwEnabled: Boolean(advancedSettings.nsfw_enabled),
        projectSettings,
    });

    // Project style is authoritative for every image task.
    const enrichedWorkflowData = {
        ...workflowData,
        style_preset:
            projectSettings.image_generation?.style || null,
        nsfw_enabled: nsfwEnabled
    };

    // A composed paragraph is already the positive prompt. Do not sanitize it or append style and environment suffixes.
    const promptComposed = Boolean(workflowData?.prompt_composed);
    const subjectSafePrompt = promptComposed
        ? String(finalPrompt || '').trim()
        : sanitizePromptForSubject(
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
    if (isAnimagineXl) {
        plan.loras = plan.loras.filter((slot) => slot.role === 'character');
        plan.enhancement.suffix = plan.enhancement.suffix
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part && !/^(score_\d+|source_anime|source_cartoon|rating_)/i.test(part))
            .join(', ');
    }

    const autismMixScene = modelFamily === 'pony'
        && !isAnimagineXl
        && String(enrichedWorkflowData.style_preset || '').toLowerCase() === 'autismmix_artist'
        && String(enrichedWorkflowData.gen_type || '').toLowerCase() === 'scene'
        && mode === 'standard';
    const stripPonyTagsForAnimagine = (text: string): string =>
        isAnimagineXl
            ? String(text || '')
                .split(',')
                .map((part) => part.trim())
                .filter((part) => part && !/^(score_\d+(?:_up)?|source_anime|source_cartoon|rating_\w+)$/i.test(part))
                .concat(['masterpiece', 'best quality', 'very aesthetic', 'newest', 'absurdres'])
                .filter((part, idx, arr) => arr.findIndex((x) => x.toLowerCase() === part.toLowerCase()) === idx)
                .join(', ')
            : text;
    const effectivePrompt = promptComposed
        ? subjectSafePrompt
        : stripPonyTagsForAnimagine(applyPromptEnhancement(
            subjectSafePrompt,
            plan.enhancement,
            { qualityFirst: autismMixScene }
        ));
    const preserveTemplateConditioning =
        modelFamily === 'pony' && !isAnimagineXl && /pony/i.test(JSON.stringify(workflow));

    const orientalRealistic = String(enrichedWorkflowData.style_preset || '').toLowerCase() === 'oriental_realistic';
    const negativeParts = promptComposed
        ? [
            String(workflowData?.negative_prompt || '').trim(),
            CHILD_SAFETY_NEGATIVE,
            orientalRealistic && shotUsesOrientalFaceNegative(enrichedWorkflowData) ? ORIENTAL_REALISTIC_NEGATIVE : '',
        ]
        : [
            sanitizeNegativePromptForSubject(
                workflowData?.negative_prompt || '',
                enrichedWorkflowData.subject_type
            ),
            plan.enhancement.negativeExtra,
            autismMixScene
                ? 'western comic, thick ink outlines, comic strip, triptych, split screen, multiple panels, 3d render, photorealistic'
                : ''
        ];
    // Saved shot negatives and the joined booster can still carry nsfw/nude from
    // an earlier SFW pass. Drop those blockers once adult mode is on.
    let negativePrompt = negativeParts.filter(Boolean).join(', ');
    if (nsfwEnabled) {
        negativePrompt = stripSfwSuppressionFromNegative(negativePrompt);
    }

    const samplerNodes = Object.values(workflow).filter(
        (node: any) => node?.class_type?.includes('KSampler')
    ) as any[];
    // Keep the selected workflow's sampling recipe unless the request overrides it.
    const defaultSteps = Number(
        generationParams?.steps
        ?? samplerNodes[0]?.inputs?.steps
        ?? (modelFamily === 'flux' ? 24 : modelFamily === 'sd15' ? 20 : modelFamily === 'redcraft_krea2' ? 10 : 25)
    );
    const defaultCfg = Number(
        generationParams?.cfg
        ?? samplerNodes[0]?.inputs?.cfg
        ?? (modelFamily === 'flux' ? 3.5 : modelFamily === 'redcraft_krea2' || modelFamily === 'qwen_image' ? 1.0 : 7)
    );

    for (const sampler of samplerNodes) {
        const positiveId = Array.isArray(sampler.inputs?.positive) ? String(sampler.inputs.positive[0]) : null;
        const negativeId = Array.isArray(sampler.inputs?.negative) ? String(sampler.inputs.negative[0]) : null;

        if (positiveId && workflow[positiveId]?.class_type === 'TextEncodeQwenImage21' && workflow[positiveId].inputs) {
            workflow[positiveId].inputs.prompt = promptComposed ? subjectSafePrompt : effectivePrompt;
            workflow[positiveId].inputs.negative_prompt = negativePrompt;
        } else if (positiveId && workflow[positiveId]?.inputs) {
            const templateText = String(workflow[positiveId].inputs.text || '').trim();
            // Keep template conditioning while applying the selected style's prompt order.
            workflow[positiveId].inputs.text = promptComposed
                ? subjectSafePrompt
                : preserveTemplateConditioning && templateText
                ? mergeClipPositivePrompt({
                    scene: subjectSafePrompt,
                    framing: [
                      plan.enhancement.prefix,
                      plan.enhancement.suffix,
                    ].filter(Boolean).join(', '),
                    templateText,
                    qualityFirst: autismMixScene,
                  })
                : effectivePrompt;
        }
        if (negativeId && workflow[negativeId]?.inputs && negativeId !== positiveId) {
            let templateText = String(workflow[negativeId].inputs.text || '').trim();
            if (nsfwEnabled) {
                templateText = stripSfwSuppressionFromNegative(templateText);
            }
            workflow[negativeId].inputs.text = !promptComposed && preserveTemplateConditioning && templateText
                ? (negativePrompt ? `${templateText}, ${negativePrompt}` : templateText)
                : negativePrompt;
        }

        const requestedSeed = Number(generationParams?.seed);
        sampler.inputs.seed = Number.isSafeInteger(requestedSeed) && requestedSeed >= 0
            && generationParams?.seed != null
            ? requestedSeed
            : Math.floor(Math.random() * 1_000_000_000);
        sampler.inputs.steps = defaultSteps;
        sampler.inputs.cfg = defaultCfg;
        if (generationParams?.sampler_name) {
            sampler.inputs.sampler_name = generationParams.sampler_name;
        } else if ((modelFamily === 'redcraft_krea2' || modelFamily === 'qwen_image') && !sampler.inputs.sampler_name) {
            sampler.inputs.sampler_name = 'euler';
        }
        if (generationParams?.scheduler) {
            sampler.inputs.scheduler = generationParams.scheduler;
        } else if ((modelFamily === 'redcraft_krea2' || modelFamily === 'qwen_image') && !sampler.inputs.scheduler) {
            sampler.inputs.scheduler = 'simple';
        }
    }

    const outputTarget = resolveImageOutputTarget({
        workflowData,
        generationParams,
        mode,
        modelFamily,
        finalPrompt,
    });
    const { width, height } = resolveComfyLatentDimensions(outputTarget);
    logger.info(
        `Resolved image canvas ${outputTarget.width}x${outputTarget.height} (Comfy latent ${width}x${height}) ratio=${outputTarget.resolved_aspect_ratio} `
        + `resolution=${outputTarget.resolution} source=${outputTarget.source}`
    );

    for (const node of Object.values(workflow) as any[]) {
        if ((node?.class_type === 'EmptyLatentImage' || node?.class_type === 'EmptySD3LatentImage') && node.inputs) {
            node.inputs.width = width;
            node.inputs.height = height;
            node.inputs.batch_size = 1;
        }
        if (node?.class_type === 'TextEncodeQwenImage21' && node.inputs) {
            node.inputs.resolution = Math.max(32, Math.round(Math.max(width, height) / 32) * 32);
        }
    }

    if (!nsfwEnabled) {
        detachAdultLookLoras(workflow);
    }

    for (const slot of plan.loras) {
        injectLora(workflow, slot.name, slot.strength, modelFamily);
        logger.info(
            `Injected ${slot.role} LoRA for ${modelFamily}: ${slot.name} @ ${slot.strength}`
        );
    }

    // Stage 2 face detail masks follow the real panel size, which a caller may fix after compile.
    const faceDetailCanvas = {
        width: Number(workflowData?.face_detail_canvas_width) > 0
            ? Number(workflowData.face_detail_canvas_width)
            : width,
        height: Number(workflowData?.face_detail_canvas_height) > 0
            ? Number(workflowData.face_detail_canvas_height)
            : height,
    };

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
            preferFaceId: workflowData?.prefer_faceid_adapter === true,
            faceIdWeight: Number.isFinite(Number(workflowData?.faceid_weight))
                ? Number(workflowData.faceid_weight)
                : undefined,
            enableFaceDetailStage2: workflowData?.face_detail_stage2 === true,
            canvasWidth: faceDetailCanvas.width,
            canvasHeight: faceDetailCanvas.height,
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
    const krea2FaceDetailStage2 = isRedCraftKrea2
        && workflowData?.face_detail_stage2 === true
        && workflowData?.use_qwen_vl_ref !== true
        && Boolean(characterRefUrl);
    if (isQwenImage || (isRedCraftKrea2 && workflowData?.use_qwen_vl_ref === true && characterRefUrl)) {
        // RedCraft Krea2 keeps its native backbone here; only the Stage 2 face refinement uses Qwen-Image 2.1.
        // Pure Qwen-Image graphs reconcile precision variants against the live remote catalog.
        if (isQwenImage) {
            const unetId = findNodeId(workflow, (node) => node?.class_type === 'UNETLoader');
            const currentUnet = String((unetId && workflow[unetId]?.inputs?.unet_name) || '');
            const resolvedUnet = pickCatalogModel(
                comfyCfg.remote_unet_names,
                ['qwen_image_2.1_bf16.safetensors', 'qwen_image_2.1_int8_convrot.safetensors'],
                /qwen[_-]?image[_-]?2[._-]?1/i,
                currentUnet,
                true
            );
            if (unetId && workflow[unetId]?.inputs && resolvedUnet && resolvedUnet !== currentUnet) {
                workflow[unetId].inputs.unet_name = resolvedUnet;
                logger.info(`Reconciled UNETLoader from ${currentUnet} to ${resolvedUnet} for native Qwen-Image 2.1 reference_latents`);
            }
            if (/qwen[_-]?image/i.test(resolvedUnet)) {
                const clipId = findNodeId(workflow, (node) => node?.class_type === 'CLIPLoader');
                if (clipId && workflow[clipId]?.inputs) {
                    const currentClip = String(workflow[clipId].inputs.clip_name || '');
                    workflow[clipId].inputs.clip_name = pickCatalogModel(
                        comfyCfg.remote_clip_names,
                        ['qwen3vl_8b_bf16.safetensors', 'qwen3vl_8b_int8_convrot.safetensors', 'qwen3vl_4b_bf16.safetensors'],
                        /qwen3vl/i,
                        currentClip || 'qwen3vl_8b_bf16.safetensors',
                        true
                    );
                    workflow[clipId].inputs.type = 'qwen_image';
                }
                const vaeLoaderId = findNodeId(workflow, (node) => node?.class_type === 'VAELoader');
                if (vaeLoaderId && workflow[vaeLoaderId]?.inputs) {
                    const currentVae = String(workflow[vaeLoaderId].inputs.vae_name || '');
                    workflow[vaeLoaderId].inputs.vae_name = pickCatalogModel(
                        comfyCfg.remote_vae_names,
                        ['qwen_image_2.1_vae_bf16.safetensors', 'qwen_image_vae.safetensors'],
                        /qwen[_-]?image.*vae/i,
                        currentVae || 'qwen_image_2.1_vae_bf16.safetensors',
                        true
                    );
                }
            }
        }

        // Qwen-Image 2.1 reads a reference through TextEncodeQwenImage21 (native reference_latents + image_slots).
        // VAEEncode into the sampler is a 4-channel SD latent and does not match this model.
        let encoderId = findNodeId(workflow, (node) => node?.class_type === 'TextEncodeQwenImage21');
        if (!encoderId && isRedCraftKrea2 && characterRefUrl) {
            const sampler = samplerNodes[0];
            const posId = Array.isArray(sampler?.inputs?.positive) ? String(sampler.inputs.positive[0]) : null;
            const negId = Array.isArray(sampler?.inputs?.negative) ? String(sampler.inputs.negative[0]) : null;
            const vaeId = findNodeId(workflow, (node) => node?.class_type === 'VAELoader');
            if (posId && workflow[posId]?.inputs) {
                const clipRef = workflow[posId].inputs.clip;
                const posText = String(workflow[posId].inputs.text || effectivePrompt);
                const negText = String(
                    (negId && workflow[negId]?.inputs?.text) || negativePrompt
                );
                workflow[posId] = {
                    inputs: {
                        clip: clipRef,
                        prompt: posText,
                        negative_prompt: negText,
                        ...(vaeId ? { vae: [vaeId, 0] } : {}),
                        resolution: Math.max(32, Math.round(Math.max(width, height) / 32) * 32),
                    },
                    class_type: 'TextEncodeQwenImage21',
                    _meta: { title: 'Text Encode Qwen Image 2.1 (Reference Lock)' }
                };
                if (sampler?.inputs) {
                    sampler.inputs.positive = [posId, 0];
                    sampler.inputs.negative = [posId, 1];
                }
                if (negId && negId !== posId) {
                    delete workflow[negId];
                }
                encoderId = posId;
            }
        }
        if (encoderId && characterRefUrl) {
            const referenceFilename = path.basename(String(characterRefUrl));
            let loadId = findNodeId(
                workflow,
                (node) => node?.class_type === 'LoadImage' && node?._meta?.title === 'NovaStory Character Reference'
            );
            if (!loadId) {
                loadId = nextNodeId(workflow);
                workflow[loadId] = {
                    inputs: { image: referenceFilename },
                    class_type: 'LoadImage',
                    _meta: { title: 'NovaStory Character Reference' }
                };
            } else if (workflow[loadId]?.inputs) {
                workflow[loadId].inputs.image = referenceFilename;
            }
            workflow[encoderId].inputs.image_1 = [loadId, 0];
            const vaeId = findNodeId(workflow, (node) => node?.class_type === 'VAELoader');
            if (vaeId) workflow[encoderId].inputs.vae = [vaeId, 0];
            logger.info(`Wired Qwen-VL character reference ${referenceFilename} as image_1`);
        }
        for (const node of Object.values(workflow) as any[]) {
            if (node?.class_type?.includes('KSampler') && node.inputs && !isFaceDetailStage2Node(node)) node.inputs.denoise = 1;
        }
    } else if (characterRefUrl && krea2FaceDetailStage2) {
        // Stage 1 stays the native Krea2 text-to-image render; the portrait is only consumed by Stage 2.
        for (const node of Object.values(workflow) as any[]) {
            if (node?.class_type?.includes('KSampler') && node.inputs) node.inputs.denoise = 1;
        }
    } else if (characterRefUrl) {
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
                isFlux || isRedCraftKrea2
            );
        } else if (!refPlan.useCharacterAdapter) {
            logger.info(
                `Skipping img2img (${refPlan.img2img.reason}); `
                + `character_ref ${referenceFilename} kept for future adapters only`
            );
            for (const node of Object.values(workflow) as any[]) {
                if (node?.class_type?.includes('KSampler') && node.inputs && !isFaceDetailStage2Node(node)) {
                    node.inputs.denoise = 1;
                }
            }
        } else {
            // Adapter path: ensure pure noise latent
            for (const node of Object.values(workflow) as any[]) {
                if (node?.class_type?.includes('KSampler') && node.inputs && !isFaceDetailStage2Node(node)) {
                    node.inputs.denoise = 1;
                }
            }
        }
    }

    // RedCraft Krea2 scheme 1B: Qwen-Image 2.1 re-draws the head crop with the portrait as reference.
    if (krea2FaceDetailStage2 && characterRefUrl) {
        const unetName = pickCatalogModel(
            comfyCfg.remote_unet_names,
            ['qwen_image_2.1_bf16.safetensors', 'qwen_image_2.1_int8_convrot.safetensors'],
            /qwen[_-]?image[_-]?2[._-]?1/i,
            'qwen_image_2.1_bf16.safetensors',
            false
        );
        const clipName = pickCatalogModel(
            comfyCfg.remote_clip_names,
            ['qwen3vl_8b_bf16.safetensors', 'qwen3vl_8b_int8_convrot.safetensors'],
            /qwen3vl[_-]?8b/i,
            'qwen3vl_8b_bf16.safetensors',
            false
        );
        const vaeName = pickCatalogModel(
            comfyCfg.remote_vae_names,
            ['qwen_image_2.1_vae_bf16.safetensors', 'qwen_image_vae.safetensors'],
            /qwen[_-]?image.*vae/i,
            'qwen_image_2.1_vae_bf16.safetensors',
            false
        );
        const missingFromCatalog = [
            [comfyCfg.remote_unet_names, unetName],
            [comfyCfg.remote_clip_names, clipName],
            [comfyCfg.remote_vae_names, vaeName],
        ].filter(([catalog, name]) =>
            Array.isArray(catalog) && catalog.length > 0 && !(catalog as unknown[]).includes(name as string)
        ).map(([, name]) => String(name));
        if (missingFromCatalog.length > 0) {
            logger.warn(`[face-detail-stage2] Qwen-Image 2.1 models missing on ComfyUI (${missingFromCatalog.join(', ')}); keeping Stage 1 Krea2 render`);
        } else {
            const stage2Sampler = samplerNodes[0];
            const wired = injectKrea2QwenFaceDetailStage2(workflow, {
                width: faceDetailCanvas.width,
                height: faceDetailCanvas.height,
                referenceFilename: path.basename(String(characterRefUrl)),
                seed: Number(stage2Sampler?.inputs?.seed ?? 1),
                unetName,
                clipName,
                vaeName,
            });
            logger.info(
                wired
                    ? `[face-detail-stage2] Krea2 Stage 1 + Qwen-Image 2.1 face refine wired (${unetName})`
                    : '[face-detail-stage2] Krea2 Stage 2 not wired (no SaveImage/stage 1 image)'
            );
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
    const resolvedPath = resolveStaticAssetPath(String(referenceImageUrl));
    const candidates = [
        resolvedPath,
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
        const productionPin = workflowData?.captured_production_pin as ProductionReferencePin | undefined;
        logger.info(`[Task ${taskId}] Asset generation started for Scene ${sceneId} (Mode: ${mode})`);
        await AssetTaskStore.processing(taskId, sceneId);

        // Character turnaround: canonical front full-body reference plate
        try {
            const { shouldUseTurnaroundComposite, generateTurnaroundComposite } = await import(
                './turnaround_composite'
            );
            const currentSettings = SettingsManager.loadSettings();
            if (!productionPin && shouldUseTurnaroundComposite(workflowData, { imageProvider: currentSettings.image_provider })) {
                const settings = currentSettings;
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

                let turnaroundGpuLease: Awaited<ReturnType<typeof GpuLeaseService.acquireLease>> | null = null;
                try {
                    turnaroundGpuLease = await GpuLeaseService.acquireLease(taskId, 'image', 30 * 60 * 1000);
                    let finalPrompt = String(
                        workflowData?.prompt
                        || workflowData?.text
                        || workflowData?.description
                        || ''
                    );
                    if (containsCjk(finalPrompt)) {
                        const turnaroundModelFamily = normalizeImageModelFamily(
                            workflowData?.model_type
                            || workflowData?.reference_model_type
                            || 'pony'
                        );
                        try {
                            finalPrompt = await resolvePicturePrompt(
                                taskId,
                                sceneId,
                                workflowData,
                                () => optimizeOutboundPrompt(finalPrompt, {
                                    modelFamily: turnaroundModelFamily,
                                    nsfwEnabled: Boolean(workflowData?.nsfw_enabled),
                                    variant: workflowData?.inference_variant,
                                })
                            );
                        } catch (translateErr) {
                            logger.warn(`[Task ${taskId}] Turnaround CJK translation fallback: ${translateErr}`);
                        }
                    }
                    // Plan 1: free LLM VRAM before multi-panel ComfyUI work
                    await runVramHandoffForImageGen(publish);

                    const result = await generateTurnaroundComposite({
                        taskId,
                        sceneId,
                        prompt: String(finalPrompt),
                        negative_prompt: workflowData?.negative_prompt
                            ? String(workflowData.negative_prompt)
                            : undefined,
                        workflowData: {
                            ...workflowData,
                            prompt: String(finalPrompt),
                        },
                        generationParams,
                        onProgress: publish
                    });

                    const assetUrl = result.sheetUrl;
                    if (shouldPersistSceneAsset(sceneId) && !workflowData?.character_id) {
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
                    if (shouldPersistSceneAsset(sceneId) && !workflowData?.character_id) {
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
                    if (turnaroundGpuLease) {
                        GpuLeaseService.releaseLease(turnaroundGpuLease.lease_id, taskId);
                    }
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
        let gpuLease: Awaited<ReturnType<typeof GpuLeaseService.acquireLease>> | null = null;
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
            let sceneVersion: number = Number(workflowData?.version || workflowData?.scene_version || 1);
            let characterId: number | null = null;
            let characterVersion: number = 1;
            try {
                const sceneRow = await db.get(
                    `SELECT chapter_id, visual_prompt, negative_prompt, shot_type, camera_movement, camera_angle, shot_spec, active_version
                     FROM scene WHERE id = ?`,
                    sceneId
                );
                if (sceneRow) {
                    if (productionPin) {
                        const current = await db.get('SELECT * FROM scene WHERE id=?', sceneId);
                        await requireProductionReferencePin(current, { expected_version: productionPin.scene_version, reference_hash: (await import('./continuity_replay')).continuityHash(productionPin) });
                    }
                    if (sceneRow.active_version != null) {
                        sceneVersion = Number(sceneRow.active_version);
                    }
                    if (workflowData?.formal_candidate?.scene_version) {
                        sceneVersion = Number(workflowData.formal_candidate.scene_version);
                    }
                    if (sceneRow.chapter_id) {
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
                        }
                        const assetRefs = productionPin ? productionPin.references.filter(ref => ref.kind === 'asset').map(ref => ({ id: ref.id, revision: ref.version, asset_revision: ref.version, project_id: sceneProjectId, status: 'completed', image_url: ref.image_url, name: ref.name, kind: ref.asset_kind, visual_prompt: '' })) : await db.all(`SELECT a.*, r.asset_revision FROM scene_asset_reference r
                            JOIN library_asset a ON a.id = r.asset_id WHERE r.scene_id = ?`, sceneId);
                        for (const ref of assetRefs) {
                            if (ref.project_id !== sceneProjectId || ref.revision !== ref.asset_revision
                                || ref.status !== 'completed' || !ref.image_url) {
                                throw new Error(`Referenced asset ${ref.name} has changed or is unavailable; rebind before generating`);
                            }
                        }
                        if (assetRefs.length) {
                            // Character shots keep the reference image. The plate sentence, including "no people", stays off the positive prompt.
                            if (!shotHasImageContract(effectiveWorkflowData.shot_spec)) {
                                const shotPrompt = String(effectiveWorkflowData.prompt || sceneRow.visual_prompt || '');
                                effectiveWorkflowData.prompt = [shotPrompt,
                                    ...assetRefs.map(ref => assetPromptForShot(String(ref.visual_prompt || ''), effectiveWorkflowData.shot_spec || {}, shotPrompt))].filter(Boolean).join(', ');
                            }
                            effectiveWorkflowData.asset_references = assetRefs.map(ref => ({
                                id: ref.id, revision: ref.revision, kind: ref.kind, image_url: ref.image_url,
                            }));
                            // Location concept art is not a pose, depth, or edge map.
                            // Feeding it to OpenPose ControlNet produced a solid black frame.
                        }
                    }
                } else if (workflowData?.library_asset_id) {
                    const libraryAsset = await db.get('SELECT project_id FROM library_asset WHERE id = ?', Number(workflowData.library_asset_id));
                    sceneProjectId = libraryAsset?.project_id ?? null;
                } else if (isSyntheticCharacterSceneId(sceneId) || workflowData?.character_id) {
                    characterId = workflowData?.character_id
                        ? Number(workflowData.character_id)
                        : syntheticCharacterId(sceneId);
                    if (characterId) {
                        const charRow = await db.get('SELECT id, project_id, active_version, visual_tags FROM character WHERE id = ?', characterId);
                        if (charRow) {
                            sceneProjectId = charRow.project_id != null ? Number(charRow.project_id) : null;
                            characterVersion = Number(charRow.active_version || 1);
                            if (
                                String(effectiveWorkflowData?.gen_type || '').toLowerCase() === 'turnaround'
                                && effectiveWorkflowData?.use_ref_portrait === true
                                && !effectiveWorkflowData?.character_ref_url
                                && !effectiveWorkflowData?.ref_image_url
                            ) {
                                const tags = parseCharacterVisualTags(charRow.visual_tags);
                                const storedAvatar = tags?.assets?.avatar_url || tags?.avatar_url;
                                if (typeof storedAvatar === 'string' && storedAvatar.trim()) {
                                    effectiveWorkflowData.character_ref_url = storedAvatar.trim();
                                    effectiveWorkflowData.ref_image_url = storedAvatar.trim();
                                }
                            }
                        }
                    }
                }
                if (sceneProjectId == null) {
                    throw new Error(`No project found for image generation scene ${sceneId}`);
                }
                const projectRow = await db.get(
                    'SELECT settings FROM project WHERE id = ?',
                    sceneProjectId
                );
                if (!projectRow) {
                    throw new Error(`Project ${sceneProjectId} was not found`);
                }
                const projectSettings = parseProjectSettings(projectRow.settings);
                const projectImageSettings = getProjectImageSettings(projectSettings);
                effectiveWorkflowData = {
                    ...effectiveWorkflowData,
                    project_settings: projectSettings,
                    model_type: projectImageSettings.model,
                    style_preset: projectImageSettings.style,
                    workflow_id: undefined,
                    selected_workflow_id: undefined,
                };
            } catch (e) {
                throw new Error(`Could not load project image settings for scene ${sceneId}: ${e}`);
            }

            const nsfwEnabled = resolveEffectiveNsfw({
                systemNsfwEnabled: Boolean(settings.advanced?.nsfw_enabled),
                projectSettings: parseProjectSettings(effectiveWorkflowData.project_settings),
            });
            effectiveWorkflowData.nsfw_enabled = nsfwEnabled;
            logger.info(
                `[Task ${taskId}] Effective NSFW=${nsfwEnabled}, style_preset=${effectiveWorkflowData.style_preset || 'none'}`
            );

            const outputModelFamily = normalizeImageModelFamily(
                effectiveWorkflowData?.model_type
                || effectiveWorkflowData?.reference_model_type
                || 'pony'
            );
            const contractShot = mode !== 'cinematic_grid' && shotHasImageContract(effectiveWorkflowData.shot_spec);

            if (mode === "cinematic_grid") {
                const rawPrompt = effectiveWorkflowData?.prompt || effectiveWorkflowData?.text || effectiveWorkflowData?.description || JSON.stringify(effectiveWorkflowData);
                finalPrompt = Prompts.buildCinematicGridImagePrompt(rawPrompt);
            } else if (contractShot) {
                const characters: Array<{ id?: number; version?: number; name?: string | null; english_name?: string | null; visual_tags?: unknown; age?: string | number | null }> = productionPin ? productionPin.text_characters.map((character) => ({ ...character })) : await db.all(
                    'SELECT id, name, english_name, visual_tags, age FROM character WHERE project_id = ?',
                    sceneProjectId
                );
                if (productionPin) {
                    for (const character of characters) {
                        const version = await db.get(
                            'SELECT age FROM character_version WHERE character_id = ? AND version = ?',
                            character.id,
                            character.version
                        );
                        character.age = version?.age ?? null;
                    }
                }
                for (const ref of productionPin?.references || []) if (ref.kind === 'character') {
                    const character = characters.find(row => Number(row.id) === ref.id);
                    if (character) character.visual_tags = ref.visual_tags;
                }
                if (productionPin) {
                    effectiveWorkflowData.character_ref_urls = productionPin.references.filter(ref => ref.kind === 'character').map(ref => ref.image_url);
                    effectiveWorkflowData.character_ref_url = effectiveWorkflowData.character_ref_urls[0];
                }
                const materials = shotImageMaterialsFromSpec(
                    effectiveWorkflowData.shot_spec,
                    characters,
                    {
                        modelFamily: outputModelFamily,
                        nsfwEnabled,
                        styleLighting: styleLightingMaterial(effectiveWorkflowData.style_preset),
                        shotType: effectiveWorkflowData.shot_type,
                        chapterId: sceneChapterId,
                        cameraAngle: effectiveWorkflowData.camera_angle,
                        cameraMovement: effectiveWorkflowData.camera_movement,
                    },
                );
                await progressHandler('vram_tuning', {
                    phase: 'vram_tuning',
                    message: 'Writing the English image prompt. The text model may use the GPU briefly.',
                    message_zh: '正在编写英文画面提示词，文本模型会短暂占用显存…',
                });
                finalPrompt = await resolvePicturePrompt(taskId, sceneId, effectiveWorkflowData, () => composeShotImagePrompt(materials, {
                    variant: effectiveWorkflowData.inference_variant,
                    stylePreset: effectiveWorkflowData.style_preset,
                }));
                const personVisible = materials.subject_scale !== 'absent'
                    && (materials.characters.length > 0 || materials.facts.some((fact) => fact.binding.length > 0));
                const currentType = String(effectiveWorkflowData.subject_type || '').toLowerCase().trim();
                const keepExplicitType = Boolean(currentType) && !/environment|landscape|location|scenery/.test(currentType);
                effectiveWorkflowData = {
                    ...effectiveWorkflowData,
                    prompt: finalPrompt,
                    prompt_composed: true,
                    subject_type: personVisible && !keepExplicitType ? 'human' : effectiveWorkflowData.subject_type,
                };
                logger.info(`[Task ${taskId}] Composed image prompt from the shot contract (${finalPrompt.length} chars)`);
            } else {
                finalPrompt = effectiveWorkflowData?.prompt || effectiveWorkflowData?.text || effectiveWorkflowData?.description || JSON.stringify(effectiveWorkflowData);

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
                // Script-backed storyboards already carry the chapter's character locks in
                // their compiled visual prompt. Re-appending full database profiles here
                // duplicates every visible character and can reintroduce later variants.
                if (!workflowData?.library_asset_id && !effectiveWorkflowData?.shot_spec?.source?.type && appearanceSnippets.length === 0 && sceneProjectId != null) {
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
                                shotType: effectiveWorkflowData?.shot_type,
                                characterId
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

                if (containsCjk(finalPrompt)) {
                    await progressHandler('vram_tuning', {
                        phase: 'vram_tuning',
                        message: 'Writing the English image prompt. The text model may use the GPU briefly.',
                        message_zh: '正在编写英文画面提示词，文本模型会短暂占用显存…',
                    });
                }
                const outboundPrompt = await resolvePicturePrompt(taskId, sceneId, effectiveWorkflowData, () => optimizeOutboundPrompt(finalPrompt, {
                    modelFamily: outputModelFamily,
                    nsfwEnabled,
                    variant: effectiveWorkflowData.inference_variant,
                }));
                if (outboundPrompt !== finalPrompt) {
                    finalPrompt = outboundPrompt;
                    effectiveWorkflowData = { ...effectiveWorkflowData, prompt: finalPrompt };
                }
            }
            try {
                await progressHandler('english_prompt', { english_prompt: finalPrompt });
            } catch (error) {
                logger.warn(`[Task ${taskId}] Could not publish the English visual prompt: ${error}`);
            }
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

            const shotMasterCharacterIds = Array.isArray(effectiveWorkflowData.shot_master_character_ids)
                ? effectiveWorkflowData.shot_master_character_ids.map(Number)
                : undefined;
            let shotMasterInputs: ShotMasterInputSnapshot | null = null;
            if (sceneChapterId != null && sceneProjectId != null) {
                shotMasterInputs = await captureShotMasterSnapshot({
                    sceneId,
                    projectId: sceneProjectId,
                    characterIds: shotMasterCharacterIds,
                });
                if (productionPin) shotMasterInputs = {
                    references: productionPin.references.filter(ref => ref.kind === 'asset').map(ref => ({ id: ref.id, revision: ref.version })),
                    versions: productionPin.references.filter(ref => ref.kind === 'character').map(ref => ({ id: ref.id, version: ref.version })),
                };
            }

            if (effectiveWorkflowData?.formal_candidate?.production_stage === 'production'
                && !formalRenderAllowed(String(effectiveWorkflowData.formal_candidate.combination || 'sdxl_unverified'))) {
                throw new Error('FORMAL_NOT_LIVE_VERIFIED');
            }

            if (useComfy) {
                logger.info(`[Task ${taskId}] Using ComfyUI`);

                // Acquire GPU lease to ensure single concurrent access to GPU and retain
                // the exact lease identity until the pipeline fully unwinds.
                gpuLease = await GpuLeaseService.acquireLease(taskId, 'image');

                // Plan 1: auto VRAM handoff — unload local LLM before Pony/SDXL claims GPU
                await runVramHandoffForImageGen(progressHandler);

                const comfyService = ComfyUIService.fromSettings(comfySettings);
                const isRunning = await comfyService.ensureRunning(
                    comfySettings.install_path
                );
                if (!isRunning) {
                    throw new Error('Failed to start or connect to ComfyUI');
                }

                if (sceneProjectId != null && !['portrait', 'turnaround', 'turnaround_panel'].includes(String(effectiveWorkflowData?.gen_type || 'scene').toLowerCase())) {
                    const plateCharacters = await db.all(
                        'SELECT id, name, visual_tags FROM character WHERE project_id = ?',
                        sceneProjectId
                    );
                    effectiveWorkflowData = resolveSceneIdentityPlate(effectiveWorkflowData, plateCharacters);
                }

                if (!comfyService.isRemote) {
                    copyReferenceImageToComfy(
                        effectiveWorkflowData,
                        staticDir,
                        comfySettings.install_path
                    );
                }

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

                const compileSettings = await applyRemoteLoraCatalog(settings, comfyService);

                const finalWorkflow = await compileComfyWorkflow(
                    effectiveWorkflowData,
                    finalPrompt,
                    mode,
                    generationParams,
                    compileSettings,
                    tierBCapability
                );

                const executableWorkflow = comfyService.isRemote
                    ? await comfyService.uploadWorkflowReferences(finalWorkflow, staticDir)
                    : finalWorkflow;

                result = await comfyService.generateImage(executableWorkflow, progressHandler, {
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
                    referenceImagePaths: settings.image_provider === 'codex'
                        ? selectCodexReferenceUrls(effectiveWorkflowData).map(url => resolveStaticAssetPath(url))
                        : undefined,
                    resumeJobId: settings.image_provider === 'codex' ? effectiveWorkflowData.codex_resume_job_id : undefined,
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
                    let pathResult: { filepath: string; url: string };
                    if (workflowData?.library_asset_id) {
                        const libraryAsset = await db.get('SELECT revision FROM library_asset WHERE id = ?', Number(workflowData.library_asset_id));
                        pathResult = getLibraryAssetPath(sceneProjectId!, Number(workflowData.library_asset_id), Number(libraryAsset.revision), `${taskId}.png`);
                    } else if (characterId != null) {
                        const genType = workflowData?.gen_type || 'character';
                        const filename = `${genType}_${characterId}_${taskId}.png`;
                        pathResult = getCharacterAssetPath({
                            projectId: sceneProjectId,
                            characterId,
                            version: characterVersion,
                            filename
                        });
                    } else {
                        const filename = `${sceneId}_${taskId}.png`;
                        pathResult = getSceneAssetPath({
                            projectId: sceneProjectId,
                            sceneId,
                            version: sceneVersion,
                            filename
                        });
                    }
                    if (fs.existsSync(pathResult.filepath)) {
                        throw new Error(`Refusing to overwrite existing image file ${pathResult.url}`);
                    }
                    fs.writeFileSync(pathResult.filepath, normalizedImage.buffer);
                    assetUrl = pathResult.url;
                    finalStatus = "completed";
                    if (normalizedImage.normalized) {
                        logger.warn(
                            `[Task ${taskId}] Provider returned ${normalizedImage.sourceWidth}x${normalizedImage.sourceHeight}; `
                            + `normalized to ${normalizedImage.width}x${normalizedImage.height}`
                        );
                    }
                    logger.info(
                        `[Task ${taskId}] Image saved to ${pathResult.filepath} `
                        + `(${normalizedImage.width}x${normalizedImage.height})`
                    );
                }

                const holdCandidate = workflowData?.formal_candidate?.publish === false;
                if (finalStatus === "completed" && sceneChapterId != null && holdCandidate) {
                    if (!productionPin && sceneProjectId != null && assetUrl) {
                        await recordShotMasterSnapshot({
                            sceneId,
                            projectId: sceneProjectId,
                            imageUrl: assetUrl,
                            characterIds: shotMasterCharacterIds,
                            captured: shotMasterInputs ?? undefined,
                        });
                    }
                    await persistFormalCandidateResult(sceneId, sceneVersion, taskId, {
                        asset_status: 'completed',
                        asset_url: assetUrl,
                        english_visual_prompt: finalPrompt,
                    });
                } else if (finalStatus === "completed" && sceneChapterId != null) {
                    const recorded = !productionPin ? await recordShotMasterSnapshot({
                        sceneId,
                        projectId: sceneProjectId!,
                        imageUrl: assetUrl!,
                        characterIds: shotMasterCharacterIds,
                        captured: shotMasterInputs ?? undefined,
                    }) : { drifted:false };
                    if (recorded.drifted) {
                        logger.warn(
                            `[Task ${taskId}] Location, prop, or character versions changed while this Shot Master was generating. `
                            + `The snapshot keeps the inputs used for ${assetUrl}.`
                        );
                    }
                    if (productionPin) {
                        const published = await persistProductionImageResult(sceneId, productionPin, taskId, { asset_status: 'completed', asset_url: assetUrl, task_id: taskId, english_visual_prompt: finalPrompt });
                        if (published.current) await recordShotMasterSnapshot({sceneId,projectId:sceneProjectId!,imageUrl:assetUrl!,captured:shotMasterInputs!});
                    }
                    else await withImmediateTransaction(async () => {
                        await syncActiveVersionAssets(sceneId, {
                            asset_status: 'completed',
                            asset_url: assetUrl,
                            task_id: taskId,
                            english_visual_prompt: finalPrompt,
                        }, sceneVersion);
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
                if (workflowData?.formal_candidate?.publish === false) {
                    await persistFormalCandidateResult(sceneId, Number(workflowData.formal_candidate.scene_version), taskId, { asset_status: 'failed' });
                } else if (productionPin) await persistProductionImageResult(sceneId, productionPin, taskId, { asset_status: 'failed', task_id: taskId });
                else if (shouldPersistSceneAsset(sceneId)) {
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
                if (workflowData?.formal_candidate?.publish === false) {
                    await persistFormalCandidateResult(sceneId, Number(workflowData.formal_candidate.scene_version), taskId, { asset_status: 'failed' });
                } else if (productionPin) await persistProductionImageResult(sceneId, productionPin, taskId, { asset_status: 'failed', task_id: taskId });
                else if (shouldPersistSceneAsset(sceneId)) {
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
            if (gpuLease) {
                GpuLeaseService.releaseLease(gpuLease.lease_id, taskId);
            }
            if (redis) redis.disconnect();
        }
    }
}
