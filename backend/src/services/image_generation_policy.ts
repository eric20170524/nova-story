/**
 * Image generation policy for local ComfyUI (Pony XL / SDXL primary).
 * FLUX.1-dev GGUF retired on 12GB stacks (2026-08); flux family code kept for
 * legacy custom workflows only.
 *
 * When NSFW is ON: auto-stack style + NSFW LoRAs (deduped) and inject unlock/trigger tags.
 * When NSFW is OFF: style/detail LoRA only + hard SFW negatives for non-adult titles.
 *
 * Filename discovery is pattern-based so similar installs (Incase / Detail / aidma, etc.)
 * work without manual paths; configured names always win when the file exists.
 */

import fs from 'fs';
import path from 'path';

/** Local Comfy model families. `flux` is legacy custom-graph only (GGUF retired 2026-08). */
export type ImageModelFamily = 'pony' | 'sd15' | 'flux';

/**
 * Normalize free-form model_type / reference_model_type strings from UI or API.
 * Unknown values and retired FLUX product defaults map to pony (except explicit flux graphs).
 */
export const normalizeImageModelFamily = (raw: unknown): ImageModelFamily => {
  const s = String(raw ?? 'pony').toLowerCase().trim();
  if (s.includes('flux')) return 'flux';
  if (
    s === 'sd15'
    || s === 'sd1.5'
    || s.includes('sd15')
    || s.includes('sd1.5')
    || /sd\s*1\.?5/.test(s)
  ) {
    return 'sd15';
  }
  return 'pony';
};

export interface LoraSlot {
  role: 'character' | 'style' | 'nsfw';
  name: string;
  strength: number;
  /** Optional tokens to append to the positive prompt when this LoRA is loaded */
  triggerWords?: string;
}

export interface PromptEnhancement {
  prefix: string;
  suffix: string;
  negativeExtra: string;
}

export interface LoraResolveInput {
  modelFamily: ImageModelFamily;
  nsfwEnabled: boolean;
  installPath?: string | null;
  /** Explicit character / custom LoRA from the request */
  characterLora?: string | null;
  characterLoraStrength?: number;
  /** Style LoRA config (comfyui.pony_lora / flux_lora) */
  styleLora?: string | null;
  styleLoraStrength?: number;
  /** NSFW LoRA config (advanced.pony_nsfw_lora / flux_nsfw_lora) */
  nsfwLora?: string | null;
  nsfwLoraStrength?: number;
  /** Visual style preset (affects whether Western NSFW LoRAs like Incase are used) */
  stylePreset?: string | null;
  /** When true, missing install_path still accepts configured names (remote ComfyUI) */
  allowRemoteUnverified?: boolean;
}

export interface ResolvedGenerationPlan {
  loras: LoraSlot[];
  enhancement: PromptEnhancement;
}

/** Default strengths tuned for 12GB stacks (detail + style without melting faces). */
export const DEFAULT_STRENGTHS = {
  pony_style: 0.65,
  pony_nsfw: 0.55,
  flux_style: 0.75,
  flux_nsfw: 0.75,
  character: 0.8
} as const;

/** Recommended filenames (used as config defaults / UI hints). */
export const RECOMMENDED_LORA_NAMES = {
  pony_style: 'Pony_DetailV2.0.safetensors',
  pony_nsfw: 'Incase_Style_PonyXL.safetensors',
  flux_style: 'XLabs_Flux_Realism.safetensors',
  flux_nsfw: 'aidmaNSFWunlock.safetensors'
} as const;

const PONY_STYLE_PATTERNS: RegExp[] = [
  /detail[_-]?v?2/i,
  /pony[_-]?detail/i,
  /detail[_-]?tweaker/i,
  /add[_-]?more[_-]?details/i,
  /best[_-]?of[_-]?pony/i,
  /cica[_-]?style/i
];

/** NSFW / adult-leaning Pony LoRAs — must NOT be picked as SFW style. */
const PONY_NSFW_PATTERNS: RegExp[] = [
  /incase/i,
  /expressiveh/i,
  /hentai/i,
  /nsfw/i,
  /explicit/i,
  /porn/i,
  /sex/i
];

const FLUX_STYLE_PATTERNS: RegExp[] = [
  /asian|guofeng|east[_-]?asian|xianxia|gufeng/i,
  /realism|xlabs/i,
  /best[_-]?of[_-]?flux/i,
  /flux.*style|style.*flux/i,
  /detail.*flux|flux.*detail/i
];

