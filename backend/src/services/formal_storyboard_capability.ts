/**
 * Formal storyboard capability baseline (Track 8 FS01).
 *
 * A capability is chain-ready only when the weight files, the full runtime node
 * chain, the model family, the shot policy, and the compiled connections all
 * pass. A custom-node directory or a single node does not count. Live
 * verification is a separate flag and stays false until a real image is archived.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { shouldAllowCharacterAdapter } from './reference_generation_policy';

export const FORMAL_SDXL_3060_WORKFLOW = 'pony_xl_12gb.json';
export const FORMAL_KREA2_12GB_WORKFLOW = 'redcraft_krea2_12gb.json';
export const FORMAL_QWEN_IMAGE_WORKFLOW = 'qwen_image_2_1.json';
export const FORMAL_REJECTED_3060_WORKFLOW = 'pony_xl_tier_b_dual_ref_l40.json';

export const FORMAL_CAPABILITY_IDS = [
  'sdxl_ip_adapter',
  'sdxl_openpose',
  'sdxl_depth',
  'sdxl_canny',
  'krea2_native_reference',
  'qwen_image_native_reference',
] as const;

export type FormalCapabilityId = (typeof FORMAL_CAPABILITY_IDS)[number];

export type FormalModelClass = 'sdxl' | 'krea2' | 'qwen_image' | 'sd15' | 'flux' | 'unknown';

export type FormalBlockReason =
  | 'not_installed'
  | 'offline'
  | 'incompatible'
  | 'missing_reference'
  | 'policy_skipped';

export interface FormalWeightRecord {
  role: string;
  filename: string;
  relative_path: string;
  bytes: number;
  sha256: string | null;
}

export interface FormalCapabilityState {
  id: FormalCapabilityId;
  installed: boolean;
  nodes_loaded: boolean;
  family_match: boolean;
  shot_allowed: boolean;
  wired: boolean;
  live_verified: boolean;
  chain_ready: boolean;
  reason: FormalBlockReason | null;
  policy_reason: string | null;
  required_nodes: string[];
  missing_nodes: string[];
  weights: FormalWeightRecord[];
  notes: string[];
}

export interface FormalShotSample {
  id: string;
  kind: string;
  production_scene_id: number | null;
  shot_type: string;
  shot_intent: string | null;
  subject_scale: string | null;
  location: string | null;
  primary_action?: string | null;
  visible_subjects: string[];
  script_id: number | null;
  script_scene_id: string | null;
  script_revision: number | null;
  has_continuity: boolean;
  continuity_status: string;
  active_version: number;
  character_ref_url: string | null;
  pose_source: 'rgb' | 'skeleton' | null;
}

export interface FormalAssessmentInput {
  modelName: string;
  workflowFile: string;
  workflow?: Record<string, any> | null;
  installPath?: string | null;
  /** `offline` means object_info could not be read. An empty object is an online install with no nodes. */
  runtime: 'offline' | 'online';
  objectInfo?: Record<string, any> | null;
  shot: FormalShotSample;
  liveVerifiedIds?: readonly string[];
  hashFiles?: boolean;
}

/** Failures still open after FS02. The route and completion path closed the first three. */
export const FORMAL_FS02_RESOLVED = [
  'draft-continuity-gate',
  'queue-clears-asset-url',
  'success-writes-shot-master',
] as const;

export const FORMAL_BASELINE_FAILURES = [
  {
    id: 'client-first-character',
    detail: 'DirectorMode sends character_ref_url and character_lora from the first mentioned character only.',
  },
] as const;

const WEIGHT_EXT = /\.(safetensors|ckpt|pt|bin|pth)$/i;

const IP_ADAPTER_NODES = ['LoadImage', 'IPAdapterModelLoader', 'CLIPVisionLoader', 'IPAdapterAdvanced'];
const CONTROL_NODES = ['LoadImage', 'ControlNetLoader', 'ControlNetApplyAdvanced'];
const OPENPOSE_PREPROCESSORS = ['OpenposePreprocessor'];
const DEPTH_PREPROCESSORS = ['DepthAnythingPreprocessor', 'MiDaS-DepthMapPreprocessor', 'Zoe-DepthMapPreprocessor'];
const CANNY_PREPROCESSORS = ['CannyEdgePreprocessor', 'Canny'];

