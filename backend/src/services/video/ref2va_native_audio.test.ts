import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoGenerationService } from './video_generation_service';
import type { ProcessVideoResult } from './loop_closer';
import type { VideoQAReport } from '../../schemas/video';

function baseProcess(hasAudio: boolean): ProcessVideoResult {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-ref2va-audio-'));
  const qaPath = path.join(directory, 'qa.json');
  const qaReport: VideoQAReport = {
    schema_version: 1,
    task_id: 't1',
    profile: 'narrative_clip',
    technical_pass: true,
    technical_details: {
      codec: 'h264',
      pixel_format: 'yuv420p',
      width: 1280,
      height: 720,
      fps: 24,
      frame_count: 120,
      duration_s: 5,
      has_audio: hasAudio,
    },
    continuity_scores: {
      appearance_error: 0,
      motion_error: 0,
      flicker_error: 0,
      seam_cost: 0,
      normalized_score: 100,
    },
    quality_grade: 'pass',
    reasons: [],
    evaluated_at: new Date().toISOString(),
  };
  fs.writeFileSync(qaPath, JSON.stringify(qaReport));
  return {
    rawVideoPath: path.join(directory, 'raw.mp4'),
    finalVideoPath: path.join(directory, 'final.mp4'),
    posterPath: path.join(directory, 'poster.jpg'),
    qaPath,
    manifestPath: path.join(directory, 'manifest.json'),
    qaReport,
    probe: {
      codec: 'h264',
      pixel_format: 'yuv420p',
      width: 1280,
      height: 720,
      fps: 24,
      frame_count: 120,
      duration_s: 5,
      has_audio: hasAudio,
    },
  };
}

test('speaking Ref2VA without native audio is rejected', () => {
  const processRes = VideoGenerationService.enforceSpeakingRef2vaAudio(
    {
      profile: 'narrative_clip',
      workflow_id: 'minimax_h3_ref2va_official_12gb',
      driving_audio_asset_id: 501,
    },
    baseProcess(false),
  );
  assert.equal(processRes.qaReport.quality_grade, 'reject');
  assert.equal(processRes.qaReport.technical_pass, false);
  assert.match(processRes.qaReport.reasons.join(' '), /missing the native audio track/);
});

test('speaking Ref2VA with native audio stays passing', () => {
  const processRes = VideoGenerationService.enforceSpeakingRef2vaAudio(
    {
      profile: 'narrative_clip',
      workflow_id: 'minimax_h3_ref2va_official_12gb',
      driving_audio_asset_id: 501,
    },
    baseProcess(true),
  );
  assert.equal(processRes.qaReport.quality_grade, 'pass');
});

test('FL2VA and silent Ref2VA without driving audio are not forced to carry audio', () => {
  const fl2va = VideoGenerationService.enforceSpeakingRef2vaAudio(
    {
      profile: 'narrative_clip',
      workflow_id: 'minimax_h3_fl2va_official_12gb',
    },
    baseProcess(false),
  );
  assert.equal(fl2va.qaReport.quality_grade, 'pass');

  const silentRef = VideoGenerationService.enforceSpeakingRef2vaAudio(
    {
      profile: 'narrative_clip',
      workflow_id: 'minimax_h3_ref2va_official_12gb',
    },
    baseProcess(false),
  );
  assert.equal(silentRef.qaReport.quality_grade, 'pass');
});
