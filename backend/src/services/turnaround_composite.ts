/**
 * Character full-body front reference generation pipeline.
 *
 * Simplified single-view turnaround: generates only a standalone 2:3 vertical
 * orthographic front full-body reference image conditioned on the approved
 * portrait (定妆照) and structured visual appearance tags.
 *
 * Contract note: borrows the clean-studio purity rules (solid pure white opaque
 * background, single appearance state, no text/rulers/insets/props) from
 * production-asset-board-pipeline.md's `clean_reference` specification, while
 * intentionally delivering a single 2:3 front full-body plate rather than a
 * 16:9 4-panel composite turnaround sheet.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../core/logging';
import { SettingsManager } from '../core/settings_manager';
import { db } from '../db/database';
import {
  getGeneratedDirectory,
  getSceneAssetPath,
  getCharacterAssetPath,
} from '../core/paths';
import { applyRemoteLoraCatalog, ComfyUIService } from './ai/comfyui_service';
import {
  compileComfyWorkflow,
  copyReferenceImageToComfy
} from './generation_service';
import { isFaceDetailStage2Node, resolveTierBFromSettings } from './tier_b_adapters';
import {
  inferPromptSubjectType,
  readStoredCharacterSheet,
  splitClauses,
  stripSceneWardrobeClauses,
  type ImageModelFamily
} from './image_generation_policy';
import { readPortraitPlate } from './portrait_plate';
import { ensureCharacterVersionBaseline, syncActiveCharacterVersion } from './character_versions';
import { GpuLeaseService } from './gpu_lease_service';
import { resolveTurnaroundStrategy, turnaroundPanelDimensions } from './image_output_spec';
import { getProjectImageSettings, parseProjectSettings, resolveEffectiveNsfw } from './project_settings';
import { isSyntheticCharacterSceneId, syntheticCharacterId } from './synthetic_scene_id';

export type TurnaroundViewId = 'front';

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
      'full body, head to toe, full-length wide shot, neutral standing A-pose, (direct front view:1.3), orthographic front, entire figure from head to feet inside frame, long skirt hem and feet visible on studio floor, shoulders and hips square to camera, facing viewer, arms slightly away from torso, hands and feet visible, unobstructed silhouette, sufficient margin',
    negativeExtra:
      'side view, profile, back view, from behind, three-quarter view, expression matrix, pose study, detail inset, multi-view split, before and after comparison, close-up, medium shot, cowboy shot, waist-up, knee-up, bust shot, upper body only, cropped legs, cropped feet, portrait crop'
  }
];

const STRIP_MULTI_VIEW =
  /\b(character turnaround sheet|multi-?view layout|multi-?view|3 views|three views|split view layout|complete 3-view|aligned character turnaround|front view,\s*side view,\s*back view|side view,\s*back view|turnaround sheet)\b/gi;
const STRIP_TURNAROUND_STAGING =
  /\b(portrait|upper body|bust shot|close-up|medium shot|side view|back view|matching reference character design|consistent (?:face(?:\s+hair\s+and\s+clothing)?|facial features|character design)(?:\s+across(?:\s+all)?\s+views)?|same outfit and hair across all views|character reference)\b/i;
const STRIP_TURNAROUND_MOOD =
  /\b(aroused|seductive|alluring|melting expression|softens under emotion|half-lidded|blushing|smile|gaze|intimate|erotic|playful|inviting|rating_explicit|rating_questionable|soft full lips|soft pink lips|expressive brows|delicate brows|full breasts|soft hourglass(?:\s+mature\s+figure)?|delicate collarbones)\b/i;
const STRIP_TURNAROUND_HANDHELD_AURA_RE =
  /\b(divine mirror|handheld|(?:floating|swirling)(?:\s+[a-z-]+){0,3}\s+petals?|petal(?:\s+[a-z-]+){0,2}\s+aura|spirit aura|immortal glow)\b/i;

/**
 * Semantic substitutions that normalize compound hair-length and garment structure descriptors.
 */
