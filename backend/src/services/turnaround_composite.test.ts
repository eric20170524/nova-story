import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAppearanceBase,
  canonicalTurnaroundPrompt,
  mergeTurnaroundAssets,
  parseTurnaroundViews,
  resolveTurnaroundIdentityReference,
  buildTurnaroundViewPrompt,
  buildTurnaroundPanelWorkflowData,
  shouldUseTurnaroundComposite,
  TURNAROUND_VIEWS
} from './turnaround_composite';
import { compileComfyWorkflow } from './generation_service';

test('extractAppearanceBase strips multi-view sheet jargon', () => {
  const raw =
    'score_9, character turnaround sheet, multi-view layout, front view, side view, back view, 1girl, long black hair, moon-white dress';
  const cleaned = extractAppearanceBase(raw);
  assert.doesNotMatch(cleaned, /turnaround sheet/i);
  assert.doesNotMatch(cleaned, /multi-view/i);
  assert.match(cleaned, /long black hair/);
  assert.match(cleaned, /moon-white dress/);
});

test('turnaround prompt keeps clothing state and removes scene mood for front view', () => {
  assert.equal(TURNAROUND_VIEWS.length, 1);
  assert.equal(TURNAROUND_VIEWS[0]?.id, 'front');

  const cleaned = extractAppearanceBase(
    'long black hair, ice-blue eyes, melting expression, half-open inner robe, moon-white xianxia dress, enchanted mirror'
  );
  assert.match(cleaned, /long black hair/);
  assert.match(cleaned, /moon-white xianxia dress/);
  assert.match(cleaned, /half-open inner robe/);
  assert.doesNotMatch(cleaned, /melting/i);
  assert.match(cleaned, /enchanted mirror/);
  const front = buildTurnaroundViewPrompt(cleaned, TURNAROUND_VIEWS[0]!, 'pony');
  assert.match(front.prompt, /half-open inner robe/);
  assert.match(front.prompt, /neutral expression|A-pose/i);
  assert.match(front.prompt, /direct front view/i);
  assert.match(front.prompt, /solid pure white opaque studio background/i);
  assert.doesNotMatch(front.prompt, /1girl|fully fastened|fully clothed/i);
  assert.doesNotMatch(front.prompt, /character reference sheet|character design sheet panel/i);
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

test('parseTurnaroundViews only allows front view and mergeTurnaroundAssets stores front plate and variant urls', () => {
  assert.deepEqual(parseTurnaroundViews({}), ['front']);
  assert.deepEqual(parseTurnaroundViews({ turnaround_views: 'all' }), ['front']);
  assert.deepEqual(parseTurnaroundViews({ turnaround_views: ['front'] }), ['front']);
  assert.deepEqual(parseTurnaroundViews({ turnaround_views: ['front', 'side', 'back'] }), ['front']);
  assert.throws(() => parseTurnaroundViews({ turnaround_views: ['side'] }), /只支持生成正面/);
  assert.throws(() => parseTurnaroundViews({ turnaround_views: ['back'] }), /只支持生成正面/);
  assert.throws(() => parseTurnaroundViews({ turnaround_views: [] }), /必须指定正面/);

  const tags = {
    assets: {
      avatar_url: '/face.png',
      turnaround_front_url: '/front.png',
      turnaround_side_url: '/legacy-side.png',
      turnaround_back_url: '/legacy-back.png',
      turnaround_url: '/front.png',
      turnaround_variants: {
        'inner robe lowered to the waist': {
          front_url: '/old-vfront.png',
          side_url: '/legacy-vside.png',
          back_url: '/legacy-vback.png',
          sheet_url: '/old-vsheet.png',
        },
      },
    },
  };
  const frontUpdated = mergeTurnaroundAssets(tags, { front: '/front2.png' }, '/front2.png');
  assert.equal(frontUpdated.assets.turnaround_front_url, '/front2.png');
  assert.equal(frontUpdated.assets.turnaround_url, '/front2.png');
  assert.equal(frontUpdated.assets.turnaround_side_url, undefined);
  assert.equal(frontUpdated.assets.turnaround_back_url, undefined);
  assert.equal(frontUpdated.assets.avatar_url, '/face.png');

  const variant = mergeTurnaroundAssets(
    tags,
    { front: '/vfront.png' },
    '/vfront.png',
    { wardrobeVariant: 'inner robe lowered to the waist' },
  );
  assert.equal(variant.assets.turnaround_front_url, '/front.png');
  assert.equal(variant.assets.turnaround_url, '/front.png');
  assert.equal(variant.assets.turnaround_variants['inner robe lowered to the waist'].front_url, '/vfront.png');
  assert.equal(variant.assets.turnaround_variants['inner robe lowered to the waist'].sheet_url, '/vfront.png');
  assert.equal(variant.assets.turnaround_variants['inner robe lowered to the waist'].side_url, undefined);
  assert.equal(variant.assets.turnaround_variants['inner robe lowered to the waist'].back_url, undefined);
});

test('buildTurnaroundPanelWorkflowData builds clean front-panel workflow state', () => {
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
  );
  assert.equal(front.character_ref_url, undefined);
  assert.equal(front.ref_image_url, undefined);
  assert.equal(front.denoise, 1);
  assert.equal(front.force_no_character_adapter, true);
  assert.equal(front.nsfw_enabled, true);
  assert.deepEqual(front.project_settings, { default_workflow_id: 7 });
});

test('buildTurnaroundViewPrompt produces clean single-figure front full-body reference prompt', () => {
  const base = 'long black hair, ice-blue eyes, moon-white xianxia dress';
  const { prompt, negative_prompt } = buildTurnaroundViewPrompt(base, TURNAROUND_VIEWS[0]!, 'pony');
  assert.match(prompt, /full body/i);
  assert.match(prompt, /moon-white xianxia dress/);
  assert.match(prompt, /solid pure white opaque studio background, completely opaque, no transparency, no checkerboard/);
  assert.match(prompt, /consistent character identity/);
  assert.match(prompt, /front view/i);
  assert.doesNotMatch(prompt, /1girl|1boy|fully fastened|fully clothed/i);
  assert.doesNotMatch(prompt, /multi-view layout/i);
  assert.match(negative_prompt, /second person|duplicate figure/i);
  assert.match(negative_prompt, /child, loli, shota/i);
  assert.match(negative_prompt, /side view, profile, back view, from behind/i);
  assert.match(negative_prompt, /expression matrix, pose study, detail inset/i);
});

test('robe turnaround keeps the stored robe and excludes decorative background', () => {
  const { prompt, negative_prompt } = buildTurnaroundViewPrompt(
    'moon-white layered silk robes, black hair',
    TURNAROUND_VIEWS[0]!,
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

test('natural-language front turnaround prompt strips Booru weights, normalizes bare age, and follows clean_reference rules', () => {
  const raw = 'oriental realistic style, photorealistic, delicate East Asian facial features, full body character design, female, 23-25, long wavy auburn-brown hair, amber brown eyes, soft full lips, expressive brows, playful and inviting expression, full breasts, translucent peach-pink silk outer robe, Qiongming Divine Mirror (bronze rim, glowing), floating pink flower petals aura, consistent face hair and clothing across views';
  const front = buildTurnaroundViewPrompt(raw, TURNAROUND_VIEWS[0]!, 'redcraft_krea2');

  // No Booru weight syntax on VLM models
  assert.doesNotMatch(front.prompt, /:1\.\d+\)/);

  // Bare age 23-25 normalized to 23 to 25 years old
  assert.match(front.prompt, /23 to 25 years old/);
  assert.doesNotMatch(front.prompt, /,\s*23-25\s*,/);

  // Explicit gender & clean_reference contract in camera sentence
  assert.match(
    front.prompt,
    /^Full-length head-to-toe wide shot, direct orthographic front view of one adult East Asian woman, female/
  );
  assert.match(front.prompt, /solid pure white opaque studio background/i);
  assert.match(front.prompt, /no before-and-after comparison, no inset boxes, and no text labels/i);

  // Handheld mirror and floating petals stripped from turnaround panel
  assert.doesNotMatch(front.prompt, /Divine Mirror|floating pink flower petals|consistent face hair/i);
});

test('turnaround strips soft hourglass, full breasts, delicate collarbones, and micro-facial cues, and wires use_qwen_vl_ref on front', async () => {
  const raw = 'oriental realistic style, photorealistic, female, 20-22, long black hair, flower hair ornaments, flower ornaments, pale ice-blue eyes, soft full lips, expressive brows, delicate collarbones, soft hourglass mature figure, full breasts, slender waist, elegant hips, crimson red hanfu xianxia dress';
  const cleaned = extractAppearanceBase(raw);
  assert.doesNotMatch(cleaned, /soft hourglass|full breasts|delicate collarbones|soft full lips|expressive brows/i);

  const front = buildTurnaroundViewPrompt(raw, TURNAROUND_VIEWS[0]!, 'redcraft_krea2');
  assert.doesNotMatch(front.prompt, /soft hourglass|full breasts|delicate collarbones|soft full lips|expressive brows/i);
  // Deduplicates flower ornaments when flower hair ornaments is present
  assert.equal((front.prompt.match(/flower/gi) || []).length, 1);
  // Expands sleeve length for hanfu/xianxia dress
  assert.match(front.prompt, /long flowing wide sleeves/);
  // Negative prompt blocks cropped upper-body shots and side/back angles
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

test('compound hair/garment descriptors and participial handheld prop stripping work cleanly on front view', () => {
  const compoundPrompt =
    'female, 22-24, collarbone-length black hair, chest-length twin tails, double-breasted trench coat, chest plate armor, holding a glowing lantern in her left hand while wearing long lace gloves';
  const front = buildTurnaroundViewPrompt(compoundPrompt, TURNAROUND_VIEWS[0]!, 'redcraft_krea2');

  assert.match(front.prompt, /shoulder-length black hair/);
  assert.match(front.prompt, /mid-back length twin tails/);
  assert.match(front.prompt, /tailored double-buttoned trench coat/);
  assert.match(front.prompt, /torso plate armor/);

  // Participial handheld prop stripped while trailing glove clause survives
  assert.doesNotMatch(front.prompt, /glowing lantern|in her left hand/i);
  assert.match(front.prompt, /wearing long lace gloves/);
});

test('resolveTurnaroundIdentityReference respects use_ref_portrait=false and request-level session portrait', () => {
  // Explicit opt-out disables reference for non-human subjects even when DB has a stored avatar
  assert.equal(
    resolveTurnaroundIdentityReference(
      { use_ref_portrait: false, ref_image_url: '/session.png' },
      '/stored-avatar.png'
    ),
    null
  );
  // A human full-body plate must follow the portrait: opt-out is ignored
  assert.equal(
    resolveTurnaroundIdentityReference(
      { use_ref_portrait: false, turnaround_front_adapter: false },
      '/stored-avatar.png',
      { mandatory: true }
    ),
    '/stored-avatar.png'
  );
  assert.equal(
    resolveTurnaroundIdentityReference(
      { use_ref_portrait: false, ref_image_url: '/session.png' },
      '/stored-avatar.png',
      { mandatory: true }
    ),
    '/session.png'
  );
  assert.equal(
    resolveTurnaroundIdentityReference(
      { turnaround_front_adapter: false },
      '/stored-avatar.png'
    ),
    null
  );
  // Request-scoped session portrait wins over DB stored avatar
  assert.equal(
    resolveTurnaroundIdentityReference(
      { use_ref_portrait: true, ref_image_url: '/session-new-portrait.png' },
      '/stored-avatar.png'
    ),
    '/session-new-portrait.png'
  );
  assert.equal(
    resolveTurnaroundIdentityReference(
      { character_ref_url: '/session-char-ref.png' },
      ''
    ),
    '/session-char-ref.png'
  );
  // Fallback to DB stored avatar when request omits explicit ref URL
  assert.equal(
    resolveTurnaroundIdentityReference({}, '/stored-avatar.png'),
    '/stored-avatar.png'
  );
});

test('identity-locked VLM prompt copies the reference face and drops competing face text', () => {
  const raw = 'oriental realistic style, photorealistic, delicate East Asian facial features, classical oriental bone structure, female, 24-26, long black hair, ice blue eyes, cold refined adult beauty, elegant sharp brows, high cheekbones, moon-white xianxia dress';
  for (const family of ['redcraft_krea2', 'qwen_image'] as const) {
    const locked = buildTurnaroundViewPrompt(raw, TURNAROUND_VIEWS[0]!, family, { identityLocked: true });
    assert.match(locked.prompt, /exact same woman shown in the reference image \(image 1\)/i);
    assert.match(locked.prompt, /identical facial structure/i);
    assert.doesNotMatch(locked.prompt, /facial features|bone structure|sharp brows|cheekbones|East Asian woman/i);
    assert.match(locked.prompt, /long black hair/);
    assert.match(locked.prompt, /moon-white xianxia dress/);
    assert.match(locked.negative_prompt, /different person, different face/i);
  }
  // The stored eye colour is named next to the copy instruction, not only left in the tag list
  const blue = buildTurnaroundViewPrompt('female, long black hair, pale ice-blue eyes, black face veil, small scar on cheek, moon-white dress', TURNAROUND_VIEWS[0]!, 'redcraft_krea2', { identityLocked: true });
  assert.match(blue.prompt, /identical facial structure, eye shape, eye color,/i);
  assert.match(blue.prompt, /do not redesign or beautify or replace the face/i);
  assert.doesNotMatch(blue.prompt, /,\s*beautify\s*,/i);
  assert.match(blue.prompt, /Keep the exact eye color from the reference image \(pale ice-blue eyes\)/);
  assert.match(blue.prompt, /black face veil/);
  assert.match(blue.prompt, /small scar on cheek/);
  const noEyes = buildTurnaroundViewPrompt('female, long black hair, moon-white dress', TURNAROUND_VIEWS[0]!, 'redcraft_krea2', { identityLocked: true });
  assert.match(noEyes.prompt, /Keep the exact eye color from the reference image\./);
  // The stray phrase from the real route output ("consistent face hair and clothing") is stripped again
  const route = buildTurnaroundViewPrompt('female, long black hair, full body, consistent face hair and clothing, moon-white dress', TURNAROUND_VIEWS[0]!, 'pony');
  assert.doesNotMatch(route.prompt, /consistent face hair and clothing/i);
  // Unlocked prompt keeps the old behavior
  const unlocked = buildTurnaroundViewPrompt(raw, TURNAROUND_VIEWS[0]!, 'redcraft_krea2');
  assert.doesNotMatch(unlocked.prompt, /image 1/);
  assert.doesNotMatch(unlocked.negative_prompt, /different person/i);
  // Pony relies on text plus the adapter, so its face text is kept
  const pony = buildTurnaroundViewPrompt(raw, TURNAROUND_VIEWS[0]!, 'pony', { identityLocked: true });
  assert.match(pony.prompt, /sharp brows/);
});

test('TurnaroundModal quick tags survive extractAppearanceBase and deduplicate cleanly in buildTurnaroundViewPrompt', () => {
  const quickTaggedPrompt = [
    'long black hair, silver hairpin',
    'full body, direct front view, head to toe',
    'neutral standing A-pose, hands and feet visible',
    'solid pure white opaque studio background',
    'consistent character identity and outfit',
  ].join(', ');

  const extracted = extractAppearanceBase(quickTaggedPrompt);
  assert.match(extracted, /full body/i);
  assert.match(extracted, /direct front view/i);
  assert.match(extracted, /neutral standing A-pose/i);
  assert.match(extracted, /hands and feet visible/i);
  assert.match(extracted, /solid pure white opaque studio background/i);
  assert.match(extracted, /consistent character identity and outfit/i);

  const built = buildTurnaroundViewPrompt(quickTaggedPrompt, TURNAROUND_VIEWS[0]!, 'pony');
  assert.match(built.prompt, /consistent character identity and outfit/i);
  // Clauses already present in poseTags/framingDetails are deduplicated rather than doubled
  assert.equal((built.prompt.match(/neutral standing A-pose/gi) || []).length, 1);
  assert.equal((built.prompt.match(/hands and feet visible/gi) || []).length, 1);
  assert.equal((built.prompt.match(/solid pure white opaque studio background/gi) || []).length, 1);
});