const FLUX_NSFW_PATTERNS: RegExp[] = [
  /aidma/i,
  /nsfw[_-]?unlock|unlock.*nsfw/i,
  /nude.*flux|flux.*nude/i,
  /nsfw/i
];

/** Trigger words known for popular LoRAs (matched by filename). */
const TRIGGER_BY_PATTERN: Array<{ pattern: RegExp; trigger: string }> = [
  { pattern: /expressiveh/i, trigger: 'Expressiveh' },
  { pattern: /aidma/i, trigger: 'aidmaNSFWunlock' },
  { pattern: /incase/i, trigger: '' } // Incase is often triggerless
];

/** Shared East-Asian feminine beauty anchors (Pony tags + FLUX phrases). */
export const EAST_ASIAN_FEMALE_BEAUTY_PONY =
  'beautiful East Asian woman, chinese beauty, japanese anime beauty, delicate feminine face, soft jawline, large expressive eyes, clear skin, pretty face, female, woman';
export const EAST_ASIAN_FEMALE_BEAUTY_FLUX =
  'beautiful young East Asian woman, Chinese and Japanese beauty aesthetics, delicate feminine face, soft facial contour, clear skin, elegant female features';
export const EAST_ASIAN_FEMALE_NEGATIVE =
  'western face, caucasian, european face, male, man, boy, androgynous, masculine face, ugly face, deformed face, asymmetrical eyes, cross-eyed, extra eyes, beard, mustache';

/**
 * Style boosters should describe look (color/light/medium), not narrative content
 * (clothing integrity, portrait composition, fashion pose). Content words are
 * stripped on action/aftermath shots via stripStyleNarrativeTokens().
 */
const STYLE_PRESET_BOOSTERS: Record<string, { pony: string; flux: string }> = {
  ancient_fantasy: {
    pony: `ancient chinese xianxia, guofeng national style, ethereal silk texture rendering, volumetric light, semi-realistic digital painting`,
    flux: `ancient Chinese xianxia fantasy, guofeng national style, ethereal silk textures, volumetric god rays`
  },
  xianxia_immortal: {
    pony: `xianxia immortal aesthetic, cool jade tones, soft volumetric godrays, ethereal atmosphere, polished semi-realistic illustration`,
    flux: `xianxia immortal aesthetic, cool jade and mist tones, translucent fabric lighting, serene atmosphere`
  },
  ethereal_glow: {
    pony: `ethereal bloom, soft glow, light particles, dreamy backlighting, smooth digital polish`,
    flux: `ethereal bloom and soft glow, luminous highlights, delicate light particles, dreamy backlighting`
  },
  guoman_painterly: {
    pony: `chinese manhua painterly, thick brushwork, strong rim light, national comic illustration finish`,
    flux: `Chinese manhua thick painterly style, rich digital brushwork, dramatic rim light`
  },
  sensual_gufeng: {
    // 魅惑古风：色调/材质/光影；alluring/sheer/intimate 在 action 镜会被自动剥离
    pony: `alluring ancient chinese guofeng fantasy illustration, sheer fabric rim light, warm gold and deep crimson accents, luxurious silk texture, intimate atmospheric haze, refined semi-realistic digital painting, dramatic chiaroscuro`,
    flux: `alluring ancient Chinese guofeng fantasy, sheer fabric rim light, luxurious silk texture, intimate atmospheric haze, cinematic lighting`
  },
  elegant_mature: {
    pony: `elegant mature aesthetic, refined semi-realistic face rendering, sophisticated proportions, cinematic key light`,
    flux: `elegant mature aesthetic, refined semi-realistic face, sophisticated proportions, soft cinematic key light`
  },
  alluring_portrait: {
    // Portrait-oriented; on action/aftermath becomes lighting-only via strip
    pony: `alluring portrait, soft beauty lighting, skin highlights, shallow depth of field`,
    flux: `alluring portrait, soft beauty lighting, subtle skin highlights, shallow depth of field`
  },
  anime: {
    pony: `source_anime, cel shaded, clean lines, vibrant colors`,
    flux: `anime illustration style, clean lines, vibrant colors`
  },
  cinematic_photo: {
    pony: 'cinematic lighting, shallow depth of field, film still, film grain',
    flux: 'cinematic photorealistic still, natural skin texture, realistic lens bokeh, film color grade, shot on 50mm'
  },
  aesthetic_romance: {
    pony: 'aesthetic romantic, soft color grading, poetic atmosphere, gentle depth of field',
    flux: 'aesthetic romantic illustration, soft cinematic color grading, poetic atmosphere, gentle depth of field'
  },
  game_illustration: {
    pony: 'game character splash art shading, sharp silhouette, polished anime-semireal shading',
    flux: 'premium game character illustration shading, splash-art quality materials, cinematic character spotlight'
  },
  semi_realistic: {
    pony: 'semi-realistic digital painting, soft blending, cinematic lighting, detailed eyes',
    flux: 'semi-realistic digital painting, East Asian facial structure, subsurface scattering, cinematic lighting'
  },
  ink_wash: {
    pony: 'ink wash painting, sumi-e, brushstrokes, negative space',
    flux: 'traditional ink wash painting, sumi-e, visible brushstrokes, rice paper texture, negative space'
  }
};

