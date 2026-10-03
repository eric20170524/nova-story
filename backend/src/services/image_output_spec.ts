import sharp from 'sharp';

export type ImageAspectRatio = '16:9' | '9:16' | '1:1' | 'auto';
export type ImageResolution = 'draft' | 'standard' | 'high';
export type ImageOrientationPolicy = 'fixed' | 'auto_by_shot';

export interface ImageOutputSpec {
  aspect_ratio: ImageAspectRatio;
  resolution: ImageResolution;
  orientation_policy: ImageOrientationPolicy;
}

export interface ImageOutputTarget extends ImageOutputSpec {
  width: number;
  height: number;
  resolved_aspect_ratio: Exclude<ImageAspectRatio, 'auto'>;
  image_size: '512' | '1K' | '2K';
  source: 'request_dimensions' | 'request' | 'project' | 'mode' | 'generation_type' | 'default';
}

export const DEFAULT_IMAGE_OUTPUT_SPEC: ImageOutputSpec = {
  aspect_ratio: '16:9',
  resolution: 'standard',
  orientation_policy: 'fixed',
};

const ASPECT_RATIOS = new Set<ImageAspectRatio>(['16:9', '9:16', '1:1', 'auto']);
const RESOLUTIONS = new Set<ImageResolution>(['draft', 'standard', 'high']);
const ORIENTATION_POLICIES = new Set<ImageOrientationPolicy>(['fixed', 'auto_by_shot']);

const parsePartialSpec = (raw: unknown): Partial<ImageOutputSpec> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  return {
    ...(ASPECT_RATIOS.has(value.aspect_ratio as ImageAspectRatio)
      ? { aspect_ratio: value.aspect_ratio as ImageAspectRatio }
      : {}),
    ...(RESOLUTIONS.has(value.resolution as ImageResolution)
      ? { resolution: value.resolution as ImageResolution }
      : {}),
    ...(ORIENTATION_POLICIES.has(value.orientation_policy as ImageOrientationPolicy)
      ? { orientation_policy: value.orientation_policy as ImageOrientationPolicy }
      : {}),
  };
};

export const normalizeImageOutputSpec = (raw: unknown): ImageOutputSpec => ({
  ...DEFAULT_IMAGE_OUTPUT_SPEC,
  ...parsePartialSpec(raw),
});

const CANVAS_MIN = 256;
const CANVAS_MAX = 4096;
/** Same tolerance as Shot Master video preflight (`width / height` vs 16:9). */
const DELIVERY_ASPECT_TOLERANCE = 0.005;

const alignDimension = (value: number) =>
  Math.max(CANVAS_MIN, Math.min(CANVAS_MAX, Math.round(value / 64) * 64));

/** Comfy UNet canvas. The delivered file keeps the requested aspect ratio. */
export const resolveComfyLatentDimensions = (target: Pick<ImageOutputTarget, 'width' | 'height'>) => ({
  width: alignDimension(target.width),
  height: alignDimension(target.height),
});

