/**
 * Reference generation policy — Tier A (default) + Tier B (reserved hooks).
 *
 * Product rule:
 *   Tags + character LoRA + text composition ALWAYS apply.
 *   Image refs enhance when present; Tier B adapters silent-fallback when missing.
 *
 * Tier A (current):
 *   - Character identity: visual tags / description / optional character LoRA
 *   - Composition: shot text (visual_prompt + camera fields)
 *   - Single portrait img2img only for portrait / turnaround / single close-up
 *
 * Tier B (future, hooks only):
 *   - character_ref_url  → IP-Adapter / PuLID / Flux Redux
 *   - composition_ref_url → ControlNet OpenPose / Depth / Canny
 *   When adapters are unavailable, fall back to Tier A without failing the job.
 */

export type ImageRefRole = 'character' | 'composition' | 'legacy';

export interface ResolvedReferenceUrls {
  /** Explicit or legacy-mapped character / identity image */
  characterRefUrl: string | null;
  /** Explicit composition / pose / layout image (Tier B) */
  compositionRefUrl: string | null;
  /** Raw legacy single slot (ref_image_url | init_image_url) */
  legacyRefUrl: string | null;
  /** Unique URLs that must be copied into ComfyUI/input */
  urlsToCopy: string[];
}

export interface Img2ImgPolicy {
  useImg2Img: boolean;
  denoise: number;
  reason: string;
}

export interface AdapterAvailability {
  /** IP-Adapter / InstantID / PuLID / Flux Redux installed & wired */
  characterAdapter: boolean;
  /** ControlNet pose/depth/canny (or equivalent) installed & wired */
  compositionControl: boolean;
  /** Optional detail from probeTierBCapability */
  characterKind?: 'ip_adapter' | 'ip_adapter_unified' | 'none';
  compositionKind?: 'openpose' | 'depth' | 'canny' | 'none';
}

export type ReferenceTier = 'A' | 'A+character_img2img' | 'A+character_adapter' | 'A+composition' | 'B';

export interface ReferenceGenerationPlan {
  tier: ReferenceTier;
  refs: ResolvedReferenceUrls;
  img2img: Img2ImgPolicy;
  useCharacterAdapter: boolean;
  useCompositionControl: boolean;
  characterAdapterType: 'none' | 'ip_adapter' | 'ip_adapter_unified' | 'pulid' | 'flux_redux';
  compositionControlType: 'none' | 'openpose' | 'depth' | 'canny';
  /** Human-readable notes for logs / UI */
  notes: string[];
}

const WIDE_FACE_TAG_KEYS = new Set([
  'eyes',
  'face_features',
  'skin_tone',
  'eyebrows',
  'lashes',
  'face',
  'facial_features'
]);

const ASSET_META_KEYS = new Set([
  'assets',
  'timeline_map',
  'variants',
  'base_model',
  'model_type',
  'avatar_url',
  'turnaround_url',
  'face_url',
  'lora_path',
  'lora_ready',
  'lora_name'
]);

const nonEmptyUrl = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
};

/**
 * Resolve dual-ref fields with backward-compatible legacy single ref.
 * character_ref_url wins over ref_image_url for identity.
 */
export const resolveReferenceUrls = (workflowData: any): ResolvedReferenceUrls => {
  const legacyRefUrl =
    nonEmptyUrl(workflowData?.ref_image_url)
    || nonEmptyUrl(workflowData?.init_image_url);

  const characterRefUrl =
    nonEmptyUrl(workflowData?.character_ref_url)
    || nonEmptyUrl(workflowData?.character_reference_url)
    || legacyRefUrl;

  const compositionRefUrl =
    nonEmptyUrl(workflowData?.composition_ref_url)
    || nonEmptyUrl(workflowData?.composition_reference_url)
    || nonEmptyUrl(workflowData?.pose_ref_url)
    || null;

  const urlsToCopy = Array.from(
    new Set([characterRefUrl, compositionRefUrl].filter(Boolean) as string[])
  );

  return { characterRefUrl, compositionRefUrl, legacyRefUrl, urlsToCopy };
};

/**
 * Tier A img2img gate: portrait latents collapse multi-person / story shots
 * into solo portraits when denoise is moderate — so narrative scenes stay txt2img.
 */
