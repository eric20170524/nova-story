import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../../db/database';
import { getGeneratedDirectory } from '../../core/paths';
import { MediaAssetService } from './media_asset_service';

test('MediaAssetService resolves a final derivative back to its raw parent', async () => {
  const projectId = 9911;
  const chapterId = 'video_asset_lineage_chapter';
  const sceneId = 99111;

  await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
  await db.run('DELETE FROM scene WHERE id = ?', sceneId);
  await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
  await db.run('DELETE FROM project WHERE id = ?', projectId);

  await db.run('INSERT INTO project (id, title) VALUES (?, ?)', projectId, 'Video Lineage Test');
  await db.run('INSERT INTO chapter (id, project_id, "index", title) VALUES (?, ?, 1, ?)', chapterId, projectId, 'Chapter');
  await db.run('INSERT INTO scene (id, chapter_id, "index", visual_prompt) VALUES (?, ?, 1, ?)', sceneId, chapterId, 'test');

  const raw = await MediaAssetService.createAsset({
    project_id: projectId,
    scene_id: sceneId,
    scene_version: 1,
    media_type: 'video',
    role: 'raw_video',
    profile: 'character_loop',
    status: 'ready',
    url: `/static/generated/videos/${projectId}/${sceneId}/raw.mp4`
  });
  const final = await MediaAssetService.createAsset({
    project_id: projectId,
    scene_id: sceneId,
    scene_version: 1,
    parent_asset_id: raw.id,
    media_type: 'video',
    role: 'loop_master',
    profile: 'character_loop',
    status: 'draft',
    url: `/static/generated/videos/${projectId}/${sceneId}/final.mp4`
  });

  const resolved = await MediaAssetService.resolveRawVideoForReprocess(final.id!);
  assert.equal(resolved.id, raw.id);
  assert.equal(resolved.role, 'raw_video');

  await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
  await db.run('DELETE FROM scene WHERE id = ?', sceneId);
  await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
  await db.run('DELETE FROM project WHERE id = ?', projectId);
});

test('MediaAssetService refuses to promote rejected final candidates', async () => {
  const projectId = 9912;
  const chapterId = 'video_asset_rejected_chapter';
  const sceneId = 99121;

  await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
  await db.run('DELETE FROM scene WHERE id = ?', sceneId);
  await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
  await db.run('DELETE FROM project WHERE id = ?', projectId);

  await db.run('INSERT INTO project (id, title) VALUES (?, ?)', projectId, 'Rejected Candidate Test');
  await db.run('INSERT INTO chapter (id, project_id, "index", title) VALUES (?, ?, 1, ?)', chapterId, projectId, 'Chapter');
  await db.run('INSERT INTO scene (id, chapter_id, "index", visual_prompt) VALUES (?, ?, 1, ?)', sceneId, chapterId, 'test');

  const asset = await MediaAssetService.createAsset({
    project_id: projectId,
    scene_id: sceneId,
    scene_version: 1,
    media_type: 'video',
    role: 'loop_master',
    profile: 'character_loop',
    status: 'rejected',
    url: `/static/generated/videos/${projectId}/${sceneId}/rejected.mp4`
  });

  await assert.rejects(() => MediaAssetService.promoteAsset(asset.id!), /Cannot promote a rejected video asset/);
  await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
  await db.run('DELETE FROM scene WHERE id = ?', sceneId);
  await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
  await db.run('DELETE FROM project WHERE id = ?', projectId);
});

