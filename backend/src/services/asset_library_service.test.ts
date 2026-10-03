import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { db, initDb } from '../db/database';
import { AssetLibraryService } from './asset_library_service';
import { exportAssetLibrary, restoreAssetLibrary } from './asset_library_backup';
import { LLMService } from './llm';
import { assetLibraryRoutes } from '../routes/asset_library';
import { VideoGenerationService } from './video/video_generation_service';
import { VideoGenerationRequestSchema } from '../schemas/video';
import { GenerationService } from './generation_service';
import { AssetTaskStore } from './task_store';

test('asset library: ownership, continuity, durable generation and lifecycle', async t => {
  await initDb();
  await db.run("INSERT INTO project (id,title) VALUES (81101,'资产验收'),(81102,'其他项目'),(81103,'复制项目')");
  await db.run(`INSERT INTO chapter (id,project_id,"index",title,content) VALUES ('asset-ch',81101,1,'铜铃','主角走进山庙，敲响铜铃'),('asset-copy-ch',81103,1,'铜铃','正文')`);
  await db.run(`INSERT INTO scene (id,chapter_id,"index",visual_prompt) VALUES (81111,'asset-ch',1,'temple'),(81113,'asset-copy-ch',1,'temple')`);
  let location: any;
  let prop: any;
  await t.test('locations and props are independent, revision edits invalidate generated appearances', async () => {
    location = await AssetLibraryService.create(81101, { kind: 'location', name: '山庙', description: '木梁石阶', visual_prompt: 'old temple, stone steps' });
    prop = await AssetLibraryService.create(81101, { kind: 'prop', name: '山庙', description: '庙的模型', visual_prompt: 'miniature temple' });
    await assert.rejects(() => AssetLibraryService.create(81101, { kind: 'location', name: '山庙' }), /UNIQUE/);
    await db.run("UPDATE library_asset SET image_url='/static/test.png',status='completed' WHERE id=?", prop.id);
    prop = await AssetLibraryService.update(prop.id, 1, { kind: 'prop', name: '铜铃', description: '旧铜暗绿铜锈', visual_prompt: 'bronze bell, dark green patina' });
    assert.equal(prop.revision, 2); assert.equal(prop.image_url, null);
    await assert.rejects(() => AssetLibraryService.update(prop.id, 1, { kind: 'prop', name: '旧版' }), /changed/);
  });
  await t.test('repeated extraction adds sources without replacing canonical appearances', async () => {
    const original = LLMService.generateStructuredWithRetry;
    try {
      LLMService.generateStructuredWithRetry = async (prompt: any, schema: any) => {
        assert.match(prompt, /已有资产是名称和外观的准绳/);
        assert.match(prompt, /bronze bell, dark green patina/);
        assert.match(prompt, /old temple, stone steps/);
        assert.match(prompt, /不同实体不能仅因/);
        return schema.parse({ assets: [
        { kind: 'location', name: '山庙', description: '模型想改成金殿', visual_prompt: 'golden palace' },
        { kind: 'prop', name: '铜铃', description: '模型想改成银铃', visual_prompt: 'silver bell' },
      ] }); };
      await AssetLibraryService.extract('asset-ch');
      const baseMock = LLMService.generateStructuredWithRetry;
      LLMService.generateStructuredWithRetry = async (...args: any[]) => {
        assert.match(args[0], /本次提取补充要求：铜铃和红绳分别提取/);
        return (baseMock as any)(...args);
      };
      await AssetLibraryService.extract('asset-ch', '铜铃和红绳分别提取');
      const rows = await AssetLibraryService.list(81101);
      assert.equal(rows.length, 2); assert.equal(rows.find(r => r.id === prop.id)?.visual_prompt, 'bronze bell, dark green patina');
      assert.deepEqual(JSON.parse(rows[0]!.source_chapter_ids), ['asset-ch']);
      LLMService.generateStructuredWithRetry = async (_prompt: any, schema: any) => {
        await db.run("UPDATE chapter SET content='改稿' WHERE id='asset-ch'");
        return schema.parse({ assets: [{ kind: 'prop', name: '不应保存' }] });
      };
      await assert.rejects(() => AssetLibraryService.extract('asset-ch'), /changed/);
      assert.equal((await AssetLibraryService.list(81101)).length, 2);
    } finally { LLMService.generateStructuredWithRetry = original; }
  });
  await t.test('binding rejects foreign-project and unfinished assets atomically, referenced assets cannot be deleted', async () => {
    const foreign = await AssetLibraryService.create(81102, { kind: 'prop', name: '外部道具' });
    await assert.rejects(() => AssetLibraryService.bind(81111, [location.id]), /Generate/);
    await db.run("UPDATE library_asset SET status='completed',image_url='/static/asset.png' WHERE project_id=81101");
    await AssetLibraryService.bind(81111, [location.id, prop.id]);
    await assert.rejects(() => AssetLibraryService.bind(81111, [foreign.id]), /Cross-project/);
    assert.equal((await AssetLibraryService.references(81111)).length, 2);
    await assert.rejects(() => AssetLibraryService.remove(prop.id), /referenced/);
    prop = await AssetLibraryService.update(prop.id, prop.revision, { kind: 'prop', name: '铜铃', visual_prompt: 'bronze bell with red tassel' });
    assert.equal((await AssetLibraryService.references(81111)).find(r => r.id === prop.id)?.stale, 1);
  });
  await t.test('video preflight rejects changed appearances and keyframes made before asset binding', async () => {
    const oldGate = process.env.NOVASTORY_ENABLE_VIDEO; process.env.NOVASTORY_ENABLE_VIDEO = 'true';
    try {
      await db.run("UPDATE scene SET asset_url='/static/frame.png' WHERE id=81111");
      const input = VideoGenerationRequestSchema.parse({ scene_id: 81111, workflow_id: 'minimax_h3_ref2va_official_12gb' });
      const stale = await VideoGenerationService.preflight(input);
      assert.ok(stale.blockers.some(b => b.includes('铜铃') && b.includes('changed')));
      assert.ok(stale.blockers.some(b => b.includes('does not reflect')));
      await db.run("UPDATE library_asset SET status='completed',image_url='/static/asset2.png' WHERE id=?", prop.id);
      await AssetLibraryService.bind(81111, [location.id, prop.id]);
      await db.run('INSERT INTO scene_asset_image_snapshot (scene_id,image_url,references_json) VALUES (?,?,?)', 81111, '/static/frame.png', JSON.stringify([{ id: location.id, revision: location.revision }, { id: prop.id, revision: prop.revision }]));
      const current = await VideoGenerationService.preflight(input);
      assert.ok(!current.blockers.some(b => b.includes('does not reflect') || b.includes('铜铃')));
    } finally { if (oldGate == null) delete process.env.NOVASTORY_ENABLE_VIDEO; else process.env.NOVASTORY_ENABLE_VIDEO = oldGate; }
  });
  await t.test('backup restores assets and references with new IDs and preserves image provenance', async () => {
    const bundle = await exportAssetLibrary(81101);
    await restoreAssetLibrary(bundle, 81103, new Map([['asset-ch', 'asset-copy-ch']]), new Map([['81111', 81113]]));
    const copied = await AssetLibraryService.list(81103);
    assert.equal(copied.length, 2); assert.ok(copied.every(a => a.id !== prop.id && a.id !== location.id));
    const refs = await AssetLibraryService.references(81113);
    assert.equal(refs.length, 2); assert.ok(refs.every(r => r.project_id === 81103 && !r.stale));
    const snapshot = await db.get('SELECT references_json FROM scene_asset_image_snapshot WHERE scene_id=81113');
    assert.deepEqual(JSON.parse(snapshot.references_json).map((r: any) => r.id).sort(), copied.map(a => a.id).sort());
    assert.deepEqual(JSON.parse(copied[0]!.source_chapter_ids), ['asset-copy-ch']);
  });
  await t.test('durable task status updates reusable assets and prevents a simultaneous second generation', async () => {
    const original = GenerationService.generateAssets;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    try {
      GenerationService.generateAssets = async (taskId, _workflow, sceneId) => { await wait; await AssetTaskStore.completed(taskId, sceneId, '/static/generated/library-test.png'); };
      await AssetLibraryService.bind(81111, []);
      const started = await AssetLibraryService.generate(prop.id);
      await assert.rejects(() => AssetLibraryService.generate(prop.id), /already generating/);
      assert.equal((await AssetLibraryService.requireAsset(prop.id)).status, 'generating');
      release();
      for (let i = 0; i < 40 && (await AssetLibraryService.requireAsset(prop.id)).status === 'generating'; i++) await new Promise(resolve => setTimeout(resolve, 5));
      const generated = await AssetLibraryService.requireAsset(prop.id);
      assert.equal(generated.status, 'completed'); assert.equal(generated.image_url, '/static/generated/library-test.png');
      assert.equal(generated.task_id, started.task_id); assert.equal(generated.revision, prop.revision + 1);
    } finally { release(); GenerationService.generateAssets = original; }
  });
  await t.test('HTTP routes validate requests and surface revision conflicts', async () => {
    const app = Fastify(); await app.register(assetLibraryRoutes, { prefix: '/api' });
    try {
      const listed = await app.inject('/api/projects/81101/asset-library'); assert.equal(listed.statusCode, 200);
      const stale = await app.inject({ method: 'PUT', url: `/api/asset-library/${prop.id}`, payload: { expected_revision: 1, asset: { kind: 'prop', name: '铜铃' } } });
      assert.equal(stale.statusCode, 409);
      const foreign = await app.inject({ method: 'PUT', url: '/api/timeline/scenes/81111/asset-references', payload: { asset_ids: [999999999] } });
      assert.equal(foreign.statusCode, 404);
    } finally { await app.close(); }
  });
});
