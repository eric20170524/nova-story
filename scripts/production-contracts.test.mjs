import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprint, validateScriptCoverage, timedSpeech, subtitles, assertReview } from './production-contracts.mjs';

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
