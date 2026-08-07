/**
 * Tier B dual-reference adapters for ComfyUI (Pony / SDXL first).
 *
 * Character identity: ComfyUI_IPAdapter_plus (IPAdapterUnifiedLoader / IPAdapterAdvanced)
 * Composition:       native ControlNetLoader + ControlNetApplyAdvanced
 *                    optional comfyui_controlnet_aux OpenposePreprocessor
 *
 * FLUX GGUF is not wired here yet — probe returns false and callers fall back to Tier A.
 *
 * Missing custom nodes or model files → silent false; never throw into the user path.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../core/logging';
import type { AdapterAvailability } from './reference_generation_policy';

export type CompositionControlKind = 'openpose' | 'depth' | 'canny' | 'none';
export type CharacterAdapterKind = 'ip_adapter' | 'ip_adapter_unified' | 'none';

export interface TierBModelFiles {
  ipadapter: string | null;
  clipVision: string | null;
  controlnet: string | null;
  compositionKind: CompositionControlKind;
}

export interface TierBCapability extends AdapterAvailability {
  modelFamilySupported: boolean;
  characterKind: CharacterAdapterKind;
  compositionKind: CompositionControlKind;
  models: TierBModelFiles;
  hasIpAdapterNodes: boolean;
  hasControlNetNodes: boolean;
  hasOpenPosePreprocessor: boolean;
  /** Human-readable install hints when something is missing */
  missing: string[];
  notes: string[];
}

export interface TierBInjectOptions {
  characterImageFilename?: string | null;
  compositionImageFilename?: string | null;
  characterWeight?: number;
  compositionStrength?: number;
  /** true when workflow is FLUX — Tier B SDXL adapters are skipped */
  isFlux?: boolean;
  capability: TierBCapability;
}

const WEIGHT_MODEL_EXTS = /\.(safetensors|ckpt|pt|bin|pth)$/i;

const listModelFiles = (dir: string): string[] => {
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => WEIGHT_MODEL_EXTS.test(f) && !f.startsWith('put_'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
};

const listModelFilesRecursive = (dir: string, depth = 0): string[] => {
  if (!dir || !fs.existsSync(dir) || depth > 2) return [];
  const out: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Prefer basename relative path for ComfyUI folder_paths
        for (const child of listModelFilesRecursive(full, depth + 1)) {
          out.push(path.join(entry.name, child).replace(/\\/g, '/'));
        }
      } else if (WEIGHT_MODEL_EXTS.test(entry.name) && !entry.name.startsWith('put_')) {
        out.push(entry.name);
      }
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => a.localeCompare(b));
};

const pickByPatterns = (files: string[], patterns: RegExp[]): string | null => {
  for (const pattern of patterns) {
    const hit = files.find((f) => pattern.test(f));
    if (hit) return hit;
  }
  return files[0] || null;
};

const customNodeDirs = (installPath: string): string[] => {
  const root = path.join(installPath, 'custom_nodes');
  if (!fs.existsSync(root)) return [];
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name.toLowerCase());
  } catch {
    return [];
  }
};

const hasIpAdapterCustomNode = (installPath: string): boolean => {
  const dirs = customNodeDirs(installPath);
  return dirs.some(
    (d) =>
      d.includes('ipadapter')
      || d.includes('ip_adapter')
      || d === 'comfyui_ipadapter_plus'
  );
};

const hasControlNetAux = (installPath: string): boolean => {
  const dirs = customNodeDirs(installPath);
  return dirs.some(
    (d) => d.includes('controlnet_aux') || d.includes('comfyui_controlnet_aux')
  );
};

/**
 * Resolve preferred model filenames from disk under a ComfyUI install.
 */
