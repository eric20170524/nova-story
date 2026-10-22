import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  discoverTierBModels,
  faceIdFromObjectInfo,
  injectTierBAdapters,
  modelChoicesFromObjectInfo,
  probeTierBCapability,
  type TierBCapability
} from './tier_b_adapters';
import { planReferenceGeneration } from './reference_generation_policy';
import { compileComfyWorkflow } from './generation_service';

const ponyWorkflow = () => ({
  '3': {
    inputs: {
      seed: 1,
      steps: 25,
      cfg: 7,
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0]
    },
    class_type: 'KSampler'
  },
  '4': {
    inputs: { ckpt_name: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors' },
    class_type: 'CheckpointLoaderSimple'
  },
  '5': {
    inputs: { width: 768, height: 1024, batch_size: 1 },
    class_type: 'EmptyLatentImage'
  },
  '6': {
    inputs: { text: 'score_9', clip: ['4', 1] },
    class_type: 'CLIPTextEncode'
  },
  '7': {
    inputs: { text: 'score_4', clip: ['4', 1] },
    class_type: 'CLIPTextEncode'
  },
  '8': {
    inputs: { samples: ['3', 0], vae: ['4', 2] },
    class_type: 'VAEDecode'
  },
  '9': {
    inputs: { filename_prefix: 't', images: ['8', 0] },
    class_type: 'SaveImage'
  }
});

const mockFullCapability = (): TierBCapability => ({
  characterAdapter: true,
  compositionControl: true,
  modelFamilySupported: true,
  characterKind: 'ip_adapter',
  compositionKind: 'openpose',
  models: {
    ipadapter: 'ip-adapter-plus-face_sdxl_vit-h.safetensors',
    clipVision: 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors',
    controlnet: 'OpenPoseXL2.safetensors',
    compositionKind: 'openpose'
  },
  hasIpAdapterNodes: true,
  hasControlNetNodes: true,
  hasOpenPosePreprocessor: false,
  missing: [],
  notes: ['mock full capability']
});

