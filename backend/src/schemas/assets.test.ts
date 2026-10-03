import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerateRequestSchema } from './assets';

const request = (generation_params: unknown, workflow: Record<string, unknown> = {}) => ({
  scene_id: 1,
  workflow,
  generation_params,
});

test('new image requests reject legacy aspect ratios in both request locations', () => {
  for (const aspect_ratio of ['3:4', '4:3']) {
    assert.equal(GenerateRequestSchema.safeParse(request({ output_spec: { aspect_ratio } })).success, false);
    assert.equal(GenerateRequestSchema.safeParse(request(null, { output_spec: { aspect_ratio } })).success, false);
  }
});

test('exact dimensions reject legacy ratios and accept supported ratios', () => {
  for (const [width, height] of [[768, 1024], [1024, 768]]) {
    assert.equal(GenerateRequestSchema.safeParse(request({ width, height })).success, false);
  }
  for (const [width, height] of [[1344, 768], [768, 1344], [1024, 1024]]) {
    assert.equal(GenerateRequestSchema.safeParse(request({ width, height })).success, true);
  }
  assert.equal(GenerateRequestSchema.safeParse(request({ width: 768 })).success, false);
  assert.equal(GenerateRequestSchema.safeParse(request({ width: 1200, height: 300 })).success, false);
  const parsed = GenerateRequestSchema.parse(request({ width: 1000, height: 562 }));
  assert.equal(parsed.generation_params?.width, 1000);
  assert.equal(parsed.generation_params?.height, 562);
});

test('supported explicit and automatic aspect ratios remain accepted', () => {
  for (const aspect_ratio of ['16:9', '9:16', '1:1', 'auto']) {
    assert.equal(GenerateRequestSchema.safeParse(request({ output_spec: { aspect_ratio } })).success, true);
  }
});