const SAFE_COMPOUND_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcollarbone[- ]length\b/gi, 'shoulder-length'],
  [/\bchest[- ]length\b/gi, 'mid-back length'],
  [/\bdouble[- ]breasted\b/gi, 'tailored double-buttoned'],
  [/\bsingle[- ]breasted\b/gi, 'tailored single-buttoned'],
  [/\bchest[- ]plate\b/gi, 'torso plate'],
  [/\bbreastplate\b/gi, 'cuirass torso'],
];

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

const stripBooruWeights = (text: string): string =>
  String(text || '').replace(/\(([^():]+):[\d.]+\)/g, '$1');

const normalizeBareAgeRange = (text: string): string =>
  String(text || '')
    .replace(/\b(\d{2})\s*[-–~]\s*(\d{2})\s*(?:years?\s*old|岁)\b/gi, '$1 to $2 years old')
    .replace(/(^|[,，]\s*)(\d{2})\s*[-–~]\s*(\d{2})(?=\s*(?:[,，]|$))/g, '$1$2 to $3 years old');

const TURNAROUND_VIEW_ORDER: TurnaroundViewId[] = ['front'];

/** null, '', 'all', or any list containing 'front' converges to the single front full-body reference. */
export function parseTurnaroundViews(
  workflowData: Record<string, unknown> | null | undefined
): TurnaroundViewId[] {
  const raw = workflowData?.turnaround_views;
  if (raw == null || raw === '' || raw === 'all') return [...TURNAROUND_VIEW_ORDER];
  const list = Array.isArray(raw) ? raw : [raw];
  const ids = list.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  if (!ids.length) throw new Error('角色全身设定图必须指定正面。');
  if (!ids.includes('front')) {
    throw new Error('角色全身设定图只支持生成正面，不再生成侧面或背面。');
  }
  if (ids.some((id) => !TURNAROUND_VIEW_ORDER.includes(id as TurnaroundViewId))) {
    logger.warn(`Legacy multi-view turnaround_views [${ids.join(', ')}] converged to ['front']`);
  }
  return ['front'];
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
    delete next.side_url;
    delete next.back_url;
    if (panels.front) next.front_url = panels.front;
    if (sheetUrl) next.sheet_url = sheetUrl;
    assets.turnaround_variants = { ...previous, [variant]: next };
    return { ...tags, assets };
  }
  delete assets.turnaround_side_url;
  delete assets.turnaround_back_url;
  if (panels.front) assets.turnaround_front_url = panels.front;
  if (sheetUrl) assets.turnaround_url = sheetUrl;
  return { ...tags, assets };
}

/**
 * Resolve the effective identity reference URL for turnaround generation.
 * - A human character's full-body plate always follows the approved portrait: the plate is
 *   worthless if it shows another person, so `use_ref_portrait === false` is ignored (`mandatory`).
 * - Otherwise explicit `use_ref_portrait === false` disables identity reference binding.
 * - Request-scoped `character_ref_url` / `ref_image_url` (e.g. an unsaved session portrait)
 *   takes precedence over the database `storedAvatarUrl`.
 */