test('discoverTierBModels finds ipadapter/clip/controlnet under install tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-tierb-'));
  try {
    fs.mkdirSync(path.join(root, 'models', 'ipadapter'), { recursive: true });
    fs.mkdirSync(path.join(root, 'models', 'clip_vision'), { recursive: true });
    fs.mkdirSync(path.join(root, 'models', 'controlnet'), { recursive: true });
    fs.writeFileSync(path.join(root, 'models', 'ipadapter', 'ip-adapter-plus_sdxl_vit-h.safetensors'), '');
    fs.writeFileSync(path.join(root, 'models', 'clip_vision', 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors'), '');
    fs.writeFileSync(path.join(root, 'models', 'controlnet', 'controlnet-openpose-sdxl.safetensors'), '');

    const models = discoverTierBModels(root);
    assert.match(models.ipadapter || '', /plus.*sdxl/i);
    assert.match(models.clipVision || '', /ViT-H/i);
    assert.equal(models.compositionKind, 'openpose');
    assert.ok(models.controlnet);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('probeTierBCapability reports missing pieces without throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-tierb-empty-'));
  try {
    fs.mkdirSync(path.join(root, 'models', 'controlnet'), { recursive: true });
    fs.writeFileSync(path.join(root, 'nodes.py'), '# fake comfy\n');
    const cap = probeTierBCapability(root, { objectInfo: {
      ControlNetLoader: {},
      ControlNetApplyAdvanced: {}
    } });
    assert.equal(cap.characterAdapter, false);
    assert.equal(cap.compositionControl, false);
    assert.ok(cap.missing.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing object_info does not assume a Canny preprocessor is installed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-tierb-canny-'));
  try {
    fs.mkdirSync(path.join(root, 'models', 'controlnet'), { recursive: true });
    fs.mkdirSync(path.join(root, 'custom_nodes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'nodes.py'), '# fake comfy\n');
    fs.writeFileSync(path.join(root, 'models', 'controlnet', 'controlnet-canny-sdxl.safetensors'), '');
    const cap = probeTierBCapability(root);
    assert.equal(cap.compositionKind, 'canny');
    assert.equal(cap.hasCannyPreprocessor, false);
    const workflow = ponyWorkflow();
    injectTierBAdapters(workflow, {
      compositionImageFilename: 'edge.png',
      capability: cap,
    });
    const types = Object.values(workflow).map((node: any) => node.class_type);
    assert.equal(types.includes('CannyEdgePreprocessor'), false);
    assert.equal(types.includes('ControlNetLoader'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('injectTierBAdapters wires IP-Adapter Advanced + ControlNet', () => {
  const workflow = ponyWorkflow();
  const result = injectTierBAdapters(workflow, {
    characterImageFilename: 'face.png',
    compositionImageFilename: 'pose.png',
    characterWeight: 0.8,
    compositionStrength: 0.6,
    isFlux: false,
    capability: mockFullCapability()
  });

  assert.equal(result.characterWired, true);
  assert.equal(result.compositionWired, true);

  const types = Object.values(workflow).map((n: any) => n.class_type);
  assert.ok(types.includes('IPAdapterModelLoader'));
  assert.ok(types.includes('CLIPVisionLoader'));
  assert.ok(types.includes('IPAdapterAdvanced'));
  assert.ok(types.includes('ControlNetLoader'));
  assert.ok(types.includes('ControlNetApplyAdvanced'));

  // Sampler model should no longer point at checkpoint directly
  assert.notDeepEqual(workflow['3'].inputs.model, ['4', 0]);
  // Positive should come from ControlNet apply
  assert.notDeepEqual(workflow['3'].inputs.positive, ['6', 0]);
  assert.equal(workflow['3'].inputs.denoise, 1);
});

test('injectTierBAdapters skips FLUX', () => {
  const workflow = ponyWorkflow();
  const result = injectTierBAdapters(workflow, {
    characterImageFilename: 'face.png',
    compositionImageFilename: 'pose.png',
    isFlux: true,
    capability: mockFullCapability()
  });
  assert.equal(result.characterWired, false);
  assert.equal(result.compositionWired, false);
});

test('planReferenceGeneration disables img2img when character adapter on', () => {
  const plan = planReferenceGeneration(
    {
      gen_type: 'turnaround',
      character_ref_url: '/static/generated/a.png',
      composition_ref_url: '/static/generated/b.png'
    },
    '1girl',
    { characterAdapter: true, compositionControl: true, characterKind: 'ip_adapter', compositionKind: 'openpose' }
  );
  assert.equal(plan.tier, 'B');
  assert.equal(plan.useCharacterAdapter, true);
  assert.equal(plan.useCompositionControl, true);
  assert.equal(plan.img2img.useImg2Img, false);
  assert.equal(plan.img2img.reason, 'deferred_to_character_adapter');
});

test('compileComfyWorkflow injects Tier B when capability forced', async () => {
  // Portrait gen_type allows character IP-Adapter; composition_ref still wires ControlNet
  const compiled = await compileComfyWorkflow(
    {
      ...ponyWorkflow(),
      character_ref_url: '/static/generated/char_face.png',
      composition_ref_url: '/static/generated/layout.png',
      gen_type: 'portrait'
    },
    '1girl, silver hair, portrait, close-up face, solo',
    'standard',
    {},
    { advanced: { nsfw_enabled: false }, comfyui: { tier_b: { enabled: true } } },
    mockFullCapability()
  );

  const types = Object.values(compiled).map((n: any) => n.class_type);
  assert.ok(types.includes('IPAdapterAdvanced'), 'IP-Adapter nodes present');
  assert.ok(types.includes('ControlNetApplyAdvanced'), 'ControlNet nodes present');
  // No classic VAEEncode img2img when adapter handles identity
  assert.equal(
    Object.values(compiled).some(
      (n: any) => n.class_type === 'VAEEncode' && n._meta?.title?.includes('Reference')
    ),
    false
  );
});

const choiceNode = (field: string, files: string[]) => ({ input: { required: { [field]: [files] } } });
const faceIdObjectInfo = (opts: { weights?: boolean; lora?: boolean; nodes?: boolean } = {}) => ({
  ...(opts.nodes === false ? {} : {
    IPAdapterUnifiedLoaderFaceID: {},
    IPAdapterFaceID: {},
    IPAdapterInsightFaceLoader: {},
  }),
  IPAdapterModelLoader: choiceNode('ipadapter_file', [
    'ip-adapter-plus_sdxl_vit-h.safetensors',
    ...(opts.weights === false ? [] : ['ip-adapter-faceid-plusv2_sdxl.bin']),
  ]),
  LoraLoader: choiceNode('lora_name', [
    'Pony_DetailV2.0.safetensors',
    ...(opts.lora === false ? [] : ['ip-adapter-faceid-plusv2_sdxl_lora.safetensors']),
  ]),
  CLIPVisionLoader: choiceNode('clip_name', ['CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors']),
  IPAdapterUnifiedLoader: {},
  IPAdapterAdvanced: {},
  IPAdapterModelLoader_: {},
});

test('FaceID needs the nodes, the weights and the LoRA; the node pack alone is not enough', () => {
  const ready = faceIdFromObjectInfo(faceIdObjectInfo());
  assert.equal(ready.available, true);
  assert.match(ready.ipadapter || '', /faceid-plusv2_sdxl\.bin/);
  assert.match(ready.lora || '', /faceid-plusv2_sdxl_lora/);

  // The remote as probed: FaceID nodes installed, no weights, no LoRA.
  const nodesOnly = faceIdFromObjectInfo(faceIdObjectInfo({ weights: false, lora: false }));
  assert.equal(nodesOnly.available, false);
  assert.equal(nodesOnly.missing.length, 2);
  assert.equal(faceIdFromObjectInfo(faceIdObjectInfo({ lora: false })).available, false);
  assert.equal(faceIdFromObjectInfo(faceIdObjectInfo({ weights: false })).available, false);
  assert.equal(faceIdFromObjectInfo(faceIdObjectInfo({ nodes: false })).available, false);
  // Never assumed without a live object_info
  assert.equal(faceIdFromObjectInfo(null).available, false);
});

test('a FaceID weight file is never picked as the plain IP-Adapter model', () => {
  const both = modelChoicesFromObjectInfo({
    IPAdapterModelLoader: choiceNode('ipadapter_file', ['ip-adapter-faceid-plusv2_sdxl.bin', 'ip-adapter-plus_sdxl_vit-h.safetensors']),
  });
  assert.equal(both.ipadapter, 'ip-adapter-plus_sdxl_vit-h.safetensors');
  const onlyFaceId = modelChoicesFromObjectInfo({
    IPAdapterModelLoader: choiceNode('ipadapter_file', ['ip-adapter-faceid-plusv2_sdxl.bin']),
  });
  assert.equal(onlyFaceId.ipadapter, null);
});

test('probeTierBCapability exposes FaceID readiness from a live object_info', () => {
  const ready = probeTierBCapability(null, { objectInfo: faceIdObjectInfo() });
  assert.equal(ready.characterAdapter, true);
  assert.equal(ready.models.ipadapter, 'ip-adapter-plus_sdxl_vit-h.safetensors');
  assert.equal(ready.faceId?.available, true);
  const nodesOnly = probeTierBCapability(null, { objectInfo: faceIdObjectInfo({ weights: false, lora: false }) });
  assert.equal(nodesOnly.faceId?.available, false);
  assert.ok(nodesOnly.notes.some((note) => /FaceID Plus V2 unavailable/.test(note)));
});

test('preferFaceId wires FaceID Plus V2 after the existing LoRA chain and not plain IP-Adapter', () => {
  const workflow: any = ponyWorkflow();
  workflow['3'].inputs.model = ['20', 0]; // model already patched by an earlier LoRA
  const cap = { ...mockFullCapability(), faceId: { available: true, ipadapter: 'ip-adapter-faceid-plusv2_sdxl.bin', lora: 'ip-adapter-faceid-plusv2_sdxl_lora.safetensors', missing: [] } };
  const result = injectTierBAdapters(workflow, {
    characterImageFilename: 'face.png',
    preferFaceId: true,
    faceIdWeight: 0.9,
    isFlux: false,
    capability: cap,
  });
  assert.equal(result.characterWired, true);
  const entries = Object.entries(workflow) as Array<[string, any]>;
  const loader = entries.find(([, n]) => n.class_type === 'IPAdapterUnifiedLoaderFaceID')!;
  const apply = entries.find(([, n]) => n.class_type === 'IPAdapterFaceID')!;
  assert.deepEqual(loader[1].inputs.model, ['20', 0]);
  assert.equal(loader[1].inputs.preset, 'FACEID PLUS V2');
  assert.deepEqual(apply[1].inputs.ipadapter, [loader[0], 1]);
  assert.equal(apply[1].inputs.weight, 0.9);
  assert.deepEqual(workflow['3'].inputs.model, [apply[0], 0]);
  const types = entries.map(([, n]) => n.class_type);
  assert.equal(types.includes('IPAdapterAdvanced'), false);
  assert.equal(types.includes('IPAdapterModelLoader'), false);
  assert.ok(result.notes.some((note) => /FaceID Plus V2 wired/.test(note)));
});

test('preferFaceId falls back to plain IP-Adapter when the install has no FaceID weights', () => {
  for (const faceId of [undefined, { available: false, ipadapter: null, lora: null, missing: ['weights'] }]) {
    const workflow: any = ponyWorkflow();
    const result = injectTierBAdapters(workflow, {
      characterImageFilename: 'face.png',
      preferFaceId: true,
      isFlux: false,
      capability: { ...mockFullCapability(), faceId },
    });
    assert.equal(result.characterWired, true);
    const types = Object.values(workflow).map((n: any) => n.class_type);
    assert.ok(types.includes('IPAdapterAdvanced'));
    assert.equal(types.includes('IPAdapterFaceID'), false);
  }
});

test('FaceID is opt-in: scene shots keep plain IP-Adapter even when FaceID is installed', () => {
  const workflow: any = ponyWorkflow();
  injectTierBAdapters(workflow, {
    characterImageFilename: 'face.png',
    isFlux: false,
    capability: { ...mockFullCapability(), faceId: { available: true, ipadapter: 'a.bin', lora: 'b.safetensors', missing: [] } },
  });
  const types = Object.values(workflow).map((n: any) => n.class_type);
  assert.ok(types.includes('IPAdapterAdvanced'));
  assert.equal(types.includes('IPAdapterFaceID'), false);
});

test('compileComfyWorkflow forwards prefer_faceid_adapter to the injector', async () => {
  const cap = { ...mockFullCapability(), faceId: { available: true, ipadapter: 'ip-adapter-faceid-plusv2_sdxl.bin', lora: 'ip-adapter-faceid-plusv2_sdxl_lora.safetensors', missing: [] } };
  const compiled = await compileComfyWorkflow(
    {
      ...ponyWorkflow(),
      character_ref_url: '/static/generated/char_face.png',
      gen_type: 'portrait',
      prefer_faceid_adapter: true,
      faceid_weight: 0.7,
    },
    '1girl, silver hair, portrait, close-up face, solo',
    'standard',
    {},
    { advanced: { nsfw_enabled: false }, comfyui: { tier_b: { enabled: true } } },
    cap
  );
  const apply: any = Object.values(compiled).find((n: any) => n.class_type === 'IPAdapterFaceID');
  assert.ok(apply, 'FaceID apply node present');
  assert.equal(apply.inputs.weight, 0.7);
});

test('probeTierBCapability enables characterAdapter when only FaceID Plus V2 is installed remotely', () => {
  const cap = probeTierBCapability(null, {
    objectInfo: {
      IPAdapterUnifiedLoaderFaceID: {},
      IPAdapterFaceID: {},
      IPAdapterModelLoader: {
        input: { required: { ipadapter_file: [['ip-adapter-faceid-plusv2_sdxl.bin']] } }
      },
      LoraLoader: {
        input: { required: { lora_name: [['ip-adapter-faceid-plusv2_sdxl_lora.safetensors']] } }
      }
    }
  });
  assert.equal(cap.faceId?.available, true);
  assert.equal(cap.characterAdapter, true);
  const wf: any = ponyWorkflow();
  const wired = injectTierBAdapters(wf, {
    characterImageFilename: 'face.png',
    preferFaceId: true,
    capability: cap
  });
  assert.equal(wired.characterWired, true);
  assert.ok(Object.values(wf).some((n: any) => n.class_type === 'IPAdapterFaceID'));
});
