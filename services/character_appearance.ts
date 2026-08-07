/**
 * Tier A character appearance helpers (frontend).
 * Keep in sync with backend/src/services/reference_generation_policy.ts concepts:
 * tags + description always feed the prompt; image refs are optional enhancement.
 */

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
    const variantId =
      chapterId != null ? timelineMap[chapterId] ?? timelineMap[String(chapterId)] : null;
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

export const buildCharacterAppearanceSnippet = (
  char: { name?: string; description?: string | null; visual_tags?: any },
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
    const clipped = desc.length > 220 ? `${desc.slice(0, 220).trim()}…` : desc;
    return `${name} appearance: ${clipped}`;
  }

  return '';
};

export const getCharacterLoraName = (char: { visual_tags?: any; id?: number }): string | null => {
  const assets = char.visual_tags?.assets;
  if (!assets?.lora_ready) return null;
  const path = assets.lora_path || assets.lora_name;
  return path ? String(path).trim() : null;
};

/** Tier A: when a single character portrait may drive classic img2img */
export const shouldUsePortraitImg2ImgForScene = (options: {
  shotType?: string | null;
  visualPrompt?: string | null;
  mentionedCount: number;
}): boolean => {
  const shotTypeLower = (options.shotType || '').toLowerCase();
  const prompt = options.visualPrompt || '';
  const isClose = ['close-up', 'close up', 'portrait', 'medium close', 'extreme close'].some(
    (k) => shotTypeLower.includes(k)
  );
  const isWide = ['wide', 'long shot', 'full body', 'extreme long', 'establishing'].some((k) =>
    shotTypeLower.includes(k)
  );
  const multiFromPrompt = /\b[23]girls?\b|\b[23]boys?\b/i.test(prompt);
  const storyAction =
    /\b(embrac|kiss|sitting|lying|straddl|between|on bed|couch|yuri|tendril|walking|reaching)\b/i.test(
      prompt
    );

  return (
    options.mentionedCount === 1
    && isClose
    && !isWide
    && !multiFromPrompt
    && !storyAction
  );
};
