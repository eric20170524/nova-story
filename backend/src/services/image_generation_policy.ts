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

export type PromptSubjectType =
  | 'female_human'
  | 'male_human'
  | 'human'
  | 'nonhuman'
  | 'mixed'
  | 'environment'
  | 'unknown';

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

const NONHUMAN_SUBJECT_RE =
  /\b(animal|creature|furry|furred|quadruped|paw|paws|paw pads?|whiskers?|muzzle|snout|beak|hooves?|tail|kitten|cat|puppy|dog|fox|rabbit|bunny|wolf|bear|otter|hamster|mouse|deer|bird)\b/i;
const FEMALE_HUMAN_RE =
  /\b(1girl|2girls|3girls|girl|girls|woman|women|female|goddess|princess|swordswoman|heroine|lady|ladies)\b/i;
const MALE_HUMAN_RE =
  /\b(1boy|2boys|3boys|boy|boys|man|men|male|prince|swordsman|hero|gentleman)\b/i;
const ENVIRONMENT_RE =
  /\b(extreme long shot|establishing shot|wide shot|long shot|panoramic|landscape|environment|overview|cityscape|plaza|square|amusement park|theme park|corridor|hallway|ticket booth|palace|hall|room|street|forest|mountains?|cloud sea)\b/i;
const ENVIRONMENT_SHOT_RE =
  /\b(extreme long shot|establishing shot|wide shot|long shot|panoramic|landscape|overview|aerial shot|overhead shot|bird'?s[- ]eye)\b/i;
const HUMAN_IDENTITY_CLAUSE_RE =
  /beautiful .*woman|chinese beauty|japanese anime beauty|east asian (?:facial|face)|delicate feminine face|soft jawline|pretty face|refined facial features|long flowing hair|fairy elegance|\b(?:1girl|2girls|3girls|female|woman|women|girl|girls)\b/i;
const HUMAN_IDENTITY_NEGATIVE_RE =
  /western face|caucasian|european face|\b(?:male|man|men|boy|boys|androgynous)\b|masculine face|beard|mustache|childlike face/i;

/** Infer subject semantics without inventing a gender or species. */
export const inferPromptSubjectType = (
  existingPrompt: string,
  explicitSubjectType?: string | null
): PromptSubjectType => {
  const explicit = String(explicitSubjectType || '').toLowerCase().trim();
  if (/mixed|multi-species|human[ _-]*(?:and|with)[ _-]*(?:animal|creature)/.test(explicit)) return 'mixed';
  if (/animal|nonhuman|non-human|creature|furry|quadruped/.test(explicit)) return 'nonhuman';
  if (/environment|landscape|location|scenery/.test(explicit)) return 'environment';
  if (/female|woman|girl/.test(explicit)) return 'female_human';
  if (/male|man|boy/.test(explicit)) return 'male_human';
  if (/human|person|people/.test(explicit)) return 'human';

  const prompt = String(existingPrompt || '');
  if (NONHUMAN_SUBJECT_RE.test(prompt)) return 'nonhuman';
  if (FEMALE_HUMAN_RE.test(prompt)) return 'female_human';
  if (MALE_HUMAN_RE.test(prompt)) return 'male_human';
  if (ENVIRONMENT_RE.test(prompt)) return 'environment';
  return 'unknown';
};

/** Remove legacy human-portrait clauses when structured scene data says otherwise. */
export const sanitizePromptForSubject = (
  prompt: string,
  subjectType?: string | null
): string => {
  const inferred = inferPromptSubjectType(prompt, subjectType);
  if (inferred !== 'nonhuman' && inferred !== 'environment') return String(prompt || '');
  return String(prompt || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !HUMAN_IDENTITY_CLAUSE_RE.test(part))
    .join(', ');
};

/** Human identity negatives can indirectly force an animal/environment prompt female. */
export const sanitizeNegativePromptForSubject = (
  prompt: string,
  subjectType?: string | null
): string => {
  const explicit = String(subjectType || '').toLowerCase();
  if (!/animal|nonhuman|non-human|creature|furry|quadruped|environment|landscape|location|scenery/.test(explicit)) {
    return String(prompt || '');
  }
  return String(prompt || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !HUMAN_IDENTITY_NEGATIVE_RE.test(part))
    .join(', ');
};

/**
 * Infer how aggressively style boosters may inject beauty/portrait language.
 * Does not require wardrobe_state fields — pure prompt heuristics.
 */
export const inferStyleShotMode = (
  existingPrompt: string,
  opts?: { genType?: string | null; shotType?: string | null; subjectType?: string | null }
): StyleShotMode => {
  const p = String(existingPrompt || '');
  const gen = String(opts?.genType || '').toLowerCase();
  const shot = String(opts?.shotType || '').toLowerCase();

  const subjectType = inferPromptSubjectType(p, opts?.subjectType);

  // A wide/establishing camera instruction is a composition contract even when
  // a character is present. Previously any detected animal/human prevented the
  // shot from entering environment mode, so Pony received no small-subject or
  // anti-portrait guidance and routinely turned wide shots into portraits.
  if (ENVIRONMENT_SHOT_RE.test(shot)) {
    return 'environment';
  }

  if (
    (ENVIRONMENT_RE.test(`${shot} ${p}`) || /\bempty (palace|hall|room|plaza|street)\b/i.test(p))
    && (subjectType === 'environment' || subjectType === 'unknown')
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

/** Split a comma-separated CLIP prompt into trimmed tokens (keeps weighted phrases intact). */
export const splitCsvPromptTokens = (text: string): string[] =>
  String(text || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

const QUALITY_TOKEN_RE =
  /^(score_\d+(?:_up)?|source_anime|source_cartoon|masterpiece|best quality)$/i;

export const isQualityPromptToken = (token: string): boolean => {
  const bare = String(token || '')
    .replace(/^\(+/, '')
    .replace(/\)+:[\d.]+$/, '')
    .replace(/\)+$/, '')
    .trim();
  return QUALITY_TOKEN_RE.test(bare);
};

/**
 * Final Pony/SD positive order: scene → shared framing → quality.
 * Template tokens like `cinematic shot` stay in framing; `score_*` / `source_anime` go last once.
 */
export const mergeClipPositivePrompt = (parts: {
  scene: string;
  framing?: string;
  templateText?: string;
  quality?: string;
}): string => {
  const sceneTokens = splitCsvPromptTokens(parts.scene);
  const framingTokens: string[] = [];
  const qualityTokens: string[] = [];

  const pushClassified = (token: string) => {
    if (isQualityPromptToken(token)) qualityTokens.push(token);
    else framingTokens.push(token);
  };

  for (const token of splitCsvPromptTokens(parts.framing || '')) pushClassified(token);
  for (const token of splitCsvPromptTokens(parts.templateText || '')) pushClassified(token);
  for (const token of splitCsvPromptTokens(parts.quality || '')) {
    // Explicit quality bag — force quality section even if misclassified.
    qualityTokens.push(token);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of [...sceneTokens, ...framingTokens, ...qualityTokens]) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out.join(', ');
};

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
  /** Structured shot_intent from scene.shot_spec (insert / establish / …). */
  shotIntent?: string | null;
  subjectType?: string | null;
  styleStrength?: number | null;
}): PromptEnhancement => {
  const {
    modelFamily,
    nsfwEnabled,
    stylePreset,
    loadedLoras = [],
    existingPrompt = '',
    genType = null,
    shotType = null,
    shotIntent = null,
    subjectType = null,
    styleStrength = null
  } = options;
  const lower = existingPrompt.toLowerCase();
  const prefixParts: string[] = [];
  const suffixParts: string[] = [];
  const negativeParts: string[] = [];

  const intent = String(shotIntent || '').toLowerCase().trim();
  const shotMode = inferStyleShotMode(existingPrompt, { genType, shotType, subjectType });
  const isActionLike = shotMode === 'action' || shotMode === 'aftermath';
  const isPortraitLike = shotMode === 'portrait' || intent === 'reaction';
  const isInsertShot =
    intent === 'insert'
    || /\b(insert shot|detail shot|macro shot|object close-up|prop close-up)\b/i.test(
      String(shotType || '')
    );
  // Insert must never inherit environment-dominant framing even if the prompt mentions a park.
  const isEnvironment =
    !isInsertShot
    && (intent === 'establish' || intent === 'wide-action' || intent === 'overhead-map' || shotMode === 'environment');
  const isNarrativeScene = String(genType || '').toLowerCase() === 'scene';
  const inferredSubject = inferPromptSubjectType(existingPrompt, subjectType);
  const isExplicitFemale = inferredSubject === 'female_human';

  // Shot intent wins over location vocabulary. Composition cues belong in the
  // CLIP *suffix* (after the scene action) so they do not steal the front window.
  if (isNarrativeScene && isInsertShot) {
    suffixParts.push(
      '(narrative insert shot:1.35), extreme detail of the specified prop or body part only, story environment still recognizable, no full face'
    );
    negativeParts.push(
      'animal portrait, full animal, full body character, face, eyes, looking at viewer, centered character, studio background, plain background'
    );
  } else if (isEnvironment) {
    suffixParts.push(
      'scenery, wide shot, establishing shot, (environment-dominant cinematic composition:1.4), (expansive detailed location:1.3), clear foreground middle ground and background'
    );
    if (inferredSubject !== 'environment' && inferredSubject !== 'unknown') {
      suffixParts.push(
        'animal far away, distant animal, (clearly visible small subject:1.3), subject occupies 15 to 20 percent of the frame, subject placed away from image center'
      );
    }
    negativeParts.push(
      'close-up, portrait, animal focus, solo focus, full-frame animal, face filling frame, oversized subject, centered character portrait, looking at viewer, studio background, plain background, simple background, shallow depth of field'
    );
  } else if (isNarrativeScene && isPortraitLike) {
    suffixParts.push(
      '(contextual narrative close-up:1.25), three-quarter or profile view, recognizable story location and props remain visible in the background'
    );
    negativeParts.push(
      'front-facing studio portrait, centered ID photo, looking at viewer, plain background, simple background, isolated character'
    );
  } else if (isNarrativeScene) {
    suffixParts.push(
      '(narrative scene composition:1.25), subject visibly interacting with the specified prop, recognizable environment, full story action readable'
    );
    negativeParts.push(
      'studio portrait, centered character portrait, looking at viewer, plain background, simple background, isolated character, face filling frame'
    );
  }

  // LoRA trigger tokens
  for (const slot of loadedLoras) {
    if (slot.triggerWords && !lower.includes(slot.triggerWords.toLowerCase())) {
      suffixParts.push(slot.triggerWords);
    }
  }

  // East-Asian feminine beauty: skip environment; lighten on action/aftermath so combat wins
  // Never invent a female human subject. Beauty anchors are legal only when the
  // prompt or structured request explicitly says the subject is female.
  if (isExplicitFemale && !isEnvironment) {
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
    negativeParts.push(EAST_ASIAN_FEMALE_NEGATIVE);
  }

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
      suffixParts.push('masterpiece, best quality');
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
      const strength = Number(styleStrength);
      suffixParts.push(
        Number.isFinite(strength) && strength > 0 && Math.abs(strength - 1) > 0.001
          ? `(${boost}:${strength})`
          : boost
      );
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
  // Scene action first; shared framing / style / quality follow (CLIP front window).
  return mergeClipPositivePrompt({
    scene: basePrompt,
    framing: joinUniqueCsv([enhancement.prefix, enhancement.suffix]),
  });
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
  const configuredStyleStrength =
    modelFamily === 'flux'
      ? comfy.flux_lora_strength ?? DEFAULT_STRENGTHS.flux_style
      : comfy.pony_lora_strength ?? DEFAULT_STRENGTHS.pony_style;
  const shotMode = inferStyleShotMode(basePrompt, {
    genType: workflowData?.gen_type ?? null,
    shotType: workflowData?.shot_type ?? null,
    subjectType: workflowData?.subject_type ?? null
  });
  // Detail/style LoRAs often amplify faces and fur. Keep them subtle on
  // environment shots so the location and spatial layout remain dominant.
  const isNarrativeScene = String(workflowData?.gen_type || '').toLowerCase() === 'scene';
  const workflowShotIntent = String(
    workflowData?.shot_intent || workflowData?.shot_spec?.shot_intent || ''
  ).toLowerCase();
  const isInsertShot =
    workflowShotIntent === 'insert'
    || /\b(insert shot|detail shot|macro shot|object close-up|prop close-up)\b/i.test(
      String(workflowData?.shot_type || '')
    );
  const styleStrength = isNarrativeScene
    ? Math.min(Number(configuredStyleStrength) || DEFAULT_STRENGTHS.pony_style, 0.35)
    : configuredStyleStrength;

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

  const resolvedLoras = resolveLoraStack({
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
  // Environment shots need spatial fidelity more than texture amplification.
  // Skip style/detail LoRAs entirely here; character LoRAs remain available.
  const loras = shotMode === 'environment' || isInsertShot
    ? resolvedLoras.filter((slot) => slot.role !== 'style')
    : resolvedLoras;

  const enhancement = buildPromptEnhancement({
    modelFamily,
    nsfwEnabled,
    stylePreset,
    loadedLoras: loras,
    existingPrompt: basePrompt,
    genType: workflowData?.gen_type ?? null,
    shotType: workflowData?.shot_type ?? null,
    shotIntent: workflowData?.shot_intent || workflowData?.shot_spec?.shot_intent || null,
    subjectType: workflowData?.subject_type ?? null,
    styleStrength: workflowData?.style_strength ?? null
  });

  return { loras, enhancement };
};

/**
 * LLM instructions for storyboard beat contracts.
 * Policy points at the server-side Pony compiler — do NOT ask for long English visual_prompt prose.
 */
export const buildTimelineVisualPromptPolicy = (nsfwEnabled: boolean): string => {
  if (nsfwEnabled) {
    return `
### Shot Contract Policy (NSFW mode ENABLED) — compiler fills final Pony tags:
- Fill location, primary_action, key_props (≤2), shot_intent, subject_scale. Chinese OK in contract fields.
- Set visual_prompt to "" (empty). Do NOT write a Detailed English scene description; the server compilePonyPrompt compiles tags.
- When intimacy/adult content is in the source, encode it as concrete visible actions/props/clothing state in the contract — do not euphemize into empty poetry and do not refuse.
- Prefer human subject locks from Character Visual Lock (1girl/2girls/3girls only when the lock already implies female humans). All characters are adults.
- Keep props concrete (jade mirror, silk bed, incense, flower petals).
- Across a chapter: insert+reaction ≤ 20%; establish+wide-action ≥ 35%.
`;
  }

  return `
### Shot Contract Policy (SFW / family-safe) — compiler fills final Pony tags:
- Fill location (paintable nouns only), primary_action (one visible verb), key_props (≤2), shot_intent, subject_scale, uniqueness_key.
- Chinese is allowed in contract fields. Set visual_prompt to "" (empty).
- Do NOT write a Detailed English scene description or long Pony prose; the server compilePonyPrompt compiles tags from the contract + Character Visual Lock.
- Never invent species tags absent from the Visual Lock (no kitten / 1girl / wolf / fox / dog paraphrases).
- Keep content safe-for-work: no nudity, no sexual acts. Intimate emotions → blush, averted gaze, hand-holding only if story requires.
- shot_intent enum: establish | wide-action | medium-action | insert | reaction | overhead-map | payoff.
- Use insert for paw/nose/ticket/map-button/music-box clues. Use establish/wide-action for geography.
- Across a chapter: close-ups/insert+reaction ≤ 20%; establish+wide-action ≥ 35%; at least one insert when key props exist.
- Adjacent uniqueness_key values must differ.
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
