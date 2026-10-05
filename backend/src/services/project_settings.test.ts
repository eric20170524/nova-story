import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalProjectSettings,
  getProjectImageSettings,
  getProjectVideoSettings,
  parseProjectSettings,
  resolveEffectiveNsfw
} from './project_settings';

test('parseProjectSettings accepts JSON string and object', () => {
  assert.equal(getProjectImageSettings(parseProjectSettings('{"image_generation":{"model":"sd15"}}')).model, 'sd15');
  assert.equal(getProjectImageSettings(parseProjectSettings({ image_generation: { model: 'pony' } as any })).model, 'pony');
  assert.deepEqual(parseProjectSettings(null), {});
});

test('old flat image fields are not read at runtime', () => {
  assert.equal(getProjectImageSettings({ default_model_type: 'sd15', nsfw_mode: 'on' }).model, 'pony');
  assert.equal(getProjectImageSettings({ default_model_type: 'sd15', nsfw_mode: 'on' }).nsfw_mode, 'inherit');
});

test('old saved image ratios are read as 16:9 and canonicalized on save', () => {
  for (const aspect_ratio of ['3:4', '4:3']) {
    const settings = parseProjectSettings(JSON.stringify({
      image_generation: { output_spec: { aspect_ratio } },
    }));
    assert.equal(getProjectImageSettings(settings).output_spec.aspect_ratio, '16:9');
  }
});

test('project video workflow keeps a known id and drops anything else', () => {
  const saved = canonicalProjectSettings({
    image_generation: { model: 'redcraft_krea2' },
    video_generation: { workflow_id: 'minimax_h3_hongchao_a2a_12gb' },
    genre: '仙侠',
  });
  assert.equal(getProjectVideoSettings(saved).workflow_id, 'minimax_h3_hongchao_a2a_12gb');
  assert.equal(saved.genre, '仙侠');
  assert.equal(getProjectVideoSettings({ video_generation: { workflow_id: 'ltx-2k' } as any }).workflow_id, null);
  assert.equal(getProjectVideoSettings({}).workflow_id, null);
});

test('resolveEffectiveNsfw uses project policy then system', () => {
  assert.equal(
    resolveEffectiveNsfw({
      systemNsfwEnabled: false,
      projectSettings: { image_generation: { ...getProjectImageSettings({}), nsfw_mode: 'on' } }
    }),
    true
  );
  assert.equal(
    resolveEffectiveNsfw({
      systemNsfwEnabled: true,
      projectSettings: { image_generation: { ...getProjectImageSettings({}), nsfw_mode: 'off' } }
    }),
    false
  );
  assert.equal(
    resolveEffectiveNsfw({
      systemNsfwEnabled: false,
      projectSettings: { image_generation: { ...getProjectImageSettings({}), nsfw_mode: 'inherit' } }
    }),
    false
  );
  assert.equal(
    resolveEffectiveNsfw({
      systemNsfwEnabled: false,
      projectSettings: { image_generation: { ...getProjectImageSettings({}), nsfw_mode: 'off' } }
    }),
    false
  );
});