export const resolveReferenceImg2ImgPolicy = (
  workflowData: any,
  finalPrompt: string = ''
): Img2ImgPolicy => {
  const genType = String(workflowData?.gen_type || '').toLowerCase();
  const explicit = workflowData?.denoise;
  const hasExplicitDenoise = typeof explicit === 'number' && Number.isFinite(explicit);

  // Per-panel full-body view in 3-view composite pipeline — never lock to portrait latent
  if (genType === 'turnaround_panel') {
    return {
      useImg2Img: false,
      denoise: 1,
      reason: 'turnaround_panel_txt2img'
    };
  }
  // Legacy single-shot multi-view (escape hatch turnaround_mode=single): still mild img2img
  if (genType === 'turnaround') {
    return {
      useImg2Img: true,
      denoise: hasExplicitDenoise ? Number(explicit) : 0.55,
      reason: 'turnaround'
    };
  }
  if (genType === 'portrait') {
    return {
      useImg2Img: true,
      denoise: hasExplicitDenoise ? Number(explicit) : 0.42,
      reason: 'portrait'
    };
  }

  const shotHint = [
    workflowData?.shot_type,
    workflowData?.camera_angle,
    workflowData?.camera_movement
  ]
    .filter(Boolean)
    .join(' ');
  const prompt = `${finalPrompt} ${workflowData?.prompt || ''} ${workflowData?.visual_prompt || ''} ${shotHint}`;
  const multiPerson =
    /\b[23]girls?\b|\b[23]boys?\b|\bmultiple\b|\bgroup\b|yuri|threesome|sandwich|三人|两人|entwined|intertwined|two-?shot|2girls/i.test(
      prompt
    );
  const storyWide =
    /extreme long|establishing|wide shot|long shot|full body|environment|cloud sea|palace|inner hall|overview|bird.?s eye|high angle overview|empty latent arena|cliff stage/i.test(
      prompt
    );
  // Intimate + combat/martial — both collapse under portrait identity locks
  const storyAction =
    /\b(embrac|kiss|sitting|lying|straddl|press|hold|whisper|kneel|behind|from behind|on (the )?(bed|couch)|between|climax|tendril|tentacle|cuddling|afterglow|walking toward|reaching|kick|throw|clash|combat|fight|martial|whip|grapple|defeat|mid-?air|battle damage|ripped|duel|punch|block|parry|slam|pinning)\b/i.test(
      prompt
    );
  const singleClose =
    /\b(close-?up|portrait|medium close|upper body|face shot)\b/i.test(prompt)
    && !multiPerson
    && /\b1girl\b|\b1boy\b|solo/i.test(prompt);

  if (hasExplicitDenoise && Number(explicit) >= 0.95) {
    return { useImg2Img: false, denoise: 1, reason: 'explicit_txt2img' };
  }

  if (multiPerson || storyWide || storyAction) {
    return {
      useImg2Img: false,
      denoise: 1,
      reason: multiPerson ? 'multi_person_story' : storyWide ? 'wide_story' : 'action_story'
    };
  }

  if (singleClose) {
    return {
      useImg2Img: true,
      denoise: hasExplicitDenoise ? Number(explicit) : 0.62,
      reason: 'single_closeup'
    };
  }

  if (hasExplicitDenoise && Number(explicit) < 0.95) {
    const d = Math.max(Number(explicit), 0.82);
    return { useImg2Img: d < 0.95, denoise: d, reason: 'generic_scene_clamped' };
  }

  return { useImg2Img: false, denoise: 1, reason: 'scene_txt2img_default' };
};

/**
 * Whether IP-Adapter / InstantID style identity adapters may lock a shot.
 *
 * Critical: multi-person, wide establishing, and action beats must NOT use a single
 * portrait ref as IP-Adapter — it collapses narrative into soft solo portraits
 * (see local/shortstory/xianxia_duel pony_v4 failure).
 *
 * Same compositional gates as Tier A img2img, plus explicit force flags.
 */
