import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GeminiProvider } from './ai/gemini_provider';
import { Prompts } from './prompts';
import {
  compileComfyWorkflow,
  mergeSceneGenerationContext,
  selectSceneCharacterAppearance,
  shouldSuppressAppearanceForDetailShot
} from './generation_service';

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
  assert.match(safeWorkflow["6"].inputs.text, /Hero opens a door[\s\S]*score_9/);
  assert.doesNotMatch(safeWorkflow["6"].inputs.text, /^score_9\b/);
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

test('real pony template keeps cinematic shot and places action before quality', async () => {
  const workflow = {
    ...ponyWorkflow(),
    '6': {
      ...ponyWorkflow()['6'],
      inputs: {
        text: 'score_9, score_8_up, score_7_up, source_anime, cinematic shot',
        clip: ['4', 1],
      },
    },
    gen_type: 'scene',
    subject_type: 'nonhuman',
    shot_type: 'Insert Shot',
    shot_intent: 'insert',
  };
  const compiled = await compileComfyWorkflow(
    workflow,
    'paw presses music-note button on miniature park map',
    'standard',
    {},
    { advanced: { nsfw_enabled: false }, comfyui: {} }
  );
  const text = String(compiled['6'].inputs.text);
  const actionIdx = text.indexOf('paw presses music-note button');
  const cinematicIdx = text.indexOf('cinematic shot');
  const scoreIdx = text.indexOf('score_9');
  assert.ok(actionIdx >= 0 && actionIdx < scoreIdx);
  assert.ok(cinematicIdx >= 0);
  assert.equal((text.match(/\bscore_9\b/g) || []).length, 1);
  assert.equal((text.match(/\bsource_anime\b/g) || []).length, 1);
  assert.doesNotMatch(text, /environment-dominant cinematic composition/i);
});

test('compiles the failed animal wide-shot case as landscape without female tags', async () => {
  const compiled = await compileComfyWorkflow(
    {
      ...ponyWorkflow(),
      gen_type: 'scene',
      subject_type: 'nonhuman',
      shot_type: 'Wide Shot',
      style_preset: 'xianxia_immortal',
      output_spec: { aspect_ratio: 'auto', orientation_policy: 'auto_by_shot' }
    },
    'The animal walks along the welcome plaza, its paws on the marble floor.',
    'standard',
    {},
    { advanced: { nsfw_enabled: false }, comfyui: {} }
  );

  assert.equal(compiled['5'].inputs.width, 1024);
  assert.equal(compiled['5'].inputs.height, 768);
  assert.match(compiled['6'].inputs.text, /environment-dominant cinematic composition/i);
  assert.match(compiled['6'].inputs.text, /clearly visible small subject|15 to 20 percent/i);
  assert.match(compiled['7'].inputs.text, /close-up|face filling frame|oversized subject/i);
  assert.doesNotMatch(compiled['6'].inputs.text, /beautiful East Asian woman|chinese beauty|\bfemale\b/i);
  assert.doesNotMatch(compiled['7'].inputs.text, /western face|\bmale\b|\bman\b|\bboy\b/i);
});

test('compiles overhead story scenes as landscape and narrative close-ups with context guards', async () => {
  const overhead = await compileComfyWorkflow(
    {
      ...ponyWorkflow(),
      gen_type: 'scene',
      subject_type: 'nonhuman',
      shot_type: 'Overhead Shot',
      output_spec: { aspect_ratio: 'auto', orientation_policy: 'auto_by_shot' }
    },
    'A tiny furry creature crosses the plaza toward a dark corridor.',
    'standard',
    {},
    { advanced: { nsfw_enabled: false }, comfyui: {} }
  );
  assert.equal(overhead['5'].inputs.width, 1024);
  assert.equal(overhead['5'].inputs.height, 768);
  assert.match(overhead['6'].inputs.text, /environment-dominant|animal far away/i);

  const closeup = await compileComfyWorkflow(
    {
      ...ponyWorkflow(),
      gen_type: 'scene',
      subject_type: 'nonhuman',
      shot_type: 'Close-Up'
    },
    'A furry creature sniffs beside a blue soda machine.',
    'standard',
    {},
    { advanced: { nsfw_enabled: false }, comfyui: {} }
  );
  assert.match(closeup['6'].inputs.text, /contextual narrative close-up|story location/i);
  assert.match(closeup['7'].inputs.text, /front-facing studio portrait|isolated character/i);
});

test('restores the sole nonhuman character for generic animal scene prompts', () => {
  const result = selectSceneCharacterAppearance(
    [{
      name: '主角小兽',
      description: '一只警惕的毛茸小兽',
      visual_tags: JSON.stringify({
        base_model: {
          tags: {
            hair: 'short fluffy light beige and white fur',
            face_features: 'cute muzzle, soft whiskers',
            build: 'small agile furry animal, cute paws'
          }
        }
      })
    }],
    'The animal leans over a wooden ticket booth and peers inside.',
    { shotType: 'Medium Shot', chapterId: 'chapter-1' }
  );

  assert.equal(result.subjectType, 'nonhuman');
  assert.equal(result.snippets.length, 1);
  assert.match(result.snippets[0] || '', /light beige|whiskers|furry animal/i);
});

