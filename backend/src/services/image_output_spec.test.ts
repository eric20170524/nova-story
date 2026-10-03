import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  normalizeImageOutputSpec,
  normalizeGeneratedImage,
  resolveComfyLatentDimensions,
  resolveImageOutputTarget,
} from './image_output_spec';

test('defaults storyboard scenes to a fixed 16:9 standard canvas', () => {
  const target = resolveImageOutputTarget({
    workflowData: { gen_type: 'scene', shot_type: 'Wide Shot' },
    modelFamily: 'pony',
    finalPrompt: 'panoramic plaza',
  });

  assert.equal(target.width, 1280);
  assert.equal(target.height, 720);
  assert.equal(target.resolved_aspect_ratio, '16:9');
  assert.equal(target.source, 'default');
  const keyframe = resolveImageOutputTarget({ workflowData: { gen_type: 'video_keyframe' } });
  assert.equal(keyframe.resolved_aspect_ratio, '16:9');
});

test('Comfy latent presets align to 64 while delivered canvases keep exact 16:9', async () => {
  for (const modelFamily of ['pony', 'sd15']) {
    for (const resolution of ['draft', 'standard', 'high'] as const) {
      for (const aspect_ratio of ['16:9', '9:16'] as const) {
        const target = resolveImageOutputTarget({
          modelFamily,
          workflowData: { gen_type: 'scene', output_spec: { aspect_ratio, resolution } },
        });
        const latent = resolveComfyLatentDimensions(target);
        assert.equal(latent.width % 64, 0);
        assert.equal(latent.height % 64, 0);
        assert.equal(target.width / target.height, aspect_ratio === '16:9' ? 16 / 9 : 9 / 16);
      }
    }
  }
  const target = resolveImageOutputTarget({ workflowData: { gen_type: 'scene' } });
  const latent = resolveComfyLatentDimensions(target);
  assert.deepEqual(latent, { width: 1280, height: 704 });
  const input = await sharp({ create: { width: latent.width, height: latent.height, channels: 3, background: '#777777' } }).png().toBuffer();
  const delivered = await normalizeGeneratedImage(input, target);
  assert.equal(delivered.width, 1280);
  assert.equal(delivered.height, 720);
});

test('project auto policy keeps wide storyboard shots at 16:9', () => {
  const target = resolveImageOutputTarget({
    workflowData: {
      gen_type: 'scene',
      shot_type: 'Establishing Shot',
      project_settings: {
        image_generation: { output_spec: {
          aspect_ratio: 'auto',
          resolution: 'standard',
          orientation_policy: 'auto_by_shot',
        } },
      },
    },
    modelFamily: 'pony',
  });

  assert.equal(target.width, 1280);
  assert.equal(target.height, 720);
  assert.equal(target.resolved_aspect_ratio, '16:9');
  assert.equal(target.source, 'project');
});

