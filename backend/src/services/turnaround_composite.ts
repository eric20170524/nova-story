/**
 * Character turnaround via one front plate, then side and back img2img, then a stitch.
 *
 * The front panel keeps the approved portrait's face and inpaints the body.
 * Side and back redraw the camera from that full-body plate.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import sharp, { type OverlayOptions } from 'sharp';
import { logger } from '../core/logging';
import { SettingsManager } from '../core/settings_manager';
import { db } from '../db/database';
import {
  getGeneratedDirectory,
  getSceneAssetPath,
  getCharacterAssetPath,
  resolveStaticAssetPath
} from '../core/paths';
import { applyRemoteLoraCatalog, ComfyUIService } from './ai/comfyui_service';
import {
  compileComfyWorkflow,
  copyReferenceImageToComfy
} from './generation_service';
import { resolveTierBFromSettings } from './tier_b_adapters';
import {
  inferPromptSubjectType,
  normalizeImageModelFamily,
  ORIENTAL_REALISTIC_FACE_LOCK,
  readStoredCharacterSheet,
  splitClauses,
  stripSceneWardrobeClauses,
  type ImageModelFamily
} from './image_generation_policy';
import { readPortraitPlate } from './portrait_plate';
import { commitCharacterEdits, ensureCharacterVersionBaseline } from './character_versions';
import { GpuLeaseService } from './gpu_lease_service';
import { resolveTurnaroundStrategy, turnaroundPanelDimensions } from './image_output_spec';
import { getProjectImageSettings, parseProjectSettings, resolveEffectiveNsfw } from './project_settings';
import { TURNAROUND_ANGLE_DENOISE } from './reference_generation_policy';
import { isSyntheticCharacterSceneId, syntheticCharacterId } from './synthetic_scene_id';

export type TurnaroundViewId = 'front' | 'side' | 'back';

export interface TurnaroundViewSpec {
  id: TurnaroundViewId;
  label: string;
  /** Extra composition tags (pose / camera) */
  poseTags: string;
  /** Strong negatives for this angle */
  negativeExtra: string;
}

export const TURNAROUND_VIEWS: TurnaroundViewSpec[] = [
  {
    id: 'front',
    label: 'FRONT',
    poseTags:
      'full body, head to toe, full-length wide shot, neutral standing A-pose, (direct front view:1.3), entire figure from head to feet inside frame, long skirt hem and feet visible on studio floor, shoulders and hips square to camera, facing viewer, arms slightly away from torso, hands and feet visible, orthographic front',
    negativeExtra:
      'side view, profile, back view, from behind, close-up, medium shot, cowboy shot, waist-up, knee-up, bust shot, upper body only, cropped legs, cropped feet, portrait crop'
  },
  {
    id: 'side',
    label: 'SIDE',
    poseTags:
      'full body, head to toe, full-length wide shot, neutral standing A-pose, (strict 90 degree left side profile:1.35), entire figure from head to feet inside frame, long skirt hem and feet visible on studio floor, head and torso both turned left, shoulders and hips in profile, feet pointing left, exactly one eye visible, nose silhouette pointing left, arms slightly away from torso, orthographic side',
    negativeExtra:
      'front view, frontal face, front-facing torso, facing viewer, looking at viewer, both eyes visible, back view, from behind, close-up, medium shot, cowboy shot, waist-up, knee-up, bust shot, upper body only, cropped legs, cropped feet, portrait crop, three-quarter view'
  },
  {
    id: 'back',
    label: 'BACK',
    poseTags:
      'full body, head to toe, full-length wide shot, neutral standing A-pose, (strict rear view from behind:1.35), entire figure from head to feet inside frame, long skirt hem and feet visible on studio floor, head and torso both facing away, occiput and nape of neck visible, continuous hair covering back of head, shoulder blades and back of garment visible, shoulders and hips facing away, arms slightly away from torso, hands and feet visible, orthographic back',
    negativeExtra:
      'front view, frontal figure, face visible, eyes, nose, turned head, looking over shoulder, looking at viewer, side view, profile, close-up, medium shot, cowboy shot, waist-up, knee-up, bust shot, upper body only, cropped legs, cropped feet, portrait crop'
  }
];

const STRIP_MULTI_VIEW =
  /\b(character turnaround sheet|multi-?view layout|multi-?view|3 views|three views|split view layout|complete 3-view|aligned character turnaround|front view,\s*side view,\s*back view|side view,\s*back view|turnaround sheet)\b/gi;
const STRIP_TURNAROUND_STAGING =
  /\b(portrait|upper body|bust shot|close-up|medium shot|front view|side view|back view|matching reference character design|consistent (?:face(?:\s+hair\s+and\s+clothing)?|facial features|character design)(?:\s+across(?:\s+all)?\s+views)?|same outfit and hair across all views|character reference|standing|full body)\b/i;
const STRIP_TURNAROUND_MOOD =
  /\b(aroused|seductive|alluring|melting expression|softens under emotion|half-lidded|blushing|smile|gaze|intimate|erotic|playful|inviting|rating_explicit|rating_questionable|soft full lips|soft pink lips|expressive brows|delicate brows|full breasts|soft hourglass(?:\s+mature\s+figure)?|delicate collarbones)\b/i;
const STRIP_BACK_FRONTAL_RE =
  /\b(eyes?|eyelids?|lips?|brows?|eyebrows?|cheekbones?|nose|facial|face|expression|cleavage|breasts?|upper chest)\b/i;
const STRIP_SIDE_FRONTAL_RE =
  /\b(both eyes|upper chest|cleavage|expression|breasts?|lips?|brows?|eyebrows?|cheekbones?)\b/i;
const STRIP_TURNAROUND_HANDHELD_AURA_RE =
  /\b(divine mirror|handheld|(?:floating|swirling)(?:\s+[a-z-]+){0,3}\s+petals?|petal(?:\s+[a-z-]+){0,2}\s+aura|spirit aura|immortal glow)\b/i;

/**
 * Semantic substitutions that protect compound hair-length and garment structure
 * descriptors from Scunthorpe truncation when frontal anatomy words are stripped.
 */
