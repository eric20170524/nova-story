/**
 * Character turnaround via 3 separate full-body views + horizontal stitch.
 *
 * Why: single-shot multi-view prompts collapse under img2img portrait refs and
 * Pony's solo-portrait prior. Generating front/side/back independently then
 * compositing is far more reliable on local Pony / SD1.5.
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
  getCharacterAssetPath
} from '../core/paths';
import { ComfyUIService } from './ai/comfyui_service';
import {
  compileComfyWorkflow,
  copyReferenceImageToComfy
} from './generation_service';
import { resolveTierBFromSettings } from './tier_b_adapters';
import {
  normalizeImageModelFamily,
  type ImageModelFamily
} from './image_generation_policy';
import { GpuLeaseService } from './gpu_lease_service';
import { getProjectImageSettings, parseProjectSettings } from './project_settings';

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
      'full body, head to toe, neutral standing A-pose, (direct front view:1.3), shoulders and hips square to camera, facing viewer, arms slightly away from torso, hands and feet visible, orthographic front',
    negativeExtra:
      'side view, profile, back view, from behind, close-up, upper body only, cropped legs, portrait crop'
  },
  {
    id: 'side',
    label: 'SIDE',
    poseTags:
      'full body, head to toe, neutral standing A-pose, (strict 90 degree left side profile:1.6), head and torso both turned left, shoulders and hips in profile, feet pointing left, exactly one eye visible, nose silhouette pointing left, arms slightly away from torso, orthographic side',
    negativeExtra:
      'front view, frontal face, front-facing torso, facing viewer, looking at viewer, both eyes visible, back view, from behind, close-up, upper body only, cropped legs, three-quarter view'
  },
  {
    id: 'back',
    label: 'BACK',
    poseTags:
      'full body, head to toe, neutral standing A-pose, (strict rear view from behind:1.6), head and torso both facing away, back of head only, shoulders and hips facing away, arms slightly away from torso, hands and feet visible, orthographic back',
    negativeExtra:
      'front view, frontal figure, face visible, eyes, nose, turned head, looking over shoulder, looking at viewer, side view, profile, close-up, upper body only, cropped legs'
  }
];

const STRIP_MULTI_VIEW =
  /\b(character turnaround sheet|multi-?view layout|multi-?view|3 views|three views|split view layout|complete 3-view|aligned character turnaround|front view,\s*side view,\s*back view|side view,\s*back view|turnaround sheet)\b/gi;
const STRIP_TURNAROUND_STAGING =
  /\b(portrait|upper body|bust shot|close-up|medium shot|front view|side view|back view|matching reference character design|consistent facial features|same outfit and hair across all views|character reference|standing|full body)\b/i;
const STRIP_TURNAROUND_MOOD =
  /\b(aroused|seductive|alluring|melting expression|softens under emotion|half-lidded|blushing|smile|gaze|half-open|loosely worn|lowered to waist|full breasts|cleavage|undressing|intimate|erotic|rating_explicit|rating_questionable)\b/i;
const STRIP_TURNAROUND_PROPS =
  /\b(mirror|sword|blade|staff|weapon|shield|orb|handheld prop)\b/i;

/**
 * Strip multi-view sheet language from a client prompt so each panel is a single figure.
 */
export function extractAppearanceBase(prompt: string): string {
  return String(prompt || '')
    .replace(STRIP_MULTI_VIEW, ' ')
    .split(/[,，]/)
    .map((clause) => clause.replace(/\s{2,}/g, ' ').trim())
    .filter((clause) => clause
      && !STRIP_TURNAROUND_STAGING.test(clause)
      && !STRIP_TURNAROUND_MOOD.test(clause)
      && !STRIP_TURNAROUND_PROPS.test(clause)
      && !/^\s*(glowing|bronze rim)\)?\s*$/i.test(clause))
    .join(', ');
}