/** Tokens that describe narrative content / portrait lock — strip on action & aftermath */
const STYLE_NARRATIVE_STRIP_RE =
  /\b(alluring|intimate|sheer fabric(?: rim light)?|portrait|looking at viewer|beauty portrait|elegant portrait|fashion pose|fully clothed|artistic portrait|group portrait|splash-art pose)\b/gi;

export type StyleShotMode = 'portrait' | 'action' | 'aftermath' | 'environment' | 'general';

/**
 * Infer how aggressively style boosters may inject beauty/portrait language.
 * Does not require wardrobe_state fields — pure prompt heuristics.
 */
export const inferStyleShotMode = (
  existingPrompt: string,
  opts?: { genType?: string | null; shotType?: string | null }
): StyleShotMode => {
  const p = String(existingPrompt || '');
  const gen = String(opts?.genType || '').toLowerCase();
  const shot = String(opts?.shotType || '').toLowerCase();

  if (
    /\bextreme long shot\b|\bestablishing\b|\bcloud sea\b|\bempty (palace|hall|room)\b/i.test(p)
    && !/\b1girl\b|\b2girls\b|\b3girls\b|woman|portrait|goddess|immortal|martial/i.test(p)
  ) {
    return 'environment';
  }

  if (
    /(torn|ripped|tattered|battle damage|clothing damage|disheveled|defeated|lying on|on (her|his|the) back|pinned|knee (on|pinning|pin)|aftermath|破损|撕|倒地|战损)/i.test(
      p
    )
  ) {
    return 'aftermath';
  }

  if (
    /(whip kick|grappling|clinch|throw|hand-to-hand|martial arts combat|combat|fight|clash|strike|punch|kick|dash|action still|打斗|体术|交锋)/i.test(
      p
    )
  ) {
    return 'action';
  }

  if (
    gen === 'portrait'
    || /\b(portrait|bust shot|upper body only|looking at viewer)\b/i.test(p)
    || (/\b(close-?up|extreme close)\b/i.test(shot) && !/\b(2girls|3girls|combat|fight)\b/i.test(p))
  ) {
    return 'portrait';
  }

  return 'general';
};

/** Strip content/portrait locks from a style booster string for action/aftermath. */
export const stripStyleNarrativeTokens = (boost: string): string => {
  return boost
    .replace(STYLE_NARRATIVE_STRIP_RE, ' ')
    .replace(/,\s*,/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^,\s*|,\s*$/g, '')
    .trim();
};

