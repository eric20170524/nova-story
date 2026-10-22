import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAppearanceBase,
  canonicalTurnaroundPrompt,
  mergeTurnaroundAssets,
  parseTurnaroundViews,
  buildFaceLockCanvas,
  buildTurnaroundViewPrompt,
  buildTurnaroundPanelWorkflowData,
  normalizeAndAlignTurnaroundPanel,
  stitchTurnaroundSheet,
  shouldUseTurnaroundComposite,
  TURNAROUND_VIEWS
} from './turnaround_composite';
import { compileComfyWorkflow } from './generation_service';
import sharp from 'sharp';

test('extractAppearanceBase strips multi-view sheet jargon', () => {
  const raw =
    'score_9, character turnaround sheet, multi-view layout, front view, side view, back view, 1girl, long black hair, moon-white dress';
  const cleaned = extractAppearanceBase(raw);
  assert.doesNotMatch(cleaned, /turnaround sheet/i);
  assert.doesNotMatch(cleaned, /multi-view/i);
  assert.match(cleaned, /long black hair/);
  assert.match(cleaned, /moon-white dress/);
});

test('turnaround prompt keeps clothing state and removes scene mood', () => {
  const cleaned = extractAppearanceBase(
    'long black hair, ice-blue eyes, melting expression, half-open inner robe, moon-white xianxia dress, enchanted mirror'
  );
  assert.match(cleaned, /long black hair/);
  assert.match(cleaned, /moon-white xianxia dress/);
  assert.match(cleaned, /half-open inner robe/);
  assert.doesNotMatch(cleaned, /melting/i);
  assert.match(cleaned, /enchanted mirror/);
  const side = buildTurnaroundViewPrompt(cleaned, TURNAROUND_VIEWS[1]!, 'pony');
  assert.match(side.prompt, /half-open inner robe/);
  assert.match(side.prompt, /neutral expression|A-pose/i);
  assert.match(side.prompt, /90 degree left side profile/i);
  assert.doesNotMatch(side.prompt, /1girl|fully fastened|fully clothed/i);
  assert.doesNotMatch(side.prompt, /character reference sheet|character design sheet panel/i);
});

test('canonical turnaround drops scene wardrobe and a variant keeps its own clothing', () => {
  const prompt = 'long black hair, half-open inner robe, moon-white xianxia dress';
  const canonical = canonicalTurnaroundPrompt(prompt);
  assert.match(canonical, /moon-white xianxia dress/);
  assert.doesNotMatch(canonical, /half-open/);
  const variant = canonicalTurnaroundPrompt(prompt, 'inner robe lowered to the waist');
  assert.match(variant, /lowered to the waist/);
  assert.doesNotMatch(variant, /half-open/);
  assert.match(extractAppearanceBase(prompt), /half-open inner robe/);
});

test('a side-only regen keeps the stored front plate and a variant stays off the canonical urls', () => {
  assert.deepEqual(parseTurnaroundViews({}), ['front', 'side', 'back']);
  assert.deepEqual(parseTurnaroundViews({ turnaround_views: 'all' }), ['front', 'side', 'back']);
  assert.deepEqual(parseTurnaroundViews({ turnaround_views: ['side'] }), ['side']);
  assert.throws(() => parseTurnaroundViews({ turnaround_views: ['top'] }), /只能指定/);
  assert.throws(() => parseTurnaroundViews({ turnaround_views: [] }), /必须指定/);

  const tags = { assets: { avatar_url: '/face.png', turnaround_front_url: '/front.png', turnaround_url: '/sheet.png' } };
  const sideOnly = mergeTurnaroundAssets(tags, { side: '/side.png' }, '/sheet2.png');
  assert.equal(sideOnly.assets.turnaround_front_url, '/front.png');
  assert.equal(sideOnly.assets.turnaround_side_url, '/side.png');
  assert.equal(sideOnly.assets.turnaround_url, '/sheet2.png');
  assert.equal(sideOnly.assets.avatar_url, '/face.png');

  const variant = mergeTurnaroundAssets(
    tags,
    { front: '/vfront.png', side: '/vside.png', back: '/vback.png' },
    '/vsheet.png',
    { wardrobeVariant: 'inner robe lowered to the waist' },
  );
  assert.equal(variant.assets.turnaround_front_url, '/front.png');
  assert.equal(variant.assets.turnaround_url, '/sheet.png');
  assert.equal(variant.assets.turnaround_variants['inner robe lowered to the waist'].front_url, '/vfront.png');
  assert.equal(variant.assets.turnaround_variants['inner robe lowered to the waist'].sheet_url, '/vsheet.png');
});