const SAFE_COMPOUND_REPLACEMENTS: ReadonlyArray< readonly [RegExp, string]> = [
  [/\bcollarbone[- ]length\b/gi, 'shoulder-length'],
  [/\bchest[- ]length\b/gi, 'mid-back length'],
  [/\bdouble[- ]breasted\b/gi, 'tailored double-buttoned'],
  [/\bsingle[- ]breasted\b/gi, 'tailored single-buttoned'],
  [/\bchest[- ]plate\b/gi, 'torso plate'],
  [/\bbreastplate\b/gi, 'cuirass torso'],
  [/\b(?:no|without)\s+face(?:\s+visible)?\b/gi, 'occiput and nape of neck visible'],
];

const GARMENT_OR_HAIR_NOUN_RE =
  /\b(hair|twintails|twin tails|ponytail|braids?|trench coat|coat|jacket|armor|cuirass|sweater|dress|robe|gown|shirt|blouse|top|skirt|suit|vest|corset|tunic|hanfu|cape|cloak|gloves)\b/i;

const OCULAR_OCCLUSION_RE =
  /\b(blindfold(?:ed)?|eyepatch|eye patch|covered eyes|eyes covered|bangs covering eyes|heavy bangs (?:covering|over) eyes|closed eyes|eyes closed|visored helmet)\b/i;

export const normalizeCompoundAppearanceTerms = (text: string): string => {
  let current = String(text || '');
  for (const [pattern, replacement] of SAFE_COMPOUND_REPLACEMENTS) {
    current = current.replace(pattern, replacement);
  }
  return current;
};

/**
 * Strip participial handheld prop phrases ("holding a glowing lantern in her left hand")
 * without devouring trailing wardrobe clauses ("while wearing long lace gloves").
 */
export const stripHandheldPropPhrases = (clause: string): string => {
  let cleaned = String(clause || '')
    .replace(
      /\b(?:holding|wielding|carrying|grasping)\s+[^,;]+?(?=\s+(?:while|and)\s+(?:wearing|dressed|clad)\b)/gi,
      ''
    )
    .replace(/\b(?:while|and)\s+(?=(?:wearing|dressed|clad)\b)/gi, '')
    .replace(
      /^(?:holding|wielding|carrying|grasping)\s+(?:a|an|the|her|his)?\s*[^,;]+$/i,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;-]+|[\s,;-]+$/g, '')
    .trim();
  if (/^(?:in|with)\s+(?:her|his|both|left|right)\s+hands?$/i.test(cleaned)) {
    cleaned = '';
  }
  return cleaned;
};

const sanitizeGarmentFrontalModifiers = (clause: string, stripRe: RegExp): string | null => {
  const normalized = normalizeCompoundAppearanceTerms(clause);
  if (!stripRe.test(normalized)) return normalized;
  if (OCULAR_OCCLUSION_RE.test(normalized)) return normalized;
  if (!GARMENT_OR_HAIR_NOUN_RE.test(normalized)) return null;
  const surgicallyCleaned = normalized
    .replace(/\b(?:deep\s+|open\s+|low-cut\s+)?cleavage(?:\s+window|\s+cutout)?\b/gi, '')
    .replace(/\bupper\s+chest\b/gi, '')
    .replace(/\b(?:full\s+)?breasts?\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;-]+|[\s,;-]+$/g, '')
    .trim();
  return surgicallyCleaned && !stripRe.test(surgicallyCleaned) ? surgicallyCleaned : null;
};

const stripBooruWeights = (text: string): string =>
  String(text || '').replace(/\(([^():]+):[\d.]+\)/g, '$1');

const normalizeBareAgeRange = (text: string): string =>
  String(text || '')
    .replace(/\b(\d{2})\s*[-–~]\s*(\d{2})\s*(?:years?\s*old|岁)\b/gi, '$1 to $2 years old')
    .replace(/(^|[,，]\s*)(\d{2})\s*[-–~]\s*(\d{2})(?=\s*(?:[,，]|$))/g, '$1$2 to $3 years old');

/**
 * Strip multi-view sheet language from a client prompt so each panel is a single figure.
 */
const TURNAROUND_VIEW_ORDER: TurnaroundViewId[] = ['front', 'side', 'back'];

/** null, '', or 'all' means the full sheet. Anything else must be front, side, or back. */
export function parseTurnaroundViews(
  workflowData: Record<string, unknown> | null | undefined
): TurnaroundViewId[] {
  const raw = workflowData?.turnaround_views;
  if (raw == null || raw === '' || raw === 'all') return [...TURNAROUND_VIEW_ORDER];
  const list = Array.isArray(raw) ? raw : [raw];
  const ids = list.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  if (!ids.length) throw new Error('三视图重出必须指定正面、侧面或背面。');
  for (const id of ids) {
    if (!TURNAROUND_VIEW_ORDER.includes(id as TurnaroundViewId)) {
      throw new Error('三视图重出只能指定正面、侧面或背面。');
    }
  }
  return TURNAROUND_VIEW_ORDER.filter((id) => ids.includes(id));
}

/**
 * Canonical panels drop chapter wardrobe such as half-open.
 * A named variant keeps that clothing text and is stored apart from the regular sheet.
 */
export function canonicalTurnaroundPrompt(prompt: string, wardrobeVariant?: string | null): string {
  const base = extractAppearanceBase(stripSceneWardrobeClauses(String(prompt || '')));
  const variant = String(wardrobeVariant || '').trim();
  return variant ? [base, variant].filter(Boolean).join(', ') : base;
}