export const discoverTierBModels = (
  installPath: string | null | undefined,
  configured: {
    ipadapter?: string | null;
    clipVision?: string | null;
    controlnet?: string | null;
  } = {}
): TierBModelFiles => {
  if (!installPath) {
    return { ipadapter: null, clipVision: null, controlnet: null, compositionKind: 'none' };
  }

  const ipadapterFiles = [
    ...listModelFiles(path.join(installPath, 'models', 'ipadapter')),
    ...listModelFiles(path.join(installPath, 'models', 'ip_adapter')),
    ...listModelFilesRecursive(path.join(installPath, 'custom_nodes', 'ComfyUI_IPAdapter_plus', 'models'))
  ];
  const clipFiles = listModelFiles(path.join(installPath, 'models', 'clip_vision'));
  const controlnetFiles = listModelFilesRecursive(path.join(installPath, 'models', 'controlnet'));

  const configuredIp = configured.ipadapter ? path.basename(String(configured.ipadapter)) : null;
  const configuredClip = configured.clipVision ? path.basename(String(configured.clipVision)) : null;
  const configuredCn = configured.controlnet
    ? String(configured.controlnet).replace(/\\/g, '/')
    : null;

  const ipadapter =
    (configuredIp && ipadapterFiles.some((f) => f === configuredIp || f.endsWith(configuredIp))
      ? configuredIp
      : null)
    || pickByPatterns(ipadapterFiles, [
      /plus-face.*sdxl/i,
      /plus_face.*sdxl/i,
      /faceid.*plus.*sdxl/i,
      /ip-adapter-plus.*sdxl/i,
      /ip_adapter_plus.*sdxl/i,
      /plus.*sdxl/i,
      /sdxl.*plus/i,
      /ip-adapter.*sdxl/i,
      /sdxl/i
    ]);

  const clipVision =
    (configuredClip && clipFiles.includes(configuredClip) ? configuredClip : null)
    || pickByPatterns(clipFiles, [
      /CLIP-ViT-H-14/i,
      /ViT-H-14/i,
      /vit.?h/i,
      /laion2B/i
    ]);

  // Prefer openpose → depth → canny for composition lock
  let compositionKind: CompositionControlKind = 'none';
  let controlnet: string | null = null;

  if (configuredCn) {
    const hit = controlnetFiles.find(
      (f) => f === configuredCn || f.endsWith(configuredCn) || path.basename(f) === path.basename(configuredCn)
    );
    if (hit) {
      controlnet = hit;
      if (/openpose|pose/i.test(hit)) compositionKind = 'openpose';
      else if (/depth/i.test(hit)) compositionKind = 'depth';
      else if (/canny|lineart|softedge|scribble/i.test(hit)) compositionKind = 'canny';
      else compositionKind = 'canny';
    }
  }

  if (!controlnet) {
    const openpose = pickByPatterns(
      controlnetFiles.filter((f) => /openpose|pose/i.test(f) && /sdxl|xl/i.test(f)),
      [/openpose/i, /pose/i]
    ) || pickByPatterns(
      controlnetFiles.filter((f) => /openpose|pose/i.test(f)),
      [/openpose/i]
    );
    const depth = pickByPatterns(
      controlnetFiles.filter((f) => /depth/i.test(f) && /sdxl|xl/i.test(f)),
      [/depth/i]
    ) || pickByPatterns(
      controlnetFiles.filter((f) => /depth/i.test(f)),
      [/depth/i]
    );
    const canny = pickByPatterns(
      controlnetFiles.filter((f) => /canny|lineart|softedge/i.test(f) && /sdxl|xl/i.test(f)),
      [/canny/i, /lineart/i]
    ) || pickByPatterns(
      controlnetFiles.filter((f) => /canny|lineart|softedge/i.test(f)),
      [/canny/i]
    );

    if (openpose) {
      controlnet = openpose;
      compositionKind = 'openpose';
    } else if (depth) {
      controlnet = depth;
      compositionKind = 'depth';
    } else if (canny) {
      controlnet = canny;
      compositionKind = 'canny';
    } else if (controlnetFiles[0]) {
      controlnet = controlnetFiles[0];
      compositionKind = 'canny';
    }
  }

  return { ipadapter, clipVision, controlnet, compositionKind };
};

/**
 * Probe filesystem (+ optional object_info) for Tier B readiness.
 * Safe when ComfyUI is offline — uses install_path only.
 */
