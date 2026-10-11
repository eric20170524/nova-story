import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { db, initDb } from '../db/database';
import { assetRoutes } from './assets';
import { GenerationService } from '../services/generation_service';
import { SettingsManager } from '../core/settings_manager';
import { persistFormalCandidateResult } from '../services/formal_storyboard_request';

const checks = { wardrobe: true, damage: true, count: true, holder: true, openings: true, space: true };

test('draft generation keeps a legacy shot image and a formal request stays closed', async () => {
  await initDb();
  await db.run("INSERT INTO project (id, title, settings) VALUES (82001, '正式分镜', '{}')");
  await db.run(`INSERT INTO chapter (id, project_id, "index", title) VALUES ('formal-ch', 82001, 1, '章')`);
  const spec = JSON.stringify({
    shot_type: 'Wide Shot',
    shot_intent: 'wide-action',
    visible_subjects: ['南宫雪'],
    location: '清暮宫内殿',
    primary_action: '南宫雪只觉喉间发紧，',
    source: { type: 'script', script_id: 2, script_scene_id: 'sc_1', script_revision: 7 },
  });
  await db.run(
    `INSERT INTO scene (id, chapter_id, "index", visual_prompt, shot_spec, asset_status, asset_url, continuity_status)
     VALUES (9995, 'formal-ch', 3, 'wide', ?, 'completed', '/static/kept.png', 'legacy')`,
    spec
  );
  const originalGenerate = GenerationService.generateAssets;
  const originalSettings = SettingsManager.loadSettings;
  GenerationService.generateAssets = async () => {};
  SettingsManager.loadSettings = () => ({ comfyui: { enabled: true } }) as any;
  const app = Fastify();
  await app.register(assetRoutes, { prefix: '/api/assets' });
  try {
    const draft = await app.inject({
      method: 'POST',
      url: '/api/assets/generate',
      payload: { scene_id: 9995, workflow: { prompt: 'draft' }, mode: 'cinematic_grid', request_key: 'draft-9995' },
    });
    assert.equal(draft.statusCode, 200, draft.body);
    assert.equal(draft.json().production_stage, 'draft');
    assert.equal(draft.json().candidate_version, 2);
    const active = await db.get('SELECT asset_url, active_version, asset_status FROM scene WHERE id = 9995');
    assert.equal(active.asset_url, '/static/kept.png');
    assert.equal(active.active_version, 1);
    assert.equal(active.asset_status, 'completed');
    const candidate = await db.get('SELECT asset_url, asset_status, shot_spec FROM scene_version WHERE scene_id = 9995 AND version = 2');
    assert.equal(candidate.asset_url, null);
    assert.equal(JSON.parse(candidate.shot_spec).formal_request.production_stage, 'draft');
    assert.equal(JSON.parse(candidate.shot_spec).formal_request.control_branch, 'draft_text');

    const replay = await app.inject({
      method: 'POST',
      url: '/api/assets/generate',
      payload: { scene_id: 9995, workflow: { prompt: 'draft' }, mode: 'cinematic_grid', request_key: 'draft-9995' },
    });
    assert.equal(replay.json().task_id, draft.json().task_id);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM scene_version WHERE scene_id = 9995')).n, 2);

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/assets/generate',
      payload: { scene_id: 9995, production_stage: 'production', workflow: { prompt: 'formal' }, request_key: 'formal-9995' },
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().code, 'CONTINUITY_REVISION_CONFLICT');
    await db.run("UPDATE generation_task SET status = 'completed' WHERE task_id = ?", draft.json().task_id);

    const formal = await app.inject({
      method: 'POST',
      url: '/api/assets/generate',
      payload: { scene_id: 9995, production_stage: 'production', workflow: { prompt: 'formal' }, request_key: 'formal-9995' },
    });
    assert.equal(formal.statusCode, 409);
    assert.equal(formal.json().code, 'CONTINUITY_ENTRY_REQUIRED');
    assert.equal((await db.get('SELECT asset_url, active_version FROM scene WHERE id = 9995')).asset_url, '/static/kept.png');

    const again = await app.inject({
      method: 'POST',
      url: '/api/assets/generate',
      payload: { scene_id: 9995, workflow: { prompt: 'another draft' }, request_key: 'draft-9995-b' },
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().candidate_version, 3);
    assert.equal((await db.get('SELECT asset_url FROM scene WHERE id = 9995')).asset_url, '/static/kept.png');

    const referenceHash = JSON.parse((await db.get('SELECT shot_spec FROM scene_version WHERE scene_id = 9995 AND version = 2')).shot_spec).formal_request.reference_hash;
    await db.run(
      "UPDATE scene_version SET asset_status = 'completed', asset_url = '/static/candidate.png' WHERE scene_id = 9995 AND version = 2"
    );
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/assets/formal-decision/9995',
      payload: { expected_version: 2, reference_hash: referenceHash, verdict: 'rejected', checks, note: '脸不像' },
    });
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal((await db.get('SELECT asset_url, active_version FROM scene WHERE id = 9995')).active_version, 1);
    const review = JSON.parse((await db.get('SELECT image_review_json FROM scene_production_frame WHERE scene_id = 9995 AND scene_version = 2')).image_review_json);
    assert.equal(review.verdict, 'rejected');

    const incomplete = await app.inject({
      method: 'POST',
      url: '/api/assets/formal-decision/9995',
      payload: { expected_version: 2, reference_hash: referenceHash, verdict: 'accepted', checks: { ...checks, space: false }, note: '空间不对' },
    });
    assert.equal(incomplete.statusCode, 409);
    assert.equal(incomplete.json().code, 'CONTINUITY_REVIEW_REQUIRED');

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/assets/formal-decision/9995',
      payload: { expected_version: 2, reference_hash: referenceHash, verdict: 'accepted', checks, note: '六项都通过' },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const adopted = await db.get('SELECT asset_url, active_version FROM scene WHERE id = 9995');
    assert.equal(adopted.active_version, 2);
    assert.equal(adopted.asset_url, '/static/candidate.png');
    const master = await db.get('SELECT image_url FROM scene_asset_image_snapshot WHERE scene_id = 9995');
    assert.equal(master.image_url, '/static/candidate.png');
    assert.equal((await db.get('SELECT asset_url FROM scene_version WHERE scene_id = 9995 AND version = 1')).asset_url, '/static/kept.png');
  } finally {
    await app.close();
    GenerationService.generateAssets = originalGenerate;
    SettingsManager.loadSettings = originalSettings;
  }
});

test('a failed formal candidate does not clear the active image', async () => {
  await initDb();
  await db.run("INSERT INTO project (id, title, settings) VALUES (82002, '失败', '{}')");
  await db.run(`INSERT INTO chapter (id, project_id, "index", title) VALUES ('fail-ch', 82002, 1, '章')`);
  await db.run(`INSERT INTO scene (id, chapter_id, "index", asset_status, asset_url, active_version) VALUES (42, 'fail-ch', 1, 'completed', '/static/kept.png', 1)`);
  await db.run(`INSERT INTO scene_version (scene_id, version, label, asset_status, asset_url) VALUES (42, 1, 'v1', 'completed', '/static/kept.png'), (42, 2, 'candidate', 'generating', NULL)`);
  await persistFormalCandidateResult(42, 2, 'task-fail', { asset_status: 'failed' });
  const scene = await db.get('SELECT asset_url, asset_status, active_version FROM scene WHERE id = 42');
  assert.equal(scene.asset_url, '/static/kept.png');
  assert.equal(scene.asset_status, 'completed');
  assert.equal(scene.active_version, 1);
  assert.equal((await db.get('SELECT asset_url, asset_status FROM scene_version WHERE scene_id = 42 AND version = 2')).asset_status, 'failed');
});
