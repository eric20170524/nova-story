export const API_BASE_URL = '/api';

export const CHARACTER_ROLES = [
  { value: 'protagonist', label: '主角 (Protagonist)' },
  { value: 'antagonist', label: '反派 (Antagonist)' },
  { value: 'supporting', label: '配角 (Supporting)' },
  { value: 'extra', label: '群众 (Extra)' },
];

export const SHOT_TYPES = [
  { value: '', label: 'Default Shot' },
  { value: 'Extreme Long Shot', label: 'Extreme Long Shot (远景)' },
  { value: 'Long Shot', label: 'Long Shot (全景)' },
  { value: 'Medium Shot', label: 'Medium Shot (中景)' },
  { value: 'Close-up', label: 'Close-up (特写)' },
  { value: 'Extreme Close-up', label: 'Extreme Close-up (大特写)' },
];

export const CAMERA_MOVEMENTS = [
  { value: '', label: 'Static' },
  { value: 'Pan', label: 'Pan (摇镜头)' },
  { value: 'Tilt', label: 'Tilt (俯仰)' },
  { value: 'Zoom In', label: 'Zoom In (推)' },
  { value: 'Zoom Out', label: 'Zoom Out (拉)' },
  { value: 'Tracking', label: 'Tracking (跟拍)' },
  { value: 'Handheld', label: 'Handheld (手持)' },
];

export const CAMERA_ANGLES = [
  { value: '', label: 'Eye-level' },
  { value: 'Low Angle', label: 'Low Angle (仰视)' },
  { value: 'High Angle', label: 'High Angle (俯视)' },
  { value: 'Overhead', label: 'Overhead (顶视)' },
  { value: 'Dutch Angle', label: 'Dutch Angle (倾斜)' },
];

export const MOCK_PROJECTS = [
  {
    id: 1,
    title: "Cyberpunk 2077: Neon Rain",
    description: "A gritty story about a hacker trying to survive in Night City.",
    created_at: "2023-10-01T10:00:00Z"
  },
  {
    id: 2,
    title: "The Last Starship",
    description: "Sci-fi space opera about the last colony ship leaving Earth.",
    created_at: "2023-10-05T14:30:00Z"
  },
  {
    id: 3,
    title: "Midnight Detective",
    description: "Noir mystery set in 1940s Chicago.",
    created_at: "2023-11-20T09:15:00Z"
  }
];

export const MOCK_CHARACTERS = [
  {
    id: 1,
    project_id: 1,
    name: "Kael",
    role: "protagonist",
    description: "A street-smart hacker with a cybernetic arm and a chip on his shoulder.",
    visual_tags: { hair: "blue neon", eyes: "cybernetic red", style: "techwear" }
  },
  {
    id: 2,
    project_id: 1,
    name: "Viper",
    role: "antagonist",
    description: "Corrupt Arasaka security chief.",
    visual_tags: { hair: "slicked black", suit: "corporate tactical" }
  }
];

export const MOCK_CHAPTERS = [
  {
    id: "uuid-c1",
    project_id: 1,
    title: "Chapter 1: The Wake Up",
    index: 0,
    content: "The rain hammered against the neon-lit window. Kael woke up with a pounding headache, the remnants of the neural surge still buzzing in his cortex."
  },
  {
    id: "uuid-c2",
    project_id: 1,
    title: "Chapter 2: The Meeting",
    index: 1,
    content: "Viper was waiting at the bar, his cybernetic eye scanning the crowd. He looked impatient."
  }
];

export const MOCK_WORKFLOWS = [
  {
    id: 1,
    name: "Anime Style V4",
    description: "Best for stylized anime characters and backgrounds.",
    content: {},
    is_active: true
  },
  {
    id: 2,
    name: "Cinematic Realistic",
    description: "Photorealistic lighting and textures (Flux/SDXL).",
    content: {},
    is_active: true
  },
  {
    id: 3,
    name: "Oil Painting",
    description: "Classic art style.",
    content: {},
    is_active: true
  }
];

export const MOCK_TIMELINE = {
  chapter_id: "uuid-c1",
  timeline: [
    {
      id: 101,
      visual_prompt: "Cyberpunk apartment interior, rainy window, neon signs outside reflecting on wet glass, messy bed, tech debris",
      audio_prompt: "Heavy rain against glass, distant police sirens, low synth drone",
      dialogue: "(Internal) My head hurts...",
      duration: 5,
      asset_status: 'idle'
    },
    {
      id: 102,
      visual_prompt: "Close up of a cybernetic hand gripping a glass of dirty water, dim lighting",
      audio_prompt: "Glass clinking, swallowing sound",
      dialogue: "",
      duration: 3,
      asset_status: 'completed',
      asset_url: 'https://placehold.co/600x600/1e293b/indigo?text=Cyber+Hand'
    },
    {
      id: 103,
      visual_prompt: "Wide shot of a futuristic city skyline at night, flying cars, massive holograms",
      audio_prompt: "City ambience, wind howling, traffic whoosh",
      dialogue: "Kael: Time to get to work.",
      duration: 8,
      asset_status: 'idle'
    }
  ]
};

