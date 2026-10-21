import assert from 'node:assert/strict';
import test from 'node:test';
import { identityReferenceBlockers, platesFromVisualTags } from './video_identity_plates';

test('video identity refs must be the pinned face and body plates', () => {
  assert.deepEqual(
    platesFromVisualTags({ assets: { avatar_url: '/face.png', turnaround_front_url: '/body.png', turnaround_url: '/sheet.png' } }),
    { face: '/face.png', body: '/body.png' },
  );
  assert.deepEqual(platesFromVisualTags({}), { face: null, body: null });
  assert.deepEqual(identityReferenceBlockers(3, { face: null, body: null }, [{ url: '/upload.png' }]), []);

  const plates = { face: '/face.png', body: '/body.png' };
  assert.deepEqual(identityReferenceBlockers(5, plates, [
    { url: '/face.png', metadata_json: JSON.stringify({ source_slot: 'face' }) },
    { url: '/body.png', metadata_json: JSON.stringify({ source_slot: 'body' }) },
  ]), []);

  const sheet = identityReferenceBlockers(5, plates, [
    { url: '/sheet.png', metadata_json: JSON.stringify({ source_slot: 'body' }) },
  ]);
  assert.equal(sheet.length, 1);
  assert.match(sheet[0] || '', /视频人物参考必须是角色版本 v5 的定妆和正面单人图。/);

  const faceOnly = identityReferenceBlockers(5, plates, [
    { url: '/face.png', metadata_json: JSON.stringify({ source_slot: 'face' }) },
  ]);
  assert.match(faceOnly[0] || '', /v5/);
});