export const shouldAllowCharacterAdapter = (
  workflowData: any,
  finalPrompt: string = '',
  img2imgPolicy?: Img2ImgPolicy
): { allow: boolean; reason: string } => {
  if (workflowData?.force_no_character_adapter === true) {
    return { allow: false, reason: 'forced_off' };
  }
  if (workflowData?.force_character_adapter === true) {
    return { allow: true, reason: 'forced_on' };
  }

  // Client asked for pure Tier A (tags + text only)
  const tier = String(workflowData?.reference_tier || '').toUpperCase();
  if (tier === 'A' || tier === 'TIER_A' || tier === 'TEXT') {
    return { allow: false, reason: 'reference_tier_a' };
  }

  const genType = String(workflowData?.gen_type || '').toLowerCase();
  // Dedicated identity pipelines may use adapters
  if (genType === 'portrait' || genType === 'turnaround' || genType === 'turnaround_panel') {
    return { allow: true, reason: genType };
  }

  const policy =
    img2imgPolicy
    || resolveReferenceImg2ImgPolicy(workflowData, finalPrompt);

  // Shared scene gates with img2img — do not identity-lock these
  if (
    policy.reason === 'multi_person_story'
    || policy.reason === 'wide_story'
    || policy.reason === 'action_story'
    || policy.reason === 'turnaround_panel_txt2img'
  ) {
    return { allow: false, reason: policy.reason };
  }

  // Single close-up / portrait-like: adapters help
  if (policy.reason === 'single_closeup' || policy.reason === 'portrait') {
    return { allow: true, reason: policy.reason };
  }

  // Explicit high denoise = composition-first txt2img; keep adapters off
  if (policy.reason === 'explicit_txt2img') {
    return { allow: false, reason: 'explicit_txt2img' };
  }

  // Default narrative scene: tags + text only (matches successful pony_v2 duel path)
  return { allow: false, reason: 'scene_prefers_txt2img' };
};

/**
 * Plan which reference path to use.
 * Tier A always applies; Tier B adapters enhance when capability + refs are present
 * AND the shot type can tolerate identity locking.
 */
export const planReferenceGeneration = (
  workflowData: any,
  finalPrompt: string = '',
  adapters: AdapterAvailability = { characterAdapter: false, compositionControl: false }
): ReferenceGenerationPlan => {
  const refs = resolveReferenceUrls(workflowData);
  const img2imgBase = refs.characterRefUrl
    ? resolveReferenceImg2ImgPolicy(
      {
        ...workflowData,
        // Prefer character ref for img2img policy decisions
        ref_image_url: refs.characterRefUrl
      },
      finalPrompt
    )
    : { useImg2Img: false, denoise: 1, reason: 'no_character_ref' };

  const notes: string[] = [
    'Tier A base: tags + LoRA + text composition always apply'
  ];

  const adapterGate = shouldAllowCharacterAdapter(workflowData, finalPrompt, img2imgBase);
  const useCharacterAdapter = Boolean(
    adapters.characterAdapter && refs.characterRefUrl && adapterGate.allow
  );
  const useCompositionControl = Boolean(adapters.compositionControl && refs.compositionRefUrl);

  if (adapters.characterAdapter && refs.characterRefUrl && !adapterGate.allow) {
    notes.push(
      `Character adapter skipped (${adapterGate.reason}) — multi/wide/action/txt2img scene keeps free composition`
    );
  }

  // When a real character adapter exists, prefer it over classic img2img for identity
  let img2img = img2imgBase;
  if (useCharacterAdapter) {
    // Never stack IP-Adapter + portrait latent img2img — adapter owns identity
    img2img = {
      useImg2Img: false,
      denoise: 1,
      reason: 'deferred_to_character_adapter'
    };
    notes.push('Character adapter available — img2img identity path disabled');
  }

  if (refs.compositionRefUrl && !useCompositionControl) {
    notes.push(
      `composition_ref present (${refs.compositionRefUrl}) but ControlNet/adapter not wired — Tier A text composition only`
    );
  }
  if (refs.characterRefUrl && !img2img.useImg2Img && !useCharacterAdapter) {
    notes.push(
      `character_ref kept for future adapters only (img2img skipped: ${img2img.reason}; adapter: ${adapterGate.reason})`
    );
  }
  if (useCharacterAdapter) {
    notes.push(`Using character adapter for ${refs.characterRefUrl}`);
  }
  if (useCompositionControl) {
    notes.push(`Using composition ControlNet for ${refs.compositionRefUrl}`);
  }

  let tier: ReferenceTier = 'A';
  if (useCharacterAdapter && useCompositionControl) tier = 'B';
  else if (useCharacterAdapter) tier = 'A+character_adapter';
  else if (useCompositionControl) tier = 'A+composition';
  else if (img2img.useImg2Img) tier = 'A+character_img2img';

  const characterAdapterType = useCharacterAdapter
    ? (adapters.characterKind === 'ip_adapter_unified' ? 'ip_adapter_unified' : 'ip_adapter')
    : 'none';
  const compositionControlType = useCompositionControl
    ? (adapters.compositionKind || 'canny')
    : 'none';

  return {
    tier,
    refs,
    img2img,
    useCharacterAdapter,
    useCompositionControl,
    characterAdapterType,
    compositionControlType,
    notes
  };
};