/**
 * Recommended local image model for each visual style.
 * - pony_xl: Pony Diffusion V6 XL / SDXL — anime/illustration/character (workflow: pony_xl_12gb.json)
 * - sd15_draft: SD 1.5 finetunes — fast pose/composition drafts (workflow: sd15_draft_12gb.json)
 * - both: either works; prefer Pony for final frames
 *
 * Style references: docs/风格参考/1/pixiv-favor.txt
 * Model guidance: docs/local_image_generation_deployment_cn.md
 * FLUX.1-dev GGUF retired on RTX 3060 12GB (2026-08).
 *
 * Adult-leaning styles live in frontend/local/advanced_visual_styles.ts (gitignored).
 * Unlock via Settings: click the hidden footer area 5 times.
 */
export type RecommendedImageModel = 'pony_xl' | 'sd15_draft' | 'both';
export type VisualStyleTier = 'standard' | 'advanced';

export interface VisualStyleDef {
  value: string;
  label: string;
  prompt: string;
  negative_prompt: string;
  recommended_model: RecommendedImageModel;
  /** standard = always listed; advanced = adult-leaning, hidden until unlocked */
  tier?: VisualStyleTier;
}

export const IMAGE_MODEL_LABELS: Record<RecommendedImageModel, string> = {
  pony_xl: 'Pony XL',
  sd15_draft: 'SD1.5 Draft',
  both: 'Pony XL / SD1.5 Draft',
};

export const IMAGE_MODEL_WORKFLOWS: Record<Exclude<RecommendedImageModel, 'both'>, string> = {
  pony_xl: 'pony_xl_12gb.json',
  sd15_draft: 'sd15_draft_12gb.json',
};

/** localStorage key for advanced (adult-leaning) style visibility */
export const ADVANCED_STYLES_STORAGE_KEY = 'novastory_advanced_styles';

