import assert from 'node:assert/strict';
import test from 'node:test';
import { assertChapterClipReady, assertNonEmptyChapterShots } from './video-delivery-contract.mjs';

const readyProbe = (extra = {}) => ({
  streams: [
    { codec_type: 'video', width: 1280, height: 720, r_frame_rate: '24/1', nb_frames: '120' },
    { codec_type: 'audio', sample_rate: '48000', channels: 2 },
  ],
  format: { duration: '5.000000' },
  ...extra,
});

test('delivery contract accepts a 720p 5-second clip and rejects geometry drift', () => {
  assert.doesNotThrow(() => assertChapterClipReady(readyProbe(), 'shot'));
  assert.throws(() => assertChapterClipReady(readyProbe({
    streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '24/1', nb_frames: '120' }],
    format: { duration: '5' },
  }), 'shot'), /1280x720/);
  assert.throws(() => assertChapterClipReady({
    streams: [{ codec_type: 'video', width: 1280, height: 720, r_frame_rate: '24/1', nb_frames: '124' }],
    format: { duration: '5.166' },
  }, 'shot'), /frames 124/);
});

test('assembled clips require an audio stream and silent sources can still be normalized', () => {
  const silent = readyProbe();
  silent.streams = silent.streams.filter(stream => stream.codec_type !== 'audio');
  assert.doesNotThrow(() => assertChapterClipReady(silent, 'source'));
  assert.throws(() => assertChapterClipReady(silent, 'assembled', { requireAudio: true }), /missing audio stream/);
});

test('an empty chapter is rejected before concat can reuse earlier clips', () => {
  assert.throws(() => assertNonEmptyChapterShots(0, 'Chapter 2'), /reuse earlier clips/);
  assert.doesNotThrow(() => assertNonEmptyChapterShots(3, 'Chapter 1'));
});

test('unknown frame counts fail closed and edited durations require exact decoded frames', () => {
  const unknown = readyProbe(); delete unknown.streams[0].nb_frames;
  assert.throws(() => assertChapterClipReady(unknown, 'unknown'), /frames unknown/);
  const edited = readyProbe(); edited.format.duration = '9.5'; edited.streams[0].nb_frames = 'N/A'; edited.streams[0].nb_read_frames = '228';
  assert.doesNotThrow(() => assertChapterClipReady(edited, 'long speech', { requireAudio: true, durationSeconds: 9.5 }));
  edited.streams[0].nb_read_frames = '120';
  assert.throws(() => assertChapterClipReady(edited, 'cropped', { durationSeconds: 9.5 }), /expected 228/);
});
