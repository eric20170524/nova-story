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
import { getGeneratedDirectory } from '../core/paths';
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
      'full body, head to toe, standing straight, front view, facing viewer, looking at viewer, arms relaxed at sides, feet visible, orthographic front, character design sheet panel',
    negativeExtra:
      'side view, profile, back view, from behind, close-up, upper body only, cropped legs, portrait crop'
  },
  {
    id: 'side',
    label: 'SIDE',
    poseTags:
      'full body, head to toe, standing straight, side view, profile view, 90 degree side angle, facing left, looking left, arms at sides, feet visible, orthographic side, character design sheet panel',
    negativeExtra:
      'front view, facing viewer, back view, from behind, close-up, upper body only, cropped legs, three-quarter view'
  },
  {
    id: 'back',
    label: 'BACK',
    poseTags:
      'full body, head to toe, standing straight, back view, from behind, rear view, facing away from viewer, back of head, arms at sides, feet visible, orthographic back, character design sheet panel',
    negativeExtra:
      'front view, face visible, looking at viewer, side view, profile, close-up, upper body only, cropped legs'
  }
];

const STRIP_MULTI_VIEW =
  /\b(character turnaround sheet|multi-?view layout|multi-?view|3 views|three views|split view layout|complete 3-view|aligned character turnaround|front view,\s*side view,\s*back view|side view,\s*back view|turnaround sheet)\b/gi;

/**
 * Strip multi-view sheet language from a client prompt so each panel is a single figure.
 */
export function extractAppearanceBase(prompt: string): string {
  return String(prompt || '')
    .replace(STRIP_MULTI_VIEW, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^,\s*|,\s*$/g, '')
    .trim();
}

export function buildTurnaroundViewPrompt(
  basePrompt: string,
  view: TurnaroundViewSpec,
  modelFamily: ImageModelFamily
): { prompt: string; negative_prompt: string } {
  const appearance = extractAppearanceBase(basePrompt);
  const quality =
    modelFamily === 'pony'
      ? 'score_9, score_8_up, score_7_up, source_anime, masterpiece, best quality'
      : 'masterpiece, best quality, highly detailed, anime style';

  const prompt = [
    quality,
    '1girl, solo, female',
    view.poseTags,
    'simple background, solid white background, even studio lighting, character reference sheet style',
    'same character design, consistent face, hair, and outfit',
    appearance
  ]
    .filter(Boolean)
    .join(', ');

  const negative = [
    'low quality, worst quality, bad anatomy, extra limbs, extra fingers, deformed hands',
    'text, watermark, logo, signature, speech bubble',
    'multiple girls, 2girls, 3girls, collage, split panel, comic panel, grid',
    'child, loli, shota, underage',
    'blurry, cropped head, missing feet, floating limbs',
    view.negativeExtra
  ].join(', ');

  return { prompt, negative_prompt: negative };
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

  const modelFamily: ImageModelFamily = normalizeImageModelFamily(
    input.workflowData?.model_type || input.workflowData?.reference_model_type || 'pony'
  );

  const baseUrl = comfySettings.base_url || 'http://127.0.0.1:8188';
  const comfyService = new ComfyUIService(baseUrl);
  const isRunning = await comfyService.ensureRunning(comfySettings.install_path);
  if (!isRunning) {
    throw new Error('Failed to start or connect to ComfyUI');
  }

  // Portrait ref for identity: keep file in Comfy input, but force high denoise (near txt2img)
  // so composition is free for full-body angles.
  const refUrl =
    (input.workflowData?.character_ref_url as string | undefined)
    || (input.workflowData?.ref_image_url as string | undefined)
    || null;

  if (refUrl) {
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

  // Tier B is Pony/SDXL only
  const tierB = await resolveTierBFromSettings(settings, {
    isFlux: modelFamily !== 'pony'
  });

  const panelBuffers: Array<{ buffer: Buffer; label: string; id: TurnaroundViewId }> = [];
  const panelPaths: Partial<Record<TurnaroundViewId, string>> = {};
  const panelW = modelFamily === 'sd15' ? 512 : 768;
  const panelH = modelFamily === 'sd15' ? 768 : 1152;
  const defaultCfg = modelFamily === 'flux' ? 3.5 : modelFamily === 'sd15' ? 7 : 6.5;
  const defaultSteps = modelFamily === 'sd15' ? 20 : 28;

  for (let i = 0; i < TURNAROUND_VIEWS.length; i++) {
    const view = TURNAROUND_VIEWS[i];
    if (!view) continue;
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
    const panelWorkflow: Record<string, unknown> = {
      ...input.workflowData,
      prompt: built.prompt,
      negative_prompt: negative,
      gen_type: 'turnaround_panel',
      // Force free composition — do NOT img2img-lock to bust portrait
      denoise: 1.0,
      // Keep ref only if adapters exist; Tier A img2img is off via denoise 1.0 + policy
      character_ref_url: refUrl || undefined,
      ref_image_url: refUrl || undefined,
      // Portrait-style preset can bias upper body; keep character style but panels own pose
      style_preset: input.workflowData?.style_preset || null
    };

    const finalWorkflow = await compileComfyWorkflow(
      panelWorkflow,
      built.prompt,
      'standard',
      {
        steps: input.generationParams?.steps ?? defaultSteps,
        cfg: input.generationParams?.cfg ?? defaultCfg,
        sampler_name: input.generationParams?.sampler_name ?? 'euler_ancestral',
        scheduler: input.generationParams?.scheduler ?? 'normal'
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

    const result = await comfyService.generateImage(finalWorkflow, async (msgType, data) => {
      await input.onProgress?.(msgType, { ...data, view: view.id });
    });

    if (result?.status !== 'completed' || !result.images?.[0]?.data) {
      throw new Error(
        `Turnaround ${view.id} view failed: ${result?.message || 'no image data'}`
      );
    }

    const panelFilename = `${input.sceneId}_${input.taskId}_${view.id}.png`;
    const panelPath = path.join(staticDir, panelFilename);
    fs.writeFileSync(panelPath, result.images[0].data);
    panelPaths[view.id] = `/static/generated/${panelFilename}`;
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

  const sheetFilename = `${input.sceneId}_${input.taskId}_turnaround.png`;
  const sheetPath = path.join(staticDir, sheetFilename);
  fs.writeFileSync(sheetPath, sheetBuffer);
  const sheetUrl = `/static/generated/${sheetFilename}`;

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
