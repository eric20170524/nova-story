/**
 * Tier B dual-reference adapters for ComfyUI (Pony / SDXL first).
 *
 * Character identity: ComfyUI_IPAdapter_plus (IPAdapterUnifiedLoader / IPAdapterAdvanced)
 * Composition:       native ControlNetLoader + ControlNetApplyAdvanced
 *                    optional comfyui_controlnet_aux OpenposePreprocessor
 *
 * FLUX GGUF retired (2026-08). If a custom flux-like graph appears, Tier B is skipped.
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

/**
 * FaceID Plus V2 (SDXL) needs three things: the FaceID nodes, its ipadapter weights and its LoRA.
 * A node pack alone is not enough — the loader fails with "IPAdapter model not found".
 */
export interface FaceIdCapability {
  available: boolean;
  ipadapter: string | null;
  lora: string | null;
  missing: string[];
}

export interface TierBCapability extends AdapterAvailability {
  modelFamilySupported: boolean;
  characterKind: CharacterAdapterKind;
  compositionKind: CompositionControlKind;
  models: TierBModelFiles;
  hasIpAdapterNodes: boolean;
  hasControlNetNodes: boolean;
  hasOpenPosePreprocessor: boolean;
  hasDepthPreprocessor?: boolean;
  hasCannyPreprocessor?: boolean;
  /** InsightFace-based face lock. Only set from a live object_info. */
  faceId?: FaceIdCapability;
  /** Human-readable install hints when something is missing */
  missing: string[];
  notes: string[];
}