export function mergeTurnaroundAssets(
  tags: Record<string, any>,
  panels: Partial<Record<TurnaroundViewId, string>>,
  sheetUrl: string | null,
  options: { wardrobeVariant?: string | null } = {},
): Record<string, any> {
  const assets = { ...(tags?.assets || {}) };
  const variant = String(options.wardrobeVariant || '').trim();
  if (variant) {
    const previous = assets.turnaround_variants && typeof assets.turnaround_variants === 'object'
      ? assets.turnaround_variants
      : {};
    const existing = previous[variant] && typeof previous[variant] === 'object' ? previous[variant] : {};
    const next: Record<string, string> = { ...existing };
    if (panels.front) next.front_url = panels.front;
    if (panels.side) next.side_url = panels.side;
    if (panels.back) next.back_url = panels.back;
    if (sheetUrl) next.sheet_url = sheetUrl;
    assets.turnaround_variants = { ...previous, [variant]: next };
    return { ...tags, assets };
  }
  if (panels.front) assets.turnaround_front_url = panels.front;
  if (panels.side) assets.turnaround_side_url = panels.side;
  if (panels.back) assets.turnaround_back_url = panels.back;
  if (sheetUrl) assets.turnaround_url = sheetUrl;
  return { ...tags, assets };
}

export function extractAppearanceBase(prompt: string): string {
  const normalized = normalizeCompoundAppearanceTerms(
    normalizeBareAgeRange(
      String(prompt || '').replace(STRIP_MULTI_VIEW, ' ')
    )
  );
  const clauses = splitClauses(normalized)
    .map((clause) => stripHandheldPropPhrases(clause.replace(/\s{2,}/g, ' ').trim()))
    .filter((clause) => clause
      && !STRIP_TURNAROUND_STAGING.test(clause)
      && !STRIP_TURNAROUND_MOOD.test(clause)
      && !STRIP_TURNAROUND_HANDHELD_AURA_RE.test(clause)
      && !/^\s*(glowing|bronze rim)\)?\s*$/i.test(clause));
  const hasFlowerHairOrnaments = clauses.some((c) => /\bflower hair ornaments?\b/i.test(c));
  const seen = new Set<string>();
  const deduped = clauses.filter((clause) => {
    const key = clause.toLowerCase();
    if (seen.has(key)) return false;
    if (hasFlowerHairOrnaments && /^flower ornaments?$/i.test(key)) return false;
    seen.add(key);
    return true;
  });
  const joined = deduped.join(', ');
  if (
    /\b(hanfu|xianxia(?:\s+immortal)?\s+(?:dress|robe))\b/i.test(joined)
    && !/\bsleeves?\b/i.test(joined)
  ) {
    return `${joined}, long flowing wide sleeves`;
  }
  return joined;
}

const FACE_LOCK_CLAUSES = new Set(
  `${ORIENTAL_REALISTIC_FACE_LOCK}, delicate classical oriental bone structure, East Asian facial features`
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
);

/** Side and back views cannot show the locked face, so those clauses leave the appearance. */
export function stripOrientalFaceLock(prompt: string): string {
  const results: string[] = [];
  for (const rawPart of splitClauses(normalizeCompoundAppearanceTerms(String(prompt || '')))) {
    const part = rawPart.trim();
    const key = part.toLowerCase();
    if (!key || FACE_LOCK_CLAUSES.has(key)) continue;
    if (/east asian facial/i.test(part)) continue;
    if (/oriental bone structure/i.test(part)) continue;
    if (/east asian eyelids/i.test(part)) continue;
    if (STRIP_BACK_FRONTAL_RE.test(part)) {
      const rescued = sanitizeGarmentFrontalModifiers(part, STRIP_BACK_FRONTAL_RE);
      if (rescued && !/\b(?:eyes?|eyelids?|lips?|brows?|eyebrows?|cheekbones?|nose|facial|face|expression)\b/i.test(rescued)) {
        results.push(rescued);
      }
      continue;
    }
    results.push(part);
  }
  return results.join(', ');
}

const filterSideAppearance = (prompt: string): string => {
  const results: string[] = [];
  for (const rawPart of splitClauses(normalizeCompoundAppearanceTerms(String(prompt || '')))) {
    const part = rawPart.trim();
    if (!part) continue;
    if (STRIP_SIDE_FRONTAL_RE.test(part)) {
      const rescued = sanitizeGarmentFrontalModifiers(part, STRIP_SIDE_FRONTAL_RE);
      if (rescued) results.push(rescued);
      continue;
    }
    results.push(part);
  }
  return results.join(', ');
};

