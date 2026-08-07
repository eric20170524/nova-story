import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GeminiProvider } from './ai/gemini_provider';
import { Prompts } from './prompts';
import { compileComfyWorkflow } from './generation_service';

const ponyWorkflow = () => ({
  "3": {
    inputs: {
      seed: 1,
      steps: 20,
      cfg: 7,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0]
    },
    class_type: "KSampler"
  },
  "4": {
    inputs: { ckpt_name: "pony.safetensors" },
    class_type: "CheckpointLoaderSimple"
  },
  "5": {
    inputs: { width: 512, height: 512, batch_size: 1 },
    class_type: "EmptyLatentImage"
  },
  "6": {
    inputs: { text: "score_9", clip: ["4", 1] },
    class_type: "CLIPTextEncode",
    _meta: { title: "Positive" }
  },
  "7": {
    inputs: { text: "low quality", clip: ["4", 1] },
    class_type: "CLIPTextEncode",
    _meta: { title: "Negative" }
  }
});

const fluxWorkflow = () => ({
  "1": {
    inputs: { unet_name: "flux1-dev.gguf" },
    class_type: "UnetLoaderGGUF"
  },
  "2": {
    inputs: { clip_name1: "t5.safetensors", clip_name2: "clip_l.safetensors" },
    class_type: "DualCLIPLoader"
  },
  "4": {
    inputs: { width: 512, height: 512, batch_size: 1 },
    class_type: "EmptyLatentImage"
  },
  "5": {
    inputs: { text: "template", clip: ["2", 0] },
    class_type: "CLIPTextEncode"
  },
  "6": {
    inputs: {
      seed: 1,
      model: ["1", 0],
      positive: ["5", 0],
      negative: ["5", 0],
      latent_image: ["4", 0]
    },
    class_type: "KSampler"
  }
});

test('compiles prompts, safety defaults, dimensions, and actual LoRA wiring', async () => {
  const safeWorkflow = await compileComfyWorkflow(
    ponyWorkflow(),
    'Hero opens a door',
    'cinematic_grid',
    { steps: 30, cfg: 6 },
    { advanced: { nsfw_enabled: false }, comfyui: {} }
  );
  assert.match(safeWorkflow["6"].inputs.text, /score_9, Hero opens a door/);
  assert.match(safeWorkflow["7"].inputs.text, /nsfw/);
  assert.equal(safeWorkflow["3"].inputs.steps, 30);
  assert.equal(safeWorkflow["5"].inputs.width, 1024);

  const loraWorkflow = await compileComfyWorkflow(
    ponyWorkflow(),
    'Hero opens a door',
    'standard',
    {},
    {
      advanced: {
        nsfw_enabled: true,
        pony_nsfw_lora: 'detail.safetensors',
        nsfw_lora_strength: 0.75
      },
      comfyui: {}
    }
  );
  const loraEntry = Object.entries(loraWorkflow).find(
    ([, node]: [string, any]) => node.class_type === 'LoraLoader'
  );
  assert.ok(loraEntry);
  assert.equal((loraEntry![1] as any).inputs.lora_name, 'detail.safetensors');
  assert.deepEqual(loraWorkflow["3"].inputs.model, [loraEntry![0], 0]);
  assert.doesNotMatch(loraWorkflow["7"].inputs.text, /explicit sexual content/);
});

test('builds the deterministic nine-panel image prompt without negative suffixes', () => {
  const prompt = Prompts.buildCinematicGridImagePrompt(
    'Hero in a snowy fortress --no cars, text'
  );
  assert.match(prompt, /exactly 3 rows and exactly 3 columns/);
  assert.match(prompt, /Panel 9 bottom-right/);
  assert.doesNotMatch(prompt, /cars, text/);
});