export const probeTierBCapability = (
  installPath: string | null | undefined,
  options: {
    objectInfo?: Record<string, any> | null;
    configured?: {
      ipadapter?: string | null;
      clipVision?: string | null;
      controlnet?: string | null;
    };
    /** Explicit kill switch from settings */
    enabled?: boolean;
  } = {}
): TierBCapability => {
  const notes: string[] = [];
  const missing: string[] = [];
  const enabled = options.enabled !== false;

  if (!enabled) {
    return {
      characterAdapter: false,
      compositionControl: false,
      modelFamilySupported: true,
      characterKind: 'none',
      compositionKind: 'none',
      models: { ipadapter: null, clipVision: null, controlnet: null, compositionKind: 'none' },
      hasIpAdapterNodes: false,
      hasControlNetNodes: false,
      hasOpenPosePreprocessor: false,
      missing: ['tier_b_disabled'],
      notes: ['Tier B disabled in settings']
    };
  }

  const models = discoverTierBModelsSafe(installPath, options.configured);
  const objectInfo = options.objectInfo || null;

  const nodeNames = objectInfo ? new Set(Object.keys(objectInfo)) : null;

  const hasIpAdapterNodes = nodeNames
    ? ['IPAdapterAdvanced', 'IPAdapter', 'IPAdapterUnifiedLoader', 'IPAdapterModelLoader'].some((n) =>
      nodeNames.has(n)
    )
    : Boolean(installPath && hasIpAdapterCustomNode(installPath));

  // Native ComfyUI always has ControlNet — if object_info missing, assume true when install looks like ComfyUI
  const hasControlNetNodes = nodeNames
    ? nodeNames.has('ControlNetLoader') && nodeNames.has('ControlNetApplyAdvanced')
    : Boolean(installPath && fs.existsSync(path.join(installPath, 'nodes.py')));

  const hasOpenPosePreprocessor = nodeNames
    ? ['OpenposePreprocessor', 'OpenposePoseEstimator', 'AIO_Preprocessor', 'DWPreprocessor'].some((n) =>
      nodeNames.has(n)
    )
    : Boolean(installPath && hasControlNetAux(installPath));

  if (!hasIpAdapterNodes) {
    missing.push('custom_nodes/ComfyUI_IPAdapter_plus');
  }
  if (!models.ipadapter) {
    missing.push('models/ipadapter/*sdxl*.safetensors');
  }
  // Unified loader embeds clip vision presets; advanced path needs explicit clip_vision file
  const needsExplicitClip = !nodeNames?.has('IPAdapterUnifiedLoader');
  if (needsExplicitClip && !models.clipVision && hasIpAdapterNodes) {
    // still allow unified path without clip file when node exists
    if (!hasIpAdapterNodes) missing.push('models/clip_vision/CLIP-ViT-H-14*.safetensors');
  }
  if (!models.clipVision && hasIpAdapterNodes && !nodeNames?.has('IPAdapterUnifiedLoader')) {
    missing.push('models/clip_vision/CLIP-ViT-H-14*.safetensors');
  }
  if (!models.controlnet) {
    missing.push('models/controlnet/*sdxl* (openpose/depth/canny)');
  }

  let characterKind: CharacterAdapterKind = 'none';
  if (hasIpAdapterNodes && models.ipadapter) {
    if (nodeNames?.has('IPAdapterUnifiedLoader') || (!nodeNames && hasIpAdapterCustomNode(installPath || ''))) {
      characterKind = 'ip_adapter_unified';
    } else if (models.clipVision || nodeNames?.has('IPAdapterAdvanced')) {
      characterKind = 'ip_adapter';
    }
  }
  // Prefer unified when available
  if (hasIpAdapterNodes && models.ipadapter && nodeNames?.has('IPAdapterUnifiedLoader')) {
    characterKind = 'ip_adapter_unified';
  } else if (hasIpAdapterNodes && models.ipadapter && models.clipVision) {
    characterKind = 'ip_adapter';
  } else if (hasIpAdapterNodes && models.ipadapter && !models.clipVision) {
    // Unified may still work without separate clip file on disk if pack is bundled
    characterKind = nodeNames?.has('IPAdapterUnifiedLoader') || !nodeNames
      ? 'ip_adapter_unified'
      : 'none';
    if (characterKind === 'none') missing.push('models/clip_vision for IPAdapterAdvanced');
  }

  const characterAdapter = characterKind !== 'none';
  const compositionControl = Boolean(hasControlNetNodes && models.controlnet);
  const compositionKind = compositionControl ? models.compositionKind : 'none';

  if (characterAdapter) {
    notes.push(`Character adapter ready (${characterKind}, model=${models.ipadapter})`);
  } else {
    notes.push('Character adapter unavailable — Tier A tags/img2img only for identity');
  }
  if (compositionControl) {
    notes.push(
      `Composition ControlNet ready (${compositionKind}, model=${models.controlnet}`
      + `${hasOpenPosePreprocessor ? ', preprocessor=yes' : ', preprocessor=no — raw image hint'})`
    );
  } else {
    notes.push('Composition ControlNet unavailable — text composition only');
  }

  return {
    characterAdapter,
    compositionControl,
    modelFamilySupported: true,
    characterKind,
    compositionKind,
    models,
    hasIpAdapterNodes,
    hasControlNetNodes,
    hasOpenPosePreprocessor,
    missing: Array.from(new Set(missing)),
    notes
  };
};