const capabilityNodes = (id: FormalCapabilityId): string[] => {
  if (id === 'sdxl_ip_adapter') return IP_ADAPTER_NODES;
  if (id === 'sdxl_openpose') return [...CONTROL_NODES, ...OPENPOSE_PREPROCESSORS];
  if (id === 'sdxl_depth') return [...CONTROL_NODES, ...DEPTH_PREPROCESSORS];
  if (id === 'sdxl_canny') return [...CONTROL_NODES, ...CANNY_PREPROCESSORS];
  if (id === 'qwen_image_native_reference') return ['LoadImage', 'TextEncodeQwenImage21'];
  return [];
};

const familyOf = (id: FormalCapabilityId): FormalModelClass =>
  id === 'krea2_native_reference' ? 'krea2' : id === 'qwen_image_native_reference' ? 'qwen_image' : 'sdxl';

export const classifyFormalModel = (raw: unknown): { model_class: FormalModelClass; label: string } => {
  const value = String(raw ?? '').toLowerCase();
  if (/krea|redcraft|convrot|赤佬/.test(value)) {
    return { model_class: 'krea2', label: /int8|convrot/.test(value) ? 'Krea2 INT8 ConvRot' : 'Krea2' };
  }
  if (/qwen[_-]?image/.test(value)) return { model_class: 'qwen_image', label: 'Qwen-Image 2.1' };
  if (value.includes('flux')) return { model_class: 'flux', label: 'FLUX' };
  if (/sd\s*1\.?5|sd15|anything-?v5/.test(value)) return { model_class: 'sd15', label: 'SD1.5' };
  if (/juggernaut|autismmix|pony|sdxl/.test(value)) return { model_class: 'sdxl', label: 'SDXL' };
  if (!value.trim()) return { model_class: 'unknown', label: 'unknown' };
  return { model_class: 'unknown', label: String(raw) };
};

export const formalTemplateDecision = (workflowFile: string): { accepted: boolean; role: 'sdxl_3060' | 'krea2_12gb' | 'qwen_image_2_1' | 'rejected' } => {
  const name = path.basename(workflowFile);
  if (name === FORMAL_SDXL_3060_WORKFLOW) return { accepted: true, role: 'sdxl_3060' };
  if (name === FORMAL_KREA2_12GB_WORKFLOW) return { accepted: true, role: 'krea2_12gb' };
  if (name === FORMAL_QWEN_IMAGE_WORKFLOW) return { accepted: true, role: 'qwen_image_2_1' };
  return { accepted: false, role: 'rejected' };
};

const listWeightFiles = (root: string, depth = 0): string[] => {
  if (!root || !fs.existsSync(root) || depth > 2) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('put_')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...listWeightFiles(full, depth + 1));
    else if (WEIGHT_EXT.test(entry.name)) found.push(full);
  }
  return found;
};

const HASH_LIMIT_BYTES = 6 * 1024 * 1024 * 1024;

const hashFile = (file: string): string | null => {
  if (fs.statSync(file).size > HASH_LIMIT_BYTES) return null;
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
};

const weightRecord = (
  role: string,
  installPath: string,
  file: string,
  hashFiles: boolean
): FormalWeightRecord => ({
  role,
  filename: path.basename(file),
  relative_path: path.relative(installPath, file).replace(/\\/g, '/'),
  bytes: fs.statSync(file).size,
  sha256: hashFiles ? hashFile(file) : null,
});

const matchingFiles = (files: string[], pattern: RegExp): string[] => files.filter((file) => pattern.test(file));

export const scanFormalWeights = (installPath: string | null | undefined, hashFiles = false): Record<FormalCapabilityId, FormalWeightRecord[]> => {
  const empty = (): Record<FormalCapabilityId, FormalWeightRecord[]> => ({
    sdxl_ip_adapter: [],
    sdxl_openpose: [],
    sdxl_depth: [],
    sdxl_canny: [],
    krea2_native_reference: [],
    qwen_image_native_reference: [],
  });
  if (!installPath) return empty();
  const result = empty();
  const ipadapter = [
    ...listWeightFiles(path.join(installPath, 'models', 'ipadapter')),
    ...listWeightFiles(path.join(installPath, 'models', 'ip_adapter')),
  ];
  const clip = listWeightFiles(path.join(installPath, 'models', 'clip_vision'));
  const control = listWeightFiles(path.join(installPath, 'models', 'controlnet'));
  const diffusion = listWeightFiles(path.join(installPath, 'models', 'diffusion_models'));
  const ipa = matchingFiles(ipadapter, /sdxl/i);
  const vision = matchingFiles(clip, /clip-vit-h-14|vit-h-14|vit.?h/i);
  if (ipa.length > 0 && vision.length > 0) {
    result.sdxl_ip_adapter = [
      ...ipa.map((file) => weightRecord('ipadapter', installPath, file, hashFiles)),
      ...vision.map((file) => weightRecord('clip_vision', installPath, file, hashFiles)),
    ];
  }
  const pose = matchingFiles(control, /openpose/i).filter((file) => /sdxl|xl/i.test(file));
  const depth = matchingFiles(control, /depth/i).filter((file) => /sdxl|xl/i.test(file));
  const canny = matchingFiles(control, /canny|lineart|softedge/i).filter((file) => /sdxl|xl/i.test(file));
  result.sdxl_openpose = pose.map((file) => weightRecord('openpose', installPath, file, hashFiles));
  result.sdxl_depth = depth.map((file) => weightRecord('depth', installPath, file, hashFiles));
  result.sdxl_canny = canny.map((file) => weightRecord('canny', installPath, file, hashFiles));
  const krea = matchingFiles(diffusion, /krea|redcraft|convrot/i)[0] || null;
  if (krea) result.krea2_native_reference = [weightRecord('diffusion', installPath, krea, hashFiles)];
  const qwen = matchingFiles(diffusion, /qwen[_-]?image/i)[0] || null;
  if (qwen) result.qwen_image_native_reference = [weightRecord('diffusion', installPath, qwen, hashFiles)];
  return result;
};

