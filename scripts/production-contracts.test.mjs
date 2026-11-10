import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprint, validateScriptCoverage, resolveSpeechLeadIn, timedSpeech, nativeAudioFilter, buildAssembledShotAudioPlan, subtitles, assertReview } from './production-contracts.mjs';
import { shotVideoPreset, resolveShotDrivingAudio } from './production-references.mjs';

const script = { id: 1, revision: 2, status: 'confirmed', document: { scenes: [
  { id: 'a', blocks: [{ id: 'd', type: 'dialogue', text: '原文对白' }, { id: 'v', type: 'voiceover', text: '原文旁白' }, { id: 's', type: 'sound', text: '铃声' }] },
  { id: 'b', blocks: [{ id: 'x', type: 'action', text: '山风' }] },
] } };
const shot = (id, scene, ids, extras = {}) => ({ id, shot_spec: { source: { type: 'script', script_id: 1, script_revision: 2, script_scene_id: scene, block_ids: ids } }, ...extras });
const valid = [shot(1, 'a', ['d', 'v', 's'], { dialogue: '原文对白', narration: '原文旁白', audio_prompt: '铃声' }), shot(2, 'b', ['x'])];
test('coverage checks all scenes, exactly-once speech, source text and chronological order', () => {
  assert.deepEqual(validateScriptCoverage(script, valid), []);
  assert.ok(validateScriptCoverage(script, valid.slice(0, 1)).length);
  assert.ok(validateScriptCoverage(script, [valid[0], valid[0], valid[1]]).length);
  assert.ok(validateScriptCoverage(script, [...valid].reverse()).length);
  const reordered = structuredClone(valid); reordered[0].shot_spec.source.block_ids = ['v', 'd', 's'];
  assert.ok(validateScriptCoverage(script, reordered).length);
  assert.ok(validateScriptCoverage(script, [{ ...valid[0], dialogue: '被改写的对白' }, valid[1]]).length);
  assert.ok(validateScriptCoverage(script, [shot(1, 'a', []), valid[1]]).length);
  const silent = structuredClone(valid); silent[0].shot_spec.source.block_ids.pop(); silent[0].audio_prompt = '';
  assert.ok(validateScriptCoverage(script, silent).some(error => error.includes('sound blocks')));
});
test('long speech extends edit duration and produces complete subtitle cues without truncating text', () => {
  const text = '完整原声。'.repeat(60);
  const timing = timedSpeech([{ id: 'one', text }, { id: 'two', text: '下一句' }], [9.75, 2.1]);
  assert.ok(timing.duration >= 12);
  assert.equal(Number.isInteger(timing.duration * 24), true);
  assert.ok(timing.cues[1].start >= timing.cues[0].end);
  assert.ok(timing.cues[1].end < timing.duration);
  const srt = subtitles(timing.cues);
  const displayed = srt.split('\n').filter(line => line && !/^\d+$/.test(line) && !line.includes(' --> '));
  assert.equal(displayed.join(''), `${text}下一句`); assert.ok(displayed.every(line => [...line].length <= 18));
  assert.throws(() => timedSpeech([{ id: 'bad', text }], [NaN]), /Invalid speech/);
});
test('approval binds reviewer, source configuration and actual file hashes', () => {
  const snapshot = { sources: ['hash1'], nsfw_mode: 'off', chapters: [1, 2] };
  const review = { reviewer: '测试审核人', reviewed_at: new Date().toISOString(), status: 'approved', fingerprint: fingerprint(snapshot) };
  assertReview(review, snapshot, 'Chapter');
  assert.throws(() => assertReview(review, { ...snapshot, sources: ['hash2'] }, 'Chapter'), /sources changed/);
  assert.throws(() => assertReview(review, { ...snapshot, nsfw_mode: 'on' }, 'Chapter'), /sources changed/);
  assert.throws(() => assertReview({ ...review, reviewer: '' }, snapshot, 'Chapter'), /approval/);
});
test('short dialogue schedules a natural lead-in offset without extending clip duration and filters native vocal formants', () => {
  const shortDialogue = timedSpeech([{ id: 'b1', type: 'dialogue', text: '来吗？' }], [0.8], 5);
  assert.equal(shortDialogue.duration, 5);
  assert.equal(shortDialogue.cues[0].start, 0.5);
  assert.equal(shortDialogue.cues[0].end, 1.3);

  const shortVoiceover = timedSpeech([{ id: 'vo1', type: 'voiceover', text: '清风吹过。' }], [1.5], 5);
  assert.equal(shortVoiceover.duration, 5);
  assert.equal(shortVoiceover.cues[0].start, 0.25);
  assert.equal(shortVoiceover.cues[0].end, 1.75);

  const tightSpeech = resolveSpeechLeadIn([{ id: 'b2', type: 'dialogue', text: '长句' }], [4.7], 5);
  assert.equal(tightSpeech, 0);

  assert.match(nativeAudioFilter(true, true), /bandreject=f=1200:width_type=h:w=1800,volume=0\.12/);
  assert.match(nativeAudioFilter(true, false), /bandreject=f=1200:width_type=h:w=1800,volume=0\.06/);
  assert.equal(nativeAudioFilter(false, false), '[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=1[native]');

  const nativePlan = buildAssembledShotAudioPlan({
    hasNativeAudio: true,
    layoutFiles: [{ path: '/tmp/a.mp3' }],
    layoutCues: [{ start: 0.5 }],
    duration: 5,
  });
  assert.equal(nativePlan.mode, 'native');
  assert.deepEqual(nativePlan.inputs, []);
  assert.match(nativePlan.filters.join(';'), /\[0:a\].*volume=1.*atrim=duration=5/);
  assert.doesNotMatch(nativePlan.filters.join(';'), /speech0|amix/);

  const ttsPlan = buildAssembledShotAudioPlan({
    hasNativeAudio: false,
    layoutFiles: [{ path: '/tmp/a.mp3' }, { path: '/tmp/b.mp3' }],
    layoutCues: [{ start: 0.5 }, { start: 2.1 }],
    duration: 5,
  });
  assert.equal(ttsPlan.mode, 'tts_fallback');
  assert.equal(ttsPlan.inputs.length, 4);
  assert.match(ttsPlan.filters.join(';'), /adelay=500\|500\[speech0\]/);
  assert.match(ttsPlan.filters.join(';'), /amix=inputs=2/);

  assert.equal(shotVideoPreset({ duration: 5 }, shortDialogue), 'standard_720p_5s');
  assert.equal(shotVideoPreset({ duration: 5 }, { duration: 6.5 }), 'standard_720p_8s');

  const layoutWithFile = {
    ...shortDialogue,
    files: [{ block_id: 'b1', asset_id: 301, url: '/static/generated/audio/b1.mp3', duration: 0.8 }],
  };
  const mediaAssets = [{ id: 301, role: 'script_speech', status: 'ready', url: '/static/generated/audio/b1.mp3' }];
  assert.deepEqual(
    resolveShotDrivingAudio({ id: 1, dialogue: '来吗？' }, mediaAssets, 'minimax_h3_ref2va_official_12gb', 'standard_720p_5s', layoutWithFile),
    { driving_audio_asset_id: 301, driving_audio_start_sec: 0.5, driving_audio_end_sec: 1.3 },
  );
  assert.deepEqual(
    resolveShotDrivingAudio({ id: 1, dialogue: '来吗？' }, mediaAssets, 'minimax_h3_fl2va_official_12gb', 'standard_720p_5s', layoutWithFile),
    { driving_audio_start_sec: 0.5, driving_audio_end_sec: 1.3 },
  );
});

