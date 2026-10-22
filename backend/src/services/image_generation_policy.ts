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
import { logger } from '../core/logging';

/** Local Comfy model families. `flux` is legacy custom-graph only (GGUF retired 2026-08). */
export type ImageModelFamily = 'pony' | 'sd15' | 'redcraft_krea2' | 'qwen_image' | 'flux';

/**
 * Normalize free-form model_type / reference_model_type strings from UI or API.
 * Unknown values and retired FLUX product defaults map to pony (except explicit flux graphs).
 */
export const normalizeImageModelFamily = (raw: unknown): ImageModelFamily => {
  const s = String(raw ?? 'pony').toLowerCase().trim();
  if (
    s.includes('krea')
    || s.includes('redcraft')
    || s.includes('赤佬')
    || s.includes('chilao')
  ) {
    return 'redcraft_krea2';
  }
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
  if (/qwen[_-]?image/.test(s)) return 'qwen_image';
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
  /**
   * RedCraft / Krea2 only. A set filename wins when it is on disk.
   * Null discovers a Krea2 NSFW LoRA. Pony and Flux ignore this field.
   */
  nsfwLora?: string | null;
  nsfwLoraStrength?: number;
  /** Visual style preset (affects whether Western NSFW LoRAs like Incase are used) */
  stylePreset?: string | null;
  /**
   * Remote ComfyUI. Accept configured and preset filenames without consulting
   * install_path — that directory is the local catalog, not the remote one.
   */
  allowRemoteUnverified?: boolean;
  /** Live LoraLoader names from the ComfyUI that will run the prompt. */
  remoteLoraNames?: readonly string[];
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
  redcraft_krea2_style: 0.8,
  redcraft_krea2_nsfw: 0.8,
  character: 0.8
} as const;