type Link = [string, number];

const asLink = (value: unknown): Link | null =>
  Array.isArray(value) && value.length >= 2 ? [String(value[0]), Number(value[1] ?? 0)] : null;

const reaches = (workflow: Record<string, any>, link: Link | null, classNames: string[], depth = 0): boolean => {
  if (!link || depth > 8) return false;
  const node = workflow[link[0]];
  if (!node) return false;
  if (classNames.includes(String(node.class_type || ''))) return true;
  for (const value of Object.values(node.inputs || {})) {
    if (reaches(workflow, asLink(value), classNames, depth + 1)) return true;
  }
  return false;
};

const samplerUses = (workflow: Record<string, any>, nodeId: string, port: 'model' | 'positive'): boolean =>
  Object.values(workflow).some((node: any) => {
    if (!String(node?.class_type || '').includes('KSampler')) return false;
    return asLink(node.inputs?.[port])?.[0] === nodeId;
  });

/** Full connection check. One loader node without its consumers is not wired. */
export const inspectFormalWiring = (
  workflow: Record<string, any> | null | undefined,
  poseSource: 'rgb' | 'skeleton' | null
): Record<FormalCapabilityId, boolean> => {
  const result: Record<FormalCapabilityId, boolean> = {
    sdxl_ip_adapter: false,
    sdxl_openpose: false,
    sdxl_depth: false,
    sdxl_canny: false,
    krea2_native_reference: false,
    qwen_image_native_reference: false,
  };
  if (!workflow) return result;
  const qwenEncode = Object.entries(workflow).find(([, node]) => node?.class_type === 'TextEncodeQwenImage21');
  if (qwenEncode) {
    const inputs = qwenEncode[1].inputs || {};
    result.qwen_image_native_reference = Boolean(
      reaches(workflow, asLink(inputs.image_1), ['LoadImage'])
      && reaches(workflow, asLink(inputs.clip), ['CLIPLoader'])
      && reaches(workflow, asLink(inputs.vae), ['VAELoader'])
      && samplerUses(workflow, qwenEncode[0], 'positive')
    );
  }
  const advanced = Object.entries(workflow).find(([, node]) => node?.class_type === 'IPAdapterAdvanced');
  if (advanced) {
    const inputs = advanced[1].inputs || {};
    result.sdxl_ip_adapter = Boolean(
      reaches(workflow, asLink(inputs.image), ['LoadImage'])
      && reaches(workflow, asLink(inputs.clip_vision), ['CLIPVisionLoader'])
      && reaches(workflow, asLink(inputs.ipadapter), ['IPAdapterModelLoader'])
      && asLink(inputs.model)
      && samplerUses(workflow, advanced[0], 'model')
    );
  }
  const controlWired = (preprocessors: string[], requirePreprocessor: boolean) => {
    const apply = Object.entries(workflow).find(([, node]) => node?.class_type === 'ControlNetApplyAdvanced');
    if (!apply) return false;
    const inputs = apply[1].inputs || {};
    const imageOk = requirePreprocessor
      ? reaches(workflow, asLink(inputs.image), preprocessors) && reaches(workflow, asLink(inputs.image), ['LoadImage'])
      : reaches(workflow, asLink(inputs.image), ['LoadImage']);
    return Boolean(
      imageOk
      && reaches(workflow, asLink(inputs.control_net), ['ControlNetLoader'])
      && asLink(inputs.positive)
      && asLink(inputs.negative)
      && samplerUses(workflow, apply[0], 'positive')
    );
  };
  result.sdxl_openpose = controlWired(OPENPOSE_PREPROCESSORS, poseSource !== 'skeleton');
  result.sdxl_depth = controlWired(DEPTH_PREPROCESSORS, true);
  result.sdxl_canny = controlWired(CANNY_PREPROCESSORS, true);
  return result;
};