test('restores scene negative prompt for compact direct generation requests', () => {
  const merged = mergeSceneGenerationContext(
    { model_type: 'pony', style_preset: 'standard' },
    {
      visual_prompt: 'one small animal in a carnival corridor',
      negative_prompt: 'two animals, duplicate animal, city street',
      shot_type: 'Wide Shot',
      camera_movement: 'Static',
      camera_angle: 'Eye-level'
    }
  );

  assert.equal(merged.prompt, 'one small animal in a carnival corridor');
  assert.equal(merged.negative_prompt, 'two animals, duplicate animal, city street');
  assert.equal(merged.shot_type, 'Wide Shot');
});

test('explicit request prompt fields override restored scene prompt fields', () => {
  const merged = mergeSceneGenerationContext(
    { prompt: 'request prompt', negative_prompt: 'request negative' },
    { visual_prompt: 'database prompt', negative_prompt: 'database negative' }
  );

  assert.equal(merged.prompt, 'request prompt');
  assert.equal(merged.negative_prompt, 'request negative');
});

test('mergeSceneGenerationContext restores shot_spec.shot_intent from the database', () => {
  const merged = mergeSceneGenerationContext(
    { model_type: 'pony', shot_type: 'Wide Shot' },
    {
      visual_prompt: 'paw presses music-note button on miniature park map',
      shot_type: 'Wide Shot',
      shot_spec: JSON.stringify({
        shot_intent: 'insert',
        location: 'arcade corridor',
        primary_action: 'paw presses music-note button',
      }),
    }
  );
  assert.equal(merged.shot_intent, 'insert');
  assert.equal(merged.shot_spec?.shot_intent, 'insert');
});

test('DB shot_spec insert intent drives enhancement even when shot_type looks wide', async () => {
  const context = mergeSceneGenerationContext(
    {
      ...ponyWorkflow(),
      gen_type: 'scene',
      subject_type: 'nonhuman',
      shot_type: 'Wide Shot',
    },
    {
      visual_prompt: 'paw presses music-note button on miniature park map',
      shot_type: 'Wide Shot',
      shot_spec: JSON.stringify({ shot_intent: 'insert' }),
    }
  );
  const compiled = await compileComfyWorkflow(
    context,
    context.prompt,
    'standard',
    {},
    { advanced: { nsfw_enabled: false }, comfyui: {} }
  );
  const text = String(compiled['6'].inputs.text);
  assert.match(text, /narrative insert shot/i);
  assert.doesNotMatch(text, /environment-dominant cinematic composition/i);
});

test('wide-shot appearance snippets omit face details and empty placeholder tags', () => {
  const result = selectSceneCharacterAppearance(
    [{
      name: '主角小兽',
      description: '一只警惕的毛茸小兽',
      visual_tags: JSON.stringify({
        base_model: {
          tags: {
            hair: 'short fluffy light beige and white fur, pointed animal ears',
            eyes: 'large glowing amber eyes',
            face_features: 'cute muzzle, soft whiskers',
            build: 'small agile furry animal, cute paws',
            clothing: 'none, soft natural fur',
            accessories: 'none'
          }
        }
      })
    }],
    'The creature appears as a tiny silhouette below a silent ferris wheel.',
    { shotType: 'Wide Shot', chapterId: 'chapter-1' }
  );

  assert.equal(result.subjectType, 'nonhuman');
  assert.match(result.snippets[0] || '', /light beige|pointed animal ears|small agile furry animal/i);
  assert.doesNotMatch(result.snippets[0] || '', /glowing amber eyes|cute muzzle|whiskers|\bnone\b/i);
});

test('detail and insert shots suppress full character appearance for prop/body-part clues', () => {
  assert.equal(
    shouldSuppressAppearanceForDetailShot(
      'Insert Shot',
      'One padded paw touches a frozen light patch on the marble tile.'
    ),
    true
  );
  assert.equal(
    shouldSuppressAppearanceForDetailShot('Medium Shot', 'The animal touches a ticket booth.'),
    false
  );
});

test('keeps mixed human and animal scenes distinct from pure nonhuman scenes', () => {
  const result = selectSceneCharacterAppearance(
    [
      {
        id: 1,
        name: 'Mira',
        description: 'adult woman, red coat',
        visual_tags: JSON.stringify({ aliases: ['the guide'] })
      },
      {
        id: 2,
        name: 'Pip',
        description: 'small fox, orange fur, white muzzle',
        visual_tags: JSON.stringify({ aliases: ['the fox'], species: 'fox' })
      }
    ],
    'Mira kneels beside Pip in the wide plaza',
    { shotType: 'Wide Shot' }
  );

  assert.equal(result.subjectType, 'mixed');
  assert.equal(result.snippets.length, 2);
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
  assert.match(nsfwPrompt, /compilePonyPrompt|Shot Contract/i);
  assert.match(nsfwPrompt, /Do NOT write a Detailed English scene description/i);

  const sfwPrompt = Prompts.generateTimeline('spring tide chapter', '', false);
  assert.match(sfwPrompt, /SFW|family-safe/i);
  assert.match(sfwPrompt, /no nudity/i);
  assert.match(sfwPrompt, /compilePonyPrompt|Shot Contract/i);
  assert.match(sfwPrompt, /Never write a Detailed English scene description/i);
  assert.match(sfwPrompt, /visual_prompt": ""/);
  assert.doesNotMatch(sfwPrompt, /visual_prompt MUST be detailed English/i);
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
