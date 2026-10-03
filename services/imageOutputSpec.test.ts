import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProjectOutputSpec } from './imageOutputSpec';

test('new settings display a 16:9 canvas', () => {
  assert.deepEqual(normalizeProjectOutputSpec(undefined), {
    aspect_ratio: '16:9', resolution: 'standard', orientation_policy: 'fixed',
  });
});

test('saved legacy ratios open as 16:9 and stay 16:9 when saved', () => {
  for (const aspect_ratio of ['3:4', '4:3']) {
    const normalized = normalizeProjectOutputSpec({ aspect_ratio, resolution: 'high' });
    assert.equal(normalized.aspect_ratio, '16:9');
    assert.equal(normalizeProjectOutputSpec(JSON.parse(JSON.stringify(normalized))).aspect_ratio, '16:9');
  }
});

test('explicit alternate ratios and automatic canvas remain available', () => {
  assert.equal(normalizeProjectOutputSpec({ aspect_ratio: '9:16' }).aspect_ratio, '9:16');
  assert.equal(normalizeProjectOutputSpec({ aspect_ratio: '1:1' }).aspect_ratio, '1:1');
  assert.deepEqual(normalizeProjectOutputSpec({ aspect_ratio: 'auto' }), {
    aspect_ratio: '16:9', resolution: 'standard', orientation_policy: 'auto_by_shot',
  });
});