const discoverTierBModelsSafe = (
  installPath: string | null | undefined,
  configured?: {
    ipadapter?: string | null;
    clipVision?: string | null;
    controlnet?: string | null;
  }
): TierBModelFiles => {
  try {
    return discoverTierBModels(installPath, configured);
  } catch (e) {
    logger.warn(`Tier B model discovery failed: ${e}`);
    return { ipadapter: null, clipVision: null, controlnet: null, compositionKind: 'none' };
  }
};

// ─── Workflow graph helpers ───────────────────────────────────────────

const findNodeId = (workflow: any, predicate: (node: any) => boolean) =>
  Object.keys(workflow).find((nodeId) => predicate(workflow[nodeId]));

const nextNodeId = (workflow: any) => {
  const numericIds = Object.keys(workflow)
    .map((nodeId) => Number(nodeId))
    .filter(Number.isFinite);
  return String((numericIds.length > 0 ? Math.max(...numericIds) : 0) + 1);
};

const getSamplerNodes = (workflow: any) =>
  Object.entries(workflow).filter(
    ([, node]: [string, any]) => node?.class_type?.includes('KSampler')
  ) as [string, any][];

/**
 * Inject Tier B nodes into a compiled Pony/SDXL workflow.
 * Returns which branches were actually wired.
 */