/**
 * Flatten visual_tags (nested or flat) into a string map of appearance tags.
 */
export const flattenVisualTagMap = (
  visualTags: any,
  options: { chapterId?: string | number | null; wideShot?: boolean } = {}
): Record<string, string> => {
  if (!visualTags || typeof visualTags !== 'object') return {};

  let tagMap: Record<string, string> = {};

  if ('base_model' in visualTags) {
    const baseTags = visualTags.base_model?.tags || {};
    let variantTags: Record<string, string> = {};
    const timelineMap = visualTags.timeline_map || {};
    const chapterId = options.chapterId;
    const variantId = chapterId != null ? timelineMap[chapterId] ?? timelineMap[String(chapterId)] : null;
    const variants = visualTags.variants || [];
    if (variantId) {
      const variant = variants.find((v: any) => v.id === variantId);
      if (variant?.tags && typeof variant.tags === 'object') {
        variantTags = variant.tags;
      }
    }
    const merged = {
      ...(typeof baseTags === 'object' && baseTags ? baseTags : {}),
      ...variantTags
    };
    tagMap = Object.fromEntries(
      Object.entries(merged).filter(([, v]) => typeof v === 'string' && String(v).trim())
    ) as Record<string, string>;
  } else {
    tagMap = Object.fromEntries(
      Object.entries(visualTags).filter(
        ([k, v]) => !ASSET_META_KEYS.has(k) && typeof v === 'string' && String(v).trim()
      )
    ) as Record<string, string>;
  }

  if (options.wideShot) {
    tagMap = Object.fromEntries(
      Object.entries(tagMap).filter(([k]) => !WIDE_FACE_TAG_KEYS.has(k.toLowerCase()))
    );
  }

  return tagMap;
};

/**
 * Build a Tier A appearance snippet for one character.
 * Prefers structured tags; falls back to free-text description.
 */
export const buildCharacterAppearanceSnippet = (
  char: {
    name?: string;
    description?: string | null;
    visual_tags?: any;
  },
  options: { chapterId?: string | number | null; wideShot?: boolean } = {}
): string => {
  const name = (char.name || 'character').trim();
  const tagMap = flattenVisualTagMap(char.visual_tags, options);
  const tagValues = Object.values(tagMap).map((v) => String(v).trim()).filter(Boolean);

  if (tagValues.length > 0) {
    const label = options.wideShot ? 'outfit & build' : 'appearance';
    return `${name} ${label}: ${tagValues.join(', ')}`;
  }

  const desc = String(char.description || '').trim();
  if (desc) {
    // Keep description short so it does not drown the shot prompt
    const clipped = desc.length > 220 ? `${desc.slice(0, 220).trim()}…` : desc;
    return `${name} appearance: ${clipped}`;
  }

  return '';
};

/**
 * Merge multiple appearance snippets into a prompt (no double-append).
 */
export const mergeAppearanceIntoPrompt = (
  basePrompt: string,
  appearanceSnippets: string[]
): string => {
  let prompt = String(basePrompt || '').trim();
  for (const raw of appearanceSnippets) {
    const snippet = String(raw || '').trim();
    if (!snippet) continue;
    // Avoid duplicate injection when client already embedded the same text
    const needle = snippet.slice(0, Math.min(48, snippet.length));
    if (needle && prompt.toLowerCase().includes(needle.toLowerCase())) continue;
    prompt = prompt ? `${prompt}, ${snippet}` : snippet;
  }
  return prompt;
};

/**
 * Extract character LoRA filename from workflow payload or visual_tags.assets.
 */
export const resolveCharacterLoraFromWorkflow = (
  workflowData: any
): { name: string; strength: number } | null => {
  const explicit =
    workflowData?.character_lora
    || workflowData?.lora_name
    || workflowData?.lora_path;
  if (explicit && String(explicit).trim()) {
    return {
      name: String(explicit).trim(),
      strength: Number(workflowData?.lora_strength ?? workflowData?.character_lora_strength ?? 0.8)
    };
  }
  return null;
};

/**
 * Default adapter availability for this codebase revision (Tier B not wired).
 * Replace with real ComfyUI node probing when implementing Tier B.
 */
export const DEFAULT_ADAPTER_AVAILABILITY: AdapterAvailability = {
  characterAdapter: false,
  compositionControl: false
};