export function buildTurnaroundViewPrompt(
  basePrompt: string,
  view: TurnaroundViewSpec,
  modelFamily: ImageModelFamily
): { prompt: string; negative_prompt: string } {
  const naturalLanguage = modelFamily === 'redcraft_krea2' || modelFamily === 'qwen_image' || modelFamily === 'flux';
  const hasOcularOcclusion = OCULAR_OCCLUSION_RE.test(String(basePrompt || ''));
  const rawFiltered = view.id === 'back'
    ? stripOrientalFaceLock(basePrompt)
    : view.id === 'side'
      ? filterSideAppearance(basePrompt)
      : normalizeCompoundAppearanceTerms(basePrompt);
  const appearance = extractAppearanceBase(naturalLanguage ? stripBooruWeights(rawFiltered) : rawFiltered);
  const subjectKind = inferPromptSubjectType(basePrompt);
  const subjectNoun = subjectKind === 'female_human'
    ? 'adult East Asian woman, female'
    : subjectKind === 'male_human'
      ? 'adult East Asian man, male'
      : 'standing character';
  const sideEyeCameraClause = hasOcularOcclusion
    ? 'The nose points left in strict profile.'
    : 'The nose points left and only one eye is visible.';
  const camera = (modelFamily === 'redcraft_krea2' || modelFamily === 'qwen_image' || modelFamily === 'flux')
    ? view.id === 'side'
      ? `Full-length head-to-toe wide shot, strict 90 degree left profile of one ${subjectNoun} standing from head to toe with entire figure, dress hem, and feet visible on the floor. The camera is directly beside them. Head, torso, and feet all point left. ${sideEyeCameraClause} Both arms hang naturally at the sides with only the left arm in the foreground.`
      : view.id === 'back'
        ? `Full-length head-to-toe wide shot, strict rear view of one ${subjectNoun} standing from head to toe with entire figure, dress hem, and feet visible on the floor, seen from directly behind. The camera is behind them. Occiput, nape of neck, shoulder blades, continuous hair covering the back of the head, and the back panel of the garment are clearly visible.`
        : `Full-length head-to-toe wide shot, direct front view of one ${subjectNoun} standing from head to toe with entire figure, dress hem, and feet visible on the floor, facing the camera.`
    : '';
  const quality =
    modelFamily === 'pony'
      ? 'score_9, score_8_up, score_7_up, source_anime, masterpiece, best quality'
      : modelFamily === 'redcraft_krea2' || modelFamily === 'qwen_image' || modelFamily === 'flux'
        ? 'masterpiece quality, highly detailed, clean studio render'
        : 'masterpiece, best quality, highly detailed';
  const rawPoseTags = view.id === 'side' && hasOcularOcclusion
    ? view.poseTags.replace(/,\s*exactly one eye visible\b/i, '')
    : view.poseTags;
  const poseTags = naturalLanguage ? stripBooruWeights(rawPoseTags) : rawPoseTags;
  const framingDetails = view.id === 'back'
    ? 'occiput and nape of neck, shoulder blades, back of garment, natural body proportions, clear silhouette, plain studio background, even flat studio lighting, solid opaque clothing'
    : 'neutral expression, natural body proportions, clear silhouette, plain studio background, even flat studio lighting, solid opaque clothing';

  const prompt = [
    camera,
    quality,
    'one solitary figure, single isolated character, no duplicate',
    poseTags,
    framingDetails,
    appearance
  ]
    .filter(Boolean)
    .join(', ');

  const negative = [
    'low quality, worst quality, bad anatomy, extra limbs, extra arms, four arms, four hands, extra fingers, deformed hands',
    'text, letters, numbers, typography, watermark, logo, signature, speech bubble, label, banner',
    'duplicate figure, second person, double head, two heads, collage, split panel, comic panel, grid, turnaround sheet, multiple views',
    'child, loli, shota, underage',
    'blurry, cropped head, missing feet, floating limbs',
    'halo, helmet, space helmet, glowing ring, moon backdrop, gradient background, gray background, architecture, archway, doorway, columns, scenery, props, floating objects',
    view.negativeExtra
  ].filter(Boolean).join(', ');

  return { prompt, negative_prompt: negative };
}

/**
 * Place the approved portrait's face on a tall canvas and leave the body transparent.
 * ComfyUI inpaints the transparent pixels and keeps the opaque face.
 */
export async function buildFaceLockCanvas(
  portraitPath: string | Buffer,
  width: number,
  height: number
): Promise<Buffer> {
  const meta = await sharp(portraitPath).metadata();
  const sourceW = meta.width || width;
  const sourceH = meta.height || height;
  const cropW = Math.max(8, Math.round(sourceW * 0.7));
  const cropH = Math.max(8, Math.round(sourceH * 0.52));
  const faceW = Math.max(32, Math.round(width * 0.22));
  const faceH = Math.max(32, Math.round(height * 0.18));
  const face = await sharp(portraitPath)
    .extract({
      left: Math.max(0, Math.round((sourceW - cropW) / 2)),
      top: Math.max(0, Math.round(sourceH * 0.02)),
      width: Math.min(cropW, sourceW),
      height: Math.min(cropH, sourceH)
    })
    .resize(faceW, faceH)
    .removeAlpha()
    .png()
    .toBuffer();
  const ellipse = Buffer.from(
    `<svg width="${faceW}" height="${faceH}"><ellipse cx="${faceW / 2}" cy="${faceH * 0.46}" rx="${faceW * 0.46}" ry="${faceH * 0.48}" fill="white"/></svg>`
  );
  const mask = await sharp(ellipse).resize(faceW, faceH).blur(8).png().toBuffer();
  const left = Math.round((width - faceW) / 2);
  const top = Math.round(height * 0.02);
  const rgb = await sharp({
    create: { width, height, channels: 3, background: { r: 232, g: 232, b: 232 } }
  }).composite([{ input: face, left, top }]).ensureAlpha().png().toBuffer();
  const alphaMask = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  }).composite([{ input: mask, left, top }]).png().toBuffer();
  return sharp(rgb).composite([{ input: alphaMask, blend: 'dest-in' }]).png().toBuffer();
}

/**
 * Front keeps the portrait face and inpaints the body.
 * Side and back redraw the camera from that full-body plate.
 */
export function buildTurnaroundPanelWorkflowData(
  workflowData: Record<string, unknown>,
  view: TurnaroundViewSpec,
  prompt: string,
  negativePrompt: string,
  frontPlateUrl: string | null,
  faceLockUrl: string | null = null
): Record<string, unknown> {
  const faceLock = view.id === 'front' && Boolean(faceLockUrl);
  const fromFront = view.id !== 'front' && Boolean(frontPlateUrl);
  return {
    ...workflowData,
    prompt,
    negative_prompt: negativePrompt,
    gen_type: 'turnaround_panel',
    nsfw_enabled: workflowData.nsfw_enabled === true,
    denoise: fromFront ? TURNAROUND_ANGLE_DENOISE : 1,
    turnaround_from_front: fromFront,
    turnaround_face_lock: faceLock,
    character_ref_url: faceLock ? faceLockUrl : fromFront ? frontPlateUrl : undefined,
    ref_image_url: faceLock ? faceLockUrl : fromFront ? frontPlateUrl : undefined,
    composition_ref_url: undefined,
    composition_reference_url: undefined,
    pose_ref_url: undefined,
    force_no_character_adapter: true,
    character_adapter_weight: undefined,
    turnaround_front_adapter: false,
    style_preset: workflowData.style_preset || null
  };
}

export interface CompositeOptions {
  panelWidth?: number;
  panelHeight?: number;
  gap?: number;
  padding?: number;
  labelHeight?: number;
  background?: string;
}

