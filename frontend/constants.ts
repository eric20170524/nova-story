export const API_BASE_URL = (import.meta as any).env?.PROD 
  ? '/novastory/api' 
  : 'http://127.0.0.1:8087/api';

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

// Optimized Styles: Decoupled from specific objects where possible, focused on art technique and lighting
export const VISUAL_STYLES = [
  { 
    value: 'anime', 
    label: 'Anime (动漫/漫画)', 
    prompt: '2D anime style, flat shading, cel shaded, vibrant colors, clean lines, highly detailed, makoto shinkai aesthetic',
    negative_prompt: '3d, photorealistic, realistic, textured skin, messy lines, sketch, monochrome'
  },
  { 
    value: 'ancient_fantasy', 
    label: 'Gu Feng Fantasy (古风幻想)', 
    prompt: 'ancient Chinese xianxia fantasy illustration, refined ink-inspired linework, painterly texture, ethereal atmosphere, cinematic volumetric lighting, elegant silk and armor textures, atmospheric depth, intricate traditional patterns',
    negative_prompt: 'modern city, concrete buildings, cars, contemporary clothing, firearms, neon urban signage, low quality, blurry, bad anatomy, malformed hands, duplicate characters'
  },
  { 
    value: 'chibi', 
    label: 'Cute/Chibi (可爱/Q版)', 
    prompt: 'chibi style, super deformed, big head small body, kawaii, soft pastel colors, simple shapes, soft lighting, 3d render style optional',
    negative_prompt: 'realistic proportions, gritty, scary, dark, complex textures, sharp edges, adult features'
  },
  { 
    value: 'semi_realistic', 
    label: 'Semi-Realistic (半写实)', 
    prompt: 'semi-realistic digital painting, smooth painterly style, soft blending, cinematic lighting, subsurface scattering, detailed eyes, riot games splash art style',
    negative_prompt: 'anime, cel shaded, flat colors, cartoon, low resolution, blurry, pixelated'
  },
  { 
    value: 'cyberpunk', 
    label: 'Cyberpunk (赛博朋克)', 
    prompt: 'neon noir aesthetics, high contrast, chromatic aberration, bioluminescent lighting, wet surface reflections, futuristic texture, cinematic teal and orange',
    negative_prompt: 'daytime, natural light, rustic, wooden textures, nature, sunshine, vintage, beige colors'
  },
  { 
    value: 'ink_wash', 
    label: 'Ink Wash (水墨/传统墨绘)', 
    prompt: 'traditional ink wash painting, sumi-e style, black and white with subtle color accents, visible brushstrokes, rice paper texture, negative space composition',
    negative_prompt: 'digital art, 3d, photorealistic, vibrant colors, sharp edges, modern, glossy'
  },
  { 
    value: 'surreal', 
    label: 'Surreal/Dreamlike (超现实/梦幻)', 
    prompt: 'dreamlike atmosphere, soft focus, ethereal glow, impossible geometry, pastel color grading, fantasy concept art, magical realism',
    negative_prompt: 'realistic, mundane, ordinary, sharp focus, gritty, documentary style'
  },
  { 
    value: 'ai_generated', 
    label: 'AI Generated (AI生成风格)', 
    prompt: 'highly polished, intricate details, perfect composition, trending on artstation, unreal engine 5 render, volumetric lighting, 8k',
    negative_prompt: 'low quality, artifacts, blurry, jpeg artifacts, bad composition'
  },
  { 
    value: 'sketch', 
    label: 'Hand-Drawn (手绘/草图)', 
    prompt: 'rough pencil sketch, graphite texture, cross-hatching shading, paper grain, monochrome, artistic, loose lines',
    negative_prompt: 'color, photorealistic, 3d, digital painting, smooth, polished, gradient'
  },
  { 
    value: 'mecha', 
    label: 'Mecha (机甲/机器人)', 
    prompt: 'hard surface modeling, metallic textures, scifi paneling, industrial design, dramatic rim lighting, lens flare, cold color palette',
    negative_prompt: 'organic, soft textures, skin, nature, fantasy, magic, rustic'
  }
];