test('front panel is txt2img; side and back img2img from the front plate', () => {
  const base = {
    model_type: 'pony',
    nsfw_enabled: true,
    project_settings: { default_workflow_id: 7 },
    reference_tier: 'A',
    character_ref_url: '/static/generated/portrait.png',
    turnaround_front_adapter: true,
    character_adapter_weight: 0.75
  };
  const front = buildTurnaroundPanelWorkflowData(
    base,
    TURNAROUND_VIEWS[0]!,
    'prompt',
    'negative',
    null
  );
  assert.equal(front.character_ref_url, undefined);
  assert.equal(front.ref_image_url, undefined);
  assert.equal(front.turnaround_from_front, false);
  assert.equal(front.denoise, 1);
  assert.equal(front.force_no_character_adapter, true);
  assert.equal(front.nsfw_enabled, true);
  assert.deepEqual(front.project_settings, { default_workflow_id: 7 });

  const side = buildTurnaroundPanelWorkflowData(
    base,
    TURNAROUND_VIEWS[1]!,
    'prompt',
    'negative',
    '/static/generated/front.png'
  );
  assert.equal(side.character_ref_url, '/static/generated/front.png');
  assert.equal(side.ref_image_url, '/static/generated/front.png');
  assert.equal(side.turnaround_from_front, true);
  assert.equal(side.denoise, 0.88);
  assert.equal(side.force_no_character_adapter, true);
  assert.equal(side.reference_tier, 'A');

  const backWithoutPlate = buildTurnaroundPanelWorkflowData(
    base,
    TURNAROUND_VIEWS[2]!,
    'prompt',
    'negative',
    null
  );
  assert.equal(backWithoutPlate.character_ref_url, undefined);
  assert.equal(backWithoutPlate.turnaround_from_front, false);
  assert.equal(backWithoutPlate.denoise, 1);

  const locked = buildTurnaroundPanelWorkflowData(
    base,
    TURNAROUND_VIEWS[0]!,
    'prompt',
    'negative',
    null,
    '/static/generated/face-lock.png'
  );
  assert.equal(locked.turnaround_face_lock, true);
  assert.equal(locked.character_ref_url, '/static/generated/face-lock.png');
  assert.equal(locked.denoise, 1);
  assert.equal(locked.turnaround_from_front, false);
});

test('face lock canvas keeps an opaque face and a transparent body', async () => {
  const portrait = await sharp({
    create: { width: 80, height: 120, channels: 3, background: { r: 200, g: 160, b: 140 } }
  }).png().toBuffer();
  const canvas = await buildFaceLockCanvas(portrait, 64, 96);
  const { width, height, channels } = await sharp(canvas).metadata();
  const raw = await sharp(canvas).ensureAlpha().raw().toBuffer();
  assert.equal(width, 64);
  assert.equal(height, 96);
  assert.equal(channels, 4);
  let opaque = 0;
  let clear = 0;
  for (let i = 3; i < raw.length; i += 4) {
    if ((raw[i] ?? 0) > 200) opaque += 1;
    if ((raw[i] ?? 0) < 20) clear += 1;
  }
  assert.ok(opaque > 20);
  assert.ok(clear > opaque);
});

test('buildTurnaroundViewPrompt is single-figure full body per angle', () => {
  const base = 'long black hair, ice-blue eyes, moon-white xianxia dress';
  for (const view of TURNAROUND_VIEWS) {
    const { prompt, negative_prompt } = buildTurnaroundViewPrompt(base, view, 'pony');
    assert.match(prompt, /full body/i);
    assert.match(prompt, /moon-white xianxia dress/);
    assert.match(prompt, /plain studio background/);
    assert.doesNotMatch(prompt, /1girl|1boy|fully fastened|fully clothed/i);
    assert.doesNotMatch(prompt, /multi-view layout/i);
    assert.match(negative_prompt, /second person|duplicate figure/i);
    assert.match(negative_prompt, /child, loli, shota/i);
    if (view.id === 'front') assert.match(prompt, /front view/i);
    if (view.id === 'side') assert.match(prompt, /side view|profile/i);
    if (view.id === 'back') assert.match(prompt, /back view|from behind/i);
  }
});