const parseHexRgb = (hex: string): { r: number; g: number; b: number } => {
  const clean = String(hex || '#f5f5f5').trim().replace(/^#/, '');
  if (clean.length === 3) {
    const r = parseInt(clean[0]! + clean[0]!, 16);
    const g = parseInt(clean[1]! + clean[1]!, 16);
    const b = parseInt(clean[2]! + clean[2]!, 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return { r, g, b };
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return { r, g, b };
  }
  return { r: 245, g: 245, b: 245 };
};

/**
 * Normalize studio background color drift (sampling 4 corners) and align the
 * character's vertical bounding box (head top & foot baseline) across views.
 */
export async function normalizeAndAlignTurnaroundPanel(
  buffer: Buffer,
  panelWidth: number,
  panelHeight: number,
  backgroundHex: string = '#f5f5f5'
): Promise<Buffer> {
  const targetBg = parseHexRgb(backgroundHex);
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const patch = Math.max(2, Math.min(16, Math.floor(Math.min(w, h) / 8)));
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  const samplePatch = (startX: number, startY: number) => {
    for (let y = startY; y < startY + patch && y < h; y++) {
      for (let x = startX; x < startX + patch && x < w; x++) {
        const idx = (y * w + x) * 3;
        sumR += data[idx] ?? targetBg.r;
        sumG += data[idx + 1] ?? targetBg.g;
        sumB += data[idx + 2] ?? targetBg.b;
        count++;
      }
    }
  };
  samplePatch(0, 0);
  samplePatch(Math.max(0, w - patch), 0);
  samplePatch(0, Math.max(0, h - patch));
  samplePatch(Math.max(0, w - patch), Math.max(0, h - patch));

  const cornerR = count > 0 ? sumR / count : targetBg.r;
  const cornerG = count > 0 ? sumG / count : targetBg.g;
  const cornerB = count > 0 ? sumB / count : targetBg.b;

  const fgThreshold = 22;
  const featherThreshold = 44;
  const minRowPixels = Math.max(2, Math.floor(w * 0.015));
  let topY = -1;
  let bottomY = -1;
  let leftX = w;
  let rightX = -1;

  for (let y = 0; y < h; y++) {
    let rowFg = 0;
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 3;
      const dr = (data[idx] ?? 0) - cornerR;
      const dg = (data[idx + 1] ?? 0) - cornerG;
      const db = (data[idx + 2] ?? 0) - cornerB;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist >= fgThreshold) {
        rowFg++;
        if (x < leftX) leftX = x;
        if (x > rightX) rightX = x;
      }
    }
    if (rowFg >= minRowPixels) {
      if (topY === -1) topY = y;
      bottomY = y;
    }
  }

  const hasSubject = topY >= 0 && bottomY > topY && (bottomY - topY) >= h * 0.15;
  if (!hasSubject) {
    return sharp(buffer)
      .resize(panelWidth, panelHeight, {
        fit: 'contain',
        background: { ...targetBg, alpha: 1 }
      })
      .png()
      .toBuffer();
  }

  const normalizedRaw = Buffer.from(data);
  const gainR = cornerR > 16 ? targetBg.r / cornerR : 1;
  const gainG = cornerG > 16 ? targetBg.g / cornerG : 1;
  const gainB = cornerB > 16 ? targetBg.b / cornerB : 1;
  const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

  for (let i = 0; i < normalizedRaw.length; i += 3) {
    const r = normalizedRaw[i] ?? 0;
    const g = normalizedRaw[i + 1] ?? 0;
    const b = normalizedRaw[i + 2] ?? 0;
    const dr = r - cornerR;
    const dg = g - cornerG;
    const db = b - cornerB;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist <= fgThreshold) {
      normalizedRaw[i] = targetBg.r;
      normalizedRaw[i + 1] = targetBg.g;
      normalizedRaw[i + 2] = targetBg.b;
    } else if (dist < featherThreshold) {
      const alpha = (dist - fgThreshold) / (featherThreshold - fgThreshold);
      const corrR = clampByte(r * gainR);
      const corrG = clampByte(g * gainG);
      const corrB = clampByte(b * gainB);
      normalizedRaw[i] = clampByte(targetBg.r * (1 - alpha) + corrR * alpha);
      normalizedRaw[i + 1] = clampByte(targetBg.g * (1 - alpha) + corrG * alpha);
      normalizedRaw[i + 2] = clampByte(targetBg.b * (1 - alpha) + corrB * alpha);
    }
  }

  const subjectH = Math.max(1, bottomY - topY + 1);
  const padX = Math.max(4, Math.round((rightX - leftX + 1) * 0.08));
  const cropLeft = Math.max(0, leftX - padX);
  const cropRight = Math.min(w - 1, rightX + padX);
  const cropW = Math.max(1, cropRight - cropLeft + 1);

  const croppedSubject = await sharp(normalizedRaw, {
    raw: { width: w, height: h, channels: 3 }
  })
    .extract({ left: cropLeft, top: topY, width: cropW, height: subjectH })
    .png()
    .toBuffer();

  // Align head top to 6% headroom and foot bottom to 94% baseline (88% figure height).
  const targetTopY = Math.round(panelHeight * 0.06);
  const targetFootY = Math.round(panelHeight * 0.94);
  const targetSubjectH = Math.max(16, targetFootY - targetTopY);

  const scaledSubject = await sharp(croppedSubject)
    .resize(panelWidth, targetSubjectH, {
      fit: 'inside',
      withoutEnlargement: false
    })
    .png()
    .toBuffer();

  const scaledMeta = await sharp(scaledSubject).metadata();
  const scaledW = scaledMeta.width || panelWidth;
  const scaledH = scaledMeta.height || targetSubjectH;
  const pasteLeft = Math.max(0, Math.floor((panelWidth - scaledW) / 2));
  // Anchor feet to targetFootY so all 3 views stand on the same horizontal ground line.
  const pasteTop = Math.max(0, targetFootY - scaledH);

  return sharp({
    create: {
      width: panelWidth,
      height: panelHeight,
      channels: 3,
      background: targetBg
    }
  })
    .composite([{ input: scaledSubject, left: pasteLeft, top: pasteTop }])
    .png()
    .toBuffer();
}

/**
 * Stitch three full-body panels into one labeled turnaround sheet (left→right).
 */
