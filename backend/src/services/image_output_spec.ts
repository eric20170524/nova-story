import sharp from 'sharp';

export type ImageAspectRatio = '3:4' | '4:3' | '1:1' | 'auto';
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
  aspect_ratio: '3:4',
  resolution: 'standard',
  orientation_policy: 'fixed',
};

const ASPECT_RATIOS = new Set<ImageAspectRatio>(['3:4', '4:3', '1:1', 'auto']);
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

export const isLandscapeShot = (shotType?: unknown, prompt?: unknown): boolean =>
  /wide|long shot|extreme long|establishing|panoramic|landscape|overview|overhead|aerial|bird'?s[- ]eye/i.test(
    `${shotType || ''} ${prompt || ''}`
  );

const alignDimension = (value: number) =>
  Math.max(256, Math.min(4096, Math.round(value / 64) * 64));

const explicitDimensions = (generationParams: any): { width: number; height: number } | null => {
  const width = Number(generationParams?.width);
  const height = Number(generationParams?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width: alignDimension(width), height: alignDimension(height) };
};

const dimensionsFor = (
  modelFamily: string,
  resolution: ImageResolution,
  aspectRatio: Exclude<ImageAspectRatio, 'auto'>
) => {
  const isSd15 = modelFamily === 'sd15';
  const portraitByResolution: Record<ImageResolution, [number, number]> = isSd15
    ? {
        draft: [384, 512],
        standard: [576, 768],
        high: [768, 1024],
      }
    : {
        draft: [576, 768],
        standard: [768, 1024],
        high: [1152, 1536],
      };
  const [portraitWidth, portraitHeight] = portraitByResolution[resolution];
  if (aspectRatio === '4:3') return { width: portraitHeight, height: portraitWidth };
  if (aspectRatio === '1:1') return { width: portraitHeight, height: portraitHeight };
  return { width: portraitWidth, height: portraitHeight };
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
  const projectRaw = workflowData.project_settings?.output_spec;
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
    const ratio = directDimensions.width === directDimensions.height
      ? '1:1'
      : directDimensions.width > directDimensions.height ? '4:3' : '3:4';
    const spec = normalizeImageOutputSpec(requestRaw || projectRaw);
    return {
      ...spec,
      ...directDimensions,
      resolved_aspect_ratio: ratio,
      image_size: imageSizeFor(spec.resolution),
      source: 'request_dimensions',
    };
  }

  // Character assets keep purpose-built framing unless a request explicitly overrides it.
  if (genType === 'turnaround' && !requestHasSpec) {
    const dimensions = modelFamily === 'sd15'
      ? { width: 768, height: 512 }
      : { width: 1152, height: 768 };
    return {
      ...DEFAULT_IMAGE_OUTPUT_SPEC,
      aspect_ratio: '4:3',
      resolved_aspect_ratio: '4:3',
      ...dimensions,
      image_size: '1K',
      source: 'generation_type',
    };
  }

  const applyProjectSpec = genType === 'scene' || requestHasSpec;
  const spec: ImageOutputSpec = {
    ...DEFAULT_IMAGE_OUTPUT_SPEC,
    ...(applyProjectSpec ? projectSpec : {}),
    ...requestSpec,
  };
  const resolvedAspectRatio: Exclude<ImageAspectRatio, 'auto'> =
    spec.aspect_ratio === 'auto' || spec.orientation_policy === 'auto_by_shot'
    ? (isLandscapeShot(workflowData.shot_type, options.finalPrompt) ? '4:3' : '3:4')
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
