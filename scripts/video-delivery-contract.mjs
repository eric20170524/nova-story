const frameRate = (stream) => {
  const raw = String(stream?.r_frame_rate || stream?.avg_frame_rate || '');
  const [num, den] = raw.split('/').map(Number);
  if (Number.isFinite(num) && Number.isFinite(den) && den) return num / den;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/**
 * Accepted narrative clips and locally normalized shot files share this contract:
 * 1280×720, 24 fps, 120 frames, 5 seconds. Audio is required only after the
 * assembler has padded a silent source.
 */
export function assertChapterClipReady(probeResult, label, options = {}) {
  if (!probeResult || typeof probeResult !== 'object') throw new Error(`${label} has no media probe`);
  const streams = Array.isArray(probeResult.streams) ? probeResult.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video');
  const problems = [];
  if (!video) problems.push('missing video stream');
  else {
    const width = Number(video.width);
    const height = Number(video.height);
    const fps = frameRate(video);
    const frames = Number(video.nb_frames);
    if (width !== 1280 || height !== 720) problems.push(`resolution ${width}x${height}, expected 1280x720`);
    if (!Number.isFinite(fps) || Math.abs(fps - 24) > 0.05) problems.push(`fps ${Number.isFinite(fps) ? fps : 'unknown'}, expected 24`);
    if (Number.isFinite(frames) && frames > 0 && frames !== 120) problems.push(`frames ${frames}, expected 120`);
  }
  const duration = Number(probeResult.format?.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - 5) > 0.2) problems.push(`duration ${Number.isFinite(duration) ? duration : 'unknown'}, expected 5s`);
  if (options.requireAudio && !streams.some(stream => stream.codec_type === 'audio')) problems.push('missing audio stream');
  if (problems.length) throw new Error(`${label} failed the delivery contract: ${problems.join('; ')}`);
}

/** An empty chapter must not be concatenated. slice(0) would reuse every earlier clip. */
export function assertNonEmptyChapterShots(shotCount, label) {
  if (!Number.isInteger(shotCount) || shotCount < 1) {
    throw new Error(`${label} has no shots; refusing to assemble an empty chapter or reuse earlier clips`);
  }
}