export function buildTurnaroundViewPrompt(
  basePrompt: string,
  view: TurnaroundViewSpec,
  modelFamily: ImageModelFamily
): { prompt: string; negative_prompt: string } {
  const appearance = extractAppearanceBase(basePrompt);
  const subject = /\b(1boy|male|man|boy)\b/i.test(basePrompt)
    && !/\b(1girl|female|woman|girl)\b/i.test(basePrompt)
    ? '1boy, solo, male'
    : '1girl, solo, female';
  const quality =
    modelFamily === 'pony'
      ? 'score_9, score_8_up, score_7_up, source_anime, masterpiece, best quality'
      : modelFamily === 'redcraft_krea2'
        ? 'masterpiece quality, highly detailed, clean studio render'
        : 'masterpiece, best quality, highly detailed, anime style';
  const layeredRobe = /\b(robes?|hanfu|long sleeves?)\b/i.test(appearance);
  const outfitConstraint = layeredRobe
    ? 'long-sleeved layered hanfu robes, shoulders and back fully covered by cloth, original outfit colors'
    : 'original outfit colors and silhouette';

  const prompt = [
    quality,
    subject,
    'one solitary figure, single isolated character, no duplicate',
    view.poseTags,
    'neutral expression, natural body proportions, canonical outfit fully fastened, clear silhouette, solid white background, even flat studio lighting',
    outfitConstraint,
    appearance
  ]
    .filter(Boolean)
    .join(', ');

  const negative = [
    'low quality, worst quality, bad anatomy, extra limbs, extra fingers, deformed hands',
    'text, watermark, logo, signature, speech bubble',
    'multiple girls, 2girls, 3girls, duplicate figure, second person, collage, split panel, comic panel, grid, turnaround sheet, multiple views',
    'child, loli, shota, underage',
    'blurry, cropped head, missing feet, floating limbs',
    'halo, glowing ring, moon backdrop, gradient background, gray background, architecture, archway, doorway, columns, scenery, props, floating objects',
    layeredRobe ? 'strapless gown, bare shoulders, exposed back, sleeveless dress, plunging neckline' : '',
    view.negativeExtra
  ].filter(Boolean).join(', ');

  return { prompt, negative_prompt: negative };
}

