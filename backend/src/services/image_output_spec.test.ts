import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  normalizeGeneratedImage,
  resolveImageOutputTarget,
} from './image_output_spec';

test('defaults storyboard scenes to a fixed 3:4 standard canvas', () => {
  const target = resolveImageOutputTarget({
    workflowData: { gen_type: 'scene', shot_type: 'Wide Shot' },
    modelFamily: 'pony',
    finalPrompt: 'panoramic plaza',
  });

  assert.equal(target.width, 768);
  assert.equal(target.height, 1024);
  assert.equal(target.resolved_aspect_ratio, '3:4');
  assert.equal(target.source, 'default');
});

test('project auto policy may switch wide storyboard shots to landscape', () => {
  const target = resolveImageOutputTarget({
    workflowData: {
      gen_type: 'scene',
      shot_type: 'Establishing Shot',
      project_settings: {
        output_spec: {
          aspect_ratio: '3:4',
          resolution: 'standard',
          orientation_policy: 'auto_by_shot',
        },
      },
    },
    modelFamily: 'pony',
  });

  assert.equal(target.width, 1024);
  assert.equal(target.height, 768);
  assert.equal(target.resolved_aspect_ratio, '4:3');
  assert.equal(target.source, 'project');
});

test('request output spec overrides the project canvas', () => {
  const target = resolveImageOutputTarget({
    workflowData: {
      gen_type: 'scene',
      project_settings: {
        output_spec: { aspect_ratio: '3:4', resolution: 'standard' },
      },
      output_spec: { aspect_ratio: '1:1', resolution: 'draft' },
    },
    modelFamily: 'pony',
  });

  assert.equal(target.width, 768);
  assert.equal(target.height, 768);
  assert.equal(target.resolved_aspect_ratio, '1:1');
  assert.equal(target.source, 'request');
});

test('exact request dimensions win and align to model-safe multiples of 64', () => {
  const target = resolveImageOutputTarget({
    workflowData: { gen_type: 'scene' },
    generationParams: { width: 1000, height: 740 },
    modelFamily: 'pony',
  });

  assert.equal(target.width, 1024);
  assert.equal(target.height, 768);
  assert.equal(target.source, 'request_dimensions');
});

test('normalizes provider output to the resolved pixel contract', async () => {
  const input = await sharp({
    create: {
      width: 1024,
      height: 1536,
      channels: 3,
      background: { r: 50, g: 60, b: 70 },
    },
  }).jpeg().toBuffer();

  const result = await normalizeGeneratedImage(input, { width: 768, height: 1024 });
  const metadata = await sharp(result.buffer).metadata();
  assert.equal(result.normalized, true);
  assert.equal(metadata.width, 768);
  assert.equal(metadata.height, 1024);
  assert.equal(metadata.format, 'png');
});