test('request output spec overrides the project canvas', () => {
  const target = resolveImageOutputTarget({
    workflowData: {
      gen_type: 'scene',
      project_settings: {
        image_generation: { output_spec: { aspect_ratio: '16:9', resolution: 'standard' } },
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

test('project canvas applies to character portraits', () => {
  const target = resolveImageOutputTarget({
    workflowData: { gen_type: 'portrait', project_settings: {
      image_generation: { output_spec: { aspect_ratio: '1:1', resolution: 'high' } }
    } },
    modelFamily: 'sd15',
  });
  assert.equal(target.width, 1024);
  assert.equal(target.height, 1024);
  assert.equal(target.source, 'project');
});

test('explicit 1280×720 stays a 16:9 delivery; 64 alignment is only the Comfy latent', () => {
  const target = resolveImageOutputTarget({
    workflowData: { gen_type: 'scene' },
    generationParams: { width: 1280, height: 720 },
    modelFamily: 'pony',
  });

  assert.equal(target.width, 1280);
  assert.equal(target.height, 720);
  assert.equal(target.resolved_aspect_ratio, '16:9');
  assert.equal(target.source, 'request_dimensions');
  assert.ok(Math.abs(target.width / target.height - 16 / 9) <= 0.005);
  assert.deepEqual(resolveComfyLatentDimensions(target), { width: 1280, height: 704 });

  const near = resolveImageOutputTarget({ generationParams: { width: 1000, height: 562 } });
  assert.equal(near.width, 1000);
  assert.equal(near.height, 562);
  assert.equal(near.resolved_aspect_ratio, '16:9');
  assert.ok(Math.abs(near.width / near.height - 16 / 9) <= 0.005);

  const offRatio = resolveImageOutputTarget({ generationParams: { width: 1280, height: 710 } });
  assert.equal(offRatio.width, 1280);
  assert.equal(offRatio.height, 720);
  assert.equal(offRatio.resolved_aspect_ratio, '16:9');

  const nearlySquare = resolveImageOutputTarget({ generationParams: { width: 1024, height: 1000 } });
  assert.equal(nearlySquare.resolved_aspect_ratio, '1:1');
  assert.equal(nearlySquare.width, 1024);
  assert.equal(nearlySquare.height, 1024);
});

test('legacy project ratios normalize without creating new legacy output', () => {
  for (const aspect_ratio of ['3:4', '4:3']) {
    assert.equal(normalizeImageOutputSpec({ aspect_ratio }).aspect_ratio, '16:9');
    const target = resolveImageOutputTarget({
      workflowData: { gen_type: 'portrait', project_settings: {
        image_generation: { output_spec: { aspect_ratio, resolution: 'standard' } }
      } },
    });
    assert.equal(target.resolved_aspect_ratio, '16:9');
  }
});

test('explicit 9:16 stays vertical and auto portrait remains 16:9', () => {
  const vertical = resolveImageOutputTarget({
    workflowData: { gen_type: 'portrait', project_settings: {
      image_generation: { output_spec: { aspect_ratio: '16:9', orientation_policy: 'auto_by_shot' } }
    } },
    generationParams: { output_spec: { aspect_ratio: '9:16' } },
  });
  assert.equal(vertical.resolved_aspect_ratio, '9:16');
  assert.equal(vertical.width, 720);
  assert.equal(vertical.height, 1280);
  const automatic = resolveImageOutputTarget({
    workflowData: { gen_type: 'portrait', shot_type: 'close-up' },
    generationParams: { output_spec: { aspect_ratio: 'auto' } },
  });
  assert.equal(automatic.resolved_aspect_ratio, '16:9');
  const square = resolveImageOutputTarget({
    workflowData: { project_settings: { image_generation: {
      output_spec: { aspect_ratio: '16:9', orientation_policy: 'auto_by_shot' },
    } } },
    generationParams: { output_spec: { aspect_ratio: '1:1' } },
  });
  assert.equal(square.resolved_aspect_ratio, '1:1');
});

test('cinematic grid and turnaround expose only supported output ratios', () => {
  const grid = resolveImageOutputTarget({ mode: 'cinematic_grid' });
  assert.equal(grid.resolved_aspect_ratio, '1:1');
  const turnaround = resolveImageOutputTarget({ workflowData: { gen_type: 'turnaround' } });
  assert.equal(turnaround.resolved_aspect_ratio, '16:9');
  assert.equal(turnaround.width, 1280);
  assert.equal(turnaround.height, 720);
});

test('wide and vertical presets use exact ratios for both model families', () => {
  for (const modelFamily of ['pony', 'sd15']) {
    for (const resolution of ['draft', 'standard', 'high']) {
      for (const aspect_ratio of ['16:9', '9:16']) {
        const target = resolveImageOutputTarget({
          modelFamily,
          generationParams: { output_spec: { aspect_ratio, resolution } },
        });
        assert.equal(target.width / target.height, aspect_ratio === '16:9' ? 16 / 9 : 9 / 16);
      }
    }
  }
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
