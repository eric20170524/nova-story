export interface LoopFrameSample {
  data: Buffer;
  channels: number;
}

export interface LoopContinuityMeasurements {
  appearance_error: number;
  motion_error: number;
  flicker_error: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

const normalizedMae = (a: LoopFrameSample, b: LoopFrameSample): number => {
  if (a.data.length !== b.data.length || a.channels !== b.channels || a.data.length === 0) {
    throw new Error('Loop metric frames must have identical non-empty raw layouts');
  }
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 1) {
    sum += Math.abs(a.data[i]! - b.data[i]!);
  }
  return sum / a.data.length / 255;
};

const meanLuma = (sample: LoopFrameSample): number => {
  const { data, channels } = sample;
  if (channels < 3 || data.length === 0) {
    throw new Error('Loop metric frame must expose at least RGB channels');
  }
  let sum = 0;
  let pixels = 0;
  for (let i = 0; i + channels - 1 < data.length; i += channels) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    pixels += 1;
  }
  return pixels > 0 ? sum / pixels / 255 : 0;
};

/**
 * Produce 0..10-ish error scores from four actual video boundary frames.
 * These metrics are intentionally simple and deterministic so they can run on CPU:
 * - appearance: first vs last frame image difference
 * - motion: mismatch between the first local frame delta and final local frame delta
 * - flicker: boundary mean-luma discontinuity
 *
 * They are a truthful baseline, not a replacement for future DINO/LPIPS/optical-flow QA.
 */
export const computeLoopContinuityMeasurements = (frames: {
  first: LoopFrameSample;
  second: LoopFrameSample;
  penultimate: LoopFrameSample;
  last: LoopFrameSample;
}): LoopContinuityMeasurements => {
  const appearance = normalizedMae(frames.first, frames.last) * 10;
  const startMotion = normalizedMae(frames.first, frames.second) * 10;
  const endMotion = normalizedMae(frames.penultimate, frames.last) * 10;
  const motion = Math.abs(startMotion - endMotion);
  const flicker = Math.abs(meanLuma(frames.first) - meanLuma(frames.last)) * 10;

  return {
    appearance_error: round2(appearance),
    motion_error: round2(motion),
    flicker_error: round2(flicker)
  };
};