test('skips a configured local LoRA when the file is not installed', async () => {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-comfy-missing-lora-'));
  fs.mkdirSync(path.join(installPath, 'models', 'loras'), { recursive: true });

  try {
    const compiled = await compileComfyWorkflow(
      ponyWorkflow(),
      'Hero opens a door',
      'standard',
      {},
      {
        advanced: {
          nsfw_enabled: true,
          pony_nsfw_lora: 'missing.safetensors',
          nsfw_lora_strength: 0.75
        },
        comfyui: { install_path: installPath }
      }
    );
    assert.equal(
      Object.values(compiled).some((node: any) => node.class_type === 'LoraLoader'),
      false
    );
    assert.deepEqual(compiled["3"].inputs.model, ["4", 0]);
  } finally {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
});

test('preserves main FLUX prompt enhancement and discovers a local style LoRA', async () => {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-comfy-'));
  const loraDirectory = path.join(installPath, 'models', 'loras');
  fs.mkdirSync(loraDirectory, { recursive: true });
  fs.writeFileSync(path.join(loraDirectory, 'flux_asian_style.safetensors'), '');

  try {
    const compiled = await compileComfyWorkflow(
      fluxWorkflow(),
      'A swordswoman in a mountain temple',
      'standard',
      {},
      {
        advanced: { nsfw_enabled: false },
        comfyui: { install_path: installPath, flux_lora_strength: 0.65 }
      }
    );
    assert.match(compiled["5"].inputs.text, /East Asian/i);
    const loraEntry = Object.entries(compiled).find(
      ([, node]: [string, any]) => node.inputs?.lora_name === 'flux_asian_style.safetensors'
    );
    assert.ok(loraEntry);
    assert.equal((loraEntry![1] as any).inputs.strength_model, 0.65);
    assert.deepEqual(compiled["6"].inputs.model, [loraEntry![0], 0]);
    // FLUX default CFG is lower when client does not override
    assert.equal(compiled["6"].inputs.cfg, 3.5);
  } finally {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
});

test('NSFW ON stacks style + adult LoRAs for non-guofeng styles', async () => {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-comfy-nsfw-stack-'));
  const loraDirectory = path.join(installPath, 'models', 'loras');
  fs.mkdirSync(loraDirectory, { recursive: true });
  fs.writeFileSync(path.join(loraDirectory, 'Pony_DetailV2.0.safetensors'), '');
  fs.writeFileSync(path.join(loraDirectory, 'Incase_Style_PonyXL.safetensors'), '');

  try {
    const compiled = await compileComfyWorkflow(
      {
        ...ponyWorkflow(),
        style_preset: 'anime'
      },
      '1girl, cyberpunk night city',
      'standard',
      {},
      {
        advanced: {
          nsfw_enabled: true,
          pony_nsfw_lora: 'Incase_Style_PonyXL.safetensors',
          nsfw_lora_strength: 0.55
        },
        comfyui: {
          install_path: installPath,
          pony_lora: 'Pony_DetailV2.0.safetensors',
          pony_lora_strength: 0.65
        }
      }
    );

    const loraNodes = Object.values(compiled).filter(
      (node: any) => node.class_type === 'LoraLoader'
    ) as any[];
    assert.equal(loraNodes.length, 2);
    const names = loraNodes.map((n) => n.inputs.lora_name).sort();
    assert.deepEqual(names, ['Incase_Style_PonyXL.safetensors', 'Pony_DetailV2.0.safetensors'].sort());
    assert.match(compiled["6"].inputs.text, /rating_/);
    assert.doesNotMatch(compiled["7"].inputs.text, /explicit sexual content/);
  } finally {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
});

test('guofeng/xianxia styles skip Incase LoRA to protect East Asian faces', async () => {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-comfy-guofeng-'));
  const loraDirectory = path.join(installPath, 'models', 'loras');
  fs.mkdirSync(loraDirectory, { recursive: true });
  fs.writeFileSync(path.join(loraDirectory, 'Pony_DetailV2.0.safetensors'), '');
  fs.writeFileSync(path.join(loraDirectory, 'Incase_Style_PonyXL.safetensors'), '');

  try {
    const compiled = await compileComfyWorkflow(
      { ...ponyWorkflow(), style_preset: 'sensual_gufeng' },
      '1girl, Lu Jiajing on jade stairs, moon-white dress',
      'standard',
      {},
      {
        advanced: {
          nsfw_enabled: true,
          pony_nsfw_lora: 'Incase_Style_PonyXL.safetensors',
          nsfw_lora_strength: 0.55
        },
        comfyui: {
          install_path: installPath,
          pony_lora: 'Pony_DetailV2.0.safetensors',
          pony_lora_strength: 0.65
        }
      }
    );
    const loraNames = Object.values(compiled)
      .filter((node: any) => node.class_type === 'LoraLoader')
      .map((n: any) => n.inputs.lora_name);
    assert.deepEqual(loraNames, ['Pony_DetailV2.0.safetensors']);
    assert.match(compiled['6'].inputs.text, /East Asian|chinese beauty/i);
    assert.match(compiled['7'].inputs.text, /western face|male/i);
  } finally {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
});

test('wires real img2img path when ref_image_url is set for turnaround', async () => {
  const compiled = await compileComfyWorkflow(
    {
      ...ponyWorkflow(),
      ref_image_url: '/static/generated/avatar_test.png',
      gen_type: 'turnaround',
      denoise: 0.55
    },
    '1girl, turnaround sheet, same face',
    'standard',
    {},
    { advanced: { nsfw_enabled: false }, comfyui: {} }
  );

  const loadNode = Object.values(compiled).find(
    (n: any) => n.class_type === 'LoadImage' && n.inputs?.image === 'avatar_test.png'
  );
  const encodeNode = Object.values(compiled).find((n: any) => n.class_type === 'VAEEncode');
  const scaleNode = Object.values(compiled).find((n: any) => n.class_type === 'ImageScale');
  assert.ok(loadNode, 'LoadImage for reference');
  assert.ok(encodeNode, 'VAEEncode for img2img');
  assert.ok(scaleNode, 'ImageScale for target resolution');
  assert.equal(compiled['3'].inputs.denoise, 0.55);
  assert.deepEqual(compiled['3'].inputs.latent_image[1], 0);
});

test('skips img2img for multi-person story scenes even if ref is passed', async () => {
  const compiled = await compileComfyWorkflow(
    {
      ...ponyWorkflow(),
      ref_image_url: '/static/generated/avatar_test.png',
      gen_type: 'scene',
      denoise: 0.65
    },
    '2girls, yuri, embracing on silk couch, story moment',
    'standard',
    {},
    { advanced: { nsfw_enabled: true }, comfyui: {} }
  );
  assert.equal(
    Object.values(compiled).some((n: any) => n.class_type === 'VAEEncode'),
    false
  );
  assert.equal(compiled['3'].inputs.denoise, 1);
});

test('character_ref_url drives img2img for turnaround (Tier A dual-field API)', async () => {
  const compiled = await compileComfyWorkflow(
    {
      ...ponyWorkflow(),
      character_ref_url: '/static/generated/char_face.png',
      composition_ref_url: '/static/generated/pose_sheet.png',
      gen_type: 'turnaround',
      denoise: 0.55
    },
    '1girl, turnaround sheet',
    'standard',
    {},
    { advanced: { nsfw_enabled: false }, comfyui: {} }
  );
  const loadNode = Object.values(compiled).find(
    (n: any) => n.class_type === 'LoadImage' && n.inputs?.image === 'char_face.png'
  );
  assert.ok(loadNode, 'LoadImage uses character_ref filename');
  assert.equal(compiled['3'].inputs.denoise, 0.55);
});

test('timeline prompt policy mentions NSFW or SFW rules', () => {
  const nsfwPrompt = Prompts.generateTimeline('spring tide chapter', '', true);
  assert.match(nsfwPrompt, /NSFW mode ENABLED/i);
  assert.match(nsfwPrompt, /1girl|2girls|3girls/i);

  const sfwPrompt = Prompts.generateTimeline('spring tide chapter', '', false);
  assert.match(sfwPrompt, /SFW|family-safe/i);
  assert.match(sfwPrompt, /no nudity/i);
});

test('decodes real Gemini inline image responses instead of returning a placeholder', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            inlineData: {
              mimeType: 'image/png',
              data: Buffer.from('image-bytes').toString('base64')
            }
          }]
        }
      }]
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );

  try {
    const result = await new GeminiProvider('test-key').generateImage('A hero');
    assert.equal(result.data?.toString(), 'image-bytes');
    assert.equal(result.url, undefined);
    assert.equal(result.error, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
