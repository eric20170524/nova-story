import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerateRequestSchema } from './assets';

const baseRequest = {
  workflow: { prompt: 'scene' },
  scene_id: 1,
  mode: 'standard',
};

test('generation params accept a complete supported canvas override', () => {
  const parsed = GenerateRequestSchema.parse({
    ...baseRequest,
    generation_params: { width: 1000, height: 750 },
  });
  assert.equal(parsed.generation_params?.width, 1000);
  assert.equal(parsed.generation_params?.height, 750);
});

test('generation params reject incomplete or unsupported canvas dimensions', () => {
  assert.equal(GenerateRequestSchema.safeParse({
    ...baseRequest,
    generation_params: { width: 768 },
  }).success, false);
  assert.equal(GenerateRequestSchema.safeParse({
    ...baseRequest,
    generation_params: { width: 1280, height: 720 },
  }).success, false);
});