// Optimized Styles: Decoupled from specific objects where possible, focused on art technique and lighting
export const STANDARD_VISUAL_STYLES: VisualStyleDef[] = [
  {
    value: 'anime',
    label: 'Anime (动漫/漫画)',
    prompt: '2D anime style, East Asian anime features, flat shading, cel shaded, vibrant colors, clean lines, highly detailed, makoto shinkai aesthetic, score_9, source_anime',
    negative_prompt: '3d, photorealistic, realistic, textured skin, messy lines, sketch, monochrome',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
  {
    value: 'ancient_fantasy',
    label: 'Gu Feng Fantasy (古风幻想)',
    prompt: 'ancient Chinese xianxia fantasy illustration, East Asian facial features, guofeng national style beauty, refined ink-inspired linework, painterly texture, ethereal atmosphere, cinematic volumetric lighting, elegant silk textures, atmospheric depth, intricate traditional patterns, semi-realistic digital rendering',
    negative_prompt: 'western face, caucasian, modern city, concrete buildings, cars, contemporary clothing, firearms, neon urban signage, low quality, blurry, bad anatomy, malformed hands, duplicate characters',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
  {
    value: 'xianxia_immortal',
    label: 'Xianxia Immortal (仙侠清冷)',
    prompt: 'xianxia immortal aesthetic, East Asian facial structure, cool ethereal fairy elegance, restrained color palette with jade and mist tones, soft volumetric godrays, translucent sheer fabric lighting, refined facial features, long flowing hair, quiet mysterious mood, polished semi-realistic digital illustration',
    negative_prompt: 'western face, caucasian, neon cyberpunk, modern streetwear, pure chibi, crude sketch, flat cel only, photoreal camera noise, low quality, blurry, bad anatomy',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
  {
    value: 'guoman_painterly',
    label: 'Guoman Painterly (国漫厚涂)',
    prompt: 'chinese manhua thick painterly style, East Asian features, rich oil-like digital brushwork, strong rim light and atmospheric haze, detailed costume folds, high contrast dramatic lighting, national comic illustration finish, elegant character-focused composition',
    negative_prompt: 'western face, caucasian, western comic halftone, pure lineart only, chibi proportions, photoreal DSLR look, low quality, blurry, messy anatomy',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
  {
    value: 'ethereal_glow',
    label: 'Ethereal Glow (光晕仙气)',
    prompt: 'ethereal bloom and soft glow illustration, East Asian refined beauty portrait, luminous skin highlights, delicate light particles, dreamy backlighting, gentle color bloom, fairy-like radiance, smooth digital polish, romantic atmospheric haze, high clarity beauty portrait finish',
    negative_prompt: 'western face, caucasian, harsh gritty texture, pure ink monochrome, dark brutalist industrial, muddy colors, low quality, blurry, overexposed white void',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
  {
    // Promoted to standard so 琼明-class projects can unify on this look without unlocking advanced styles
    value: 'sensual_gufeng',
    label: 'Sensual Gu Feng (魅惑古风)',
    prompt:
      'alluring ancient Chinese fantasy beauty illustration, seductive yet elegant mood, soft sheer fabric rim light, warm gold and deep crimson accents, refined semi-realistic digital painting, dramatic chiaroscuro, luxurious silk texture, intimate atmospheric haze, beautiful East Asian woman, chinese beauty',
    negative_prompt:
      'western face, caucasian, childlike face, chibi, modern streetwear, neon cyberpunk city, male, androgynous, ugly face, low quality, blurry, bad anatomy, messy hands',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
  {
    value: 'aesthetic_romance',
    label: 'Aesthetic Romance (唯美氛围)',
    prompt: 'aesthetic romantic illustration, East Asian features, soft cinematic color grading, poetic atmosphere, elegant portrait composition, gentle depth of field, refined fabric and hair detail, warm-cool contrast mood lighting, polished digital beauty art',
    negative_prompt: 'western face, caucasian, gritty documentary, crude meme style, flat clipart, noisy compression, low quality, blurry, bad anatomy',
    recommended_model: 'both',
    tier: 'standard',
  },
  {
    value: 'game_illustration',
    label: 'Game Illustration (游戏立绘)',
    prompt: 'premium game character illustration, East Asian character design, splash-art quality, sharp costume silhouette, vivid material contrast, dynamic yet readable pose, polished anime-semireal hybrid shading, detailed accessories, cinematic character spotlight, commercial key visual finish',
    negative_prompt: 'rough sketch, unfinished lineart, pure photoreal photo, muddy silhouette, low quality, blurry, bad anatomy',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
  {
    value: 'chibi',
    label: 'Cute/Chibi (可爱/Q版)',
    prompt: 'chibi style, super deformed, big head small body, kawaii, soft pastel colors, simple shapes, soft lighting, 3d render style optional',
    negative_prompt: 'realistic proportions, gritty, scary, dark, complex textures, sharp edges, adult features',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
  {
    value: 'semi_realistic',
    label: 'Semi-Realistic (半写实)',
    prompt: 'semi-realistic digital painting, East Asian facial structure, smooth painterly style, soft blending, cinematic lighting, subsurface scattering, detailed eyes, riot games splash art style',
    negative_prompt: 'western face, caucasian, anime, cel shaded, flat colors, cartoon, low resolution, blurry, pixelated',
    recommended_model: 'both',
    tier: 'standard',
  },
  {
    value: 'cyberpunk',
    label: 'Cyberpunk (赛博朋克)',
    prompt: 'neon noir aesthetics, high contrast, chromatic aberration, bioluminescent lighting, wet surface reflections, futuristic texture, cinematic teal and orange',
    negative_prompt: 'daytime, natural light, rustic, wooden textures, nature, sunshine, vintage, beige colors',
    recommended_model: 'both',
    tier: 'standard',
  },
  {
    value: 'ink_wash',
    label: 'Ink Wash (水墨/传统墨绘)',
    prompt: 'traditional ink wash painting, sumi-e style, black and white with subtle color accents, visible brushstrokes, rice paper texture, negative space composition',
    negative_prompt: 'digital art, 3d, photorealistic, vibrant colors, sharp edges, modern, glossy',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
  {
    value: 'surreal',
    label: 'Surreal/Dreamlike (超现实/梦幻)',
    prompt: 'dreamlike atmosphere, soft focus, ethereal glow, impossible geometry, pastel color grading, fantasy concept art, magical realism',
    negative_prompt: 'realistic, mundane, ordinary, sharp focus, gritty, documentary style',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
  {
    value: 'ai_generated',
    label: 'AI Generated (AI生成风格)',
    prompt: 'highly polished, intricate details, perfect composition, trending on artstation, unreal engine 5 render, volumetric lighting, 8k',
    negative_prompt: 'low quality, artifacts, blurry, jpeg artifacts, bad composition',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
  {
    value: 'sketch',
    label: 'Hand-Drawn (手绘/草图)',
    prompt: 'rough pencil sketch, graphite texture, cross-hatching shading, paper grain, monochrome, artistic, loose lines',
    negative_prompt: 'color, photorealistic, 3d, digital painting, smooth, polished, gradient',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
  {
    value: 'mecha',
    label: 'Mecha (机甲/机器人)',
    prompt: 'hard surface modeling, metallic textures, scifi paneling, industrial design, dramatic rim lighting, lens flare, cold color palette',
    negative_prompt: 'organic, soft textures, skin, nature, fantasy, magic, rustic',
    recommended_model: 'both',
    tier: 'standard',
  },
  {
    value: 'cinematic_photo',
    label: 'Cinematic Photo (电影写实)',
    prompt: 'cinematic photorealistic still, East Asian features, natural skin texture, realistic lens bokeh, physically based lighting, film color grade, shallow depth of field, detailed environment interaction, shot on 50mm lens look',
    negative_prompt: 'western face, caucasian, anime, cel shaded, cartoon, chibi, flat illustration, oversaturated comic colors, low quality, blurry',
    recommended_model: 'pony_xl',
    tier: 'standard',
  },
];

/**
 * Optional local advanced styles (gitignored file).
 * Copy from advanced_visual_styles.example.ts if missing.
 */
const advancedStyleModules = import.meta.glob<{ ADVANCED_VISUAL_STYLES?: VisualStyleDef[] }>(
  './local/advanced_visual_styles.ts',
  { eager: true }
);

export const ADVANCED_VISUAL_STYLES: VisualStyleDef[] = Object.values(advancedStyleModules)
  .flatMap((mod) => mod?.ADVANCED_VISUAL_STYLES ?? [])
  .map((s) => ({ ...s, tier: 'advanced' as const }));

/** Standard styles only (always safe to list). Prefer getVisualStyles() in UI. */
export const VISUAL_STYLES = STANDARD_VISUAL_STYLES;

export function isAdvancedStylesEnabled(): boolean {
  try {
    return localStorage.getItem(ADVANCED_STYLES_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAdvancedStylesEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ADVANCED_STYLES_STORAGE_KEY, enabled ? '1' : '0');
    window.dispatchEvent(new CustomEvent('novastory-advanced-styles-changed', { detail: { enabled } }));
  } catch {
    /* ignore */
  }
}

/** Visible styles for dropdowns: standard always; advanced only when unlocked (deduplicated by value) */
export function getVisualStyles(includeAdvanced: boolean = isAdvancedStylesEnabled()): VisualStyleDef[] {
  const rawList = includeAdvanced && ADVANCED_VISUAL_STYLES.length > 0
    ? [...STANDARD_VISUAL_STYLES, ...ADVANCED_VISUAL_STYLES]
    : STANDARD_VISUAL_STYLES;

  const seen = new Set<string>();
  const unique: VisualStyleDef[] = [];
  for (const style of rawList) {
    if (!seen.has(style.value)) {
      seen.add(style.value);
      unique.push(style);
    }
  }
  return unique;
}

export function findVisualStyle(value: string): VisualStyleDef | undefined {
  return (
    getVisualStyles(true).find((s) => s.value === value) ??
    STANDARD_VISUAL_STYLES.find((s) => s.value === value)
  );
}

/** Format style option label with recommended local model tag */
export function formatVisualStyleLabel(
  style: Pick<VisualStyleDef, 'label' | 'recommended_model' | 'tier'>,
  translatedLabel?: string
): string {
  const name = translatedLabel || style.label;
  const model = IMAGE_MODEL_LABELS[style.recommended_model];
  const advancedTag = style.tier === 'advanced' ? ' · ★' : '';
  return `${name} · ${model}${advancedTag}`;
}

export interface OpenPosePreset {
  id: string;
  name: string;
  name_zh: string;
  prompt_snippet: string;
}

export const OPENPOSE_PRESETS: OpenPosePreset[] = [
  { id: 'standing_neutral', name: 'Standing Full-Body', name_zh: '标准站姿全景', prompt_snippet: 'standing, full body pose, front view, neutral posture' },
  { id: 'running_action', name: 'Action Running', name_zh: '奔跑追逐动作', prompt_snippet: 'dynamic running pose, mid-stride, action shot, motion blur background' },
  { id: 'sword_slash', name: 'Sword Slash / Fighting', name_zh: '挥刀/战斗招式', prompt_snippet: 'dynamic sword slashing pose, combat stance, intense action, heroic posture' },
  { id: 'sitting_dialogue', name: 'Sitting Conversation', name_zh: '坐姿对话', prompt_snippet: 'sitting on chair, casual posture, medium shot, relaxed dialogue pose' },
  { id: 'looking_back', name: 'Over the Shoulder Glance', name_zh: '回眸/侧颜特写', prompt_snippet: 'looking back over shoulder, close-up portrait, dramatic gaze, depth of field' },
  { id: 'flying_dynamic', name: 'Floating / Dynamic Leap', name_zh: '跃空/飞天姿态', prompt_snippet: 'floating in mid-air, dynamic leaping pose, windblown hair and clothes' }
];

