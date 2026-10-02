import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { db, initDb } from '../db/database';
import { assetRoutes } from './assets';
import { GenerationService } from '../services/generation_service';
import { SettingsManager } from '../core/settings_manager';

test('concurrent image submission replays one durable task and rejects a changed request', async () => {
  await initDb();
  await db.run("INSERT INTO project (id,title,settings) VALUES (81201,'重复提交','{}')");
  await db.run(`INSERT INTO chapter (id,project_id,"index",title) VALUES ('idem-image-ch',81201,1,'章')`);
  await db.run(`INSERT INTO scene (id,chapter_id,"index",visual_prompt) VALUES (81211,'idem-image-ch',1,'temple')`);
  const originalGenerate = GenerationService.generateAssets;
  const originalSettings = SettingsManager.loadSettings;
  let submissions = 0;
  GenerationService.generateAssets = async () => { submissions++; };
  SettingsManager.loadSettings = () => ({ comfyui: { enabled: false } }) as any;
  const app = Fastify(); await app.register(assetRoutes, { prefix: '/api/assets' });
  try {
    const payload = { scene_id: 81211, workflow: { prompt: 'temple' }, request_key: 'image-idempotency-test', new_version: true };
    const unavailable = await app.inject({ method: 'POST', url: '/api/assets/generate', payload });
    assert.equal(unavailable.statusCode, 409);
    SettingsManager.loadSettings = () => ({ comfyui: { enabled: false }, image_provider: 'codex' }) as any;
    const responses = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/assets/generate', payload })));
    assert.ok(responses.every(r => r.statusCode === 200));
    assert.equal(responses[0]!.json().task_id, responses[1]!.json().task_id);
    assert.equal(submissions, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM scene_version WHERE scene_id=81211')).count, 2);
    const replay = await app.inject({ method: 'POST', url: '/api/assets/generate', payload });
    assert.equal(replay.json().task_id, responses[0]!.json().task_id);
    const conflict = await app.inject({ method: 'POST', url: '/api/assets/generate', payload: { ...payload, workflow: { prompt: 'different' } } });
    assert.equal(conflict.statusCode, 409); assert.equal(submissions, 1);
  } finally { await app.close(); GenerationService.generateAssets = originalGenerate; SettingsManager.loadSettings = originalSettings; }
});
