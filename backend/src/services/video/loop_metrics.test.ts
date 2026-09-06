import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLoopContinuityMeasurements, type LoopFrameSample } from './loop_metrics';

const rgb = (...values: number[]): LoopFrameSample => ({
  data: Buffer.from(values),
  channels: 3
});

test('loop continuity metrics report zero for identical static boundary frames', () => {
  const frame = rgb(10, 20, 30, 40, 50, 60);
  const metrics = computeLoopContinuityMeasurements({
    first: frame,
    second: frame,
    penultimate: frame,
    last: frame
  });
  assert.deepEqual(metrics, {
    appearance_error: 0,
    motion_error: 0,
    flicker_error: 0
  });
});

test('loop continuity metrics react to appearance, motion and luminance discontinuity', () => {
  const metrics = computeLoopContinuityMeasurements({
    first: rgb(0, 0, 0, 0, 0, 0),
    second: rgb(10, 10, 10, 10, 10, 10),
    penultimate: rgb(200, 200, 200, 200, 200, 200),
    last: rgb(255, 255, 255, 255, 255, 255)
  });

  assert.ok(metrics.appearance_error >= 9.9);
  assert.ok(metrics.motion_error > 1);
  assert.ok(metrics.flicker_error >= 9.9);
});

test('loop continuity metrics reject mismatched frame layouts', () => {
  assert.throws(() => computeLoopContinuityMeasurements({
    first: rgb(0, 0, 0),
    second: rgb(0, 0, 0, 0, 0, 0),
    penultimate: rgb(0, 0, 0),
    last: rgb(0, 0, 0)
  }), /identical non-empty raw layouts/);
});