test('MediaAssetService can stage a reference through the remote Comfy HTTP input transport', async () => {
  const generatedDir = getGeneratedDirectory();
  fs.mkdirSync(generatedDir, { recursive: true });
  const sourcePath = path.join(generatedDir, 'remote_transport_ref.png');
  fs.writeFileSync(sourcePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const originalFetch = global.fetch;
  const originalTransport = process.env.NOVASTORY_COMFY_REFERENCE_TRANSPORT;
  process.env.NOVASTORY_COMFY_REFERENCE_TRANSPORT = 'http';

  let uploadedFilename = '';
  global.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData;
    const file = form.get('image') as any;
    uploadedFilename = String(file?.name || '');
    return new Response(JSON.stringify({
      name: uploadedFilename,
      subfolder: 'novastory',
      type: 'input'
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  let stagedPath = '';
  try {
    const staged = await MediaAssetService.stageAssetForComfy({
      id: 991299,
      project_id: 9912,
      scene_id: 99121,
      scene_version: 1,
      media_type: 'image',
      role: 'character_reference',
      status: 'ready',
      url: '/static/generated/remote_transport_ref.png',
      mime_type: 'image/png'
    });
    stagedPath = staged.stagedPath;

    assert.ok(uploadedFilename.endsWith('_remote_transport_ref.png'));
    assert.equal(staged.stagedFilename, `novastory/${uploadedFilename}`);
    assert.equal(fs.existsSync(staged.stagedPath), true);
  } finally {
    global.fetch = originalFetch;
    if (originalTransport == null) delete process.env.NOVASTORY_COMFY_REFERENCE_TRANSPORT;
    else process.env.NOVASTORY_COMFY_REFERENCE_TRANSPORT = originalTransport;
    try { fs.unlinkSync(sourcePath); } catch {}
    if (stagedPath) {
      try { fs.unlinkSync(stagedPath); } catch {}
    }
  }
});

test('Character Center images become reusable no-copy MediaAsset references idempotently', async () => {
  const projectId = 9913;
  const chapterId = 'character_ref_adapter_chapter';
  const sceneId = 99131;
  const characterId = 991301;
  const generatedDir = getGeneratedDirectory();
  fs.mkdirSync(generatedDir, { recursive: true });

  const faceFilename = 'character_adapter_face.png';
  const turnaroundFilename = 'character_adapter_turnaround.png';
  const facePath = path.join(generatedDir, faceFilename);
  const turnaroundPath = path.join(generatedDir, turnaroundFilename);
  fs.writeFileSync(facePath, Buffer.from('face-reference'));
  fs.writeFileSync(turnaroundPath, Buffer.from('turnaround-reference'));

  const faceUrl = `/static/generated/${faceFilename}`;
  const turnaroundUrl = `/static/generated/${turnaroundFilename}`;

  try {
    await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
    await db.run('DELETE FROM character WHERE id = ?', characterId);
    await db.run('DELETE FROM scene WHERE id = ?', sceneId);
    await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
    await db.run('DELETE FROM project WHERE id = ?', projectId);

    await db.run('INSERT INTO project (id, title) VALUES (?, ?)', projectId, 'Character Adapter Test');
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
      `INSERT INTO character (id, project_id, name, visual_tags)
       VALUES (?, ?, ?, ?)`,
      characterId,
      projectId,
      'Adapter Hero',
      JSON.stringify({
        assets: {
          face_url: faceUrl,
          // Same physical image exposed through two Character Center slots must not
          // create duplicate MediaAsset rows.
          avatar_url: faceUrl,
          turnaround_url: turnaroundUrl
        }
      })
    );

    const sceneGlobalMotion = await MediaAssetService.createAsset({
      project_id: projectId,
      scene_id: sceneId,
      scene_version: null,
      media_type: 'video',
      role: 'motion_reference',
      status: 'ready',
      url: '/static/generated/scene_global_motion.mp4',
      mime_type: 'video/mp4'
    });

    const first = await MediaAssetService.listSceneContextAssets(sceneId, 1);
    assert.ok(
      first.some((asset) => asset.id === sceneGlobalMotion.id),
      'scene-global references with scene_version=NULL must remain visible for versioned scene loads'
    );

    const refs = first.filter((asset) => asset.role === 'character_reference');
    assert.equal(refs.length, 2);
    assert.deepEqual(new Set(refs.map((asset) => asset.url)), new Set([faceUrl, turnaroundUrl]));
    assert.ok(refs.every((asset) => asset.project_id === projectId));
    assert.ok(refs.every((asset) => asset.character_id === characterId));
    assert.ok(refs.every((asset) => asset.scene_id == null));
    assert.ok(refs.every((asset) => asset.status === 'ready'));
    for (const asset of refs) {
      const metadata = JSON.parse(asset.metadata_json || '{}');
      assert.equal(metadata.source, 'character_center_adapter');
      assert.equal(metadata.no_copy, true);
    }

    const firstIds = refs.map((asset) => asset.id).sort();
    const second = await MediaAssetService.listSceneContextAssets(sceneId, 1);
    const secondIds = second
      .filter((asset) => asset.role === 'character_reference')
      .map((asset) => asset.id)
      .sort();
    assert.deepEqual(secondIds, firstIds, 'repeated scene loads must reuse MediaAsset identities');

    // Character Center changed: the old face becomes stale while the existing
    // turnaround becomes the only active identity. The adapter archives only its own
    // stale row instead of deleting/copying physical assets.
    await db.run(
      'UPDATE character SET visual_tags = ? WHERE id = ?',
      JSON.stringify({ assets: { face_url: turnaroundUrl } }),
      characterId
    );
    const afterChange = await MediaAssetService.listSceneContextAssets(sceneId, 1);
    const activeRefs = afterChange.filter((asset) => asset.role === 'character_reference');
    assert.equal(activeRefs.length, 1);
    assert.equal(activeRefs[0]!.url, turnaroundUrl);

    const archived = await db.get(
      `SELECT COUNT(*) AS count
       FROM media_asset
       WHERE project_id = ? AND character_id = ?
         AND role = 'character_reference' AND status = 'archived'`,
      projectId,
      characterId
    );
    assert.equal(Number(archived?.count || 0), 1);
  } finally {
    await db.run('DELETE FROM media_asset WHERE project_id = ?', projectId);
    await db.run('DELETE FROM character WHERE id = ?', characterId);
    await db.run('DELETE FROM scene WHERE id = ?', sceneId);
    await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
    await db.run('DELETE FROM project WHERE id = ?', projectId);
    try { fs.unlinkSync(facePath); } catch {}
    try { fs.unlinkSync(turnaroundPath); } catch {}
  }
});