const shotWorkflow = (shot: FormalShotSample) => ({
  gen_type: 'scene',
  shot_type: shot.shot_type,
  shot_intent: shot.shot_intent,
  subject_scale: shot.subject_scale,
  character_ref_url: shot.character_ref_url,
  shot_spec: {
    shot_type: shot.shot_type,
    shot_intent: shot.shot_intent,
    subject_scale: shot.subject_scale,
    location: shot.location,
    visible_subjects: shot.visible_subjects,
    primary_action: shot.primary_action,
    source: {
      type: 'script',
      script_id: shot.script_id,
      script_scene_id: shot.script_scene_id,
      ...(shot.has_continuity ? { continuity: { reference: true } } : {}),
    },
  },
});

const loadedNodes = (objectInfo: Record<string, any> | null | undefined, required: string[]): { loaded: boolean; missing: string[] } => {
  const names = new Set(Object.keys(objectInfo || {}));
  if (required.length === 0) return { loaded: false, missing: [] };
  const groupStart = required.findIndex((name) => OPENPOSE_PREPROCESSORS.includes(name) || DEPTH_PREPROCESSORS.includes(name) || CANNY_PREPROCESSORS.includes(name));
  const base = groupStart === -1 ? required : required.slice(0, groupStart);
  const choices = groupStart === -1 ? [] : required.slice(groupStart);
  const missing = base.filter((name) => !names.has(name));
  if (choices.length > 0 && !choices.some((name) => names.has(name))) missing.push(choices.join('|'));
  return { loaded: missing.length === 0, missing };
};

const primaryReason = (input: {
  familyMatch: boolean;
  templateOk: boolean;
  installed: boolean;
  runtime: 'offline' | 'online';
  nodesLoaded: boolean;
  shotAllowed: boolean;
  needsReference: boolean;
  hasReference: boolean;
  installProbe: boolean;
}): FormalBlockReason | null => {
  if (!input.familyMatch || !input.templateOk) return 'incompatible';
  if (!input.installed) return 'not_installed';
  if (input.runtime === 'offline') return 'offline';
  if (!input.nodesLoaded) return 'not_installed';
  if (input.installProbe) return null;
  if (input.needsReference && !input.hasReference) return 'missing_reference';
  if (!input.shotAllowed) return 'policy_skipped';
  return null;
};