test('robe turnaround keeps the stored robe and excludes decorative background', () => {
  const { prompt, negative_prompt } = buildTurnaroundViewPrompt(
    'moon-white layered silk robes, black hair',
    TURNAROUND_VIEWS[1]!,
    'pony'
  );
  assert.match(prompt, /moon-white layered silk robes/);
  assert.doesNotMatch(prompt, /fully covered|fully fastened|strapless gown/i);
  assert.doesNotMatch(negative_prompt, /strapless gown/);
  assert.match(negative_prompt, /halo|gradient background/);
  assert.match(negative_prompt, /archway/);
});

test('shouldUseTurnaroundComposite respects escape hatch', () => {
  assert.equal(shouldUseTurnaroundComposite({ gen_type: 'turnaround' }), true);
  assert.equal(shouldUseTurnaroundComposite({ gen_type: 'portrait' }), false);
  assert.equal(
    shouldUseTurnaroundComposite({ gen_type: 'turnaround', turnaround_mode: 'single' }),
    false
  );
  assert.equal(
    shouldUseTurnaroundComposite({ gen_type: 'turnaround', turnaround_composite: false }),
    false
  );
});

test('stitchTurnaroundSheet produces labeled wide sheet', async () => {
  const mk = async (r: number, g: number, b: number) =>
    sharp({
      create: { width: 200, height: 400, channels: 3, background: { r, g, b } }
    })
      .png()
      .toBuffer();

  const sheet = await stitchTurnaroundSheet([
    { buffer: await mk(200, 50, 50), label: 'FRONT' },
    { buffer: await mk(50, 200, 50), label: 'SIDE' },
    { buffer: await mk(50, 50, 200), label: 'BACK' }
  ]);

  const meta = await sharp(sheet).metadata();
  assert.ok(meta.width && meta.width > 1400);
  assert.ok(meta.height && meta.height > 900);
  assert.equal(meta.width! / meta.height!, 16 / 9);
  assert.equal(meta.format, 'png');
});

test('natural-language turnaround prompts strip Booru weights, balance parens, normalize bare age, and drop facial cues from rear view', () => {
  const raw = 'oriental realistic style, photorealistic, delicate East Asian facial features, full body character design, female, 23-25, long wavy auburn-brown hair, amber brown eyes, soft full lips, expressive brows, playful and inviting expression, full breasts, translucent peach-pink silk outer robe, Qiongming Divine Mirror (bronze rim, glowing), floating pink flower petals aura, consistent face hair and clothing across views';
  const front = buildTurnaroundViewPrompt(raw, TURNAROUND_VIEWS[0]!, 'redcraft_krea2');
  const side = buildTurnaroundViewPrompt(raw, TURNAROUND_VIEWS[1]!, 'redcraft_krea2');
  const back = buildTurnaroundViewPrompt(raw, TURNAROUND_VIEWS[2]!, 'redcraft_krea2');

  // No Booru weight syntax on VLM models
  assert.doesNotMatch(front.prompt, /:1\.\d+\)/);
  assert.doesNotMatch(side.prompt, /:1\.\d+\)/);
  assert.doesNotMatch(back.prompt, /:1\.\d+\)/);

  // Bare age 23-25 normalized to 23 to 25 years old
  assert.match(front.prompt, /23 to 25 years old/);
  assert.doesNotMatch(front.prompt, /,\s*23-25\s*,/);

  // Explicit gender in camera sentence on all 3 views
  assert.match(front.prompt, /^Full-length head-to-toe wide shot, direct front view of one adult East Asian woman, female/);
  assert.match(side.prompt, /^Full-length head-to-toe wide shot, strict 90 degree left profile of one adult East Asian woman, female/);
  assert.match(back.prompt, /^Full-length head-to-toe wide shot, strict rear view of one adult East Asian woman, female/);

  // Handheld mirror and floating petals stripped from turnaround panels
  assert.doesNotMatch(front.prompt, /Divine Mirror|floating pink flower petals|consistent face hair/i);

  // Back view strips all facial / eye / lip / brow / chest clauses
  assert.doesNotMatch(back.prompt, /amber brown eyes|soft full lips|expressive brows|full breasts|neutral expression/i);
  assert.match(back.prompt, /long wavy auburn-brown hair/);
  assert.match(back.prompt, /translucent peach-pink silk outer robe/);
});

