import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeNsfwMode,
  parseProjectSettings,
  resolveEffectiveNsfw
} from './project_settings';

test('parseProjectSettings accepts JSON string and object', () => {
  assert.equal(parseProjectSettings('{"nsfw_mode":"on"}').nsfw_mode, 'on');
  assert.equal(parseProjectSettings({ default_style: 'anime' }).default_style, 'anime');
  assert.deepEqual(parseProjectSettings(null), {});
});

test('legacy nsfw_enabled maps to mode', () => {
  assert.equal(normalizeNsfwMode({ nsfw_enabled: true }), 'on');
  assert.equal(normalizeNsfwMode({ nsfw_enabled: false }), 'off');
  assert.equal(normalizeNsfwMode({}), 'inherit');
});

test('resolveEffectiveNsfw priority: request > project > system', () => {
  assert.equal(
    resolveEffectiveNsfw({
      systemNsfwEnabled: false,
      projectSettings: { nsfw_mode: 'on' }
    }),
    true
  );
  assert.equal(
    resolveEffectiveNsfw({
      systemNsfwEnabled: true,
      projectSettings: { nsfw_mode: 'off' }
    }),
    false
  );
  assert.equal(
    resolveEffectiveNsfw({
      systemNsfwEnabled: false,
      projectSettings: { nsfw_mode: 'inherit' }
    }),
    false
  );
  assert.equal(
    resolveEffectiveNsfw({
      systemNsfwEnabled: false,
      projectSettings: { nsfw_mode: 'off' },
      requestOverride: true
    }),
    true
  );
});