export interface TierBInjectOptions {
  characterImageFilename?: string | null;
  compositionImageFilename?: string | null;
  characterWeight?: number;
  compositionStrength?: number;
  /** Use FaceID Plus V2 for identity when the install has it; otherwise plain IP-Adapter is used. */
  preferFaceId?: boolean;
  faceIdWeight?: number;
  /** Enable Stage 2 local face crop-inpaint-restore pipeline (Scheme 3 + Scheme 1 for Pony/SDXL). */
  enableFaceDetailStage2?: boolean;
  canvasWidth?: number;
  canvasHeight?: number;
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

const choiceList = (objectInfo: Record<string, any> | null, node: string, field: string): string[] => {
  const raw = objectInfo?.[node]?.input?.required?.[field];
  const list = Array.isArray(raw) ? raw[0] : [];
  return Array.isArray(list) ? list.map((item) => String(item)) : [];
};

const FACEID_NODES = ['IPAdapterUnifiedLoaderFaceID', 'IPAdapterFaceID'] as const;
const FACEID_WEIGHTS_RE = /faceid[-_]?plusv2.*sdxl(?!.*lora)/i;
const FACEID_LORA_RE = /faceid[-_]?plusv2.*sdxl.*lora/i;

/** FaceID Plus V2 readiness from a live object_info. Without object_info it is never assumed. */
export const faceIdFromObjectInfo = (objectInfo: Record<string, any> | null): FaceIdCapability => {
  const missing: string[] = [];
  if (!objectInfo) {
    return { available: false, ipadapter: null, lora: null, missing: ['object_info unavailable'] };
  }
  for (const node of FACEID_NODES) {
    if (!objectInfo[node]) missing.push(`custom node ${node}`);
  }
  const ipadapter = choiceList(objectInfo, 'IPAdapterModelLoader', 'ipadapter_file')
    .find((file) => FACEID_WEIGHTS_RE.test(file)) || null;
  const lora = choiceList(objectInfo, 'LoraLoader', 'lora_name')
    .find((file) => FACEID_LORA_RE.test(file)) || null;
  if (!ipadapter) missing.push('models/ipadapter/ip-adapter-faceid-plusv2_sdxl.bin');
  if (!lora) missing.push('models/loras/ip-adapter-faceid-plusv2_sdxl_lora.safetensors');
  return { available: missing.length === 0, ipadapter, lora, missing };
};

/** Model filenames advertised by a live ComfyUI, including a remote install. */
export const modelChoicesFromObjectInfo = (objectInfo: Record<string, any> | null) => {
  // FaceID weights share the ipadapter folder but need their own loader; never use them as the plain adapter.
  const ipadapterFiles = choiceList(objectInfo, 'IPAdapterModelLoader', 'ipadapter_file')
    .filter((file) => !/faceid/i.test(file));
  const clipFiles = choiceList(objectInfo, 'CLIPVisionLoader', 'clip_name');
  const controlnetFiles = choiceList(objectInfo, 'ControlNetLoader', 'control_net_name');
  const ipadapter = pickByPatterns(ipadapterFiles, [
    /plus-face.*sdxl/i,
    /plus_face.*sdxl/i,
    /ip-adapter-plus.*sdxl/i,
    /plus.*sdxl/i,
    /sdxl/i,
  ]);
  const clipVision = pickByPatterns(clipFiles, [/CLIP-ViT-H-14/i, /ViT-H-14/i, /vit.?h/i]);
  const openpose = controlnetFiles.find((file) => /openpose|pose/i.test(file) && /sdxl|xl/i.test(file));
  const depth = controlnetFiles.find((file) => /depth/i.test(file) && /sdxl|xl/i.test(file));
  const canny = controlnetFiles.find((file) => /canny|lineart/i.test(file) && /sdxl|xl/i.test(file));
  const controlnet = openpose || depth || canny || null;
  const compositionKind: CompositionControlKind = openpose ? 'openpose' : depth ? 'depth' : canny ? 'canny' : 'none';
  return { ipadapter, clipVision, controlnet, compositionKind };
};

/**
 * Probe filesystem (+ optional object_info) for Tier B readiness.
 * A remote ComfyUI reports its model names through object_info; the local install path is optional.
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
  const remoteModels = modelChoicesFromObjectInfo(objectInfo);
  if (!models.ipadapter && remoteModels.ipadapter) models.ipadapter = remoteModels.ipadapter;
  if (!models.clipVision && remoteModels.clipVision) models.clipVision = remoteModels.clipVision;
  if (!models.controlnet && remoteModels.controlnet) {
    models.controlnet = remoteModels.controlnet;
    models.compositionKind = remoteModels.compositionKind;
  }

  const nodeNames = objectInfo ? new Set(Object.keys(objectInfo)) : null;

  const hasIpAdapterNodes = nodeNames
    ? [
      'IPAdapterAdvanced',
      'IPAdapter',
      'IPAdapterUnifiedLoader',
      'IPAdapterModelLoader',
      'IPAdapterUnifiedLoaderFaceID',
      'IPAdapterFaceID'
    ].some((n) => nodeNames.has(n))
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

  const hasDepthPreprocessor = nodeNames
    ? ['DepthAnythingPreprocessor', 'MiDaS-DepthMapPreprocessor', 'Zoe-DepthMapPreprocessor', 'Zoe_DepthAnythingPreprocessor'].some((n) =>
      nodeNames.has(n)
    )
    : Boolean(installPath && hasControlNetAux(installPath));

  const hasCannyPreprocessor = nodeNames
    ? ['CannyEdgePreprocessor', 'Canny'].some((n) => nodeNames.has(n))
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

  const faceId = faceIdFromObjectInfo(objectInfo);
  if (characterKind === 'none' && faceId.available) {
    characterKind = 'ip_adapter_unified';
  }
  const characterAdapter = characterKind !== 'none';
  const compositionControl = Boolean(hasControlNetNodes && models.controlnet);
  const compositionKind = compositionControl ? models.compositionKind : 'none';

  if (characterAdapter) {
    notes.push(`Character adapter ready (${characterKind}, model=${models.ipadapter || faceId.ipadapter})`);
  } else {
    notes.push('Character adapter unavailable — Tier A tags/img2img only for identity');
  }
  notes.push(
    faceId.available
      ? `FaceID Plus V2 ready (model=${faceId.ipadapter}, lora=${faceId.lora})`
      : `FaceID Plus V2 unavailable — plain IP-Adapter for identity (missing: ${faceId.missing.join(', ')})`
  );
  if (compositionControl) {
    const hasPre =
      compositionKind === 'openpose' ? hasOpenPosePreprocessor :
      compositionKind === 'depth' ? hasDepthPreprocessor :
      hasCannyPreprocessor;
    notes.push(
      `Composition ControlNet ready (${compositionKind}, model=${models.controlnet}`
      + `${hasPre ? ', preprocessor=yes' : ', preprocessor=no — raw image hint'})`
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
    hasDepthPreprocessor,
    hasCannyPreprocessor,
    faceId,
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
): { characterWired: boolean; compositionWired: boolean; faceDetailWired?: boolean; notes: string[] } => {
  const notes: string[] = [];
  let characterWired = false;
  let compositionWired = false;
  let faceDetailWired = false;

  if (options.isFlux) {
    notes.push('Tier B SDXL adapters skipped for FLUX workflow');
    return { characterWired, compositionWired, faceDetailWired, notes };
  }

  const cap = options.capability;
  const charFile = options.characterImageFilename
    ? path.basename(options.characterImageFilename)
    : null;
  const compFile = options.compositionImageFilename
    ? path.basename(options.compositionImageFilename)
    : null;

  const initialSamplers = getSamplerNodes(workflow);
  const firstInitialSampler = initialSamplers[0]?.[1];
  const basePositiveLink: [string, number] | null = Array.isArray(firstInitialSampler?.inputs?.positive)
    ? [String(firstInitialSampler.inputs.positive[0]), Number(firstInitialSampler.inputs.positive[1] ?? 0)]
    : null;
  const baseNegativeLink: [string, number] | null = Array.isArray(firstInitialSampler?.inputs?.negative)
    ? [String(firstInitialSampler.inputs.negative[0]), Number(firstInitialSampler.inputs.negative[1] ?? 0)]
    : null;

  // ── Character: FaceID Plus V2 when asked for and installed, else IP-Adapter ──
  if (cap.characterAdapter && charFile && cap.characterKind !== 'none') {
    const useFaceId = options.preferFaceId === true && cap.faceId?.available === true;
    try {
      if (useFaceId) {
        characterWired = injectFaceIdAdapter(workflow, {
          imageFilename: charFile,
          weight: clamp(options.faceIdWeight ?? 0.85, 0.05, 1.5)
        });
        if (characterWired) {
          notes.push(`FaceID Plus V2 wired image=${charFile} weight=${options.faceIdWeight ?? 0.85}`);
        }
      } else if (cap.models.ipadapter) {
        characterWired = injectIpAdapter(workflow, {
          imageFilename: charFile,
          kind: cap.characterKind,
          ipadapterFile: cap.models.ipadapter,
          clipVisionFile: cap.models.clipVision,
          weight: clamp(options.characterWeight ?? 0.75, 0.05, 1.5)
        });
        if (characterWired) {
          notes.push(`IP-Adapter wired image=${charFile} weight=${options.characterWeight ?? 0.75}`);
        }
      }
    } catch (e) {
      notes.push(`Character adapter inject failed: ${e}`);
      logger.warn(`Character adapter inject failed: ${e}`);
    }
  }

  // ── Composition: ControlNet ────────────────────────────────────────
  if (cap.compositionControl && compFile && cap.models.controlnet) {
    try {
      const usePreprocessor =
        (cap.compositionKind === 'openpose' && cap.hasOpenPosePreprocessor)
        || (cap.compositionKind === 'depth' && Boolean(cap.hasDepthPreprocessor ?? true))
        || (cap.compositionKind === 'canny' && Boolean(cap.hasCannyPreprocessor));
      compositionWired = injectControlNet(workflow, {
        imageFilename: compFile,
        controlnetFile: cap.models.controlnet,
        strength: clamp(options.compositionStrength ?? 0.55, 0.05, 1.5),
        kind: cap.compositionKind,
        usePreprocessor
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

  // ── Stage 2: Face-Detail Local Inpaint Pipeline (Scheme 3 + Scheme 1) ──
  if (characterWired && options.enableFaceDetailStage2 === true) {
    try {
      faceDetailWired = injectPonyFaceDetailStage2(workflow, {
        width: options.canvasWidth || 768,
        height: options.canvasHeight || 1344,
        basePositiveLink,
        baseNegativeLink,
      });
      if (faceDetailWired) {
        notes.push('Pony Stage 2 Face-Detail local crop-inpaint-restore wired');
      }
    } catch (e) {
      notes.push(`Pony Stage 2 Face-Detail inject failed: ${e}`);
      logger.warn(`Pony Stage 2 Face-Detail inject failed: ${e}`);
    }
  }

  return { characterWired, compositionWired, faceDetailWired, notes };
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * FaceID Plus V2: an InsightFace embedding carries the face only, so unlike plain IP-Adapter
 * it does not drag the reference's bust composition into a full-body frame.
 * The unified FaceID loader patches the model with the FaceID LoRA, so it is chained after any LoRAs.
 */
const injectFaceIdAdapter = (
  workflow: any,
  opts: { imageFilename: string; weight: number }
): boolean => {
  const samplers = getSamplerNodes(workflow);
  const firstSampler = samplers[0]?.[1];
  if (!firstSampler || !Array.isArray(firstSampler.inputs?.model)) return false;
  const modelLink: [string, number] = [
    String(firstSampler.inputs.model[0]),
    Number(firstSampler.inputs.model[1] ?? 0)
  ];

  const loadId = nextNodeId(workflow);
  workflow[loadId] = {
    inputs: { image: opts.imageFilename },
    class_type: 'LoadImage',
    _meta: { title: 'NovaStory Character Ref (FaceID)' }
  };
  const loaderId = nextNodeId(workflow);
  workflow[loaderId] = {
    inputs: { model: modelLink, preset: 'FACEID PLUS V2', lora_strength: 0.6, provider: 'CUDA' },
    class_type: 'IPAdapterUnifiedLoaderFaceID',
    _meta: { title: 'NovaStory IPAdapter FaceID Loader' }
  };
  const applyId = nextNodeId(workflow);
  workflow[applyId] = {
    inputs: {
      model: [loaderId, 0],
      ipadapter: [loaderId, 1],
      image: [loadId, 0],
      weight: opts.weight,
      weight_faceidv2: 1.0,
      weight_type: 'linear',
      combine_embeds: 'concat',
      start_at: 0.0,
      end_at: 1.0,
      embeds_scaling: 'V only'
    },
    class_type: 'IPAdapterFaceID',
    _meta: { title: 'NovaStory IPAdapter FaceID Apply' }
  };
  for (const [, sampler] of samplers) {
    if (sampler.inputs) sampler.inputs.model = [applyId, 0];
  }
  return true;
};

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
  const firstSampler = samplers[0]?.[1];
  if (!firstSampler) return false;
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