const listLoraFiles = (installPath?: string | null): string[] => {
  if (!installPath) return [];
  const loraDirectory = path.join(String(installPath), 'models', 'loras');
  if (!fs.existsSync(loraDirectory)) return [];
  try {
    return fs
      .readdirSync(loraDirectory)
      .filter((filename) => /\.(safetensors|ckpt|pt)$/i.test(filename))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
};

const fileExistsInInstall = (installPath: string | null | undefined, filename: string): boolean => {
  if (!installPath) return false;
  return fs.existsSync(path.join(String(installPath), 'models', 'loras', path.basename(filename)));
};

const pickByPatterns = (
  candidates: string[],
  patterns: RegExp[],
  excludePatterns: RegExp[] = []
): string | null => {
  const filtered = candidates.filter(
    (name) => !excludePatterns.some((p) => p.test(name))
  );
  for (const pattern of patterns) {
    const hit = filtered.find((name) => pattern.test(name));
    if (hit) return hit;
  }
  return null;
};

const resolveTrigger = (filename: string): string | undefined => {
  for (const entry of TRIGGER_BY_PATTERN) {
    if (entry.pattern.test(filename) && entry.trigger) return entry.trigger;
  }
  return undefined;
};

/**
 * Resolve a single configured or auto-discovered LoRA filename.
 * - Configured path wins when present on disk (or remote-unverified).
 * - Otherwise pattern discovery runs.
 * - When NSFW is off, adult-named LoRAs are never returned for style.
 */
export const resolveNamedOrDiscoveredLora = (options: {
  configured?: string | null;
  installPath?: string | null;
  allowRemoteUnverified?: boolean;
  patterns: RegExp[];
  excludePatterns?: RegExp[];
  /** Fallback: any remaining file matching loose hint */
  fallbackPatterns?: RegExp[];
}): string | null => {
  const {
    configured,
    installPath,
    allowRemoteUnverified,
    patterns,
    excludePatterns = [],
    fallbackPatterns = []
  } = options;

  const configuredName = configured ? String(configured).trim() : '';
  if (configuredName) {
    const base = path.basename(configuredName);
    if (!installPath && allowRemoteUnverified !== false) {
      return base;
    }
    if (fileExistsInInstall(installPath, base)) {
      return base;
    }
  }

  const candidates = listLoraFiles(installPath);
  if (candidates.length === 0) return null;

  return (
    pickByPatterns(candidates, patterns, excludePatterns)
    || pickByPatterns(candidates, fallbackPatterns, excludePatterns)
  );
};

export const resolveStyleLora = (
  modelFamily: ImageModelFamily,
  nsfwEnabled: boolean,
  input: Pick<LoraResolveInput, 'installPath' | 'styleLora' | 'allowRemoteUnverified'>
): string | null => {
  // SD1.5 draft stack: do not auto-attach Pony/SDXL LoRAs (wrong architecture).
  if (modelFamily === 'sd15') {
    return null;
  }

  if (modelFamily === 'flux') {
    // Prefer Asian/guofeng first, then realism — never pick pure NSFW unlock as style.
    return resolveNamedOrDiscoveredLora({
      configured: input.styleLora,
      installPath: input.installPath,
      allowRemoteUnverified: input.allowRemoteUnverified,
      patterns: FLUX_STYLE_PATTERNS,
      excludePatterns: FLUX_NSFW_PATTERNS.filter((p) => /aidma|nsfw[_-]?unlock/i.test(p.source)),
      fallbackPatterns: [/flux/i]
    });
  }

  // Pony: style = detail / quality. Never auto-pick Incase etc. as style when SFW.
  const excludeNsfw = nsfwEnabled ? [] : PONY_NSFW_PATTERNS;
  return resolveNamedOrDiscoveredLora({
    configured: input.styleLora,
    installPath: input.installPath,
    allowRemoteUnverified: input.allowRemoteUnverified,
    patterns: PONY_STYLE_PATTERNS,
    excludePatterns: excludeNsfw,
    fallbackPatterns: nsfwEnabled ? [/pony/i] : [/pony|detail/i]
  });
};

export const resolveNsfwLora = (
  modelFamily: ImageModelFamily,
  input: Pick<LoraResolveInput, 'installPath' | 'nsfwLora' | 'allowRemoteUnverified'>
): string | null => {
  // SD1.5 draft: skip Pony/Incase NSFW LoRAs (incompatible).
  if (modelFamily === 'sd15') {
    return null;
  }

  if (modelFamily === 'flux') {
    return resolveNamedOrDiscoveredLora({
      configured: input.nsfwLora,
      installPath: input.installPath,
      allowRemoteUnverified: input.allowRemoteUnverified,
      patterns: FLUX_NSFW_PATTERNS,
      fallbackPatterns: [/nsfw/i]
    });
  }

  return resolveNamedOrDiscoveredLora({
    configured: input.nsfwLora,
    installPath: input.installPath,
    allowRemoteUnverified: input.allowRemoteUnverified,
    patterns: PONY_NSFW_PATTERNS,
    // Prefer Incase-style over generic "detail" misconfiguration
    fallbackPatterns: [/incase|expressiveh|hentai/i]
  });
};

export const resolveLoraStack = (input: LoraResolveInput): LoraSlot[] => {
  const slots: LoraSlot[] = [];
  const used = new Set<string>();
  const allowRemote = input.allowRemoteUnverified !== false && !input.installPath;

  const push = (slot: LoraSlot | null) => {
    if (!slot?.name) return;
    const key = path.basename(slot.name).toLowerCase();
    if (used.has(key)) return;
    // Local install: skip missing files
    if (input.installPath && !fileExistsInInstall(input.installPath, slot.name) && !allowRemote) {
      return;
    }
    if (!input.installPath && !allowRemote) return;
    used.add(key);
    slots.push({
      ...slot,
      name: path.basename(slot.name),
      triggerWords: slot.triggerWords ?? resolveTrigger(slot.name)
    });
  };

  if (input.characterLora) {
    push({
      role: 'character',
      name: path.basename(String(input.characterLora)),
      strength: Number(input.characterLoraStrength ?? DEFAULT_STRENGTHS.character)
    });
  }

  const styleName = resolveStyleLora(input.modelFamily, input.nsfwEnabled, {
    installPath: input.installPath,
    styleLora: input.styleLora,
    allowRemoteUnverified: input.allowRemoteUnverified
  });

  const defaultStyleStrength =
    input.modelFamily === 'flux'
      ? DEFAULT_STRENGTHS.flux_style
      : DEFAULT_STRENGTHS.pony_style;

  if (styleName) {
    push({
      role: 'style',
      name: styleName,
      strength: Number(input.styleLoraStrength ?? defaultStyleStrength)
    });
  }

  const stylePreset = String(input.stylePreset || '').toLowerCase();
  const isGuofengFamily =
    /gufeng|xianxia|ancient_fantasy|guoman|ethereal|sensual|immortal|guofeng/.test(stylePreset);

  if (input.nsfwEnabled) {
    const nsfwName = resolveNsfwLora(input.modelFamily, {
      installPath: input.installPath,
      nsfwLora: input.nsfwLora,
      allowRemoteUnverified: input.allowRemoteUnverified
    });
    const defaultNsfwStrength =
      input.modelFamily === 'flux' ? DEFAULT_STRENGTHS.flux_nsfw : DEFAULT_STRENGTHS.pony_nsfw;

    if (nsfwName) {
      // If config accidentally points NSFW at the same detail file as style, try rediscovery
      const styleKey = styleName ? path.basename(styleName).toLowerCase() : '';
      let finalNsfw = nsfwName;
      if (path.basename(nsfwName).toLowerCase() === styleKey) {
        const rediscovered = resolveNsfwLora(input.modelFamily, {
          installPath: input.installPath,
          nsfwLora: null,
          allowRemoteUnverified: false
        });
        if (rediscovered && path.basename(rediscovered).toLowerCase() !== styleKey) {
          finalNsfw = rediscovered;
        } else {
          finalNsfw = ''; // skip duplicate
        }
      }

      // Incase is a Western/comic NSFW style LoRA — it fights guofeng/xianxia East-Asian faces.
      // For 国风/仙侠 presets, rely on uncensored Pony base + explicit tags instead of Incase.
      if (
        finalNsfw
        && input.modelFamily === 'pony'
        && isGuofengFamily
        && /incase/i.test(finalNsfw)
      ) {
        finalNsfw = '';
      }

      if (finalNsfw) {
        let strength = Number(input.nsfwLoraStrength ?? defaultNsfwStrength);
        if (isGuofengFamily && input.modelFamily === 'pony') {
          strength = Math.min(strength, 0.4);
        }
        push({
          role: 'nsfw',
          name: finalNsfw,
          strength
        });
      }
    }
  }

  return slots;
};

const joinUniqueCsv = (parts: string[]): string =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((part, index, arr) => arr.findIndex((x) => x.toLowerCase() === part.toLowerCase()) === index)
    .join(', ');

/**
 * Build positive/negative prompt boosters for model + NSFW mode + optional style preset.
 * Style must not override narrative clothing state or combat composition.
 * Does NOT force explicit content into every frame when NSFW is on — only unlocks quality/triggers.
 */
export const buildPromptEnhancement = (options: {
  modelFamily: ImageModelFamily;
  nsfwEnabled: boolean;
  stylePreset?: string | null;
  loadedLoras?: LoraSlot[];
  existingPrompt?: string;
  /** Optional hints for style shot mode (gen_type / shot_type) */
  genType?: string | null;
  shotType?: string | null;
}): PromptEnhancement => {
  const {
    modelFamily,
    nsfwEnabled,
    stylePreset,
    loadedLoras = [],
    existingPrompt = '',
    genType = null,
    shotType = null
  } = options;
  const lower = existingPrompt.toLowerCase();
  const prefixParts: string[] = [];
  const suffixParts: string[] = [];
  const negativeParts: string[] = [];

  const shotMode = inferStyleShotMode(existingPrompt, { genType, shotType });
  const isActionLike = shotMode === 'action' || shotMode === 'aftermath';
  const isPortraitLike = shotMode === 'portrait';
  const isEnvironment = shotMode === 'environment';

  // LoRA trigger tokens
  for (const slot of loadedLoras) {
    if (slot.triggerWords && !lower.includes(slot.triggerWords.toLowerCase())) {
      suffixParts.push(slot.triggerWords);
    }
  }

  // East-Asian feminine beauty: skip environment; lighten on action/aftermath so combat wins
  const looksLikeMaleOnly =
    /\b1boy\b|\b2boys\b|\bmen only\b/i.test(existingPrompt)
    && !/\b1girl\b|\b2girls\b|\b3girls\b|woman|female/i.test(existingPrompt);

  if (!looksLikeMaleOnly && !isEnvironment) {
    if (isActionLike) {
      // Identity only — no heavy beauty-portrait stack
      if (modelFamily === 'pony' || modelFamily === 'sd15') {
        if (!/(east asian|chinese beauty)/i.test(existingPrompt)) {
          suffixParts.push('East Asian features, female');
        }
      } else if (!/(east asian|chinese|japanese|korean)/i.test(existingPrompt)) {
        suffixParts.push('East Asian facial features, female');
      }
    } else if (modelFamily === 'pony') {
      if (!/(east asian|chinese beauty|japanese anime beauty)/i.test(existingPrompt)) {
        suffixParts.push(EAST_ASIAN_FEMALE_BEAUTY_PONY);
      }
    } else if (modelFamily === 'sd15') {
      if (!/(east asian|chinese beauty|japanese anime beauty)/i.test(existingPrompt)) {
        suffixParts.push(
          'beautiful East Asian woman, delicate feminine face, large expressive eyes, clear skin, pretty face, female'
        );
      }
    } else if (!/(east asian|chinese|japanese|korean)/i.test(existingPrompt)) {
      suffixParts.push(EAST_ASIAN_FEMALE_BEAUTY_FLUX);
    }
  }
  negativeParts.push(EAST_ASIAN_FEMALE_NEGATIVE);

  if (modelFamily === 'pony') {
    if (nsfwEnabled) {
      const intimateCue =
        /(nude|naked|sex|breast|nipple|yuri|nsfw|intimate|penetration|tentacle|pussy|penis|topless|bottomless|undress|半裸|裸|乳|交合|春潮)/i.test(
          existingPrompt
        );
      if (!/\brating_/i.test(existingPrompt)) {
        suffixParts.push(
          intimateCue
            ? 'rating_explicit, rating_questionable'
            : 'rating_safe, rating_questionable, rating_explicit'
        );
      }
      suffixParts.push(intimateCue ? 'detailed skin, refined anatomy' : 'detailed skin');
    } else {
      if (!/source_anime|source_cartoon/i.test(existingPrompt)) {
        suffixParts.push('source_anime');
      }
      // SFW = no sex/genitalia — NOT "fully clothed fashion". Allow battle tears.
      negativeParts.push(
        'nsfw, nude, genitalia, sexual act, pussy, penis, sex'
      );
      // On non-damage shots still discourage gratuitous exposure; on aftermath allow tears
      if (!isActionLike) {
        negativeParts.push('explicit sexual content, exposed breasts');
      } else {
        negativeParts.push('explicit sexual content');
      }
    }
  } else if (modelFamily === 'sd15') {
    // Danbooru-style drafts: quality tags, no Pony score/rating system
    if (!/masterpiece|best quality/i.test(existingPrompt)) {
      prefixParts.push('masterpiece, best quality');
    }
    if (nsfwEnabled) {
      suffixParts.push('detailed skin');
    } else {
      negativeParts.push('nsfw, nude, genitalia, sexual act, explicit sexual content');
      if (!isActionLike) {
        negativeParts.push('exposed breasts');
      }
    }
  } else {
    if (nsfwEnabled) {
      suffixParts.push('detailed skin texture, natural anatomy');
    } else {
      negativeParts.push('nsfw, nude, genitalia, sexual act, explicit sexual content');
      if (!isActionLike) {
        negativeParts.push('exposed breasts');
      }
    }
  }

  // Shared quality / safety
  negativeParts.push(
    'low quality, worst quality, bad anatomy, extra limbs, text, watermark, child, loli, shota, blurry face, mutated hands'
  );

  const presetKey = stylePreset ? String(stylePreset).toLowerCase() : '';
  const booster = presetKey ? STYLE_PRESET_BOOSTERS[presetKey] : undefined;
  if (booster) {
    // SD1.5 drafts use tag-like pony boosters; FLUX custom graphs use natural phrases
    let boost = modelFamily === 'flux' ? booster.flux : booster.pony;
    // (2) Auto-strip alluring / intimate / portrait locks on action & aftermath
    if (isActionLike) {
      boost = stripStyleNarrativeTokens(boost);
    }
    // alluring_portrait on non-portrait scene shots: keep lighting only
    if (presetKey === 'alluring_portrait' && !isPortraitLike) {
      boost = stripStyleNarrativeTokens(boost);
      if (!boost) {
        boost = 'soft beauty lighting, shallow depth of field';
      }
    }
    const boostTokens = boost.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 2);
    const already = boostTokens.length > 0 && boostTokens.every((t) => t && lower.includes(t));
    if (!already && boost) {
      suffixParts.push(boost);
    }
  } else if (
    /(xianxia|guofeng|hanfu|immortal|仙|古风|汉服|仙侠)/i.test(existingPrompt)
    && !/(east asian|guofeng|xianxia)/i.test(existingPrompt)
  ) {
    suffixParts.push(
      modelFamily === 'flux'
        ? 'East Asian facial features, ancient Chinese fantasy atmosphere'
        : 'East Asian features, ancient chinese fantasy, guofeng'
    ); // pony + sd15
  }

  // (1) Default: NO fully clothed / artistic portrait.
  // Portrait mode only: soft elegance (not clothing lock).
  // Action/aftermath: anti-fashion-pose negatives + combat-friendly positives.
  if (!nsfwEnabled) {
    negativeParts.push('nude, nipples, explicit');
    if (isPortraitLike) {
      suffixParts.push('tasteful elegance');
    } else if (shotMode === 'aftermath') {
      suffixParts.push('tasteful action still, combat aftermath, ripped fabric edges visible');
      negativeParts.push(
        'intact pristine dress, perfect undamaged clothing, dual standing fashion pose, glamorous group portrait, looking at viewer selfie pose, both standing idle'
      );
    } else if (shotMode === 'action') {
      suffixParts.push('tasteful action still, dynamic combat composition');
      negativeParts.push(
        'dual standing fashion pose, glamorous group portrait, looking at viewer selfie pose, static beauty portrait only'
      );
    }
    // general / environment: no fully clothed injection
  }

  return {
    prefix: joinUniqueCsv(prefixParts),
    suffix: joinUniqueCsv(suffixParts),
    negativeExtra: joinUniqueCsv(negativeParts)
  };
};