export const injectTierBAdapters = (
  workflow: any,
  options: TierBInjectOptions
): { characterWired: boolean; compositionWired: boolean; notes: string[] } => {
  const notes: string[] = [];
  let characterWired = false;
  let compositionWired = false;

  if (options.isFlux) {
    notes.push('Tier B SDXL adapters skipped for FLUX workflow');
    return { characterWired, compositionWired, notes };
  }

  const cap = options.capability;
  const charFile = options.characterImageFilename
    ? path.basename(options.characterImageFilename)
    : null;
  const compFile = options.compositionImageFilename
    ? path.basename(options.compositionImageFilename)
    : null;

  // ── Character: IP-Adapter ──────────────────────────────────────────
  if (cap.characterAdapter && charFile && cap.characterKind !== 'none') {
    try {
      characterWired = injectIpAdapter(workflow, {
        imageFilename: charFile,
        kind: cap.characterKind,
        ipadapterFile: cap.models.ipadapter!,
        clipVisionFile: cap.models.clipVision,
        weight: clamp(options.characterWeight ?? 0.75, 0.05, 1.5)
      });
      if (characterWired) {
        notes.push(`IP-Adapter wired image=${charFile} weight=${options.characterWeight ?? 0.75}`);
      }
    } catch (e) {
      notes.push(`IP-Adapter inject failed: ${e}`);
      logger.warn(`IP-Adapter inject failed: ${e}`);
    }
  }

  // ── Composition: ControlNet ────────────────────────────────────────
  if (cap.compositionControl && compFile && cap.models.controlnet) {
    try {
      compositionWired = injectControlNet(workflow, {
        imageFilename: compFile,
        controlnetFile: cap.models.controlnet,
        strength: clamp(options.compositionStrength ?? 0.55, 0.05, 1.5),
        kind: cap.compositionKind,
        usePreprocessor: cap.hasOpenPosePreprocessor && cap.compositionKind === 'openpose'
      });
      if (compositionWired) {
        notes.push(
          `ControlNet wired image=${compFile} model=${cap.models.controlnet} strength=${options.compositionStrength ?? 0.55}`
        );
      }
    } catch (e) {
      notes.push(`ControlNet inject failed: ${e}`);
      logger.warn(`ControlNet inject failed: ${e}`);
    }
  }

  return { characterWired, compositionWired, notes };
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const injectIpAdapter = (
  workflow: any,
  opts: {
    imageFilename: string;
    kind: CharacterAdapterKind;
    ipadapterFile: string;
    clipVisionFile: string | null;
    weight: number;
  }
): boolean => {
  const samplers = getSamplerNodes(workflow);
  if (samplers.length === 0) return false;

  // Current model link (after LoRAs if already injected)
  const firstSampler = samplers[0][1];
  const modelLink: [string, number] = Array.isArray(firstSampler.inputs?.model)
    ? [String(firstSampler.inputs.model[0]), Number(firstSampler.inputs.model[1] ?? 0)]
    : ['0', 0];

  const loadId = nextNodeId(workflow);
  workflow[loadId] = {
    inputs: { image: opts.imageFilename },
    class_type: 'LoadImage',
    _meta: { title: 'NovaStory Character Ref (IP-Adapter)' }
  };

  let patchedModelLink: [string, number];

  if (opts.kind === 'ip_adapter_unified') {
    const unifiedId = nextNodeId(workflow);
    // Unified loader: model + preset; outputs MODEL + IPADAPTER
    workflow[unifiedId] = {
      inputs: {
        model: modelLink,
        preset: guessUnifiedPreset(opts.ipadapterFile),
        lora_strength: 0.6,
        provider: 'CUDA'
      },
      class_type: 'IPAdapterUnifiedLoader',
      _meta: { title: 'NovaStory IPAdapter Unified Loader' }
    };

    const applyId = nextNodeId(workflow);
    // Prefer IPAdapterAdvanced if we only have simple apply — use IPAdapter
    workflow[applyId] = {
      inputs: {
        model: [unifiedId, 0],
        ipadapter: [unifiedId, 1],
        image: [loadId, 0],
        weight: opts.weight,
        start_at: 0.0,
        end_at: 1.0,
        weight_type: 'standard'
      },
      class_type: 'IPAdapter',
      _meta: { title: 'NovaStory IPAdapter Apply' }
    };
    patchedModelLink = [applyId, 0];
  } else {
    // Classic: ModelLoader + CLIPVision + Advanced
    const ipaLoadId = nextNodeId(workflow);
    workflow[ipaLoadId] = {
      inputs: { ipadapter_file: opts.ipadapterFile },
      class_type: 'IPAdapterModelLoader',
      _meta: { title: 'NovaStory IPAdapter Model' }
    };

    const clipId = nextNodeId(workflow);
    if (opts.clipVisionFile) {
      workflow[clipId] = {
        inputs: { clip_name: opts.clipVisionFile },
        class_type: 'CLIPVisionLoader',
        _meta: { title: 'NovaStory CLIP Vision' }
      };
    }

    const applyId = nextNodeId(workflow);
    const advancedInputs: Record<string, any> = {
      model: modelLink,
      ipadapter: [ipaLoadId, 0],
      image: [loadId, 0],
      weight: opts.weight,
      weight_type: 'linear',
      combine_embeds: 'concat',
      start_at: 0.0,
      end_at: 1.0,
      embeds_scaling: 'V only'
    };
    if (opts.clipVisionFile) {
      advancedInputs.clip_vision = [clipId, 0];
    }
    workflow[applyId] = {
      inputs: advancedInputs,
      class_type: 'IPAdapterAdvanced',
      _meta: { title: 'NovaStory IPAdapter Advanced' }
    };
    patchedModelLink = [applyId, 0];
  }

  for (const [, sampler] of samplers) {
    if (sampler.inputs) {
      sampler.inputs.model = patchedModelLink;
    }
  }
  return true;
};

const guessUnifiedPreset = (ipadapterFile: string): string => {
  const f = ipadapterFile.toLowerCase();
  if (f.includes('faceid') && f.includes('plus')) return 'FACEID PLUS V2';
  if (f.includes('faceid')) return 'FACEID';
  if (f.includes('plus-face') || f.includes('plus_face')) return 'PLUS FACE (portraits)';
  if (f.includes('plus')) return 'PLUS (high strength)';
  if (f.includes('full')) return 'FULL FACE';
  return 'PLUS (high strength)';
};

const injectControlNet = (
  workflow: any,
  opts: {
    imageFilename: string;
    controlnetFile: string;
    strength: number;
    kind: CompositionControlKind;
    usePreprocessor: boolean;
  }
): boolean => {
  const samplers = getSamplerNodes(workflow);
  if (samplers.length === 0) return false;

  const loadId = nextNodeId(workflow);
  workflow[loadId] = {
    inputs: { image: opts.imageFilename },
    class_type: 'LoadImage',
    _meta: { title: 'NovaStory Composition Ref' }
  };

  let imageLink: [string, number] = [loadId, 0];

  if (opts.usePreprocessor && opts.kind === 'openpose') {
    const preId = nextNodeId(workflow);
    // OpenposePreprocessor is the common controlnet_aux class name
    workflow[preId] = {
      inputs: {
        image: [loadId, 0],
        detect_hand: 'enable',
        detect_body: 'enable',
        detect_face: 'enable',
        resolution: 1024
      },
      class_type: 'OpenposePreprocessor',
      _meta: { title: 'NovaStory OpenPose Preprocessor' }
    };
    imageLink = [preId, 0];
  }

  const cnLoadId = nextNodeId(workflow);
  workflow[cnLoadId] = {
    inputs: { control_net_name: opts.controlnetFile },
    class_type: 'ControlNetLoader',
    _meta: { title: 'NovaStory ControlNet Loader' }
  };

  // Optional VAE for SDXL ControlNets that need it
  const vaeSourceId =
    findNodeId(workflow, (n) => n?.class_type === 'CheckpointLoaderSimple')
    || findNodeId(workflow, (n) => n?.class_type === 'VAELoader');

  for (const [, sampler] of samplers) {
    if (!sampler.inputs) continue;
    const positive = sampler.inputs.positive;
    const negative = sampler.inputs.negative;
    if (!Array.isArray(positive) || !Array.isArray(negative)) continue;

    const applyId = nextNodeId(workflow);
    const applyInputs: Record<string, any> = {
      positive,
      negative,
      control_net: [cnLoadId, 0],
      image: imageLink,
      strength: opts.strength,
      start_percent: 0.0,
      end_percent: 0.85
    };
    if (vaeSourceId) {
      // CheckpointLoaderSimple VAE output index = 2
      const node = workflow[vaeSourceId];
      const vaeIndex = node?.class_type === 'VAELoader' ? 0 : 2;
      applyInputs.vae = [vaeSourceId, vaeIndex];
    }

    workflow[applyId] = {
      inputs: applyInputs,
      class_type: 'ControlNetApplyAdvanced',
      _meta: { title: 'NovaStory ControlNet Apply' }
    };

    sampler.inputs.positive = [applyId, 0];
    sampler.inputs.negative = [applyId, 1];
  }

  return true;
};

/**
 * Fetch /object_info from a live ComfyUI instance (best-effort).
 */
export const fetchComfyObjectInfo = async (
  baseUrl: string,
  timeoutMs = 4000
): Promise<Record<string, any> | null> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/object_info`, {
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, any>;
  } catch {
    return null;
  }
};

/** Settings-shaped helper used by generation_service */
export const resolveTierBFromSettings = async (
  runtimeSettings: any,
  options: { isFlux?: boolean } = {}
): Promise<TierBCapability> => {
  const comfy = runtimeSettings?.comfyui || {};
  const installPath = comfy.install_path || null;
  const baseUrl = comfy.base_url || 'http://127.0.0.1:8188';
  const tierB = comfy.tier_b || {};

  const objectInfo = await fetchComfyObjectInfo(baseUrl);
  const capability = probeTierBCapability(installPath, {
    objectInfo,
    enabled: tierB.enabled !== false && comfy.tier_b_enabled !== false,
    configured: {
      ipadapter: tierB.ipadapter_model || comfy.ipadapter_model,
      clipVision: tierB.clip_vision_model || comfy.clip_vision_model,
      controlnet: tierB.controlnet_model || comfy.controlnet_model
    }
  });

  if (options.isFlux) {
    return {
      ...capability,
      characterAdapter: false,
      compositionControl: false,
      modelFamilySupported: false,
      notes: [
        ...capability.notes,
        'FLUX.1-dev GGUF: Tier B dual-ref not yet supported — using Tier A'
      ]
    };
  }

  return capability;
};