export const assessFormalShot = (input: FormalAssessmentInput): FormalCapabilityState[] => {
  const model = classifyFormalModel(input.modelName);
  const template = formalTemplateDecision(input.workflowFile);
  const weights = scanFormalWeights(input.installPath, input.hashFiles === true);
  const wiring = inspectFormalWiring(input.workflow, input.shot.pose_source);
  const installProbe = input.shot.id === 'install';
  const identity = shouldAllowCharacterAdapter(shotWorkflow(input.shot), '');
  const people = input.shot.visible_subjects.filter(Boolean);

  return FORMAL_CAPABILITY_IDS.map((id) => {
    const required = capabilityNodes(id);
    const nodes = loadedNodes(input.runtime === 'online' ? input.objectInfo : null, required);
    const familyMatch = model.model_class === familyOf(id);
    const templateOk = template.accepted && (
      (familyOf(id) === 'sdxl' && template.role === 'sdxl_3060')
      || (familyOf(id) === 'krea2' && template.role === 'krea2_12gb')
      || (familyOf(id) === 'qwen_image' && template.role === 'qwen_image_2_1')
    );
    const remoteQwenReady = id === 'qwen_image_native_reference'
      && input.runtime === 'online'
      && Array.isArray(input.objectInfo?.UNETLoader?.input?.required?.unet_name?.[0])
      && input.objectInfo.UNETLoader.input.required.unet_name[0].some((name: unknown) => /qwen[_-]?image/i.test(String(name)));
    const referenceInstalled = id !== 'krea2_native_reference' && (weights[id].length > 0 || remoteQwenReady);
    const shotAllowed = installProbe
      ? false
      : id === 'sdxl_ip_adapter' || id === 'qwen_image_native_reference'
        ? identity.allow
        : id === 'sdxl_openpose'
          ? people.length > 0
          : false;
    const needsReference = shotAllowed && (id === 'sdxl_ip_adapter' || id === 'qwen_image_native_reference' || id === 'sdxl_openpose');
    const hasReference = id === 'sdxl_ip_adapter' || id === 'qwen_image_native_reference'
      ? Boolean(input.shot.character_ref_url)
      : input.shot.pose_source != null;
    const nodesLoaded = id === 'krea2_native_reference' ? false : input.runtime === 'online' && nodes.loaded;
    const wired = templateOk && wiring[id];
    const liveVerified = (input.liveVerifiedIds || []).includes(id);
    const reason = primaryReason({
      familyMatch,
      templateOk,
      installed: referenceInstalled,
      runtime: input.runtime,
      nodesLoaded,
      shotAllowed,
      needsReference,
      hasReference,
      installProbe,
    });
    const chainReady = familyMatch && templateOk && referenceInstalled && nodesLoaded && shotAllowed && hasReference && wired;
    const notes: string[] = [];
    if (id === 'krea2_native_reference') {
      notes.push('redcraft_krea2_12gb.json has no reference conditioning node');
      if (weights[id].length > 0) notes.push(`base diffusion weight is present and is not a reference install: ${weights[id][0]!.filename}`);
    }
    if (!template.accepted) notes.push(`${path.basename(input.workflowFile)} is not a 3060 formal template`);
    if (installProbe) notes.push('install probe does not judge a shot');
    else if (id === 'sdxl_ip_adapter') notes.push(`identity policy ${identity.reason}`);
    if (!wired && reason == null) notes.push('workflow chain is not connected');
    return {
      id,
      installed: referenceInstalled,
      nodes_loaded: nodesLoaded,
      family_match: familyMatch,
      shot_allowed: shotAllowed,
      wired,
      live_verified: liveVerified,
      chain_ready: chainReady,
      reason: chainReady ? null : reason,
      policy_reason: installProbe ? null : id === 'sdxl_ip_adapter' ? identity.reason : id === 'sdxl_openpose' && people.length === 0 ? 'no_person' : null,
      required_nodes: required,
      missing_nodes: input.runtime === 'online' ? nodes.missing : required,
      weights: id === 'krea2_native_reference' ? [] : weights[id],
      notes,
    };
  });
};

export const loadWorkflowTemplate = (workflowFile: string): Record<string, any> | null => {
  const safe = path.basename(workflowFile);
  const full = path.join(__dirname, '../../static/workflows', safe);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
};

/** Install-level view used by the settings probe. It does not claim a shot passed. */
export const assessFormalInstall = (input: Omit<FormalAssessmentInput, 'shot'> & { shot?: FormalShotSample }): {
  model_class: FormalModelClass;
  model_label: string;
  template: ReturnType<typeof formalTemplateDecision>;
  workflow_file: string;
  capabilities: FormalCapabilityState[];
} => {
  const model = classifyFormalModel(input.modelName);
  const placeholder: FormalShotSample = input.shot || {
    id: 'install',
    kind: 'missing_capability',
    production_scene_id: null,
    shot_type: 'Close-up',
    shot_intent: null,
    subject_scale: null,
    location: null,
    visible_subjects: [],
    script_id: null,
    script_scene_id: null,
    script_revision: null,
    has_continuity: false,
    continuity_status: 'legacy',
    active_version: 1,
    character_ref_url: null,
    pose_source: null,
  };
  return {
    model_class: model.model_class,
    model_label: model.label,
    template: formalTemplateDecision(input.workflowFile),
    workflow_file: path.basename(input.workflowFile),
    capabilities: assessFormalShot({ ...input, shot: placeholder, workflow: input.workflow === undefined ? loadWorkflowTemplate(input.workflowFile) : input.workflow }),
  };
};

export const assertIsolatedFormalDatabase = (filename: string): void => {
  const base = path.basename(filename).toLowerCase();
  if (base === 'sql_app.db' || base.includes('sql_app')) {
    throw new Error('Formal storyboard samples must not write the production database');
  }
};

export const formalSampleShotSpec = (sample: FormalShotSample) => ({
  shot_type: sample.shot_type,
  shot_intent: sample.shot_intent,
  subject_scale: sample.subject_scale,
  location: sample.location,
  primary_action: sample.primary_action || '',
  visible_subjects: sample.visible_subjects,
  source: {
    type: 'script',
    script_id: sample.script_id,
    script_scene_id: sample.script_scene_id,
    script_revision: sample.script_revision,
  },
});