export const applyPromptEnhancement = (
  basePrompt: string,
  enhancement: PromptEnhancement
): string => {
  const parts = [enhancement.prefix, basePrompt, enhancement.suffix]
    .map((p) => p.trim())
    .filter(Boolean);
  return joinUniqueCsv(parts);
};

/**
 * Resolve full plan from runtime settings + request workflow payload.
 */
export const resolveGenerationPlan = (options: {
  modelFamily: ImageModelFamily;
  nsfwEnabled: boolean;
  runtimeSettings: any;
  workflowData?: any;
  basePrompt?: string;
}): ResolvedGenerationPlan => {
  const { modelFamily, nsfwEnabled, runtimeSettings, workflowData = {}, basePrompt = '' } = options;
  const comfy = runtimeSettings?.comfyui || {};
  const advanced = runtimeSettings?.advanced || {};

  const styleLora =
    modelFamily === 'flux'
      ? comfy.flux_lora
      : modelFamily === 'sd15'
        ? null
        : comfy.pony_lora;
  const styleStrength =
    modelFamily === 'flux'
      ? comfy.flux_lora_strength ?? DEFAULT_STRENGTHS.flux_style
      : comfy.pony_lora_strength ?? DEFAULT_STRENGTHS.pony_style;

  const nsfwLora =
    modelFamily === 'flux'
      ? advanced.flux_nsfw_lora
      : modelFamily === 'sd15'
        ? null
        : advanced.pony_nsfw_lora;

  const characterLora =
    workflowData?.lora_name || workflowData?.lora_path || workflowData?.character_lora;

  const stylePreset =
    workflowData?.style_preset || workflowData?.style || workflowData?.visual_style || null;

  const loras = resolveLoraStack({
    modelFamily,
    nsfwEnabled,
    installPath: comfy.install_path,
    characterLora,
    characterLoraStrength: workflowData?.lora_strength,
    styleLora,
    styleLoraStrength: styleStrength,
    nsfwLora,
    nsfwLoraStrength: advanced.nsfw_lora_strength,
    stylePreset,
    allowRemoteUnverified: !comfy.install_path
  });

  const enhancement = buildPromptEnhancement({
    modelFamily,
    nsfwEnabled,
    stylePreset,
    loadedLoras: loras,
    existingPrompt: basePrompt,
    genType: workflowData?.gen_type ?? null,
    shotType: workflowData?.shot_type ?? null
  });

  return { loras, enhancement };
};