test('turnaround strips soft hourglass, full breasts, delicate collarbones, and micro-facial cues across views, and wires use_qwen_vl_ref on front', async () => {
  const raw = 'oriental realistic style, photorealistic, female, 20-22, long black hair, flower hair ornaments, flower ornaments, pale ice-blue eyes, soft full lips, expressive brows, delicate collarbones, soft hourglass mature figure, full breasts, slender waist, elegant hips, crimson red hanfu xianxia dress';
  const cleaned = extractAppearanceBase(raw);
  assert.doesNotMatch(cleaned, /soft hourglass|full breasts|delicate collarbones|soft full lips|expressive brows/i);

  const front = buildTurnaroundViewPrompt(raw, TURNAROUND_VIEWS[0]!, 'redcraft_krea2');
  const side = buildTurnaroundViewPrompt(raw, TURNAROUND_VIEWS[1]!, 'redcraft_krea2');
  const back = buildTurnaroundViewPrompt(raw, TURNAROUND_VIEWS[2]!, 'redcraft_krea2');
  assert.doesNotMatch(front.prompt, /soft hourglass|full breasts|delicate collarbones|soft full lips|expressive brows/i);
  assert.doesNotMatch(side.prompt, /soft hourglass|full breasts|delicate collarbones|soft full lips|expressive brows/i);
  // Deduplicates flower ornaments when flower hair ornaments is present
  assert.equal((front.prompt.match(/flower/gi) || []).length, 1);
  // Expands sleeve length for hanfu/xianxia dress
  assert.match(front.prompt, /long flowing wide sleeves/);
  // Back view strips eye color to prevent head turning toward camera
  assert.doesNotMatch(back.prompt, /ice-blue eyes/i);
  // Negative prompt blocks cropped upper-body shots
  assert.match(front.negative_prompt, /medium shot, cowboy shot, waist-up, knee-up, bust shot, upper body only, cropped legs, cropped feet/);

  const kreaTemplate = {
    '3': { inputs: { seed: 1, steps: 16, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] }, class_type: 'KSampler' },
    '4': { inputs: { unet_name: 'krea2_raw_bf16.safetensors', weight_dtype: 'default' }, class_type: 'UNETLoader' },
    '5': { inputs: { width: 832, height: 1216, batch_size: 1 }, class_type: 'EmptySD3LatentImage' },
    '6': { inputs: { text: '', clip: ['10', 0] }, class_type: 'CLIPTextEncode' },
    '7': { inputs: { text: '', clip: ['10', 0] }, class_type: 'CLIPTextEncode' },
    '8': { inputs: { samples: ['3', 0], vae: ['11', 0] }, class_type: 'VAEDecode' },
    '9': { inputs: { filename_prefix: 'NovaStory_RedCraft_Krea2', images: ['8', 0] }, class_type: 'SaveImage' },
    '10': { inputs: { clip_name: 'qwen3vl_4b_bf16.safetensors', type: 'qwen_image', device: 'default' }, class_type: 'CLIPLoader' },
    '11': { inputs: { vae_name: 'qwen_image_vae.safetensors' }, class_type: 'VAELoader' }
  };
  const panelWf = {
    ...kreaTemplate,
    ...buildTurnaroundPanelWorkflowData(
      { model_type: 'redcraft_krea2', nsfw_enabled: true },
      TURNAROUND_VIEWS[0]!,
      front.prompt,
      front.negative_prompt,
      null,
      null
    ),
    turnaround_view: 'front',
    character_ref_url: '/static/generated/portrait.png',
    ref_image_url: '/static/generated/portrait.png',
    use_qwen_vl_ref: true,
  };
  const compiled = await compileComfyWorkflow(panelWf, front.prompt, 'standard');
  const qwenNode = Object.values(compiled).find((n: any) => n?.class_type === 'TextEncodeQwenImage21') as any;
  assert.ok(qwenNode, 'Expected TextEncodeQwenImage21 node in compiled redcraft_krea2 front panel workflow');
  assert.ok(Array.isArray(qwenNode.inputs.image_1), 'Expected image_1 reference wired on TextEncodeQwenImage21');
  const sd3Latent = Object.values(compiled).find((n: any) => n?.class_type === 'EmptySD3LatentImage') as any;
  assert.equal(sd3Latent?.inputs?.width, 768);
  assert.equal(sd3Latent?.inputs?.height, 1152);
});