export async function stitchTurnaroundSheet(
  panels: Array<{ buffer: Buffer; label: string }>,
  options: CompositeOptions = {}
): Promise<Buffer> {
  if (panels.length !== 3) {
    throw new Error(`stitchTurnaroundSheet expects 3 panels, got ${panels.length}`);
  }

  const panelWidth = options.panelWidth ?? 512;
  const panelHeight = options.panelHeight ?? 896;
  const gap = options.gap ?? 16;
  const padding = options.padding ?? 24;
  const labelHeight = options.labelHeight ?? 40;
  const background = options.background ?? '#f5f5f5';

  const contentW = padding * 2 + panelWidth * 3 + gap * 2;
  const contentH = padding * 2 + labelHeight + panelHeight;
  // Keep the panel layout independent from the delivered 16:9 asset canvas.
  const canvasW = Math.ceil(Math.max(contentW, contentH * 16 / 9) / 64) * 64;
  const canvasH = canvasW * 9 / 16;
  const offsetX = Math.floor((canvasW - contentW) / 2);
  const offsetY = Math.floor((canvasH - contentH) / 2);

  const composites: OverlayOptions[] = [];

  for (let i = 0; i < 3; i++) {
    const panel = panels[i];
    if (!panel) {
      throw new Error(`stitchTurnaroundSheet missing panel at index ${i}`);
    }
    const x = offsetX + padding + i * (panelWidth + gap);
    const yLabel = offsetY + padding;
    const yImg = offsetY + padding + labelHeight;

    const fitted = await normalizeAndAlignTurnaroundPanel(
      panel.buffer,
      panelWidth,
      panelHeight,
      background
    );

    const labelSvg = Buffer.from(
      `<svg width="${panelWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="${background}"/>
        <text x="50%" y="60%" text-anchor="middle" font-family="Arial, sans-serif"
          font-size="22" font-weight="700" fill="#333">${panel.label}</text>
      </svg>`
    );

    composites.push({ input: labelSvg, left: x, top: yLabel });
    composites.push({ input: fitted, left: x, top: yImg });
  }

  return sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background
    }
  })
    .composite(composites)
    .png()
    .toBuffer();
}

export interface TurnaroundGenerateInput {
  taskId: string;
  sceneId: number;
  /** Full client prompt (may include multi-view wording; will be cleaned per panel) */
  prompt: string;
  negative_prompt?: string;
  workflowData: Record<string, unknown>;
  generationParams?: any;
  onProgress?: (msg: string, data?: any) => void | Promise<void>;
}

export interface TurnaroundGenerateResult {
  sheetUrl: string;
  sheetPath: string;
  panelUrls: { front: string; side: string; back: string };
}

/**
 * Generate front/side/back full-body panels then stitch into turnaround sheet.
 */
