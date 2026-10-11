import assert from 'node:assert/strict';
import test from 'node:test';
import { formalProductionBlocked, nextSceneAfterImageEvent } from './formalShotImage';
import type { Scene } from '../types';

const scene = { id: 9995, asset_status: 'completed', asset_url: '/static/kept.png', visual_prompt: '', audio_prompt: '', dialogue: '', duration: 3 } as Scene;

test('a dropped image connection and a failed candidate keep the selected image', () => {
  assert.equal(nextSceneAfterImageEvent(scene, 'disconnect').asset_url, '/static/kept.png');
  assert.equal(nextSceneAfterImageEvent(scene, 'failed').asset_status, 'completed');
  assert.equal(nextSceneAfterImageEvent(scene, 'completed', '/static/candidate.png', 2).asset_url, '/static/kept.png');
  assert.equal(nextSceneAfterImageEvent(scene, 'completed', '/static/first.png', null).asset_url, '/static/first.png');
});

test('a failed or dropped generation without an image stops showing generating', () => {
  const empty = { ...scene, asset_status: 'generating', asset_url: null } as Scene;
  const failed = nextSceneAfterImageEvent(empty, 'failed');
  const dropped = nextSceneAfterImageEvent(empty, 'disconnect');
  assert.equal(failed.asset_status, 'failed');
  assert.equal(failed.asset_url, null);
  assert.equal(dropped.asset_status, 'failed');
  assert.equal(dropped.asset_url, null);
});

test('formal generation stays closed until a capability is live', () => {
  assert.deepEqual(formalProductionBlocked(undefined), ['status_unavailable']);
  assert.deepEqual(formalProductionBlocked([{ reason: 'offline', chain_ready: false, live_verified: false }]), ['offline']);
  assert.deepEqual(formalProductionBlocked([{ reason: null, chain_ready: true, live_verified: true }]), []);
});