/** Recommended filenames (used as config defaults / UI hints). */
export const RECOMMENDED_LORA_NAMES = {
  pony_style: 'Pony_DetailV2.0.safetensors',
  pony_nsfw: 'Incase_Style_PonyXL.safetensors',
  flux_style: 'XLabs_Flux_Realism.safetensors',
  flux_nsfw: 'aidmaNSFWunlock.safetensors',
  redcraft_krea2_style: 'RedCraft_Style_v1.safetensors',
  redcraft_krea2_nsfw: 'Krea2_NSFW_V4.1.safetensors'
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

const REDCRAFT_KREA2_STYLE_PATTERNS: RegExp[] = [
  /krea.*style|style.*krea/i,
  /redcraft.*style|style.*redcraft/i,
  /krea2[_-]?detail/i,
  /krea2/i,
  /redcraft/i
];

const REDCRAFT_KREA2_NSFW_PATTERNS: RegExp[] = [
  /krea.*nsfw|nsfw.*krea/i,
  /redcraft.*nsfw|nsfw.*redcraft/i,
  /krea.*nude|redcraft.*nude/i,
  /krea.*uncensor|redcraft.*uncensor/i
];

/** Trigger words known for popular LoRAs (matched by filename). */
const TRIGGER_BY_PATTERN: Array<{ pattern: RegExp; trigger: string }> = [
  { pattern: /expressive[_-]?h/i, trigger: 'Expressiveh' },
  { pattern: /aidma/i, trigger: 'aidmaNSFWunlock' },
  { pattern: /incase/i, trigger: '' } // Incase is often triggerless
];

/** Shared East-Asian feminine beauty anchors (Pony tags + FLUX phrases). */
export const EAST_ASIAN_FEMALE_BEAUTY_PONY =
  '(delicate East Asian facial features:1.25), (classical Chinese beauty, oriental bone structure:1.2), beautiful East Asian woman, chinese beauty, japanese anime beauty, delicate feminine face, soft jawline, large expressive eyes, clear skin, pretty face, female, woman';
export const EAST_ASIAN_FEMALE_BEAUTY_FLUX =
  'beautiful young East Asian woman, classical Chinese and oriental beauty aesthetics, delicate East Asian facial bone structure, soft facial contour, gentle nose bridge, luminous porcelain skin, elegant female features';
export const EAST_ASIAN_FEMALE_NEGATIVE =
  'western face, caucasian, european face, european facial structure, deep-set western eyes, prominent brow ridge, high western nose bridge, male, man, boy, androgynous, masculine face, ugly face, deformed face, asymmetrical eyes, cross-eyed, extra eyes, beard, mustache';

/** Positive lock for 东方写实. Krea2 uses CFG 1, so this has to be in the positive prompt. */
export const ORIENTAL_REALISTIC_FACE_LOCK =
  'oriental realistic style, photorealistic, delicate East Asian facial features, classical oriental bone structure, soft East Asian eyelids, natural porcelain skin texture, subsurface scattering, realistic human anatomy';

/** Blocks a Caucasian read and a flat anime or doll read. No gender tokens. */
export const ORIENTAL_REALISTIC_NEGATIVE =
  'caucasian, western face, european facial structure, deep-set western eyes, prominent brow ridge, high nose bridge, deep eye sockets, european, western facial features, anime, cartoon, 3d render, doll, illustration, flat color';

/**
 * Style boosters should describe look (color/light/medium), not narrative content
 * (clothing integrity, portrait composition, fashion pose). Content words are
 * stripped on action/aftermath shots via stripStyleNarrativeTokens().
 */
const STYLE_PRESET_BOOSTERS: Record<string, { pony: string; flux: string }> = {
  ancient_fantasy: {
    pony: `ancient chinese xianxia, guofeng national style, delicate East Asian facial features, ethereal silk texture rendering, volumetric light, semi-realistic digital painting`,
    flux: `ancient Chinese xianxia fantasy, guofeng national style, delicate East Asian facial bone structure, ethereal silk textures, volumetric god rays`
  },
  guofeng_xianxia: {
    pony: `ancient chinese xianxia, guofeng national style, delicate East Asian facial features, classical oriental bone structure, ethereal silk texture rendering, volumetric light, semi-realistic digital painting`,
    flux: `ancient Chinese xianxia fantasy, guofeng national style, delicate East Asian facial bone structure, classical oriental aesthetics, ethereal silk textures, volumetric god rays`
  },
  xianxia_immortal: {
    pony: `xianxia immortal aesthetic, delicate East Asian facial features, cool jade tones, soft volumetric godrays, ethereal atmosphere, polished semi-realistic illustration`,
    flux: `xianxia immortal aesthetic, delicate East Asian facial bone structure, cool jade and mist tones, translucent fabric lighting, serene atmosphere`
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
    // Non-composed path only. A composed still uses styleLightingMaterial and does not receive this booster.
    pony: `alluring ancient chinese guofeng fantasy illustration, delicate East Asian facial features, sheer fabric rim light, warm gold and deep crimson accents, luxurious silk texture, intimate atmospheric haze, refined semi-realistic digital painting, dramatic chiaroscuro`,
    flux: `alluring ancient Chinese guofeng fantasy, delicate East Asian facial bone structure, sheer fabric rim light, luxurious silk texture, intimate atmospheric haze, cinematic lighting`
  },
  elegant_mature: {
    pony: `elegant mature aesthetic, refined semi-realistic face rendering, sophisticated proportions, cinematic key light`,
    flux: `elegant mature aesthetic, refined semi-realistic face, sophisticated proportions, soft cinematic key light`
  },
  oriental_realistic: {
    pony: `(oriental realistic style:1.2), (delicate East Asian facial features:1.25), (classical oriental bone structure:1.2), soft East Asian eyelids, natural porcelain skin texture, photorealistic, subsurface scattering, realistic human anatomy`,
    flux: ORIENTAL_REALISTIC_FACE_LOCK,
  },
  semi_realistic: {
    pony: `refined semi-realistic digital painting, delicate East Asian facial features, soft blending, volumetric soft light, cinematic lighting, detailed eyes`,
    flux: `refined semi-realistic digital painting, delicate East Asian facial structure, subsurface scattering, soft studio lighting, cinematic lighting`
  },
  alluring_portrait: {
    pony: `alluring portrait, soft beauty lighting, skin highlights, shallow depth of field`,
    flux: `alluring portrait, soft beauty lighting, subtle skin highlights, shallow depth of field`
  },
  anime: {
    pony: `source_anime, cel shaded, clean lines, vibrant colors`,
    flux: `anime illustration style, clean lines, vibrant colors`
  },
  western_comic: {
    pony: `western comic book, thick ink, bold rim light, graphic novel shading`,
    flux: `western comic book illustration, thick ink, graphic novel lighting`
  },
  autismmix_artist: {
    pony: `source_anime, polished anime illustration, refined linework, rich color`,
    flux: `polished anime illustration, refined linework, rich color`
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
  ink_wash: {
    pony: 'ink wash painting, sumi-e, brushstrokes, negative space',
    flux: 'traditional ink wash painting, sumi-e, visible brushstrokes, rice paper texture, negative space'
  }
};

/** Tokens that describe narrative content / portrait lock. Not applied to a composed shot prompt. */
const STYLE_NARRATIVE_STRIP_RE =
  /\b(alluring|intimate|sheer fabric(?: rim light)?|portrait|looking at viewer|beauty portrait|elegant portrait|fashion pose|fully clothed|artistic portrait|group portrait|splash-art pose)\b/gi;

/** Light and material only. The text model may use this; it is not appended after the paragraph. */
const STYLE_LIGHTING_MATERIAL: Record<string, string> = {
  ancient_fantasy: 'volumetric light, semi-realistic material',
  guofeng_xianxia: 'volumetric light, semi-realistic material',
  xianxia_immortal: 'soft volumetric godrays, cool mist light',
  ethereal_glow: 'soft glow, dreamy backlighting',
  guoman_painterly: 'strong rim light, painterly material',
  sensual_gufeng: 'dramatic chiaroscuro, rim light, semi-realistic material',
  elegant_mature: 'cinematic key light',
  alluring_portrait: 'soft beauty lighting, shallow depth of field',
  anime: 'cel-shaded light, clean color',
  western_comic: 'bold rim light, graphic shading',
  autismmix_artist: 'polished illustration light, rich color',
  cinematic_photo: 'cinematic lighting, shallow depth of field',
  aesthetic_romance: 'soft color grade, gentle depth of field',
  game_illustration: 'cinematic character spotlight',
  oriental_realistic: 'realistic cinematic lighting, subsurface scattering, delicate East Asian skin texture',
  semi_realistic: 'cinematic lighting, soft blending',
  ink_wash: 'ink wash light, negative space',
};

export const styleLightingMaterial = (stylePreset?: string | null): string => {
  const key = String(stylePreset || '').toLowerCase().trim();
  return key ? STYLE_LIGHTING_MATERIAL[key] || '' : '';
};

/** Atmosphere only. Appended after a composed paragraph; it does not replace that paragraph. */
export const NSFW_ATMOSPHERE_SENTENCE =
  'natural uncensored details, erotic sensual atmosphere, soft skin texture';

export const CHILD_SAFETY_NEGATIVE =
  'low quality, worst quality, bad anatomy, extra limbs, text, watermark, child, loli, shota, blurry face, mutated hands';

/** Booru subject tags. Natural-language "no people" does not keep AutismMix off a figure. */
export const LIBRARY_PLATE_PERSON_NEGATIVE =
  '1girl, 2girls, 1boy, solo, human, person, people, character, face, portrait, hands';

const PLATE_BODY_CLAUSE_RE =
  /\b(faces?|facial|skins?|anatomy|eyes?|portraits?|beauty|girls?|boys?|women|woman|men|man|humans?|persons?|people|characters?)\b/i;

/** Style light and material for an empty plate. Face, skin, and anatomy clauses stay off. */
const plateStyleLighting = (stylePreset?: string | null): string =>
  styleLightingMaterial(stylePreset)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !PLATE_BODY_CLAUSE_RE.test(part))
    .join(', ');

export type StyleShotMode = 'portrait' | 'action' | 'aftermath' | 'environment' | 'general';

const NONHUMAN_SUBJECT_RE =
  /\b(animal|creature|furry|furred|quadruped|paw|paws|paw pads?|whiskers?|muzzle|snout|beak|hooves?|tail|kitten|cat|puppy|dog|fox|rabbit|bunny|wolf|bear|otter|hamster|mouse|deer|bird)\b/i;
const FEMALE_HUMAN_RE =
  /\b(1girl|2girls|3girls|girl|girls|woman|women|female|goddess|princess|swordswoman|heroine|lady|ladies)\b|(?:神女|仙子|女修|少女|女子|妇人|美妇|师姐|师妹|娘子|双乳|酥胸)/i;
const MALE_HUMAN_RE =
  /\b(1boy|2boys|3boys|boy|boys|man|men|male|prince|swordsman|hero|gentleman)\b|(?:少年|男子|男修|公子|少侠|老者|壮汉)/i;
const ENVIRONMENT_RE =
  /\b(establishing shot|panoramic|landscape|environment|overview|cityscape|no people)\b/i;
const ENVIRONMENT_SHOT_RE =
  /\b(extreme long shot|establishing shot|wide shot|long shot|panoramic|landscape|overview|aerial shot|overhead shot|bird'?s[- ]eye)\b/i;
const HUMAN_IDENTITY_CLAUSE_RE =
  /beautiful .*woman|chinese beauty|japanese anime beauty|east asian (?:facial|face)|classical chinese|oriental bone structure|delicate feminine face|soft jawline|pretty face|refined facial features|long flowing hair|fairy elegance|\b(?:1girl|2girls|3girls|female|woman|women|girl|girls)\b/i;
const HUMAN_IDENTITY_NEGATIVE_RE =
  /western face|caucasian|european face|european facial structure|deep-set western eyes|prominent brow ridge|high (?:western )?nose bridge|deep eye sockets|western facial features|\b(?:male|man|men|boy|boys|androgynous)\b|masculine face|beard|mustache|childlike face/i;

/** A finished sentence, not a tag list. Plate and identity suffixes stay off it. */
export const isWrittenParagraph = (prompt: string): boolean => {
  const text = String(prompt || '').trim();
  if (!/[.!?。]/.test(text)) return false;
  if (text.split(/\s+/).filter(Boolean).length >= 8) return true;
  return /[\u3400-\u9fff]/.test(text) && text.length >= 12;
};

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
  const explicit = String(subjectType || '').toLowerCase();
  const explicitNonPerson = /animal|nonhuman|non-human|creature|furry|quadruped|environment|landscape|location|scenery/.test(explicit);
  if (isWrittenParagraph(prompt) && !explicitNonPerson) return String(prompt || '');
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
  const personSubject =
    subjectType === 'female_human'
    || subjectType === 'male_human'
    || subjectType === 'human'
    || subjectType === 'mixed';

  // A wide camera on a person is still that person's shot. A place name such as
  // palace does not make the subject an empty plate.
  if (ENVIRONMENT_SHOT_RE.test(shot) && !personSubject) {
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
 * Adult look files (ExpressiveH, Incase, aidma, *nsfw*).
 * A custom graph may already wire these. SFW compiles detach them by this test.
 * Bare "sex" / "explicit" are omitted so unrelated filenames are left in place.
 */
const ADULT_LOOK_LORA_RE = /incase|expressive[_-]?h|hentai|nsfw|aidma|porn/i;

export const isAdultLookLoraName = (filename: string): boolean =>
  ADULT_LOOK_LORA_RE.test(path.basename(String(filename || '')));

/** A cast sheet, a listed character, or a human subject in the prompt. */
export const shotHasVisiblePerson = (options: {
  prompt?: string | null;
  subjectType?: string | null;
  genType?: string | null;
  characterIds?: Array<unknown> | null;
}): boolean => {
  const gen = String(options.genType || '').toLowerCase();
  if (/portrait|turnaround|face/.test(gen)) return true;
  if (Array.isArray(options.characterIds) && options.characterIds.some((id) => Number(id) > 0)) return true;
  const subject = inferPromptSubjectType(options.prompt || '', options.subjectType);
  return subject === 'female_human' || subject === 'male_human' || subject === 'human' || subject === 'mixed';
};

const visibleCharacterIds = (workflowData: any): number[] => {
  const pools = [
    workflowData?.shot_master_character_ids,
    workflowData?.character_ids,
    workflowData?.shot_spec?.character_ids,
    workflowData?.character_id != null ? [workflowData.character_id] : [],
  ];
  const ids: number[] = [];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    for (const id of pool) {
      const numeric = Number(id);
      if (Number.isFinite(numeric) && numeric > 0) ids.push(numeric);
    }
  }
  return ids;
};

/** Establishing plates and overhead maps are empty frames even with no "wide" wording. */
export const isEmptyShotIntent = (shotIntent?: string | null): boolean => {
  const intent = String(shotIntent || '').toLowerCase().trim();
  return intent === 'establish' || intent === 'overhead-map';
};

const SFW_SUPPRESSION_PHRASE_RE =
  /\b(?:explicit sexual content|exposed breasts|sexual acts?|sexual content)\b/gi;
const SFW_SUPPRESSION_TOKEN_RE =
  /\b(?:nsfw|nudes?|naked|nudity|nipples?|genitalia|genitals|pussy|penis|sex|explicit)\b/gi;
const EMPTY_WEIGHT_GROUP_RE = /[([]\s*:?[\d.]*\s*[)\]]/g;
const SUPPRESSION_FILLER_RE = /^(?:no|not|without|avoid|and|or)$/i;

/**
 * Drop SFW blockers (nsfw, nude, …) from a negative prompt.
 * Safety tokens such as child / loli are kept. Clauses that still say something
 * else keep that remainder, including their own weights.
 */
export const stripSfwSuppressionFromNegative = (prompt: string): string => {
  const kept: string[] = [];
  for (const raw of String(prompt || '').split(/[,，]/)) {
    let clause = raw.trim();
    if (!clause) continue;
    clause = clause.replace(SFW_SUPPRESSION_PHRASE_RE, ' ');
    clause = clause.replace(SFW_SUPPRESSION_TOKEN_RE, ' ');
    clause = clause.replace(EMPTY_WEIGHT_GROUP_RE, ' ');
    clause = clause.replace(/\s{2,}/g, ' ').replace(/^[\s.:;-]+|[\s.:;-]+$/g, '').trim();
    if (!clause || SUPPRESSION_FILLER_RE.test(clause)) continue;
    if (!/[a-z0-9\u4e00-\u9fff]/i.test(clause)) continue;
    kept.push(clause);
  }
  return kept.join(', ');
};

/**
 * Resolve a single configured or auto-discovered LoRA filename.
 * - Configured path wins when present on disk (or remote-unverified).
 * - Otherwise pattern discovery runs against the local install.
 * - Remote mode never scans install_path, so a local-only filename is not submitted.
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
    const isExcluded = excludePatterns.some((re) => re.test(base));
    if (!isExcluded) {
      if (allowRemoteUnverified === true || (!installPath && allowRemoteUnverified !== false)) {
        return base;
      }
      if (fileExistsInInstall(installPath, base)) {
        return base;
      }
    }
  }

  // Retained install_path is not the remote catalog.
  if (allowRemoteUnverified === true) return null;

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
  // SD1.5 and Qwen-Image use different weights. Do not auto-attach Pony/SDXL LoRAs.
  if (modelFamily === 'sd15' || modelFamily === 'qwen_image') {
    return null;
  }

  if (modelFamily === 'redcraft_krea2') {
    return resolveNamedOrDiscoveredLora({
      configured: input.styleLora,
      installPath: input.installPath,
      allowRemoteUnverified: input.allowRemoteUnverified,
      patterns: REDCRAFT_KREA2_STYLE_PATTERNS,
      excludePatterns: [...REDCRAFT_KREA2_NSFW_PATTERNS, /pony/i, /flux/i, /incase/i, /expressiveh/i],
      fallbackPatterns: [/krea|redcraft/i]
    });
  }

  if (modelFamily === 'flux') {
    // Prefer Asian/guofeng first, then realism — never pick pure NSFW unlock as style.
    return resolveNamedOrDiscoveredLora({
      configured: input.styleLora,
      installPath: input.installPath,
      allowRemoteUnverified: input.allowRemoteUnverified,
      patterns: FLUX_STYLE_PATTERNS,
      excludePatterns: [...FLUX_NSFW_PATTERNS.filter((p) => /aidma|nsfw[_-]?unlock/i.test(p.source)), /pony/i, /krea/i, /redcraft/i],
      fallbackPatterns: [/flux/i]
    });
  }

  // Pony detail slot stays a quality LoRA. Adult looks belong to the style preset.
  void nsfwEnabled;
  return resolveNamedOrDiscoveredLora({
    configured: input.styleLora,
    installPath: input.installPath,
    allowRemoteUnverified: input.allowRemoteUnverified,
    patterns: PONY_STYLE_PATTERNS,
    excludePatterns: [...PONY_NSFW_PATTERNS, /artistsautism/i, /flux/i, /krea/i, /redcraft/i],
    fallbackPatterns: [/pony|detail/i]
  });
};

/**
 * Look LoRAs owned by a visual style. NSFW policy does not pick a second file.
 * adultOnly slots are omitted while the project is SFW, because those files
 * pull everyday shots toward a specific adult rendering.
 */
const PONY_PRESET_LOOKS: Record<string, Array<{
  filenames: string[];
  patterns: RegExp[];
  strength: number;
  adultOnly: boolean;
  trigger?: string;
}>> = {
  anime: [
    {
      filenames: ['Expressive_H-000001.safetensors', 'ExpressiveH_PonyXL.safetensors'],
      patterns: [/expressive[_-]?h/i],
      strength: 0.55,
      adultOnly: true,
      trigger: 'Expressiveh'
    }
  ],
  western_comic: [
    {
      filenames: ['Incase_Style_AutismMix_v3.safetensors', 'Incase_Style_PonyXL.safetensors'],
      patterns: [/incase/i],
      strength: 0.55,
      adultOnly: true
    }
  ],
  autismmix_artist: [
    {
      filenames: ['artistsautism_lora_XL_dim32_8e_v2_civit.safetensors'],
      patterns: [/artistsautism|50[_-]?styles/i],
      strength: 0.5,
      adultOnly: false
    }
  ]
};

const resolvePresetLookFile = (
  look: { filenames: string[]; patterns: RegExp[] },
  input: Pick<LoraResolveInput, 'installPath' | 'allowRemoteUnverified'>
): string | null => {
  // Canonical preset name. A local file with a different fallback name must
  // not be sent to a remote ComfyUI that does not have it.
  if (input.allowRemoteUnverified === true) {
    return look.filenames[0] ?? null;
  }
  if (input.installPath) {
    for (const name of look.filenames) {
      if (fileExistsInInstall(input.installPath, name)) return name;
    }
    return resolveNamedOrDiscoveredLora({
      installPath: input.installPath,
      allowRemoteUnverified: false,
      patterns: look.patterns
    });
  }
  if (input.allowRemoteUnverified !== false) {
    return look.filenames[0] ?? null;
  }
  return null;
};

export const resolveNsfwLora = (
  modelFamily: ImageModelFamily,
  input: Pick<LoraResolveInput, 'installPath' | 'nsfwLora' | 'allowRemoteUnverified'>
): string | null => {
  // SD1.5 and Qwen-Image: skip Pony/Incase NSFW LoRAs (incompatible).
  if (modelFamily === 'sd15' || modelFamily === 'qwen_image') {
    return null;
  }

  if (modelFamily === 'redcraft_krea2') {
    return resolveNamedOrDiscoveredLora({
      configured: input.nsfwLora,
      installPath: input.installPath,
      allowRemoteUnverified: input.allowRemoteUnverified,
      patterns: REDCRAFT_KREA2_NSFW_PATTERNS,
      excludePatterns: [/pony/i, /flux/i, /incase/i, /expressiveh/i, /aidma/i],
      fallbackPatterns: [/krea.*nsfw|redcraft.*nsfw/i]
    });
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
  const remoteUnverified = input.allowRemoteUnverified === true;

  const push = (slot: LoraSlot | null) => {
    if (!slot?.name) return;
    const key = path.basename(slot.name).toLowerCase();
    if (used.has(key)) return;
    if (Array.isArray(input.remoteLoraNames)) {
      const catalog = new Set(input.remoteLoraNames.map((name) => path.basename(String(name)).toLowerCase()));
      if (!catalog.has(key)) {
        logger.warn(`Remote ComfyUI has no LoRA ${path.basename(slot.name)}; this image will not use it`);
        return;
      }
    }
    if (!remoteUnverified) {
      // Local install: skip missing files. Remote keeps the canonical name.
      if (input.installPath && !fileExistsInInstall(input.installPath, slot.name)) return;
      if (!input.installPath && input.allowRemoteUnverified === false) return;
    }
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
      : input.modelFamily === 'redcraft_krea2'
        ? DEFAULT_STRENGTHS.redcraft_krea2_style
        : DEFAULT_STRENGTHS.pony_style;

  if (styleName) {
    push({
      role: 'style',
      name: styleName,
      strength: Number(input.styleLoraStrength ?? defaultStyleStrength)
    });
  }

  // RedCraft NSFW is a Krea2 LoRA on the diffusion model, not a Pony look file.
  // SFW compiles leave it off. Empty frames drop it later with the style slot.
  if (input.modelFamily === 'redcraft_krea2' && input.nsfwEnabled) {
    const nsfwName = resolveNsfwLora(input.modelFamily, {
      installPath: input.installPath,
      nsfwLora: input.nsfwLora,
      allowRemoteUnverified: input.allowRemoteUnverified
    });
    if (nsfwName) {
      push({
        role: 'nsfw',
        name: nsfwName,
        strength: Number(input.nsfwLoraStrength ?? DEFAULT_STRENGTHS.redcraft_krea2_nsfw)
      });
    }
  }

  if (input.modelFamily === 'pony') {
    const presetKey = String(input.stylePreset || '').toLowerCase();
    const looks = PONY_PRESET_LOOKS[presetKey] ?? [];
    for (const look of looks) {
      if (look.adultOnly && !input.nsfwEnabled) continue;
      const name = resolvePresetLookFile(look, input);
      if (!name) continue;
      push({
        role: 'style',
        name,
        strength: look.strength,
        triggerWords: look.trigger
      });
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
  qualityFirst?: boolean;
}): string => {
  const sceneTokens = splitCsvPromptTokens(parts.scene);
  const sceneContent: string[] = [];
  const framingTokens: string[] = [];
  const qualityTokens: string[] = [];

  for (const token of sceneTokens) {
    if (parts.qualityFirst && isQualityPromptToken(token)) qualityTokens.push(token);
    else sceneContent.push(token);
  }

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
  if (parts.qualityFirst) {
    qualityTokens.sort((left, right) => {
      const priority = (token: string): number => {
        const score = token.match(/^score_(\d+)(?:_up)?$/i);
        if (score) return 9 - Number(score[1]);
        if (/^source_anime$/i.test(token)) return 20;
        if (/^source_cartoon$/i.test(token)) return 21;
        return 30;
      };
      return priority(left) - priority(right);
    });
  }
  const orderedTokens = parts.qualityFirst
    ? [...qualityTokens, ...sceneContent, ...framingTokens]
    : [...sceneContent, ...framingTokens, ...qualityTokens];
  for (const token of orderedTokens) {
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
  /** Storyboard shots that actually show a person, even on a wide camera. */
  hasVisiblePerson?: boolean | null;
  /** Turnaround panel angle ('front') for full-body front reference plates. */
  turnaroundView?: string | null;
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
    styleStrength = null,
    hasVisiblePerson = null,
  } = options;
  const naturalLanguage = modelFamily === 'flux' || modelFamily === 'redcraft_krea2' || modelFamily === 'qwen_image';
  const isTurnaroundPanel = String(genType || '').toLowerCase().trim() === 'turnaround_panel';
  const isTurnaround = isTurnaroundPanel || String(genType || '').toLowerCase().trim() === 'turnaround';
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
  const inferredSubject = inferPromptSubjectType(existingPrompt, subjectType);
  const explicitKind = String(subjectType || '').toLowerCase();
  const explicitNonPerson = /animal|nonhuman|non-human|creature|furry|quadruped|environment|landscape|location|scenery/.test(explicitKind);
  // A finished person paragraph keeps its own face, species, and composition.
  const keepWrittenParagraph = isWrittenParagraph(existingPrompt) && !explicitNonPerson;
  const personSubject =
    hasVisiblePerson === true
    || inferredSubject === 'female_human'
    || inferredSubject === 'male_human'
    || inferredSubject === 'human'
    || inferredSubject === 'mixed';
  // A character action, including wide-action, is not an empty plate. A blank
  // intent plus the words "wide shot" or "palace" must not force one either.
  const isEnvironment =
    !isInsertShot
    && !personSubject
    && intent !== 'wide-action'
    && intent !== 'medium-action'
    && intent !== 'reaction'
    && intent !== 'payoff'
    && (isEmptyShotIntent(intent) || shotMode === 'environment');
  const requestedGen = String(genType || '').toLowerCase();
  const isNarrativeScene = requestedGen === 'scene';
  const isLibraryLocation = requestedGen === 'location';
  const isLibraryProp = requestedGen === 'prop';
  const isLibraryPlate = isLibraryLocation || isLibraryProp;
  const isExplicitFemale = inferredSubject === 'female_human';

  // Library plates are identified by gen_type. A period or the word "intimate"
  // must not turn a location or prop into a person shot.
  if (isLibraryProp) {
    suffixParts.push(
      'one physical object, centered product photograph, front view, simple backdrop'
    );
    negativeParts.push(
      LIBRARY_PLATE_PERSON_NEGATIVE,
      'character sheet, turnaround, multiple views, costume design, armor, weapon'
    );
  } else if (isLibraryLocation) {
    suffixParts.push(
      'scenery, wide shot, establishing shot, (environment-dominant cinematic composition:1.4), (expansive detailed location:1.3), clear foreground middle ground and background'
    );
    negativeParts.push(
      'close-up, portrait, animal focus, solo focus, full-frame animal, face filling frame, oversized subject, centered character portrait, looking at viewer, studio background, plain background, simple background, shallow depth of field',
      LIBRARY_PLATE_PERSON_NEGATIVE
    );
  } else if (isNarrativeScene && isInsertShot) {
    suffixParts.push(
      '(narrative insert shot:1.35), extreme detail of the specified prop or body part only, story environment still recognizable, no full face'
    );
    negativeParts.push(
      'animal portrait, full animal, full body character, face, eyes, looking at viewer, centered character, studio background, plain background'
    );
  } else if (isEnvironment && !keepWrittenParagraph) {
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
  if (isExplicitFemale && !isEnvironment && !keepWrittenParagraph && !isLibraryPlate) {
    if (isActionLike) {
      // Identity only — no heavy frontal beauty-portrait stack
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
    if (nsfwEnabled && isLibraryPlate) {
      if (!/\brating_/i.test(existingPrompt)) {
        suffixParts.push('rating_safe');
      }
    } else if (nsfwEnabled) {
      const intimateCue =
        !isTurnaround
        && /(nude|naked|sex|breast|nipple|yuri|nsfw|intimate|penetration|tentacle|pussy|penis|topless|bottomless|undress|半裸|裸|乳|交合|春潮)/i.test(
          existingPrompt
        );
      if (!/\brating_/i.test(existingPrompt)) {
        suffixParts.push(
          isTurnaround
            ? 'rating_safe'
            : intimateCue
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
    if (nsfwEnabled && !isLibraryPlate) {
      suffixParts.push('detailed skin');
    } else if (!nsfwEnabled) {
      negativeParts.push('nsfw, nude, genitalia, sexual act, explicit sexual content');
      if (!isActionLike) {
        negativeParts.push('exposed breasts');
      }
    }
  } else if (modelFamily === 'redcraft_krea2' || modelFamily === 'qwen_image') {
    // RedCraft Krea2 uses natural language prompt booster (no Pony score/tags, native NSFW support).
    // oriental_realistic brings its own face lock. The ethereal suffix reads as a doll illustration.
    const orientalRealisticPreset = String(stylePreset || '').toLowerCase() === 'oriental_realistic';
    if (!orientalRealisticPreset && !/high aesthetic|photographic detail|delicate lighting/i.test(existingPrompt)) {
      const isOrientalContext =
        !keepWrittenParagraph
        && (
          /ancient_fantasy|xianxia|guofeng|guoman|sensual_gufeng|ink_wash/i.test(String(stylePreset || ''))
          || /(xianxia|guofeng|hanfu|immortal|仙|古风|汉服|仙侠|East Asian|oriental)/i.test(existingPrompt)
        );
      suffixParts.push(
        isOrientalContext
          ? 'high aesthetic detail, rich textures, soft ethereal lighting, intricate nuances'
          : 'high aesthetic photographic detail, rich textures, natural studio lighting, intricate nuances'
      );
    }
    const intimateCue =
      !isTurnaround
      && /(nude|naked|sex|breast|nipple|yuri|nsfw|intimate|penetration|tentacle|pussy|penis|topless|bottomless|undress|半裸|裸|乳|交合|春潮)/i.test(
        existingPrompt
      );
    const castImage = /portrait|face/i.test(String(genType || ''));
    const personShot = hasVisiblePerson === true || castImage || shotHasVisiblePerson({
      prompt: existingPrompt,
      subjectType,
      genType,
    });
    if (nsfwEnabled && !isLibraryPlate) {
      // Cast portraits and narrative person shots get the atmosphere unlock.
      // Turnaround generation never injects intimateCue or NSFW_ATMOSPHERE_SENTENCE.
      if (!isTurnaround && (intimateCue || personShot)) {
        suffixParts.push(NSFW_ATMOSPHERE_SENTENCE);
      } else {
        suffixParts.push('highly detailed skin texture, delicate lighting, realistic anatomy');
      }
    } else if (!nsfwEnabled) {
      negativeParts.push('nsfw, nude, genitalia, sexual act, explicit sexual content');
      if (!isActionLike) {
        negativeParts.push('exposed breasts');
      }
    }
  } else {
    if (nsfwEnabled && !isLibraryPlate) {
      suffixParts.push('detailed skin texture, natural anatomy');
    } else if (!nsfwEnabled) {
      negativeParts.push('nsfw, nude, genitalia, sexual act, explicit sexual content');
      if (!isActionLike) {
        negativeParts.push('exposed breasts');
      }
    }
  }

  // Shared quality / safety
  negativeParts.push(CHILD_SAFETY_NEGATIVE);

  const presetKey = stylePreset ? String(stylePreset).toLowerCase() : '';
  const orientalPerson = presetKey === 'oriental_realistic' && (
    hasVisiblePerson === true
    || personSubject
    || /portrait|turnaround|face/i.test(String(genType || ''))
  );
  const booster = presetKey === 'oriental_realistic' || keepWrittenParagraph || isLibraryPlate
    ? undefined
    : (presetKey ? STYLE_PRESET_BOOSTERS[presetKey] : undefined);
  if (isLibraryPlate) {
    const lighting = plateStyleLighting(stylePreset);
    if (lighting) suffixParts.push(lighting);
  } else if (presetKey === 'oriental_realistic') {
    if (orientalPerson) {
      if (!/oriental realistic style/i.test(lower)) {
        const lock = (modelFamily === 'pony' || modelFamily === 'sd15')
          ? (STYLE_PRESET_BOOSTERS.oriental_realistic?.pony ?? ORIENTAL_REALISTIC_FACE_LOCK)
          : ORIENTAL_REALISTIC_FACE_LOCK;
        suffixParts.push(lock);
      }
      negativeParts.push(ORIENTAL_REALISTIC_NEGATIVE);
    } else if (!keepWrittenParagraph && !/subsurface scattering/i.test(lower) && STYLE_LIGHTING_MATERIAL.oriental_realistic) {
      suffixParts.push(STYLE_LIGHTING_MATERIAL.oriental_realistic);
    }
  } else if (booster) {
    // SD1.5 drafts use tag-like pony boosters; FLUX & RedCraft Krea2 use natural phrases
    const boost = naturalLanguage ? booster.flux : booster.pony;
    const boostTokens = boost.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 2);
    const already = boostTokens.length > 0 && boostTokens.every((t) => t && lower.includes(t));
    if (!already && boost) {
      const strength = Number(styleStrength);
      suffixParts.push(
        !naturalLanguage && Number.isFinite(strength) && strength > 0 && Math.abs(strength - 1) > 0.001
          ? `(${boost}:${strength})`
          : boost
      );
    }
  } else if (
    !isLibraryPlate
    && !keepWrittenParagraph
    && /(xianxia|guofeng|hanfu|immortal|仙|古风|汉服|仙侠)/i.test(existingPrompt)
    && !/(east asian|guofeng|xianxia)/i.test(existingPrompt)
  ) {
    suffixParts.push(
      naturalLanguage
        ? 'East Asian facial features, ancient Chinese fantasy atmosphere'
        : 'East Asian features, ancient chinese fantasy, guofeng'
    ); // pony + sd15
  }

  // (1) Default: NO fully clothed / artistic portrait.
  // Portrait mode only: soft elegance (not clothing lock).
  // Action/aftermath: anti-fashion-pose negatives + combat-friendly positives.
  if (!nsfwEnabled && !isLibraryPlate) {
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
  enhancement: PromptEnhancement,
  options: { qualityFirst?: boolean } = {}
): string => {
  // Scene action first; shared framing / style / quality follow (CLIP front window).
  return mergeClipPositivePrompt({
    scene: basePrompt,
    framing: joinUniqueCsv([enhancement.prefix, enhancement.suffix]),
    qualityFirst: options.qualityFirst,
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

  const styleLora =
    modelFamily === 'flux'
      ? comfy.flux_lora
      : modelFamily === 'sd15' || modelFamily === 'qwen_image'
        ? null
        : modelFamily === 'redcraft_krea2'
          ? comfy.redcraft_krea2_lora
          : comfy.pony_lora;
  const configuredStyleStrength =
    modelFamily === 'flux'
      ? comfy.flux_lora_strength ?? DEFAULT_STRENGTHS.flux_style
      : modelFamily === 'redcraft_krea2'
        ? comfy.redcraft_krea2_lora_strength ?? DEFAULT_STRENGTHS.redcraft_krea2_style
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
  ).toLowerCase().trim();
  const isInsertShot =
    workflowShotIntent === 'insert'
    || /\b(insert shot|detail shot|macro shot|object close-up|prop close-up)\b/i.test(
      String(workflowData?.shot_type || '')
    );
  const styleStrength = isNarrativeScene
    ? Math.min(Number(configuredStyleStrength) || DEFAULT_STRENGTHS.pony_style, 0.35)
    : configuredStyleStrength;

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
    nsfwLora: modelFamily === 'redcraft_krea2'
      ? runtimeSettings?.advanced?.redcraft_krea2_nsfw_lora ?? null
      : null,
    nsfwLoraStrength: modelFamily === 'redcraft_krea2'
      ? DEFAULT_STRENGTHS.redcraft_krea2_nsfw
      : undefined,
    stylePreset,
    allowRemoteUnverified: Boolean(comfy.mode === 'remote' || !comfy.install_path),
    remoteLoraNames: Array.isArray(comfy.remote_lora_names) ? comfy.remote_lora_names : undefined,
  });
  const strengthCapped = isNarrativeScene
    ? resolvedLoras.map((slot) => (
      slot.role === 'style'
        ? { ...slot, strength: Math.min(slot.strength, 0.35) }
        : slot
    ))
    : resolvedLoras;
  const hasPerson = shotHasVisiblePerson({
    prompt: basePrompt,
    subjectType: workflowData?.subject_type ?? null,
    genType: workflowData?.gen_type ?? null,
    characterIds: visibleCharacterIds(workflowData),
  });
  // Empty scenery and prop inserts stay spatially faithful. A wide shot that
  // still shows a person keeps the RedCraft NSFW LoRA and unlock prompt.
  const libraryPlate = ['location', 'prop'].includes(String(workflowData?.gen_type || '').toLowerCase());
  // Detail and adult-look LoRAs pull a figure into an empty plate. Drop them
  // for library locations and props even when the prompt has no "no people".
  const loras = libraryPlate || (!hasPerson && (shotMode === 'environment' || isEmptyShotIntent(workflowShotIntent) || isInsertShot))
    ? strengthCapped.filter((slot) => slot.role === 'character')
    : strengthCapped;

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
    styleStrength: workflowData?.style_strength ?? null,
    hasVisiblePerson: hasPerson,
    turnaroundView: workflowData?.turnaround_view ?? null,
  });

  return { loras, enhancement };
};

/**
 * LLM instructions for storyboard beat contracts.
 * Policy points at the server compiler — do NOT ask the storyboard model for the final English visual_prompt.
 */
export const buildTimelineVisualPromptPolicy = (
  nsfwEnabled: boolean,
  options: { responseFormat?: 'timeline' | 'script_storyboard' } = {},
): string => {
  const contractOnly = options.responseFormat === 'script_storyboard';
  const visualPromptRule = contractOnly
    ? '- Return only the requested shot contract fields. Do NOT output visual_prompt or negative_prompt; the server compiles the contract into an English image prompt.'
    : '- Set visual_prompt to "" (empty). Do NOT write a Detailed English scene description; the server compiles the contract into an English image prompt.';
  if (nsfwEnabled) {
    return `
### Shot Contract Policy (NSFW mode ENABLED) — compiler fills the English image prompt:
- Fill location, primary_action, key_props (≤2), shot_intent, subject_scale. Chinese OK in contract fields.
${visualPromptRule}
- When intimacy/adult content is in the source, encode it as concrete visible actions/props/clothing state in the contract — do not euphemize into empty poetry and do not refuse.
- Prefer human subject locks from Character Visual Lock (1girl/2girls/3girls only when the lock already implies female humans). All characters are adults.
- Keep props concrete (jade mirror, silk bed, incense, flower petals).
- Across a chapter: insert+reaction ≤ 20%; establish+wide-action ≥ 35%.
`;
  }

  return `
### Shot Contract Policy (SFW / family-safe) — compiler fills the English image prompt:
- Fill location (paintable nouns only), primary_action (one visible verb), key_props (≤2), shot_intent, subject_scale${contractOnly ? '.' : ', uniqueness_key.'}
${contractOnly ? '- Chinese is allowed in contract fields. Return only the requested shot contract fields; do NOT output visual_prompt or negative_prompt.' : '- Chinese is allowed in contract fields. Set visual_prompt to "" (empty).'}
- Do NOT write a Detailed English scene description or long Pony prose; the server compiles English tags from the contract + Character Visual Lock.
- Never invent species tags absent from the Visual Lock (no kitten / 1girl / wolf / fox / dog paraphrases).
- Keep content safe-for-work: no nudity, no sexual acts. Intimate emotions → blush, averted gaze, hand-holding only if story requires.
- shot_intent enum: establish | wide-action | medium-action | insert | reaction | overhead-map | payoff.
- Use insert for paw/nose/ticket/map-button/music-box clues. Use establish/wide-action for geography.
- Across a chapter: close-ups/insert+reaction ≤ 20%; establish+wide-action ≥ 35%; at least one insert when key props exist.
${contractOnly ? '- Adjacent shots must differ in visible action or key props.' : '- Adjacent uniqueness_key values must differ.'}
`;
};

export type CharacterSheetGender = 'female' | 'male' | 'unspecified';

export type CharacterAppearanceFields = {
  age?: string | null;
  hair?: string | null;
  eyes?: string | null;
  face?: string | null;
  skin?: string | null;
  body?: string | null;
  clothing?: string | null;
  accessories?: string | null;
  /** Structured flag from stored fields. True when those fields state the character is undressed. */
  undressed?: boolean | null;
};

export type CharacterDesign = {
  gender: CharacterSheetGender;
  age: string;
  hair: string;
  eyes: string;
  face: string;
  skin: string;
  body: string;
  clothing: string;
  accessories: string;
  undressed: boolean;
};

export class CharacterSheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CharacterSheetError';
  }
}

export function normalizeStoredGender(value: unknown): CharacterSheetGender {
  const gender = String(value ?? '').trim().toLowerCase();
  if (gender === 'female' || gender === 'woman' || gender === 'girl' || gender === '1girl' || gender === '女' || gender === '女性') {
    return 'female';
  }
  if (gender === 'male' || gender === 'man' || gender === 'boy' || gender === '1boy' || gender === '男' || gender === '男性') {
    return 'male';
  }
  return 'unspecified';
}

const appearanceText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const SHEET_MOOD_RE =
  /\b(aroused|seductive|alluring|melting expression|softens under emotion|half-lidded|blushing|smile|gaze)\b/i;
const SCENE_WARDROBE_RE =
  /half-open|lowered to (?:the )?waist|loosely worn|when aroused|intimate scenes?|unclothed|\bnude\b|barefoot/i;
const COSTUME_RE = /\b(dress|robe|robes|hanfu|gown)\b|仙裙|汉服|裙|袍/i;
const XIANXIA_DRESS_RE = /xianxia\b[^,]{0,48}\bdress\b/i;

/** Split comma-separated clauses without splitting inside parentheses (...), and balance stray parens. */
export const splitClauses = (value: string): string[] => {
  const text = String(value || '');
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '(' || ch === '（') {
      depth += 1;
      current += '(';
    } else if (ch === ')' || ch === '）') {
      if (depth > 0) {
        depth -= 1;
        current += ')';
      }
    } else if ((ch === ',' || ch === '，') && depth === 0) {
      const cleaned = current.trim();
      if (cleaned) parts.push(cleaned);
      current = '';
    } else {
      current += ch;
    }
  }
  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts.map((clause) => {
    let open = 0;
    let balanced = '';
    for (const ch of clause) {
      if (ch === '(') {
        open += 1;
        balanced += ch;
      } else if (ch === ')') {
        if (open > 0) {
          open -= 1;
          balanced += ch;
        }
      } else {
        balanced += ch;
      }
    }
    if (open > 0) {
      balanced = balanced.replace(/\(/g, '');
    }
    return balanced.trim();
  }).filter(Boolean);
};

/** Drop scene mood and the clothing state of one chapter. Keep the costume, hair, and eyes. */
const sheetClauses = (value: string): string =>
  splitClauses(value)
    .filter((clause) => !SHEET_MOOD_RE.test(clause) && !SCENE_WARDROBE_RE.test(clause))
    .join(', ');

const mustKeepLines = (source: Record<string, any>): string[] =>
  Array.isArray(source.identity_lock?.must_keep)
    ? source.identity_lock.must_keep.map((line: unknown) => String(line || '').trim()).filter(Boolean)
    : [];

const classifyMustKeep = (lines: string[]): Partial<CharacterDesign> => {
  const found: Partial<CharacterDesign> = {};
  for (const line of lines) {
    const usable = sheetClauses(line);
    if (!usable) continue;
    if (!found.eyes && /\beyes?\b|眼/.test(line)) {
      found.eyes = usable;
    } else if (!found.hair && /\bhair\b|发/.test(line)) {
      found.hair = usable;
    } else if (!found.clothing && COSTUME_RE.test(line)) {
      found.clothing = usable;
    } else if (!found.skin && /\bskin\b/i.test(line)) {
      found.skin = usable;
    } else if (!found.body && /\b(figure|posture|waist|curves|breasts?|build)\b/i.test(line)) {
      found.body = usable;
    } else if (!found.face && /\b(beauty|face|brows|expression|cheekbones)\b/i.test(line)) {
      found.face = usable;
    } else if (!found.accessories && /\b(hairpin|mirror|ornament|jade|sigil|aura|necklace)\b/i.test(line)) {
      found.accessories = usable;
    }
  }
  return found;
};

const designRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const designIsFrozen = (design: Record<string, unknown> | null): boolean =>
  Boolean(design && (appearanceText(design.clothing) || appearanceText(design.hair) || appearanceText(design.eyes)));

/** True when visual_tags.design already holds clothing, hair, or eyes. */
export function storedDesignIsFrozen(tags: unknown): boolean {
  let parsed = tags;
  if (typeof tags === 'string') {
    try {
      parsed = JSON.parse(tags || '{}');
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== 'object') return false;
  return designIsFrozen(designRecord((parsed as Record<string, unknown>).design));
}

/** Drop one chapter's wardrobe state. Keep the regular costume clause. */
export function stripSceneWardrobeClauses(value: string): string {
  return splitClauses(value)
    .filter((clause) => !SCENE_WARDROBE_RE.test(clause))
    .join(', ');
}

const inferSheetGender = (
  gender: CharacterSheetGender,
  hintText: string
): CharacterSheetGender => {
  if (gender !== 'unspecified') return gender;
  if (!hintText || NONHUMAN_SUBJECT_RE.test(hintText)) return 'unspecified';
  const isFemale =
    FEMALE_HUMAN_RE.test(hintText)
    || /\b(breasts?|hourglass|cleavage)\b/i.test(hintText)
    || XIANXIA_DRESS_RE.test(hintText);
  const isMale = MALE_HUMAN_RE.test(hintText);
  if (isFemale && !isMale) return 'female';
  if (isMale && !isFemale) return 'male';
  return 'unspecified';
};

/**
 * Design appearance for 定妆照 and 三视图.
 * A frozen visual_tags.design wins. Otherwise the identity lock supplies the costume,
 * and a chapter wardrobe such as "half-open" or "lowered to waist" stays out.
 */
export function resolveSheetDesign(
  tags: Record<string, any> | null | undefined,
  fallbackContext?: { description?: string | null }
): CharacterDesign {
  const source = tags && typeof tags === 'object' ? tags : {};
  const stored = designRecord(source.design);
  const base = source.base_model?.tags && typeof source.base_model.tags === 'object'
    ? source.base_model.tags
    : {};
  const fromKeep = classifyMustKeep(mustKeepLines(source));
  const baseClothing = appearanceText(base.clothing || source.clothing);
  const pick = (key: keyof CharacterDesign, ...candidates: unknown[]): string => {
    const storedValue = stored ? appearanceText(stored[key]) : '';
    if (storedValue) return storedValue;
    for (const candidate of candidates) {
      const text = appearanceText(candidate);
      if (text) return text;
    }
    return '';
  };
  const clothing = pick(
    'clothing',
    fromKeep.clothing,
    sheetClauses(baseClothing)
  );
  const design: CharacterDesign = {
    gender: 'unspecified',
    age: pick('age', base.age, source.age),
    hair: pick('hair', fromKeep.hair, sheetClauses(appearanceText(base.hair || source.hair))),
    eyes: pick('eyes', fromKeep.eyes, sheetClauses(appearanceText(base.eyes || source.eyes))),
    face: pick('face', fromKeep.face, sheetClauses(appearanceText(base.face || source.face || base.face_features || source.face_features))),
    skin: pick('skin', fromKeep.skin, base.skin, source.skin, base.skin_tone),
    body: pick('body', fromKeep.body, sheetClauses(appearanceText(base.body || source.body || base.build || source.build))),
    clothing,
    accessories: pick('accessories', fromKeep.accessories, base.accessories, source.accessories),
    undressed: stored?.undressed === true,
  };
  const hintedGender = normalizeStoredGender(stored?.gender ?? source.gender ?? base.gender);
  design.gender = inferSheetGender(
    hintedGender,
    [
      design.face,
      design.body,
      design.clothing,
      design.eyes,
      mustKeepLines(source).join(', '),
      fallbackContext?.description || '',
    ].filter(Boolean).join(', ')
  );
  return design;
}

const sceneStateFromIncoming = (
  previous: Record<string, any>,
  incoming: Record<string, unknown>
): Record<string, string> => {
  const scene: Record<string, string> = {};
  const prior = previous.scene_state;
  if (prior && typeof prior === 'object' && !Array.isArray(prior)) {
    for (const [key, value] of Object.entries(prior as Record<string, unknown>)) {
      const text = appearanceText(value);
      if (text) scene[key] = text;
    }
  }
  for (const [key, value] of Object.entries(incoming || {})) {
    const text = appearanceText(value);
    if (text) scene[key] = text;
  }
  return scene;
};

/**
 * Keep the sheet design stable. Chapter tags still update base_model and scene_state.
 * Returns the design to store on the merged document.
 */
export function freezeCharacterDesign(
  previous: Record<string, any> | null | undefined,
  incoming: Record<string, unknown> = {}
): CharacterDesign {
  const prior = previous && typeof previous === 'object' ? previous : {};
  const stored = designRecord(prior.design);
  if (designIsFrozen(stored)) {
    const frozen = resolveSheetDesign(prior);
    const incomingGender = normalizeStoredGender(incoming.gender);
    if (frozen.gender === 'unspecified' && incomingGender !== 'unspecified') {
      frozen.gender = incomingGender;
    }
    return frozen;
  }
  const seeded = resolveSheetDesign(prior);
  const fill = (key: 'age' | 'hair' | 'eyes' | 'face' | 'skin' | 'body' | 'clothing' | 'accessories') => {
    if (seeded[key]) return;
    const text = appearanceText(incoming[key]);
    if (!text) return;
    if (key === 'clothing' && SCENE_WARDROBE_RE.test(text)) return;
    seeded[key] = text;
  };
  fill('age');
  fill('hair');
  fill('eyes');
  fill('face');
  fill('skin');
  fill('body');
  fill('clothing');
  fill('accessories');
  const incomingGender = normalizeStoredGender(incoming.gender);
  if (seeded.gender === 'unspecified' && incomingGender !== 'unspecified') {
    seeded.gender = incomingGender;
  }
  return seeded;
}

/** Attach design and scene_state onto a merged visual_tags document. */
export function sealCharacterDesign(
  previous: Record<string, any> | null | undefined,
  incoming: Record<string, unknown>,
  merged: Record<string, any>
): Record<string, any> {
  return {
    ...merged,
    design: freezeCharacterDesign(previous, incoming),
    scene_state: sceneStateFromIncoming(previous || {}, incoming),
  };
}

const EDITABLE_DESIGN_KEYS = ['gender', 'age', 'hair', 'eyes', 'face', 'skin', 'body', 'clothing', 'accessories'] as const;

/**
 * Sync visual_tags.design when a user explicitly creates or edits character appearance tags.
 * Only activates when visual_tags contains appearance fields or design already exists.
 */
export function syncEditableCharacterDesign(
  tags: Record<string, any> | null | undefined,
  fallbackContext?: { description?: string | null; age?: string | null },
  options: { preferFlatEdits?: boolean } = {}
): Record<string, any> {
  const doc = tags && typeof tags === 'object' ? { ...tags } : {};
  const baseTags = doc.base_model?.tags && typeof doc.base_model.tags === 'object'
    ? doc.base_model.tags as Record<string, unknown>
    : {};
  const existingDesign = designRecord(doc.design);
  const hasAppearanceEdit = Boolean(
    existingDesign
    || appearanceText(baseTags.clothing || doc.clothing)
    || appearanceText(baseTags.hair || doc.hair)
    || appearanceText(baseTags.eyes || doc.eyes)
    || appearanceText(baseTags.face || doc.face || baseTags.face_features || doc.face_features)
    || appearanceText(baseTags.body || doc.body || baseTags.build || doc.build)
    || appearanceText(baseTags.accessories || doc.accessories)
    || (Array.isArray(doc.identity_lock?.must_keep) && doc.identity_lock.must_keep.length > 0)
  );
  if (!hasAppearanceEdit) return doc;

  const baseResolved = resolveSheetDesign({ ...doc, design: undefined }, fallbackContext);
  const preferFlat = options.preferFlatEdits === true || !Array.isArray(doc.identity_lock?.must_keep) || doc.identity_lock.must_keep.length === 0;
  const pickField = (resolvedVal: string, flatVal: string, existingVal: string): string =>
    preferFlat
      ? (flatVal || resolvedVal || existingVal)
      : (resolvedVal || flatVal || existingVal);
  const nextDesign: CharacterDesign = {
    gender: baseResolved.gender,
    age: appearanceText(fallbackContext?.age ?? baseTags.age ?? doc.age) || baseResolved.age || appearanceText(existingDesign?.age),
    hair: pickField(baseResolved.hair, sheetClauses(appearanceText(baseTags.hair || doc.hair)), appearanceText(existingDesign?.hair)),
    eyes: pickField(baseResolved.eyes, sheetClauses(appearanceText(baseTags.eyes || doc.eyes)), appearanceText(existingDesign?.eyes)),
    face: pickField(baseResolved.face, sheetClauses(appearanceText(baseTags.face || doc.face || baseTags.face_features || doc.face_features)), appearanceText(existingDesign?.face)),
    skin: pickField(baseResolved.skin, appearanceText(baseTags.skin || doc.skin || baseTags.skin_tone), appearanceText(existingDesign?.skin)),
    body: pickField(baseResolved.body, sheetClauses(appearanceText(baseTags.body || doc.body || baseTags.build || doc.build)), appearanceText(existingDesign?.body)),
    clothing: pickField(baseResolved.clothing, sheetClauses(appearanceText(baseTags.clothing || doc.clothing)), appearanceText(existingDesign?.clothing)),
    accessories: pickField(baseResolved.accessories, splitClauses(appearanceText(baseTags.accessories || doc.accessories)).join(', '), appearanceText(existingDesign?.accessories)),
    undressed: Boolean(doc.undressed === true || baseTags.undressed === true || existingDesign?.undressed === true),
  };
  const explicitGender = normalizeStoredGender(baseTags.gender ?? doc.gender ?? existingDesign?.gender);
  if (explicitGender !== 'unspecified') {
    nextDesign.gender = explicitGender;
  }
  void EDITABLE_DESIGN_KEYS;
  return {
    ...doc,
    design: nextDesign,
  };
}

/** Stored gender and appearance. Sheet clothing and eyes come from the design lock. */
export function readStoredCharacterSheet(
  tags: Record<string, any> | null | undefined,
  fallbackContext?: { description?: string | null }
): {
  gender: CharacterSheetGender;
  appearance: CharacterAppearanceFields;
} {
  const design = resolveSheetDesign(tags, fallbackContext);
  const source = tags && typeof tags === 'object' ? tags : {};
  const base = source.base_model?.tags && typeof source.base_model.tags === 'object'
    ? source.base_model.tags
    : {};
  const sceneUndressed = source.undressed === true || base.undressed === true;
  return {
    gender: design.gender,
    appearance: {
      age: design.age,
      hair: design.hair,
      eyes: design.eyes,
      face: design.face,
      skin: design.skin,
      body: design.body,
      clothing: design.clothing,
      accessories: design.accessories,
      undressed: design.clothing ? design.undressed : sceneUndressed || design.undressed,
    },
  };
}

/**
 * Sheet layout plus the character's stored gender and appearance fields.
 * Studio background is layout only. A missing gender is not filled in.
 * When the stored fields say the character is undressed and NSFW is off, the sheet fails.
 */
export const buildCharacterPromptHeader = (
  _modelFamily: ImageModelFamily,
  nsfwEnabled: boolean,
  genType: string,
  gender: CharacterSheetGender | null = 'unspecified',
  appearance?: CharacterAppearanceFields | null,
): { prefix: string; negative: string } => {
  if (appearance?.undressed === true && !nsfwEnabled) {
    throw new CharacterSheetError('角色字段标明未着装，项目未开启 NSFW，定妆已停止。');
  }
  const storedGender = gender === 'female' || gender === 'male' ? gender : 'unspecified';
  const layout = genType === 'turnaround'
    ? 'full body character design, direct orthographic front view, head to toe, neutral standing A-pose, entire figure and feet visible, unobstructed silhouette, consistent character identity, solid pure white opaque studio background, completely opaque, no transparency, no checkerboard, plain studio background'
    : 'high quality character portrait, upper body, waist-up, front view, facing camera, both shoulders visible, eye-level, detailed face and eyes, neutral expression, clothes visible only at the collar and shoulders, empty hands, plain studio background';
  const look = [
    appearance?.age,
    appearance?.hair,
    appearance?.eyes,
    appearance?.face,
    appearance?.skin,
    appearance?.body,
    appearance?.clothing,
    appearance?.accessories,
  ].map(part => String(part || '').trim()).filter(Boolean);
  const prefix = [layout, storedGender === 'unspecified' ? '' : storedGender, ...look]
    .filter(Boolean)
    .join(', ');
  const angleNegative = genType === 'turnaround'
    ? ', side view, profile, back view, from behind, three-quarter view, turnaround sheet, multiple views, split panel, expression matrix, pose study, detail inset, before and after comparison, close-up, medium shot, cowboy shot, waist-up, knee-up, bust shot, upper body only, cropped legs, cropped feet, portrait crop, transparent background, checkerboard background'
    : ', side view, profile, back view, from behind, holding a mirror, holding a sword, holding a flower, handheld prop';
  return {
    prefix,
    negative: `${CHILD_SAFETY_NEGATIVE}, distorted face, cluttered background, mismatched clothing, inconsistent face${angleNegative}`,
  };
};