/** LLM instructions appended when generating storyboard visual_prompts. */
export const buildTimelineVisualPromptPolicy = (nsfwEnabled: boolean): string => {
  if (nsfwEnabled) {
    return `
### Image Model Policy (NSFW mode ENABLED):
- visual_prompt MUST be detailed English suitable for Pony XL / SDXL (final) or SD1.5 draft local models.
- Prefer tag-friendly phrasing for character shots: subject count (1girl/2girls/3girls), hair, eyes, clothing state, pose, action, environment, lighting.
- When the source text depicts intimacy or adult content, describe it with clear visual tags (clothing disheveled, body contact, expressions, magical aura) — do NOT euphemize into empty poetry and do NOT refuse.
- Still avoid underage cues. All characters are adults.
- For multi-person intimate scenes, prefer 2 subjects per shot when poses are complex; use 3girls only for simpler group framing.
- Keep environment props concrete (jade mirror, silk bed, incense, flower petals, cloud sea palace).
- Do NOT write Chinese inside visual_prompt; keep Chinese only in dialogue if needed.
`;
  }

  return `
### Image Model Policy (SFW / family-safe mode):
- visual_prompt MUST be detailed English suitable for Pony XL / SDXL finals or SD1.5 draft previews.
- Prefer tag-friendly phrasing: subject count, hair, eyes, full costume, pose, expression, environment, lighting.
- Keep content safe-for-work: no nudity, no sexual acts, no explicit body focus. Intimate emotions → blush, averted gaze, close standing, hand-holding only if story requires.
- Emphasize costume design, cinematic composition, and atmosphere (xianxia mist, palace, volumetric light).
- Do NOT write Chinese inside visual_prompt; keep Chinese only in dialogue if needed.
`;
};