export async function generateTurnaroundComposite(
  input: TurnaroundGenerateInput
): Promise<TurnaroundGenerateResult> {
  const settings = SettingsManager.loadSettings();
  const comfySettings = settings.comfyui || {};
  if (!comfySettings.enabled) {
    throw new Error('Turnaround composite requires local ComfyUI (comfyui.enabled)');
  }

  const staticDir = getGeneratedDirectory();
  fs.mkdirSync(staticDir, { recursive: true });

  const comfyService = ComfyUIService.fromSettings(comfySettings);
  const isRunning = await comfyService.ensureRunning(comfySettings.install_path);
  if (!isRunning) {
    throw new Error('Failed to start or connect to ComfyUI');
  }

  let projectId: number | null = null;
  let characterId: number | null = null;
  let version: number = Number(input.workflowData?.version || input.workflowData?.scene_version || 1);

  let inferredSubjectType: string | null = null;
  let humanTurnaround = false;
  let storedAvatarUrl = '';
  let storedTags: Record<string, any> = {};
  const sceneRow = await db.get(
    'SELECT chapter_id, active_version FROM scene WHERE id = ?',
    input.sceneId
  );
  if (sceneRow) {
    if (sceneRow.active_version != null) {
      version = Number(sceneRow.active_version);
    }
    if (sceneRow.chapter_id) {
      const chapterRow = await db.get(
        'SELECT project_id FROM chapter WHERE id = ?',
        sceneRow.chapter_id
      );
      if (chapterRow?.project_id) {
        projectId = Number(chapterRow.project_id);
      }
    }
  } else if (isSyntheticCharacterSceneId(input.sceneId) || input.workflowData.character_id) {
    characterId = input.workflowData?.character_id
      ? Number(input.workflowData.character_id)
      : syntheticCharacterId(input.sceneId);
    if (characterId) {
      const charRow = await db.get(
        'SELECT id, name, project_id, active_version, description, visual_tags FROM character WHERE id = ?',
        characterId
      );
      if (charRow) {
        projectId = charRow.project_id != null ? Number(charRow.project_id) : null;
        version = Number(charRow.active_version || 1);
        try {
          const tags = typeof charRow.visual_tags === 'string'
            ? JSON.parse(charRow.visual_tags || '{}')
            : (charRow.visual_tags || {});
          storedTags = tags && typeof tags === 'object' ? tags : {};
          storedAvatarUrl = String(storedTags?.assets?.avatar_url || storedTags?.avatar_url || '').trim();
          const storedSheet = readStoredCharacterSheet(storedTags, { description: charRow.description });
          if (storedSheet.gender === 'female') {
            inferredSubjectType = 'female_human';
          } else if (storedSheet.gender === 'male') {
            inferredSubjectType = 'male_human';
          }
          const subject = inferPromptSubjectType(
            [charRow.name, charRow.description, storedSheet.appearance.hair, storedSheet.appearance.clothing].filter(Boolean).join(', '),
            storedTags.subject_type || storedTags.species || inferredSubjectType,
          );
          humanTurnaround = subject !== 'nonhuman' && subject !== 'environment';
        } catch {
          /* ignore malformed visual_tags */
        }
      }
    }
  }

  let effectiveWorkflowData: Record<string, unknown> = {
    ...input.workflowData,
    ...(inferredSubjectType && !input.workflowData.subject_type ? { subject_type: inferredSubjectType } : {}),
    character_ref_url: undefined,
    ref_image_url: undefined,
    turnaround_front_adapter: false,
  };
  if (projectId != null) {
    const projectRow = await db.get('SELECT settings FROM project WHERE id = ?', projectId);
    if (projectRow) {
      const projectSettings = parseProjectSettings(projectRow.settings);
      const nsfwEnabled = resolveEffectiveNsfw({
        systemNsfwEnabled: Boolean(settings.advanced?.nsfw_enabled),
        projectSettings,
      });
      effectiveWorkflowData = {
        ...effectiveWorkflowData,
        project_settings: projectSettings,
        model_type: getProjectImageSettings(projectSettings).model,
        style_preset: getProjectImageSettings(projectSettings).style,
        nsfw_enabled: effectiveWorkflowData.nsfw_enabled ?? nsfwEnabled,
        workflow_id: undefined,
        selected_workflow_id: undefined,
      };
    }
  }

  const modelFamily: ImageModelFamily = getProjectImageSettings(
    parseProjectSettings(effectiveWorkflowData.project_settings)
  ).model;
  const compileSettings = await applyRemoteLoraCatalog(settings, comfyService);

  // Tier B is Pony/SDXL only
  const tierB = await resolveTierBFromSettings(settings, {
    isFlux: modelFamily !== 'pony'
  });

  const panelBuffers: Array<{ buffer: Buffer; label: string; id: TurnaroundViewId }> = [];
  const panelPaths: Partial<Record<TurnaroundViewId, string>> = {};
  const { width: panelW, height: panelH } = turnaroundPanelDimensions(modelFamily);
  const requestedSeed = Number(input.generationParams?.seed);
  const sheetSeed = Number.isSafeInteger(requestedSeed) && requestedSeed >= 0 && input.generationParams?.seed != null
    ? requestedSeed
    : Math.floor(Math.random() * 1_000_000_000);
  const requestedViews = parseTurnaroundViews(input.workflowData);
  const wardrobeVariant = String(input.workflowData?.wardrobe_variant || '').trim();
  const panelPrompt = canonicalTurnaroundPrompt(input.prompt, wardrobeVariant);
  const storedPanelUrl = (view: TurnaroundViewId): string => {
    const assets = storedTags.assets || {};
    if (wardrobeVariant) {
      const bucket = assets.turnaround_variants?.[wardrobeVariant];
      const record = bucket && typeof bucket === 'object' ? bucket as Record<string, unknown> : {};
      const key = view === 'front' ? 'front_url' : view === 'side' ? 'side_url' : 'back_url';
      return String(record[key] || '').trim();
    }
    if (view === 'front') return String(assets.turnaround_front_url || storedTags.turnaround_front_url || '').trim();
    if (view === 'side') return String(assets.turnaround_side_url || '').trim();
    return String(assets.turnaround_back_url || '').trim();
  };
  const readStoredPanel = (view: TurnaroundViewId): Buffer => {
    const url = storedPanelUrl(view);
    const file = url ? resolveStaticAssetPath(url) : '';
    if (!url || !file || !fs.existsSync(file)) {
      throw new Error('已有的三视图单格不在磁盘上，不能只重出其他角度。');
    }
    return fs.readFileSync(file);
  };
  const storedBuffers = new Map<TurnaroundViewId, Buffer>();
  for (const view of TURNAROUND_VIEWS) {
    if (requestedViews.includes(view.id)) continue;
    storedBuffers.set(view.id, readStoredPanel(view.id));
  }

  let frontPlateUrl: string | null = requestedViews.includes('front') ? null : storedPanelUrl('front');
  if (characterId != null && humanTurnaround) {
    await readPortraitPlate(storedAvatarUrl);
  }

  for (let i = 0; i < requestedViews.length; i++) {
    const view = TURNAROUND_VIEWS.find((item) => item.id === requestedViews[i]);
    if (!view) continue;

    const currentLease = GpuLeaseService.getCurrentLease();
    if (currentLease && currentLease.owner_task_id === input.taskId) {
      GpuLeaseService.heartbeat(currentLease.lease_id, input.taskId);
    }

    await input.onProgress?.('progress', {
      phase: 'turnaround_panel',
      view: view.id,
      index: i + 1,
      total: requestedViews.length
    });
    logger.info(
      `[Task ${input.taskId}] Turnaround panel ${i + 1}/${requestedViews.length}: ${view.id}`
    );

    const built = buildTurnaroundViewPrompt(panelPrompt, view, modelFamily);
    const clientNeg = String(input.negative_prompt || '').trim();
    const negative = clientNeg
      ? `${clientNeg}, ${built.negative_prompt}`
      : built.negative_prompt;

    const useVlmRef = modelFamily === 'qwen_image' || modelFamily === 'redcraft_krea2';
    const usePonyFrontAdapter = modelFamily === 'pony' && view.id === 'front' && Boolean(tierB.characterAdapter && storedAvatarUrl);
    const angleFrontPlate = !useVlmRef && view.id !== 'front' ? (frontPlateUrl || null) : null;
    const panelRef = useVlmRef
      ? (view.id === 'front' ? (storedAvatarUrl || null) : (frontPlateUrl || storedAvatarUrl || null))
      : usePonyFrontAdapter
        ? storedAvatarUrl
        : angleFrontPlate;
    if (panelRef && !comfyService.isRemote) {
      copyReferenceImageToComfy(
        { character_ref_url: panelRef, ref_image_url: panelRef },
        staticDir,
        comfySettings.install_path
      );
    }

    const panelWorkflow: Record<string, unknown> = {
      ...buildTurnaroundPanelWorkflowData(
        effectiveWorkflowData,
        view,
        built.prompt,
        negative,
        angleFrontPlate,
        null
      ),
      turnaround_view: view.id,
      ...(panelRef
        ? {
            character_ref_url: panelRef,
            ref_image_url: panelRef,
            ...(useVlmRef ? { use_qwen_vl_ref: true } : {}),
          }
        : {}),
      ...(usePonyFrontAdapter
        ? {
            force_no_character_adapter: false,
            force_character_adapter: true,
            character_adapter_weight: 0.55,
            turnaround_front_adapter: true,
          }
        : {}),
    };

    const finalWorkflow = await compileComfyWorkflow(
      panelWorkflow,
      built.prompt,
      'standard',
      {
        steps: input.generationParams?.steps,
        cfg: input.generationParams?.cfg,
        sampler_name: input.generationParams?.sampler_name,
        scheduler: input.generationParams?.scheduler,
        seed: sheetSeed
      },
      compileSettings,
      tierB
    );

    for (const node of Object.values(finalWorkflow) as any[]) {
      if ((node?.class_type === 'EmptyLatentImage' || node?.class_type === 'EmptySD3LatentImage') && node.inputs) {
        node.inputs.width = panelW;
        node.inputs.height = panelH;
        node.inputs.batch_size = 1;
      }
      if (node?.class_type?.includes('KSampler') && node.inputs) {
        node.inputs.denoise = panelWorkflow.turnaround_from_front === true
          ? TURNAROUND_ANGLE_DENOISE
          : 1;
        if (modelFamily === 'redcraft_krea2' && !input.generationParams?.steps) {
          node.inputs.steps = Math.max(Number(node.inputs.steps) || 10, 16);
        }
      }
    }

    const executableWorkflow = comfyService.isRemote
      ? await comfyService.uploadWorkflowReferences(finalWorkflow, staticDir)
      : finalWorkflow;

    const result = await comfyService.generateImage(
      executableWorkflow,
      async (msgType, data) => {
        await input.onProgress?.(msgType, { ...data, view: view.id });
      },
      {
        onPromptQueued: async (promptId) => {
          try {
            const { AssetTaskStore } = await import('./task_store');
            await AssetTaskStore.setComfyPromptId(input.taskId, promptId);
          } catch {
            /* ignore */
          }
        }
      }
    );

    if (result?.status !== 'completed' || !result.images?.[0]?.data) {
      throw new Error(
        `Turnaround ${view.id} view failed: ${result?.message || 'no image data'}`
      );
    }

    const panelFilename = characterId != null
      ? `turnaround_${characterId}_${view.id}_${input.taskId}.png`
      : `${input.sceneId}_${input.taskId}_${view.id}.png`;

    const panelPathResult = characterId != null
      ? getCharacterAssetPath({
          projectId,
          characterId,
          version,
          filename: panelFilename
        })
      : getSceneAssetPath({
          projectId,
          sceneId: input.sceneId,
          version,
          filename: panelFilename
        });

    fs.writeFileSync(panelPathResult.filepath, result.images[0].data);
    if (view.id === 'front') {
      const staged = path.join(staticDir, path.basename(panelPathResult.filepath));
      if (path.resolve(staged) !== path.resolve(panelPathResult.filepath)) {
        fs.copyFileSync(panelPathResult.filepath, staged);
      }
      frontPlateUrl = panelPathResult.url;
    }
    panelPaths[view.id] = panelPathResult.url;
    panelBuffers.push({
      buffer: result.images[0].data as Buffer,
      label: view.label,
      id: view.id
    });
  }

  await input.onProgress?.('progress', { phase: 'turnaround_stitch' });
  logger.info(`[Task ${input.taskId}] Stitching turnaround sheet`);

  const sheetBuffer = await stitchTurnaroundSheet(
    TURNAROUND_VIEWS.map((view) => {
      const rendered = panelBuffers.find((panel) => panel.id === view.id);
      if (rendered) return { buffer: rendered.buffer, label: view.label };
      const stored = storedBuffers.get(view.id);
      if (!stored) throw new Error('已有的三视图单格不在磁盘上，不能只重出其他角度。');
      return { buffer: stored, label: view.label };
    })
  );

  const sheetFilename = characterId != null
    ? `turnaround_${characterId}_${input.taskId}.png`
    : `${input.sceneId}_${input.taskId}_turnaround.png`;

  const sheetPathResult = characterId != null
    ? getCharacterAssetPath({
        projectId,
        characterId,
        version,
        filename: sheetFilename
      })
    : getSceneAssetPath({
        projectId,
        sceneId: input.sceneId,
        version,
        filename: sheetFilename
      });

  fs.writeFileSync(sheetPathResult.filepath, sheetBuffer);
  const sheetUrl = sheetPathResult.url;
  const sheetPath = sheetPathResult.filepath;

  logger.info(`[Task ${input.taskId}] Turnaround sheet saved ${sheetUrl}`);

  if (characterId != null) {
    try {
      await ensureCharacterVersionBaseline(characterId);
      const row = await db.get('SELECT visual_tags FROM character WHERE id = ?', characterId);
      const previous = row?.visual_tags;
      const tags = previous
        ? (typeof previous === 'string' ? JSON.parse(previous) : previous)
        : {};
      const merged = mergeTurnaroundAssets(tags, {
        ...(panelPaths.front ? { front: panelPaths.front } : {}),
        ...(panelPaths.side ? { side: panelPaths.side } : {}),
        ...(panelPaths.back ? { back: panelPaths.back } : {}),
      }, sheetUrl, { wardrobeVariant });
      await db.run('UPDATE character SET visual_tags = ? WHERE id = ?', JSON.stringify(merged), characterId);
      if (!wardrobeVariant) await commitCharacterEdits(characterId, previous);
    } catch (error) {
      logger.warn(`[Task ${input.taskId}] Could not store the turnaround plates: ${error}`);
    }
  }

  const urlFor = (view: TurnaroundViewId) => panelPaths[view] || storedPanelUrl(view);
  return {
    sheetUrl,
    sheetPath,
    panelUrls: {
      front: urlFor('front'),
      side: urlFor('side'),
      back: urlFor('back'),
    }
  };
}

/** Whether request should use 3-view composite path (decoupled via resolveTurnaroundStrategy) */
export function shouldUseTurnaroundComposite(
  workflowData: any,
  options?: { imageProvider?: string | null }
): boolean {
  const genType = String(workflowData?.gen_type || '').toLowerCase();
  if (genType !== 'turnaround') return false;
  return resolveTurnaroundStrategy({
    imageProvider: options?.imageProvider,
    workflowData,
  }) === 'split_3_panel';
}