const explicitDimensions = (generationParams: any): { width: number; height: number } | null => {
  const width = Number(generationParams?.width);
  const height = Number(generationParams?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
};

const matchesDeliveryRatio = (width: number, height: number, ratio: number) =>
  height > 0 && Math.abs(width / height - ratio) <= DELIVERY_ASPECT_TOLERANCE;

const clampCanvas = (value: number) => Math.max(CANVAS_MIN, Math.min(CANVAS_MAX, Math.round(value)));

/** Keep an explicit request on its labeled ratio. 64-alignment belongs only on the Comfy latent. */
const deliveryDimensions = (width: number, height: number, ratio: number) => {
  if (
    width >= CANVAS_MIN && width <= CANVAS_MAX
    && height >= CANVAS_MIN && height <= CANVAS_MAX
    && matchesDeliveryRatio(width, height, ratio)
  ) {
    return { width, height };
  }
  const side = clampCanvas(Math.max(width, height));
  if (Math.abs(ratio - 1) <= DELIVERY_ASPECT_TOLERANCE) return { width: side, height: side };
  const landscape = width >= height;
  const other = clampCanvas(landscape ? side / ratio : side * ratio);
  const delivered = landscape ? { width: side, height: other } : { width: other, height: side };
  if (matchesDeliveryRatio(delivered.width, delivered.height, ratio)) return delivered;
  return landscape
    ? { width: clampCanvas(other * ratio), height: other }
    : { width: other, height: clampCanvas(other / ratio) };
};

const dimensionsFor = (
  modelFamily: string,
  resolution: ImageResolution,
  aspectRatio: Exclude<ImageAspectRatio, 'auto'>
) => {
  const isSd15 = modelFamily === 'sd15';
  if (aspectRatio === '16:9') {
    return isSd15
      ? (resolution === 'draft' ? { width: 640, height: 360 } : resolution === 'high' ? { width: 1024, height: 576 } : { width: 768, height: 432 })
      : (resolution === 'draft' ? { width: 896, height: 504 } : resolution === 'high' ? { width: 1536, height: 864 } : { width: 1280, height: 720 });
  }
  if (aspectRatio === '9:16') {
    return isSd15
      ? (resolution === 'draft' ? { width: 360, height: 640 } : resolution === 'high' ? { width: 576, height: 1024 } : { width: 432, height: 768 })
      : (resolution === 'draft' ? { width: 504, height: 896 } : resolution === 'high' ? { width: 864, height: 1536 } : { width: 720, height: 1280 });
  }
  const squareSize = isSd15
    ? { draft: 512, standard: 768, high: 1024 }[resolution]
    : { draft: 768, standard: 1024, high: 1536 }[resolution];
  return { width: squareSize, height: squareSize };
};

const imageSizeFor = (resolution: ImageResolution): ImageOutputTarget['image_size'] =>
  resolution === 'draft' ? '512' : resolution === 'high' ? '2K' : '1K';

export const resolveImageOutputTarget = (options: {
  workflowData?: any;
  generationParams?: any;
  mode?: string;
  modelFamily?: string;
  finalPrompt?: string;
}): ImageOutputTarget => {
  const workflowData = options.workflowData || {};
  const generationParams = options.generationParams || {};
  const modelFamily = options.modelFamily || 'pony';
  const mode = options.mode || 'standard';
  const genType = String(workflowData.gen_type || 'scene');
  const requestRaw = generationParams.output_spec || workflowData.output_spec;
  const projectRaw = workflowData.project_settings?.image_generation?.output_spec;
  const requestSpec = parsePartialSpec(requestRaw);
  const projectSpec = parsePartialSpec(projectRaw);
  const requestHasSpec = Object.keys(requestSpec).length > 0;
  const projectHasSpec = Object.keys(projectSpec).length > 0;

  if (mode === 'cinematic_grid') {
    return {
      ...DEFAULT_IMAGE_OUTPUT_SPEC,
      aspect_ratio: '1:1',
      resolved_aspect_ratio: '1:1',
      width: 1024,
      height: 1024,
      image_size: '1K',
      source: 'mode',
    };
  }

  const directDimensions = explicitDimensions(generationParams);
  if (directDimensions) {
    const requestedRatio = directDimensions.width / directDimensions.height;
    const ratio = Math.abs(requestedRatio - 1) <= 0.04
      ? '1:1'
      : directDimensions.width > directDimensions.height ? '16:9' : '9:16';
    const ratioValue = ratio === '1:1' ? 1 : ratio === '16:9' ? 16 / 9 : 9 / 16;
    const spec = normalizeImageOutputSpec(requestRaw || projectRaw);
    return {
      ...spec,
      aspect_ratio: ratio,
      ...deliveryDimensions(directDimensions.width, directDimensions.height, ratioValue),
      resolved_aspect_ratio: ratio,
      image_size: imageSizeFor(spec.resolution),
      source: 'request_dimensions',
    };
  }

  // A turnaround sheet is assembled from three panels by its compositor.
  if (genType === 'turnaround' && !requestHasSpec) {
    const dimensions = dimensionsFor(modelFamily, 'standard', '16:9');
    return {
      ...DEFAULT_IMAGE_OUTPUT_SPEC,
      aspect_ratio: '16:9',
      resolved_aspect_ratio: '16:9',
      ...dimensions,
      image_size: '1K',
      source: 'generation_type',
    };
  }

  const applyProjectSpec = genType !== 'turnaround';
  const spec: ImageOutputSpec = {
    ...DEFAULT_IMAGE_OUTPUT_SPEC,
    ...(applyProjectSpec ? projectSpec : {}),
    ...requestSpec,
  };
  const resolvedAspectRatio: Exclude<ImageAspectRatio, 'auto'> =
    requestSpec.aspect_ratio && requestSpec.aspect_ratio !== 'auto'
      ? requestSpec.aspect_ratio
      : spec.aspect_ratio === 'auto' || spec.orientation_policy === 'auto_by_shot'
        ? '16:9'
        : spec.aspect_ratio;
  const dimensions = dimensionsFor(modelFamily, spec.resolution, resolvedAspectRatio);

  return {
    ...spec,
    ...dimensions,
    resolved_aspect_ratio: resolvedAspectRatio,
    image_size: imageSizeFor(spec.resolution),
    source: requestHasSpec ? 'request' : projectHasSpec && applyProjectSpec ? 'project' : 'default',
  };
};

export const normalizeGeneratedImage = async (
  input: Buffer,
  target: Pick<ImageOutputTarget, 'width' | 'height'>
) => {
  const metadata = await sharp(input).metadata();
  const sourceWidth = metadata.width || 0;
  const sourceHeight = metadata.height || 0;
  const normalized = sourceWidth !== target.width || sourceHeight !== target.height;
  const output = await sharp(input)
    .rotate()
    .resize(target.width, target.height, {
      fit: 'cover',
      position: 'centre',
    })
    .png()
    .toBuffer();
  return {
    buffer: output,
    width: target.width,
    height: target.height,
    sourceWidth,
    sourceHeight,
    normalized,
  };
};
