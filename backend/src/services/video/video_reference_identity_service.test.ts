import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../db/database';
import type { VideoGenerationRequest } from '../../schemas/video';
import { MediaAssetService } from './media_asset_service';
import { VideoReferenceIdentityService } from './video_reference_identity_service';

const baseRequest = (sceneId: number, refs: number[]): VideoGenerationRequest => ({
  scene_id: sceneId,
  scene_version: 1,
  profile: 'narrative_clip',
  workflow_id: 'minimax_h3_hongchao_a2a_12gb',
  keyframe_asset_id: 0,
  character_reference_asset_ids: refs,
  preset: 'preview_480p_5s',
  run_loop_closer: true
});

test('H3 character references fail closed when one request spans multiple character identities', async () => {
  const projectId = 9931;
  const chapterId = 'video_reference_identity_chapter';
  const sceneId = 99311;
  const characterA = 993101;
  const characterB = 993102;

  await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
  await db.run('DELETE FROM character WHERE id IN (?, ?)', characterA, characterB);
  await db.run('DELETE FROM scene WHERE id = ?', sceneId);
  await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
  await db.run('DELETE FROM project WHERE id = ?', projectId);

  try {
    await db.run('INSERT INTO project (id, title) VALUES (?, ?)', projectId, 'Reference Identity Test');
    await db.run(
      'INSERT INTO chapter (id, project_id, "index", title) VALUES (?, ?, 1, ?)',
      chapterId,
      projectId,
      'Chapter'
    );
    await db.run(
      'INSERT INTO scene (id, chapter_id, "index", visual_prompt) VALUES (?, ?, 1, ?)',
      sceneId,
      chapterId,
      'test'
    );
    await db.run(
      'INSERT INTO character (id, project_id, name) VALUES (?, ?, ?)',
      characterA,
      projectId,
      'Character A'
    );
    await db.run(
      'INSERT INTO character (id, project_id, name) VALUES (?, ?, ?)',
      characterB,
      projectId,
      'Character B'
    );

    const refA1 = await MediaAssetService.createAsset({
      project_id: projectId,
      scene_id: null,
      scene_version: null,
      character_id: characterA,
      media_type: 'image',
      role: 'character_reference',
      status: 'ready',
      url: '/static/generated/ref_a1.png'
    });
    const refA2 = await MediaAssetService.createAsset({
      project_id: projectId,
      scene_id: null,
      scene_version: null,
      character_id: characterA,
      media_type: 'image',
      role: 'character_reference',
      status: 'ready',
      url: '/static/generated/ref_a2.png'
    });
    const refB = await MediaAssetService.createAsset({
      project_id: projectId,
      scene_id: null,
      scene_version: null,
      character_id: characterB,
      media_type: 'image',
      role: 'character_reference',
      status: 'ready',
      url: '/static/generated/ref_b.png'
    });
    const wrongRole = await MediaAssetService.createAsset({
      project_id: projectId,
      scene_id: sceneId,
      scene_version: 1,
      media_type: 'image',
      role: 'video_keyframe',
      status: 'ready',
      url: '/static/generated/keyframe_not_identity.png'
    });
    const unboundManual = await MediaAssetService.createAsset({
      project_id: projectId,
      scene_id: sceneId,
      scene_version: null,
      character_id: null,
      media_type: 'image',
      role: 'character_reference',
      status: 'ready',
      url: '/static/generated/manual_identity.png'
    });

    const mixed = await VideoReferenceIdentityService.validate(
      baseRequest(sceneId, [refA1.id!, refB.id!])
    );
    assert.equal(mixed.character_id, null);
    assert.ok(mixed.blockers.some((blocker) => blocker.includes('multiple identities')));
    assert.ok(mixed.blockers.some((blocker) => blocker.includes(String(characterA))));
    assert.ok(mixed.blockers.some((blocker) => blocker.includes(String(characterB))));

    const sameCharacter = await VideoReferenceIdentityService.validate(
      baseRequest(sceneId, [refA1.id!, refA2.id!, unboundManual.id!])
    );
    assert.deepEqual(sameCharacter.blockers, []);
    assert.equal(sameCharacter.character_id, characterA);

    const roleMismatch = await VideoReferenceIdentityService.validate(
      baseRequest(sceneId, [wrongRole.id!])
    );
    assert.ok(roleMismatch.blockers.some((blocker) => blocker.includes("role is 'video_keyframe'")));
  } finally {
    await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
    await db.run('DELETE FROM character WHERE id IN (?, ?)', characterA, characterB);
    await db.run('DELETE FROM scene WHERE id = ?', sceneId);
    await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
    await db.run('DELETE FROM project WHERE id = ?', projectId);
  }
});