/** Portrait adapter is opt-in for the front only; side/back keep their own camera angle. */
export function buildTurnaroundPanelWorkflowData(
  workflowData: Record<string, unknown>,
  view: TurnaroundViewSpec,
  prompt: string,
  negativePrompt: string,
  refUrl: string | null
): Record<string, unknown> {
  const useFrontAdapter = view.id === 'front'
    && workflowData.turnaround_front_adapter === true
    && Boolean(refUrl);
  const requestedWeight = Number(workflowData.character_adapter_weight);
  const frontWeight = Number.isFinite(requestedWeight)
    ? Math.min(Math.max(requestedWeight, 0), 0.35)
    : 0.35;

  return {
    ...workflowData,
    prompt,
    negative_prompt: negativePrompt,
    gen_type: 'turnaround_panel',
    nsfw_enabled: false,
    denoise: 1,
    character_ref_url: useFrontAdapter ? refUrl : undefined,
    ref_image_url: useFrontAdapter ? refUrl : undefined,
    composition_ref_url: undefined,
    composition_reference_url: undefined,
    pose_ref_url: undefined,
    reference_tier: useFrontAdapter ? 'A+B' : 'A',
    force_no_character_adapter: !useFrontAdapter,
    character_adapter_weight: useFrontAdapter ? frontWeight : undefined,
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

  const canvasW = padding * 2 + panelWidth * 3 + gap * 2;
  const canvasH = padding * 2 + labelHeight + panelHeight;

  const composites: OverlayOptions[] = [];

  for (let i = 0; i < 3; i++) {
    const panel = panels[i];
    if (!panel) {
      throw new Error(`stitchTurnaroundSheet missing panel at index ${i}`);
    }
    const x = padding + i * (panelWidth + gap);
    const yLabel = padding;
    const yImg = padding + labelHeight;

    const fitted = await sharp(panel.buffer)
      .resize(panelWidth, panelHeight, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      })
      .png()
      .toBuffer();

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

  // A portrait reference is optional for the front panel only.
  const refUrl =
    (input.workflowData?.character_ref_url as string | undefined)
    || (input.workflowData?.ref_image_url as string | undefined)
    || null;

  if (refUrl && input.workflowData.turnaround_front_adapter === true && !comfyService.isRemote) {
    copyReferenceImageToComfy(
      {
        ...input.workflowData,
        character_ref_url: refUrl,
        ref_image_url: refUrl
      },
      staticDir,
      comfySettings.install_path
    );
  }

  let projectId: number | null = null;
  let characterId: number | null = null;
  let version: number = Number(input.workflowData?.version || input.workflowData?.scene_version || 1);

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
  } else if (input.sceneId >= 900_000 || input.workflowData.character_id) {
    if (input.workflowData?.character_id) {
      characterId = Number(input.workflowData.character_id);
    } else {
      for (const offset of [999990, 999991, 999992, 90000000]) {
        if (input.sceneId > offset && input.sceneId < offset + 100000) {
          characterId = input.sceneId - offset;
          break;
        }
      }
    }
    if (characterId) {
      const charRow = await db.get(
        'SELECT id, project_id, active_version FROM character WHERE id = ?',
        characterId
      );
      if (charRow) {
        projectId = charRow.project_id != null ? Number(charRow.project_id) : null;
        version = Number(charRow.active_version || 1);
      }
    }
  }

  let effectiveWorkflowData = input.workflowData;
  if (projectId != null) {
    const projectRow = await db.get('SELECT settings FROM project WHERE id = ?', projectId);
    if (projectRow) {
      const projectSettings = parseProjectSettings(projectRow.settings);
      effectiveWorkflowData = {
        ...input.workflowData,
        project_settings: projectSettings,
        model_type: getProjectImageSettings(projectSettings).model,
        style_preset: getProjectImageSettings(projectSettings).style,
        workflow_id: undefined,
        selected_workflow_id: undefined,
      };
    }
  }

  const modelFamily: ImageModelFamily = getProjectImageSettings(
    parseProjectSettings(effectiveWorkflowData.project_settings)
  ).model;

  // Tier B is Pony/SDXL only
  const tierB = await resolveTierBFromSettings(settings, {
    isFlux: modelFamily !== 'pony'
  });

  const panelBuffers: Array<{ buffer: Buffer; label: string; id: TurnaroundViewId }> = [];
  const panelPaths: Partial<Record<TurnaroundViewId, string>> = {};
  const panelW = modelFamily === 'sd15' ? 512 : 768;
  const panelH = modelFamily === 'sd15' ? 768 : 1152;

  for (let i = 0; i < TURNAROUND_VIEWS.length; i++) {
    const view = TURNAROUND_VIEWS[i];
    if (!view) continue;

    const currentLease = GpuLeaseService.getCurrentLease();
    if (currentLease && currentLease.owner_task_id === input.taskId) {
      GpuLeaseService.heartbeat(currentLease.lease_id, input.taskId);
    }

    await input.onProgress?.('progress', {
      phase: 'turnaround_panel',
      view: view.id,
      index: i + 1,
      total: 3
    });
    logger.info(
      `[Task ${input.taskId}] Turnaround panel ${i + 1}/3: ${view.id}`
    );

    const built = buildTurnaroundViewPrompt(input.prompt, view, modelFamily);
    const clientNeg = String(input.negative_prompt || '').trim();
    const negative = clientNeg
      ? `${clientNeg}, ${built.negative_prompt}`
      : built.negative_prompt;

    // Panel workflow: single full-body, no multi-view sheet, near-txt2img
    const panelWorkflow = buildTurnaroundPanelWorkflowData(
      effectiveWorkflowData,
      view,
      built.prompt,
      negative,
      refUrl
    );

    const finalWorkflow = await compileComfyWorkflow(
      panelWorkflow,
      built.prompt,
      'standard',
      {
        steps: input.generationParams?.steps,
        cfg: input.generationParams?.cfg,
        sampler_name: input.generationParams?.sampler_name,
        scheduler: input.generationParams?.scheduler,
        seed: input.generationParams?.seed
      },
      settings,
      tierB
    );

    // Ensure full-body friendly latent (portrait ratio slightly tall)
    for (const node of Object.values(finalWorkflow) as any[]) {
      if (node?.class_type === 'EmptyLatentImage' && node.inputs) {
        node.inputs.width = panelW;
        node.inputs.height = panelH;
        node.inputs.batch_size = 1;
      }
      if (node?.class_type?.includes('KSampler') && node.inputs) {
        node.inputs.denoise = 1.0;
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
    panelBuffers.map((p) => ({ buffer: p.buffer, label: p.label }))
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

  return {
    sheetUrl,
    sheetPath,
    panelUrls: {
      front: panelPaths.front!,
      side: panelPaths.side!,
      back: panelPaths.back!
    }
  };
}

/** Whether request should use 3-view composite path */
export function shouldUseTurnaroundComposite(workflowData: any): boolean {
  const genType = String(workflowData?.gen_type || '').toLowerCase();
  if (genType !== 'turnaround') return false;
  // Escape hatch for debugging single-shot multi-view
  if (workflowData?.turnaround_mode === 'single' || workflowData?.turnaround_composite === false) {
    return false;
  }
  return true;
}