export function resolveTurnaroundIdentityReference(
  workflowData: Record<string, unknown> | null | undefined,
  storedAvatarUrl?: string | null,
  options: { mandatory?: boolean } = {},
): string | null {
  const mandatory = options.mandatory === true;
  if (!mandatory && workflowData?.use_ref_portrait === false) {
    return null;
  }
  const requestRef = String(
    workflowData?.character_ref_url || workflowData?.ref_image_url || ''
  ).trim();
  if (requestRef) {
    return requestRef;
  }
  if (!mandatory && workflowData?.turnaround_front_adapter === false) {
    return null;
  }
  const fallback = String(storedAvatarUrl || '').trim();
  return fallback || null;
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

/** Face-structure wording that fights a bound identity reference instead of helping it. */
const FACE_TEXT_RE =
  /\b(face|facial|cheekbones?|brows?|eyebrows?|nose|lips?|jaw(?:line)?|eyelids?|bone structure|complexion)\b/i;
const FACE_ACCESSORY_OR_MARK_RE =
  /\b(mask|veil|scar|mark|mole|freckles?|tattoo|glasses|spectacles|monocle|eyepatch|blindfold|goggles|facepaint)\b/i;

export function stripConflictingFaceText(text: string): string {
  return splitClauses(text)
    .filter((clause) => FACE_ACCESSORY_OR_MARK_RE.test(clause) || !FACE_TEXT_RE.test(clause))
    .join(', ');
}

export function buildTurnaroundViewPrompt(
  basePrompt: string,
  view: TurnaroundViewSpec = TURNAROUND_VIEWS[0]!,
  modelFamily: ImageModelFamily = 'pony',
  options: { identityLocked?: boolean } = {}
): { prompt: string; negative_prompt: string } {
  const naturalLanguage = modelFamily === 'redcraft_krea2' || modelFamily === 'qwen_image' || modelFamily === 'flux';
  // Qwen-VL models read the portrait as image 1; its face must win over any face text.
  const vlmLocked = options.identityLocked === true
    && (modelFamily === 'redcraft_krea2' || modelFamily === 'qwen_image');
  const rawFiltered = normalizeCompoundAppearanceTerms(basePrompt);
  const extracted = extractAppearanceBase(naturalLanguage ? stripBooruWeights(rawFiltered) : rawFiltered);
  const appearance = vlmLocked
    ? stripConflictingFaceText(extracted)
    : extracted;
  const subjectKind = inferPromptSubjectType(basePrompt);
  const subjectNoun = subjectKind === 'female_human'
    ? 'adult East Asian woman, female'
    : subjectKind === 'male_human'
      ? 'adult East Asian man, male'
      : 'standing character';
  const lockedNoun = subjectKind === 'female_human'
    ? 'woman'
    : subjectKind === 'male_human'
      ? 'man'
      : 'character';
  // Eyes are a few pixels in a full-body frame, so the model drops their colour first.
  // Name the stored colour next to the copy instruction instead of leaving it only in the tag list.
  const eyeClause = vlmLocked
    ? splitClauses(extracted).find((clause) => /\beyes?\b/i.test(clause) && !/\b(shape|eyelids?)\b/i.test(clause))
    : undefined;
  const eyeColorLock = eyeClause
    ? ` Keep the exact eye color from the reference image (${eyeClause.trim()}); the irises must not turn dark brown or black.`
    : vlmLocked
      ? ' Keep the exact eye color from the reference image.'
      : '';

  const camera = vlmLocked
    ? `Full-length head-to-toe wide shot, direct orthographic front view of the exact same ${lockedNoun} shown in the reference image (image 1), standing from head to toe with entire figure, dress hem, and feet visible on the floor, facing the camera on a solid pure white opaque studio background. Copy the face from the reference image exactly: identical facial structure, eye shape, eye color, nose, lips, skin tone, hairstyle, hair color, and body proportions; do not redesign or beautify or replace the face.${eyeColorLock} Keep the canonical outfit; show only this single current appearance state with no before-and-after comparison, no inset boxes, and no text labels.`
    : naturalLanguage
      ? `Full-length head-to-toe wide shot, direct orthographic front view of one ${subjectNoun} standing from head to toe with entire figure, dress hem, and feet visible on the floor, facing the camera on a solid pure white opaque studio background. Preserve recognizable facial structure, hairstyle, body proportions, and canonical outfit from the identity reference; show only this single current appearance state with no before-and-after comparison, no inset boxes, and no text labels.`
      : '';
  const quality =
    modelFamily === 'pony'
      ? 'score_9, score_8_up, score_7_up, source_anime, masterpiece, best quality'
      : naturalLanguage
        ? 'masterpiece quality, highly detailed, clean studio render'
        : 'masterpiece, best quality, highly detailed';
  const poseTags = naturalLanguage ? stripBooruWeights(view.poseTags) : view.poseTags;
  const framingDetails =
    'neutral expression, natural body proportions, clear silhouette, solid pure white opaque studio background, completely opaque, no transparency, no checkerboard, plain studio background, even flat studio lighting, solid opaque clothing, consistent character identity';

  const rawPromptParts = [
    camera,
    quality,
    'one solitary figure, single isolated character, no duplicate',
    poseTags,
    framingDetails,
    appearance
  ]
    .filter(Boolean)
    .join(', ');
  const seenClauses = new Set<string>();
  const prompt = splitClauses(rawPromptParts)
    .map((c) => c.trim())
    .filter((c) => {
      if (!c) return false;
      const key = stripBooruWeights(c).toLowerCase();
      if (seenClauses.has(key)) return false;
      seenClauses.add(key);
      return true;
    })
    .join(', ');

  const negative = [
    'low quality, worst quality, bad anatomy, extra limbs, extra arms, four arms, four hands, extra fingers, deformed hands',
    'text, title bar, character name label, view number, ruler, color palette swatch, letters, numbers, typography, watermark, logo, signature, UI, speech bubble, label, banner',
    'duplicate figure, second person, double head, two heads, collage, split panel, comic panel, grid, turnaround sheet, multiple views',
    'child, loli, shota, underage',
    options.identityLocked === true
      ? 'different person, different face, altered facial features, redesigned face, generic beauty face, face replaced'
      : '',
    'blurry, cropped head, missing feet, floating limbs',
    'handheld prop, weapon, halo, helmet, space helmet, glowing ring, moon backdrop, gradient background, gray background, transparent background, checkerboard background, architecture, archway, doorway, columns, scenery, props, floating objects',
    view.negativeExtra
  ].filter(Boolean).join(', ');

  return { prompt, negative_prompt: negative };
}

/**
 * Build workflow metadata for the single front full-body panel.
 */
export function buildTurnaroundPanelWorkflowData(
  workflowData: Record<string, unknown>,
  _view: TurnaroundViewSpec,
  prompt: string,
  negativePrompt: string,
): Record<string, unknown> {
  return {
    ...workflowData,
    prompt,
    negative_prompt: negativePrompt,
    gen_type: 'turnaround_panel',
    nsfw_enabled: workflowData.nsfw_enabled === true,
    denoise: 1,
    character_ref_url: undefined,
    ref_image_url: undefined,
    composition_ref_url: undefined,
    composition_reference_url: undefined,
    pose_ref_url: undefined,
    force_no_character_adapter: true,
    character_adapter_weight: undefined,
    turnaround_front_adapter: false,
    style_preset: workflowData.style_preset || null
  };
}

export interface TurnaroundGenerateInput {
  taskId: string;
  sceneId: number;
  /** Full client prompt (cleaned to canonical full-body front prompt) */
  prompt: string;
  negative_prompt?: string;
  workflowData: Record<string, unknown>;
  generationParams?: any;
  onProgress?: (msg: string, data?: any) => void | Promise<void>;
}

export interface TurnaroundGenerateResult {
  sheetUrl: string;
  sheetPath: string;
  panelUrls: { front: string };
}

/**
 * Generate the single canonical front full-body character reference image.
 */
export async function generateTurnaroundComposite(
  input: TurnaroundGenerateInput
): Promise<TurnaroundGenerateResult> {
  const settings = SettingsManager.loadSettings();
  const comfySettings = settings.comfyui || {};
  if (!comfySettings.enabled) {
    throw new Error('Turnaround generation requires local ComfyUI (comfyui.enabled)');
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
          const storedTags = tags && typeof tags === 'object' ? tags : {};
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

  const activeAvatarUrl = resolveTurnaroundIdentityReference(
    input.workflowData,
    storedAvatarUrl,
    { mandatory: humanTurnaround },
  );
  if (humanTurnaround && input.workflowData?.use_ref_portrait === false) {
    logger.warn(`[Task ${input.taskId}] use_ref_portrait=false ignored: a human full-body plate must follow the approved portrait`);
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

  const { width: panelW, height: panelH } = turnaroundPanelDimensions(modelFamily);
  const requestedSeed = Number(input.generationParams?.seed);
  const sheetSeed = Number.isSafeInteger(requestedSeed) && requestedSeed >= 0 && input.generationParams?.seed != null
    ? requestedSeed
    : Math.floor(Math.random() * 1_000_000_000);

  parseTurnaroundViews(input.workflowData);
  const wardrobeVariant = String(input.workflowData?.wardrobe_variant || '').trim();
  const panelPrompt = canonicalTurnaroundPrompt(input.prompt, wardrobeVariant);

  if (characterId != null && humanTurnaround) {
    await readPortraitPlate(activeAvatarUrl || storedAvatarUrl);
  }

  const view = TURNAROUND_VIEWS[0]!;
  const currentLease = GpuLeaseService.getCurrentLease();
  if (currentLease && currentLease.owner_task_id === input.taskId) {
    GpuLeaseService.heartbeat(currentLease.lease_id, input.taskId);
  }

  await input.onProgress?.('progress', {
    phase: 'turnaround_panel',
    view: view.id,
    index: 1,
    total: 1
  });
  logger.info(`[Task ${input.taskId}] Generating front full-body reference: ${view.id}`);

  // qwen_image reads the portrait natively in its single stage. redcraft_krea2 keeps its native Stage 1 render
  // and gets the portrait only in the Qwen-Image 2.1 Stage 2 face refine (scheme 1B).
  const useVlmRef = modelFamily === 'qwen_image';
  const useKreaFaceStage2 = modelFamily === 'redcraft_krea2' && Boolean(activeAvatarUrl);
  const usePonyFrontAdapter = modelFamily === 'pony' && Boolean(tierB.characterAdapter && activeAvatarUrl);
  if (!activeAvatarUrl) {
    logger.warn(`[Task ${input.taskId}] Turnaround generation proceeding without active identity reference`);
  } else if (modelFamily === 'pony' && !tierB.characterAdapter) {
    logger.warn(`[Task ${input.taskId}] Pony turnaround proceeding without IP-Adapter (tierB.characterAdapter unavailable): face will NOT be locked`);
  }
  const panelRef = useVlmRef || useKreaFaceStage2
    ? activeAvatarUrl
    : usePonyFrontAdapter
      ? activeAvatarUrl
      : null;

  // Krea2 Stage 1 has no reference image, so its prompt must not point at "image 1".
  const built = buildTurnaroundViewPrompt(panelPrompt, view, modelFamily, {
    identityLocked: Boolean(panelRef) && !useKreaFaceStage2,
  });
  const clientNeg = String(input.negative_prompt || '').trim();
  const negative = clientNeg
    ? `${clientNeg}, ${built.negative_prompt}`
    : built.negative_prompt;

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
      negative
    ),
    turnaround_view: view.id,
    ...(panelRef
      ? {
          character_ref_url: panelRef,
          ref_image_url: panelRef,
          ...(useVlmRef ? { use_qwen_vl_ref: true } : {}),
          ...(useKreaFaceStage2 ? { face_detail_stage2: true } : {}),
        }
      : {}),
    face_detail_canvas_width: panelW,
    face_detail_canvas_height: panelH,
    ...(usePonyFrontAdapter
      ? {
          force_no_character_adapter: false,
          force_character_adapter: true,
          character_adapter_weight: 0.55,
          faceid_weight: 0.85,
          face_detail_stage2: true,
          turnaround_front_adapter: true,
        }
      : {}),
  };

  const wantFaceId = usePonyFrontAdapter && tierB.faceId?.available === true;
  if (usePonyFrontAdapter && !wantFaceId) {
    logger.info(
      `[Task ${input.taskId}] FaceID unavailable, using plain IP-Adapter (face lock is weak): ${tierB.faceId?.missing?.join(', ') || 'unknown'}`
    );
  }

  const runPanel = async (preferFaceId: boolean) => {
    const compiled = await compileComfyWorkflow(
      { ...panelWorkflow, prefer_faceid_adapter: preferFaceId },
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

    for (const node of Object.values(compiled) as any[]) {
      if ((node?.class_type === 'EmptyLatentImage' || node?.class_type === 'EmptySD3LatentImage') && node.inputs) {
        node.inputs.width = panelW;
        node.inputs.height = panelH;
        node.inputs.batch_size = 1;
      }
      // Stage 2 face-detail samplers carry their own denoise/steps; the Stage 1 reset must not touch them.
      if (node?.class_type?.includes('KSampler') && node.inputs && !isFaceDetailStage2Node(node)) {
        node.inputs.denoise = 1;
        if (modelFamily === 'redcraft_krea2' && !input.generationParams?.steps) {
          node.inputs.steps = Math.max(Number(node.inputs.steps) || 10, 16);
        }
      }
    }

    const executable = comfyService.isRemote
      ? await comfyService.uploadWorkflowReferences(compiled, staticDir)
      : compiled;

    return comfyService.generateImage(
      executable,
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
  };

  let result = await runPanel(wantFaceId);
  if (wantFaceId && result?.status !== 'completed' && /faceid|insightface|ipadapter|ip-adapter/i.test(String(result?.message || ''))) {
    // object_info cannot prove the InsightFace runtime works. Fall back instead of failing the plate.
    logger.warn(`[Task ${input.taskId}] FaceID run failed (${result?.message}); retrying with plain IP-Adapter`);
    result = await runPanel(false);
  }

  if (result?.status !== 'completed' || !result.images?.[0]?.data) {
    throw new Error(
      `Turnaround front view failed: ${result?.message || 'no image data'}`
    );
  }

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

  fs.writeFileSync(sheetPathResult.filepath, result.images[0].data);
  const staged = path.join(staticDir, path.basename(sheetPathResult.filepath));
  if (path.resolve(staged) !== path.resolve(sheetPathResult.filepath)) {
    fs.copyFileSync(sheetPathResult.filepath, staged);
  }

  const sheetUrl = sheetPathResult.url;
  const sheetPath = sheetPathResult.filepath;

  logger.info(`[Task ${input.taskId}] Turnaround front full-body image saved ${sheetUrl}`);

  if (characterId != null && !wardrobeVariant) {
    // The regular plate is a candidate. It becomes the body identity plate (turnaround_front_url)
    // only when the user adopts it, so a face that drifted from the portrait cannot spread
    // into later shots and video.
    logger.info(`[Task ${input.taskId}] Turnaround front plate is a candidate until adopted: ${sheetUrl}`);
  } else if (characterId != null) {
    try {
      await ensureCharacterVersionBaseline(characterId);
      const row = await db.get('SELECT visual_tags FROM character WHERE id = ?', characterId);
      const previous = row?.visual_tags;
      const tags = previous
        ? (typeof previous === 'string' ? JSON.parse(previous) : previous)
        : {};
      const merged = mergeTurnaroundAssets(
        tags,
        { front: sheetUrl },
        sheetUrl,
        { wardrobeVariant }
      );
      await db.run('UPDATE character SET visual_tags = ? WHERE id = ?', JSON.stringify(merged), characterId);
      await syncActiveCharacterVersion(characterId);
    } catch (error) {
      logger.warn(`[Task ${input.taskId}] Could not store the wardrobe variant plate: ${error}`);
    }
  }

  return {
    sheetUrl,
    sheetPath,
    panelUrls: {
      front: sheetUrl,
    }
  };
}

/** Whether request should use the dedicated front full-body turnaround pipeline */
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
