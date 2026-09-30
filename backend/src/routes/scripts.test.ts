import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { db, initDb } from '../db/database';
import { scriptRoutes } from './scripts';
import type { ScriptDocument } from '../schemas/script';

test('Track 5 S1-BE: Fastify /api/chapters/:id/script and /api/scripts routes', async (t) => {
  await initDb();

  const app = Fastify();
  await app.register(scriptRoutes, { prefix: '/api' });
  await app.ready();

  const projId = Number(`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-8));
  await db.run(
    `INSERT INTO project (id, title, description, settings, user_id)
     VALUES (?, 'Route测试项目', '用于测试脚本API', '{}', 'test_user')`,
    projId
  );

  const chapterId = `ch_api_${projId}`;
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, '第1章 路由测试', '小说正文在此。', '摘要', 'draft')`,
    chapterId,
    projId
  );

  let scriptId: number;

  await t.test('GET /api/chapters/:chapterId/script returns exists=false before creation', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/chapters/${chapterId}/script`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.exists, false);
    assert.equal(body.script, null);
  });

  await t.test('POST /api/chapters/:chapterId/script creates initial script', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/script`,
      payload: { title: '测试短剧第一集' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.script);
    assert.equal(body.script.revision, 1);
    assert.equal(body.script.status, 'draft');
    assert.equal(body.script.document.title, '测试短剧第一集');
    scriptId = body.script.id;
  });

  await t.test('GET /api/chapters/:chapterId/script returns created script', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/chapters/${chapterId}/script`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.exists, true);
    assert.equal(body.script.id, scriptId);
  });

  await t.test('PUT /api/scripts/:scriptId validates expected_revision and saves', async () => {
    // 1. Revision conflict with wrong expected_revision
    const conflictRes = await app.inject({
      method: 'PUT',
      url: `/api/scripts/${scriptId}`,
      payload: {
        document: {
          schemaVersion: 1,
          title: '冲突测试',
          targetDurationSec: 120,
          outline: { logline: '', mustKeepEvents: [], beats: [], endingHook: '' },
          locations: [],
          props: [],
          scenes: [],
        },
        expected_revision: 999,
      },
    });
    assert.equal(conflictRes.statusCode, 409);

    // 2. Successful save with correct expected_revision 1
    const validDoc: ScriptDocument = {
      schemaVersion: 1,
      title: '修改后的剧本',
      targetDurationSec: 120,
      outline: {
        logline: '主角遭遇危机',
        mustKeepEvents: [{ id: 'e1', text: '危机降临', sourceParagraphIds: [] }],
        beats: [{ id: 'b1', purpose: '铺垫', eventIds: ['e1'] }],
        endingHook: '命悬一线',
      },
      locations: [{ id: 'loc1', name: '破庙', description: '' }],
      props: [],
      scenes: [
        {
          id: 'sc1',
          beatIds: ['b1'],
          eventIds: ['e1'],
          sourceParagraphIds: [],
          locationId: 'loc1',
          interiorExterior: 'interior',
          timeOfDay: '夜',
          characterIds: [],
          propIds: [],
          blocks: [
            { id: 'blk1', type: 'action', text: '大雨倾盆。' },
            { id: 'blk2', type: 'voiceover', characterId: null, text: '暴风雨来了。' },
          ],
        },
      ],
    };

    const saveRes = await app.inject({
      method: 'PUT',
      url: `/api/scripts/${scriptId}`,
      payload: {
        document: validDoc,
        expected_revision: 1,
      },
    });
    assert.equal(saveRes.statusCode, 200);
    const saveBody = JSON.parse(saveRes.body);
    assert.equal(saveBody.script.revision, 2);
    assert.equal(saveBody.script.document.title, '修改后的剧本');
  });

  await t.test('POST /api/scripts/:scriptId/confirm confirms revision 2', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/scripts/${scriptId}/confirm`,
      payload: {
        expected_revision: 2,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.script.status, 'confirmed');
    assert.equal(body.script.revision, 3);
  });

  await t.test('POST /api/scripts/:scriptId/restore restores previous revision', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/scripts/${scriptId}/restore`,
      payload: {
        expected_revision: 3,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.script.status, 'draft');
    assert.equal(body.script.revision, 4);
  });

  await t.test('POST /api/scripts/:scriptId/refresh-source explicitly updates snapshot and increments revision', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/scripts/${scriptId}/refresh-source`,
      payload: {
        expected_revision: 4,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.script.revision, 5);
    assert.equal(body.script.freshness.sourceChanged, false);
  });

  await t.test('GET /api/scripts/:scriptId/export returns markdown', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/scripts/${scriptId}/export?format=markdown`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.format, 'markdown');
    assert.ok(body.markdown.includes('测试短剧第一集'));
  });

  await t.test('Candidate API lifecycle: create, update, discard', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/scripts/${scriptId}/candidates`,
      payload: {
        kind: 'outline',
        expected_revision: 5,
        request_key: 'req_api_cand_1',
        after_json: JSON.stringify({ logline: 'API测试提纲' }),
      },
    });
    assert.equal(createRes.statusCode, 201);
    const cand = JSON.parse(createRes.body).candidate;
    assert.equal(cand.state, 'pending');

    // Update candidate
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/scripts/${scriptId}/candidates/${cand.id}`,
      payload: {
        expected_revision: 5,
        after_json: JSON.stringify({ logline: '更新后的API提纲' }),
      },
    });
    assert.equal(updateRes.statusCode, 200);
    const updatedCand = JSON.parse(updateRes.body).candidate;
    assert.ok(updatedCand.after_json.includes('更新后的API提纲'));

    // Discard candidate
    const discardRes = await app.inject({
      method: 'POST',
      url: `/api/scripts/${scriptId}/candidates/${cand.id}/discard`,
    });
    assert.equal(discardRes.statusCode, 200);
    const discardedCand = JSON.parse(discardRes.body).candidate;
    assert.equal(discardedCand.state, 'discarded');
  });

  await t.test('POST /api/scripts/:scriptId/storyboard-candidates validation and error handling', async () => {
    // Attempting to generate storyboard for draft script returns 400
    const res = await app.inject({
      method: 'POST',
      url: `/api/scripts/${scriptId}/storyboard-candidates`,
      payload: {
        expected_revision: 5,
        request_key: 'req_sb_test_1',
      },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.detail.includes('只有已确认'));
  });

  await t.test('POST /api/scripts/:scriptId/storyboard-candidates/:changeId/apply error handling', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/scripts/${scriptId}/storyboard-candidates/nonexistent_change_id/apply`,
      payload: {
        expected_revision: 5,
      },
    });
    // Candidate not found returns 404 or 400
    assert.ok(res.statusCode === 400 || res.statusCode === 404);
  });

  await app.close();
});