test('prompt surgery preserves compound hair/garment descriptors, avoids face/chest tokens in back positive, handles blindfolds, and strips only handheld prop sub-phrases', () => {
  const compoundPrompt =
    'female, 22-24, collarbone-length black hair, chest-length twin tails, double-breasted trench coat, chest plate armor, off-shoulder cleavage sweater, holding a glowing lantern in her left hand while wearing long lace gloves, no face visible';
  const back = buildTurnaroundViewPrompt(compoundPrompt, TURNAROUND_VIEWS[2]!, 'redcraft_krea2');
  const side = buildTurnaroundViewPrompt(compoundPrompt, TURNAROUND_VIEWS[1]!, 'redcraft_krea2');

  // Compound hair & garment descriptors survive without truncation or loss
  assert.match(back.prompt, /shoulder-length black hair/);
  assert.match(back.prompt, /mid-back length twin tails/);
  assert.match(back.prompt, /tailored double-buttoned trench coat/);
  assert.match(back.prompt, /torso plate armor/);
  assert.match(back.prompt, /off-shoulder sweater/);
  assert.match(side.prompt, /off-shoulder sweater/);

  // Participial handheld prop stripped while trailing glove clause survives
  assert.doesNotMatch(back.prompt, /glowing lantern|in her left hand/i);
  assert.match(back.prompt, /wearing long lace gloves/);

  // Back view positive prompt has zero 'face' or 'chest' tokens and includes dorsal anatomy anchors
  assert.doesNotMatch(back.prompt, /\b(?:face|chest|breasts|cleavage)\b/i);
  assert.match(back.prompt, /occiput and nape of neck/i);
  assert.match(back.prompt, /shoulder blades/i);

  // Blindfold / eyepatch characters do not force "one eye visible" in side view
  const blindfoldPrompt = 'female, 24 years old, silver hair, black silk blindfold covering eyes, dark coat';
  const blindfoldSide = buildTurnaroundViewPrompt(blindfoldPrompt, TURNAROUND_VIEWS[1]!, 'redcraft_krea2');
  assert.doesNotMatch(blindfoldSide.prompt, /one eye is visible|exactly one eye visible/i);
  assert.match(blindfoldSide.prompt, /black silk blindfold/i);
});

test('normalizeAndAlignTurnaroundPanel normalizes drifted backgrounds to #f5f5f5 and aligns subject head/foot baselines across views', async () => {
  const createSyntheticCharacterPanel = async (
    bg: { r: number; g: number; b: number },
    charTopY: number,
    charBottomY: number
  ) => {
    const w = 240;
    const h = 360;
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 3;
        const inChar = y >= charTopY && y <= charBottomY && x >= 80 && x <= 160;
        raw[idx] = inChar ? 40 : bg.r;
        raw[idx + 1] = inChar ? 55 : bg.g;
        raw[idx + 2] = inChar ? 90 : bg.b;
      }
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  };

  // Three panels with drastically different vertical framing and background color drift
  const frontRaw = await createSyntheticCharacterPanel({ r: 226, g: 226, b: 226 }, 12, 345); // 92% tall
  const sideRaw = await createSyntheticCharacterPanel({ r: 248, g: 248, b: 245 }, 72, 288);  // 60% tall
  const backRaw = await createSyntheticCharacterPanel({ r: 235, g: 232, b: 228 }, 40, 310);  // 75% tall

  const measureAlignedBounds = async (panelBuf: Buffer) => {
    const aligned = await normalizeAndAlignTurnaroundPanel(panelBuf, 256, 448, '#f5f5f5');
    const { data, info } = await sharp(aligned).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // Corner pixel should be normalized to #f5f5f5 (245, 245, 245)
    assert.equal(data[0], 245);
    assert.equal(data[1], 245);
    assert.equal(data[2], 245);
    let topY = -1;
    let bottomY = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * 3;
        if ((data[idx] ?? 245) < 150) {
          if (topY === -1) topY = y;
          bottomY = y;
        }
      }
    }
    return { topY, bottomY };
  };

  const bFront = await measureAlignedBounds(frontRaw);
  const bSide = await measureAlignedBounds(sideRaw);
  const bBack = await measureAlignedBounds(backRaw);

  // All 3 panels now share the same foot baseline and aligned head height (within 2px rounding)
  assert.ok(Math.abs(bFront.bottomY - bSide.bottomY) <= 2);
  assert.ok(Math.abs(bFront.bottomY - bBack.bottomY) <= 2);
  assert.ok(Math.abs(bFront.topY - bSide.topY) <= 2);
  assert.ok(Math.abs(bFront.topY - bBack.topY) <= 2);
});



