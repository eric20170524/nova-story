import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProjectImageSettings,
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
