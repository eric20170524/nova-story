/**
 * Image generation policy for local ComfyUI (Pony XL / FLUX.1-dev GGUF).
 *
 * When NSFW is ON: auto-stack style + NSFW LoRAs (deduped) and inject unlock/trigger tags.
 * When NSFW is OFF: style/detail LoRA only + hard SFW negatives for non-adult titles.
 *
 * Filename discovery is pattern-based so similar installs (Incase / Detail / aidma, etc.)
 * work without manual paths; configured names always win when the file exists.
 */

import fs from 'fs';
import path from 'path';

export type ImageModelFamily = 'pony' | 'flux';

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

const STYLE_PRESET_BOOSTERS: Record<string, { pony: string; flux: string }> = {
  ancient_fantasy: {
    pony: 'ancient chinese xianxia, guofeng, East Asian features, ethereal silk, volumetric light',
    flux: 'ancient Chinese xianxia fantasy, East Asian facial features, guofeng national style, ethereal silk textures, volumetric god rays'
  },
  xianxia_immortal: {
    pony: 'xianxia immortal, cool jade tones, sheer fabric light, East Asian features, ethereal atmosphere',
    flux: 'xianxia immortal aesthetic, East Asian beauty, cool jade and mist tones, translucent fabric lighting, serene atmosphere'
  },
  ethereal_glow: {
    pony: 'ethereal bloom, soft glow, luminous skin, light particles, dreamy backlighting',
    flux: 'ethereal bloom and soft glow, luminous skin highlights, delicate light particles, dreamy backlighting'
  },
  guoman_painterly: {
    pony: 'chinese manhua painterly, thick brushwork, strong rim light, East Asian features',
    flux: 'Chinese manhua thick painterly style, East Asian features, rich digital brushwork, dramatic rim light'
  },
  sensual_gufeng: {
    pony: 'alluring ancient chinese fantasy, sheer fabric rim light, luxurious silk, intimate atmosphere',
    flux: 'alluring ancient Chinese fantasy beauty, sheer fabric rim light, luxurious silk, intimate atmospheric haze'
  },
  elegant_mature: {
    pony: 'elegant mature beauty, refined semi-realistic face, sophisticated proportions, cinematic key light',
    flux: 'elegant mature East Asian beauty, refined semi-realistic face, sophisticated proportions, soft cinematic key light'
  },
  alluring_portrait: {
    pony: 'alluring portrait, soft beauty lighting, skin highlights, shallow depth of field',
    flux: 'alluring portrait, soft beauty lighting, subtle skin highlights, shallow depth of field, magazine key visual'
  },
  anime: {
    pony: 'source_anime, cel shaded, clean lines, vibrant colors',
    flux: 'anime illustration style, clean lines, vibrant colors, East Asian anime features'
  },
  cinematic_photo: {
    pony: 'cinematic lighting, shallow depth of field, film still',
    flux: 'cinematic photorealistic still, natural skin texture, realistic lens bokeh, film color grade, shot on 50mm'
  },
  aesthetic_romance: {
    pony: 'aesthetic romantic, soft color grading, poetic atmosphere, elegant portrait',
    flux: 'aesthetic romantic illustration, soft cinematic color grading, poetic atmosphere, gentle depth of field'
  },
  game_illustration: {
    pony: 'game character splash art, sharp silhouette, polished anime-semireal shading',
    flux: 'premium game character illustration, splash-art quality, sharp costume silhouette, cinematic character spotlight'
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
    input.modelFamily === 'flux' ? DEFAULT_STRENGTHS.flux_style : DEFAULT_STRENGTHS.pony_style;

  if (styleName) {
    push({
      role: 'style',
      name: styleName,
      strength: Number(input.styleLoraStrength ?? defaultStyleStrength)
    });
  }

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
      if (finalNsfw) {
        push({
          role: 'nsfw',
          name: finalNsfw,
          strength: Number(input.nsfwLoraStrength ?? defaultNsfwStrength)
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
 * Does NOT force explicit content into every frame when NSFW is on — only unlocks quality/triggers.
 */
export const buildPromptEnhancement = (options: {
  modelFamily: ImageModelFamily;
  nsfwEnabled: boolean;
  stylePreset?: string | null;
  loadedLoras?: LoraSlot[];
  existingPrompt?: string;
}): PromptEnhancement => {
  const { modelFamily, nsfwEnabled, stylePreset, loadedLoras = [], existingPrompt = '' } = options;
  const lower = existingPrompt.toLowerCase();
  const prefixParts: string[] = [];
  const suffixParts: string[] = [];
  const negativeParts: string[] = [];

  // LoRA trigger tokens
  for (const slot of loadedLoras) {
    if (slot.triggerWords && !lower.includes(slot.triggerWords.toLowerCase())) {
      suffixParts.push(slot.triggerWords);
    }
  }

  if (modelFamily === 'pony') {
    // Workflow template already has score_* for pony; only add if prompt is standalone
    if (!/(score_9|score_8_up)/i.test(existingPrompt) && !lower.includes('score_9')) {
      // Keep light — compile step may still prepend workflow template
    }
    if (nsfwEnabled) {
      // Unlock adult capability without forcing nudity on establishing / clothed shots
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
      negativeParts.push(
        'nsfw, nude, explicit sexual content, exposed breasts, genitalia, sexual act, pussy, penis, sex'
      );
    }
  } else {
    // FLUX
    if (
      !/(east asian|chinese|japanese|korean|asian|guofeng|xianxia)/i.test(existingPrompt)
    ) {
      suffixParts.push('East Asian facial features, soft facial contour, East Asian beauty');
    }
    if (nsfwEnabled) {
      suffixParts.push('detailed skin texture, natural anatomy');
    } else {
      negativeParts.push(
        'nsfw, nude, explicit sexual content, exposed breasts, genitalia, sexual act'
      );
    }
    if (!/(western face|caucasian)/i.test(existingPrompt)) {
      negativeParts.push('western face, caucasian');
    }
  }

  // Shared quality / safety
  negativeParts.push('low quality, worst quality, bad anatomy, extra limbs, text, watermark, child, loli, shota');

  const presetKey = stylePreset ? String(stylePreset).toLowerCase() : '';
  const booster = presetKey ? STYLE_PRESET_BOOSTERS[presetKey] : undefined;
  if (booster) {
    const boost = modelFamily === 'flux' ? booster.flux : booster.pony;
    // Avoid re-injecting if the director already appended the full style prompt
    const boostTokens = boost.split(',').map((t) => t.trim().toLowerCase()).slice(0, 2);
    const already = boostTokens.every((t) => t && lower.includes(t));
    if (!already) {
      suffixParts.push(boost);
    }
  } else if (
    // Heuristic: guofeng / xianxia story content without preset
    /(xianxia|guofeng|hanfu|immortal|仙|古风|汉服|仙侠)/i.test(existingPrompt)
    && !/(east asian|guofeng|xianxia)/i.test(existingPrompt)
  ) {
    suffixParts.push(
      modelFamily === 'flux'
        ? 'East Asian facial features, ancient Chinese fantasy atmosphere'
        : 'East Asian features, ancient chinese fantasy, guofeng'
    );
  }

  // Advanced/adult styles when NSFW off still need soft SFW framing
  if (
    !nsfwEnabled
    && (presetKey === 'sensual_gufeng' || presetKey === 'alluring_portrait' || presetKey === 'elegant_mature')
  ) {
    suffixParts.push('tasteful elegance, fully clothed, artistic portrait');
    negativeParts.push('nude, nipples, explicit');
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
    modelFamily === 'flux' ? comfy.flux_lora : comfy.pony_lora;
  const styleStrength =
    modelFamily === 'flux'
      ? comfy.flux_lora_strength ?? DEFAULT_STRENGTHS.flux_style
      : comfy.pony_lora_strength ?? DEFAULT_STRENGTHS.pony_style;

  const nsfwLora =
    modelFamily === 'flux' ? advanced.flux_nsfw_lora : advanced.pony_nsfw_lora;

  const characterLora =
    workflowData?.lora_name || workflowData?.lora_path || workflowData?.character_lora;

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
    allowRemoteUnverified: !comfy.install_path
  });

  const stylePreset =
    workflowData?.style_preset || workflowData?.style || workflowData?.visual_style || null;

  const enhancement = buildPromptEnhancement({
    modelFamily,
    nsfwEnabled,
    stylePreset,
    loadedLoras: loras,
    existingPrompt: basePrompt
  });

  return { loras, enhancement };
};

/** LLM instructions appended when generating storyboard visual_prompts. */
export const buildTimelineVisualPromptPolicy = (nsfwEnabled: boolean): string => {
  if (nsfwEnabled) {
    return `
### Image Model Policy (NSFW mode ENABLED):
- visual_prompt MUST be detailed English suitable for Pony XL / FLUX local models.
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
- visual_prompt MUST be detailed English suitable for Pony XL (anime/illustration) or FLUX (scenes).
- Prefer tag-friendly phrasing: subject count, hair, eyes, full costume, pose, expression, environment, lighting.
- Keep content safe-for-work: no nudity, no sexual acts, no explicit body focus. Intimate emotions → blush, averted gaze, close standing, hand-holding only if story requires.
- Emphasize costume design, cinematic composition, and atmosphere (xianxia mist, palace, volumetric light).
- Do NOT write Chinese inside visual_prompt; keep Chinese only in dialogue if needed.
`;
};

/** Quality header for character portrait / turnaround build-prompt (Pony). */
export const buildCharacterPromptHeader = (
  modelFamily: ImageModelFamily,
  nsfwEnabled: boolean,
  genType: string
): { prefix: string; negative: string } => {
  if (modelFamily === 'pony') {
    const base =
      genType === 'turnaround'
        ? 'score_9, score_8_up, score_7_up, character turnaround sheet, full body model sheet, multi-view layout, front view, side view, back view, 3 views, aligned character turnaround, consistent character design'
        : 'score_9, score_8_up, score_7_up, portrait, upper body, front view, masterpiece, detailed face and eyes';
    const neg = nsfwEnabled
      ? 'score_4, score_3, score_2, score_1, bad anatomy, low quality, worst quality, cropped head, blurry, extra limbs, mismatched clothing, inconsistent face, child, loli'
      : 'score_4, score_3, score_2, score_1, bad anatomy, low quality, worst quality, cropped head, blurry, extra limbs, mismatched clothing, inconsistent face, nsfw, nude, child, loli';
    return { prefix: base, negative: neg };
  }

  const base =
    genType === 'turnaround'
      ? 'full body character turnaround sheet, split view layout, front view, side view, back view, complete 3-view character model sheet, character reference sheet, consistent character design from all angles, clean studio white background, masterpiece quality, East Asian facial features'
      : 'high quality character portrait, front view, detailed face and eyes, clean studio background, East Asian facial features';
  const neg = nsfwEnabled
    ? 'low quality, distorted face, bad anatomy, extra limbs, cluttered background, inconsistent costume, western face, child'
    : 'low quality, distorted face, bad anatomy, extra limbs, cluttered background, inconsistent costume, western face, nsfw, nude, child';
  return { prefix: base, negative: neg };
};