/** Quality header for character portrait / turnaround build-prompt. */
export const buildCharacterPromptHeader = (
  modelFamily: ImageModelFamily,
  nsfwEnabled: boolean,
  genType: string
): { prefix: string; negative: string } => {
  if (modelFamily === 'pony') {
    // turnaround prompt is appearance base only — pipeline generates front/side/back panels then stitches
    const base =
      genType === 'turnaround'
        ? `score_9, score_8_up, score_7_up, source_anime, full body character design, consistent character identity, 1girl, solo, female, ${EAST_ASIAN_FEMALE_BEAUTY_PONY}`
        : `score_9, score_8_up, score_7_up, source_anime, portrait, upper body, front view, masterpiece, detailed face and eyes, 1girl, solo, female, ${EAST_ASIAN_FEMALE_BEAUTY_PONY}`;
    const negCore = `${EAST_ASIAN_FEMALE_NEGATIVE}, score_4, score_3, score_2, score_1, bad anatomy, low quality, worst quality, cropped head, blurry, extra limbs, mismatched clothing, inconsistent face, child, loli`;
    const neg = nsfwEnabled
      ? negCore
      : `${negCore}, nsfw, nude`;
    return { prefix: base, negative: neg };
  }

  if (modelFamily === 'sd15') {
    const base =
      genType === 'turnaround'
        ? `masterpiece, best quality, full body character design, consistent character identity, 1girl, solo, female, beautiful East Asian woman, delicate feminine face, clear skin`
        : `masterpiece, best quality, portrait, upper body, front view, detailed face and eyes, 1girl, solo, female, beautiful East Asian woman, delicate feminine face`;
    const negCore = `${EAST_ASIAN_FEMALE_NEGATIVE}, lowres, bad anatomy, low quality, worst quality, cropped head, blurry, extra limbs, mismatched clothing, inconsistent face, child, loli`;
    const neg = nsfwEnabled ? negCore : `${negCore}, nsfw, nude`;
    return { prefix: base, negative: neg };
  }

  // Legacy custom FLUX graphs only
  const base =
    genType === 'turnaround'
      ? `full body character design, consistent character identity, clean studio white background, masterpiece quality, 1girl, female, ${EAST_ASIAN_FEMALE_BEAUTY_FLUX}`
      : `high quality character portrait, front view, detailed face and eyes, clean studio background, 1girl, female, ${EAST_ASIAN_FEMALE_BEAUTY_FLUX}`;
  const negCore = `${EAST_ASIAN_FEMALE_NEGATIVE}, low quality, distorted face, bad anatomy, extra limbs, cluttered background, inconsistent costume, child`;
  const neg = nsfwEnabled ? negCore : `${negCore}, nsfw, nude`;
  return { prefix: base, negative: neg };
};
