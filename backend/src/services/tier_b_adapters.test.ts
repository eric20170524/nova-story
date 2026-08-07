import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  discoverTierBModels,
  injectTierBAdapters,
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
  const compiled = await compileComfyWorkflow(
    {
      ...ponyWorkflow(),
      character_ref_url: '/static/generated/char_face.png',
      composition_ref_url: '/static/generated/layout.png',
      gen_type: 'scene'
    },
    '1girl, silver hair, sitting on throne, medium shot',
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
