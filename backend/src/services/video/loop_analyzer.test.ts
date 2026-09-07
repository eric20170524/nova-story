import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopAnalyzer } from './loop_analyzer';
import type { VideoProbeInfo } from './video_postprocess_service';

const probe: VideoProbeInfo = {
  codec: 'h264',
  pixel_format: 'yuv420p',
  width: 864,
  height: 480,
  fps: 24,
  frame_count: 120,
  duration_s: 5,
  has_audio: false
};

test('LoopAnalyzer passes a low-cost measured seam', () => {
  const report = LoopAnalyzer.evaluateVideo({
    taskId: 'qa_pass',
    profile: 'character_loop',
    probe,
    continuity: {
      appearance_error: 1.0,
      motion_error: 1.0,
      flicker_error: 1.0
    }
  });
  assert.equal(report.quality_grade, 'pass');
  assert.equal(report.continuity_scores.seam_cost, 1);
});

test('LoopAnalyzer requests manual review between 1.50 and 2.20', () => {
  const report = LoopAnalyzer.evaluateVideo({
    taskId: 'qa_review',
    profile: 'character_loop',
    probe,
    continuity: {
      appearance_error: 1.8,
      motion_error: 1.8,
      flicker_error: 1.8
    }
  });
  assert.equal(report.quality_grade, 'manual_review');
  assert.ok(report.reasons.some((reason) => reason.includes('manual review')));
});

test('LoopAnalyzer rejects a loop seam above 2.20', () => {
  const report = LoopAnalyzer.evaluateVideo({
    taskId: 'qa_reject',
    profile: 'character_loop',
    probe,
    continuity: {
      appearance_error: 3.0,
      motion_error: 3.0,
      flicker_error: 3.0
    }
  });
  assert.equal(report.quality_grade, 'reject');
});

test('LoopAnalyzer never fabricates a passing score when visual analysis is unavailable', () => {
  const report = LoopAnalyzer.evaluateVideo({
    taskId: 'qa_missing',
    profile: 'character_loop',
    probe,
    analysisError: 'frame extraction failed'
  });
  assert.equal(report.quality_grade, 'manual_review');
  assert.ok(report.reasons.some((reason) => reason.includes('Continuity analysis unavailable')));
});