  if (opts.usePreprocessor) {
    if (opts.kind === 'openpose') {
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
    } else if (opts.kind === 'depth') {
      const preId = nextNodeId(workflow);
      workflow[preId] = {
        inputs: {
          image: [loadId, 0],
          ckpt_name: 'depth_anything_vitl14.pth',
          resolution: 1024
        },
        class_type: 'DepthAnythingPreprocessor',
        _meta: { title: 'NovaStory Depth Anything Preprocessor' }
      };
      imageLink = [preId, 0];
    } else if (opts.kind === 'canny') {
      const preId = nextNodeId(workflow);
      workflow[preId] = {
        inputs: {
          image: [loadId, 0],
          low_threshold: 100,
          high_threshold: 200,
          resolution: 1024
        },
        class_type: 'CannyEdgePreprocessor',
        _meta: { title: 'NovaStory Canny Edge Preprocessor' }
      };
      imageLink = [preId, 0];
    }
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

export const FACE_DETAIL_STAGE2_META = 'face_detail_stage2';

/** True for nodes injected by a Stage 2 face-detail pipeline; global resets (denoise, steps) must skip them. */
export const isFaceDetailStage2Node = (node: any): boolean =>
  node?._meta?.stage === FACE_DETAIL_STAGE2_META;

/**
 * Head ROI as a CreateShapeMask for a front full-body frame: the head sits on the vertical centre line,
 * about 13% below the top edge. Sized from the real canvas so it follows every panel size.
 */
export const buildHeadMaskInputs = (width: number, height: number): Record<string, unknown> => {
  const w = Math.max(256, Math.round(Number(width) || 768));
  const h = Math.max(256, Math.round(Number(height) || 1344));
  return {
    shape: 'circle',
    frames: 1,
    location_x: Math.round(w / 2),
    location_y: Math.round(h * 0.13),
    grow: 0,
    frame_width: w,
    frame_height: h,
    shape_width: Math.max(64, Math.round(w * 0.25)),
    shape_height: Math.max(64, Math.round(h * 0.195)),
  };
};

/**
 * Choose a loader model name against a live catalog: the first preferred name present, else the first
 * name matching `pattern`, else `fallback`. With no catalog, `onlyWhenCatalogPresent` keeps `fallback`
 * and otherwise the first preferred name is used.
 */
export const pickCatalogModel = (
  catalog: unknown,
  preferred: string[],
  pattern: RegExp,
  fallback: string,
  onlyWhenCatalogPresent: boolean
): string => {
  const names = Array.isArray(catalog)
    ? catalog.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (names.length === 0) {
    return onlyWhenCatalogPresent ? fallback : (preferred[0] || fallback);
  }
  if (onlyWhenCatalogPresent && names.includes(fallback)) return fallback;
  for (const candidate of preferred) {
    if (names.includes(candidate)) return candidate;
  }
  return names.find((n) => pattern.test(n)) || fallback;
};

/**
 * Pony/SDXL Stage 2 Face-Detail Local Inpaint Pipeline (Scheme 3 + Scheme 1):
 * Crops the head/face ROI from Stage 1's full-body decode to 768x768, re-samples with
 * the FaceID/IP-Adapter patched SDXL model via VAEEncodeForInpaint, and restores onto Stage 1.
 */
const injectPonyFaceDetailStage2 = (
  workflow: any,
  opts: {
    width: number;
    height: number;
    basePositiveLink?: [string, number] | null;
    baseNegativeLink?: [string, number] | null;
  }
): boolean => {
  const samplers = getSamplerNodes(workflow).filter(
    ([, node]) => !isFaceDetailStage2Node(node)
  );
  const firstSampler = samplers[0]?.[1];
  if (!firstSampler?.inputs) return false;

  const saveId = findNodeId(workflow, (n) => n?.class_type === 'SaveImage');
  const stage1DecodeLink: [string, number] | null =
    saveId && Array.isArray(workflow[saveId]?.inputs?.images)
      ? [String(workflow[saveId].inputs.images[0]), Number(workflow[saveId].inputs.images[1] ?? 0)]
      : null;
  if (!saveId || !stage1DecodeLink) return false;

  const decodeNode = workflow[stage1DecodeLink[0]];
  const vaeLink: [string, number] | null = Array.isArray(decodeNode?.inputs?.vae)
    ? [String(decodeNode.inputs.vae[0]), Number(decodeNode.inputs.vae[1] ?? 0)]
    : (() => {
        const vaeId = findNodeId(workflow, (n) => n?.class_type === 'VAELoader');
        if (vaeId) return [vaeId, 0] as [string, number];
        const ckptId = findNodeId(workflow, (n) => n?.class_type === 'CheckpointLoaderSimple');
        if (ckptId) return [ckptId, 2] as [string, number];
        return null;
      })();
  if (!vaeLink) return false;

  const modelLink: [string, number] = [
    String(firstSampler.inputs.model[0]),
    Number(firstSampler.inputs.model[1] ?? 0),
  ];
  const posLink: [string, number] = opts.basePositiveLink || [
    String(firstSampler.inputs.positive[0]),
    Number(firstSampler.inputs.positive[1] ?? 0),
  ];
  const negLink: [string, number] = opts.baseNegativeLink || [
    String(firstSampler.inputs.negative[0]),
    Number(firstSampler.inputs.negative[1] ?? 0),
  ];

  const w = Math.max(256, Math.round(Number(opts.width) || 768));
  const h = Math.max(256, Math.round(Number(opts.height) || 1344));

  const maskId = nextNodeId(workflow);
  workflow[maskId] = {
    inputs: buildHeadMaskInputs(w, h),
    class_type: 'CreateShapeMask',
    _meta: { title: 'NovaStory Stage 2 Head Mask (Pony)', stage: FACE_DETAIL_STAGE2_META },
  };

  const cropId = nextNodeId(workflow);
  workflow[cropId] = {
    inputs: {
      '图像': stage1DecodeLink,
      '遮罩': [maskId, 0],
      '遮罩填充': true,
      '扩展系数上': 1.5,
      '扩展系数下': 1.5,
      '扩展系数左': 1.5,
      '扩展系数右': 1.5,
      '输出尺寸': '自定义宽高',
      '自定义宽': 768,
      '自定义高': 768,
      '倍数取整': 32,
    },
    class_type: 'GH_MaskCropV2',
    _meta: { title: 'NovaStory Stage 2 Face Crop (Pony)', stage: FACE_DETAIL_STAGE2_META },
  };

  const inpaintEncodeId = nextNodeId(workflow);
  workflow[inpaintEncodeId] = {
    inputs: {
      pixels: [cropId, 1],
      vae: vaeLink,
      mask: [cropId, 2],
      grow_mask_by: 6,
    },
    class_type: 'VAEEncodeForInpaint',
    _meta: { title: 'NovaStory Stage 2 VAE Encode Inpaint (Pony)', stage: FACE_DETAIL_STAGE2_META },
  };

  const stage2SamplerId = nextNodeId(workflow);
  workflow[stage2SamplerId] = {
    inputs: {
      seed: Number(firstSampler.inputs.seed ?? 1),
      steps: 18,
      cfg: Number(firstSampler.inputs.cfg ?? 5.5),
      sampler_name: String(firstSampler.inputs.sampler_name || 'euler_ancestral'),
      scheduler: String(firstSampler.inputs.scheduler || 'normal'),
      denoise: 0.5,
      model: modelLink,
      positive: posLink,
      negative: negLink,
      latent_image: [inpaintEncodeId, 0],
    },
    class_type: 'KSampler',
    _meta: { title: 'NovaStory Stage 2 KSampler (Pony Face Detail)', stage: FACE_DETAIL_STAGE2_META },
  };

  const stage2DecodeId = nextNodeId(workflow);
  workflow[stage2DecodeId] = {
    inputs: {
      samples: [stage2SamplerId, 0],
      vae: vaeLink,
    },
    class_type: 'VAEDecode',
    _meta: { title: 'NovaStory Stage 2 VAE Decode (Pony)', stage: FACE_DETAIL_STAGE2_META },
  };

  const restoreId = nextNodeId(workflow);
  workflow[restoreId] = {
    inputs: {
      '接缝': [cropId, 0],
      '裁剪图像': [stage2DecodeId, 0],
      '遮罩扩展百分比': 5,
      '遮罩羽化百分比': 12,
      '裁剪遮罩': [cropId, 2],
      '背景图像': stage1DecodeLink,
      '颜色还原强度': 0.5,
    },
    class_type: 'GH_CropRestore',
    _meta: { title: 'NovaStory Stage 2 Face Restore (Pony)', stage: FACE_DETAIL_STAGE2_META },
  };

  workflow[saveId].inputs.images = [restoreId, 0];
  return true;
};

export interface Krea2FaceDetailStage2Options {
  width: number;
  height: number;
  /** Filename of the approved portrait, readable by ComfyUI LoadImage (image 2 of the Qwen-Image 2.1 encoder). */
  referenceFilename: string;
  seed: number;
  unetName?: string;
  clipName?: string;
  vaeName?: string;
  prompt?: string;
  negativePrompt?: string;
  steps?: number;
  denoise?: number;
}

const KREA2_STAGE2_PROMPT =
  'Keep the exact same face as the person in image 2: identical facial structure, eye shape, eye color, nose, lips and skin tone. '
  + 'Keep the head pose, hairstyle, lighting and clothing collar of image 1. Photorealistic, sharp detailed face, natural skin texture.';
const KREA2_STAGE2_NEGATIVE =
  'low quality, worst quality, deformed, blurry face, different person, different face, altered facial features, generic beauty face';

/**
 * RedCraft Krea2 Stage 2 (scheme 1B): Stage 1 keeps the native Krea2 full-body render. The head ROI is cropped
 * to 768x768, re-drawn by Qwen-Image 2.1 with the portrait as image 2 (TextEncodeQwenImage21GH), then
 * pasted back with GH_CropRestore. SaveImage is re-pointed at the restored full-body image.
 * The sampler is tagged so global denoise/steps resets leave it alone.
 */
export const injectKrea2QwenFaceDetailStage2 = (
  workflow: any,
  opts: Krea2FaceDetailStage2Options
): boolean => {
  const saveId = findNodeId(workflow, (n) => n?.class_type === 'SaveImage');
  const stage1Link: [string, number] | null =
    saveId && Array.isArray(workflow[saveId]?.inputs?.images)
      ? [String(workflow[saveId].inputs.images[0]), Number(workflow[saveId].inputs.images[1] ?? 0)]
      : null;
  if (!saveId || !stage1Link || !opts.referenceFilename) return false;
  if (Object.values(workflow).some((n: any) => isFaceDetailStage2Node(n))) return false;

  const meta = (title: string) => ({ title, stage: FACE_DETAIL_STAGE2_META });
  const w = Math.max(256, Math.round(Number(opts.width) || 768));
  const h = Math.max(256, Math.round(Number(opts.height) || 1152));

  const refId = nextNodeId(workflow);
  workflow[refId] = {
    inputs: { image: opts.referenceFilename },
    class_type: 'LoadImage',
    _meta: meta('NovaStory Stage 2 Face Reference (Qwen-Image 2.1)'),
  };
  const maskId = nextNodeId(workflow);
  workflow[maskId] = {
    inputs: buildHeadMaskInputs(w, h),
    class_type: 'CreateShapeMask',
    _meta: meta('NovaStory Stage 2 Head Mask (Krea2)'),
  };
  const cropId = nextNodeId(workflow);
  workflow[cropId] = {
    inputs: {
      '图像': stage1Link,
      '遮罩': [maskId, 0],
      '遮罩填充': true,
      '扩展系数上': 1.5,
      '扩展系数下': 1.5,
      '扩展系数左': 1.5,
      '扩展系数右': 1.5,
      '输出尺寸': '自定义宽高',
      '自定义宽': 768,
      '自定义高': 768,
      '倍数取整': 32,
    },
    class_type: 'GH_MaskCropV2',
    _meta: meta('NovaStory Stage 2 Face Crop (Krea2)'),
  };
  const unetId = nextNodeId(workflow);
  workflow[unetId] = {
    inputs: { unet_name: opts.unetName || 'qwen_image_2.1_bf16.safetensors', weight_dtype: 'default' },
    class_type: 'UNETLoader',
    _meta: meta('NovaStory Stage 2 Qwen-Image 2.1 UNet'),
  };
  const clipId = nextNodeId(workflow);
  workflow[clipId] = {
    inputs: { clip_name: opts.clipName || 'qwen3vl_8b_bf16.safetensors', type: 'qwen_image' },
    class_type: 'CLIPLoader',
    _meta: meta('NovaStory Stage 2 Qwen3-VL 8B'),
  };
  const vaeId = nextNodeId(workflow);
  workflow[vaeId] = {
    inputs: { vae_name: opts.vaeName || 'qwen_image_2.1_vae_bf16.safetensors' },
    class_type: 'VAELoader',
    _meta: meta('NovaStory Stage 2 Qwen-Image 2.1 VAE'),
  };
  const encodeId = nextNodeId(workflow);
  workflow[encodeId] = {
    inputs: {
      clip: [clipId, 0],
      prompt: opts.prompt || KREA2_STAGE2_PROMPT,
      negative_prompt: opts.negativePrompt || KREA2_STAGE2_NEGATIVE,
      latent_width: 768,
      latent_height: 768,
      mode: '填充',
      ref_image_size: '自动',
      vae: [vaeId, 0],
      mask: [cropId, 2],
      image_01: [cropId, 1],
      image_02: [refId, 0],
    },
    class_type: 'TextEncodeQwenImage21GH',
    _meta: meta('NovaStory Stage 2 Qwen-Image 2.1 Face Encode'),
  };
  const samplerId = nextNodeId(workflow);
  workflow[samplerId] = {
    inputs: {
      seed: Number.isFinite(Number(opts.seed)) ? Number(opts.seed) : 1,
      steps: opts.steps ?? 16,
      cfg: 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: opts.denoise ?? 0.65,
      model: [unetId, 0],
      positive: [encodeId, 0],
      negative: [encodeId, 1],
      latent_image: [encodeId, 2],
    },
    class_type: 'KSampler',
    _meta: meta('NovaStory Stage 2 KSampler (Qwen-Image 2.1 Face Detail)'),
  };
  const decodeId = nextNodeId(workflow);
  workflow[decodeId] = {
    inputs: { samples: [samplerId, 0], vae: [vaeId, 0] },
    class_type: 'VAEDecode',
    _meta: meta('NovaStory Stage 2 VAE Decode (Qwen-Image 2.1)'),
  };
  const restoreQwenId = nextNodeId(workflow);
  workflow[restoreQwenId] = {
    inputs: { image: [decodeId, 0], info: [encodeId, 3] },
    class_type: 'RestoreQwenImage21GH',
    _meta: meta('NovaStory Stage 2 Qwen Restore'),
  };
  const pasteId = nextNodeId(workflow);
  workflow[pasteId] = {
    inputs: {
      '接缝': [cropId, 0],
      '裁剪图像': [restoreQwenId, 0],
      '遮罩扩展百分比': 5,
      '遮罩羽化百分比': 12,
      '裁剪遮罩': [cropId, 2],
      '背景图像': stage1Link,
      '颜色还原强度': 0.5,
    },
    class_type: 'GH_CropRestore',
    _meta: meta('NovaStory Stage 2 Face Restore (Krea2)'),
  };

  workflow[saveId].inputs.images = [pasteId, 0];
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

  let objectInfo: Record<string, any> | null = null;
  if (comfy.mode === 'remote') {
    try {
      const { ComfyUIService } = await import('./ai/comfyui_service');
      const response = await ComfyUIService.fromSettings(comfy).authenticatedFetch('/object_info', {}, 8000);
      if (response.ok) objectInfo = await response.json() as Record<string, any>;
    } catch {
      objectInfo = null;
    }
  }
  if (!objectInfo) objectInfo = await fetchComfyObjectInfo(baseUrl);
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
