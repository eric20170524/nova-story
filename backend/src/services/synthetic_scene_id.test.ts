import assert from 'node:assert/strict';
import test from 'node:test';
import { isSyntheticCharacterSceneId, shouldPersistSceneAsset, syntheticCharacterId } from './synthetic_scene_id';

test('reserved character scene ids do not swallow real director shots', () => {
  assert.equal(syntheticCharacterId(90_000_007), 7);
  assert.equal(syntheticCharacterId(999_997), 7);
  assert.equal(isSyntheticCharacterSceneId(900_001), false);
  assert.equal(shouldPersistSceneAsset(900_001), true);
  assert.equal(shouldPersistSceneAsset(90_000_007), false);
  assert.equal(shouldPersistSceneAsset(2_000_000_004), false);
});
