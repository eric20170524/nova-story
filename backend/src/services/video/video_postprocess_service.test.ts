import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LoopCloser } from './loop_closer';
import { VideoPostprocessService } from './video_postprocess_service';

const exec = promisify(execFile);

test('narrative postprocessing retains audible source audio while character loops remain silent', async t => {
  if (!await VideoPostprocessService.isFfmpegAvailable() || !await VideoPostprocessService.isFfprobeAvailable()) {
    t.skip('ffmpeg and ffprobe are required');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-narrative-audio-'));
  try {
    const source = path.join(directory, 'source.mp4');
    await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
    const narrative = await LoopCloser.process({ taskId: 'test-narrative-audio', profile: 'narrative_clip',
      rawVideoPath: source, outputDirectory: path.join(directory, 'narrative'), runLoopCloser: false });
    assert.equal(narrative.probe.has_audio, true);
    assert.ok(Math.abs(narrative.probe.duration_s - 5) < 0.12);
    assert.equal(narrative.probe.fps, 24);
    assert.equal(narrative.probe.frame_count, 120);
    assert.equal(narrative.qaReport.technical_pass, true);
    const decoded = await exec('ffmpeg', ['-v', 'error', '-i', narrative.finalVideoPath,
      '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1'], { encoding: 'buffer' });
    const samples = decoded.stdout;
    assert.ok(samples.length > 1000);
    let peak = 0;
    for (let i = 0; i + 1 < samples.length; i += 2) peak = Math.max(peak, Math.abs(samples.readInt16LE(i)));
    assert.ok(peak > 100, 'the retained audio must contain audible samples');
    const loop = await LoopCloser.process({ taskId: 'test-loop-audio', profile: 'character_loop',
      rawVideoPath: source, outputDirectory: path.join(directory, 'loop'), runLoopCloser: false });
    assert.equal(loop.probe.has_audio, false);
    assert.equal(loop.probe.fps, 24);
    assert.equal(loop.probe.frame_count, 120);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('124 model frames deliver exact 720p and optional 480p 24fps clips', async t => {
  if (!await VideoPostprocessService.isFfmpegAvailable() || !await VideoPostprocessService.isFfprobeAvailable()) {
    t.skip('ffmpeg and ffprobe are required');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-h3-delivery-'));
  try {
    const source = path.join(directory, 'model-124.mp4');
    await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=24', '-frames:v', '124',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', source]);
    for (const [label, width, height] of [['720p', 1280, 720], ['480p', 864, 480]] as const) {
      const result = await LoopCloser.process({
        taskId: `delivery-${label}`, profile: 'narrative_clip',
        rawVideoPath: source, outputDirectory: path.join(directory, label),
        targetWidth: width, targetHeight: height, runLoopCloser: false,
      });
      assert.equal(result.probe.width, width);
      assert.equal(result.probe.height, height);
      assert.equal(result.probe.fps, 24);
      assert.equal(result.probe.frame_count, 120);
      assert.ok(Math.abs(result.probe.duration_s - 5) < 0.12);
      assert.equal(result.qaReport.technical_pass, true);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
