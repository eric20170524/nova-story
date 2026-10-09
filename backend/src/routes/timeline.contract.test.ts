import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { db, initDb } from '../db/database';
import { timelineRoutes } from './timeline';
import { packShotSpec } from '../schemas/shot_contract';
import { draftEnglishFromCues, setVisualPromptTranslatorForTests, setVisualPromptVerifierForTests } from '../services/english_visual_prompt';

test('正文直写入口返回 410，保留现有镜头', async () => {
  await initDb();
  const project = await db.run("INSERT INTO project(title) VALUES('直写停用验收')");
  const chapterId = 'direct-write-disabled';
  await db.run('INSERT INTO chapter(id,project_id,"index",title,content) VALUES(?,?,1,?,?)', chapterId, project.lastID, '验收', '林岚离开，陈月留下。她举起蓝伞。');
  const scene = await db.run('INSERT INTO scene(chapter_id,"index",visual_prompt) VALUES(?,1,?)', chapterId, 'Existing verified shot.');
  const app = Fastify(); await app.register(timelineRoutes, { prefix: '/api/timeline' });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/timeline/generate', payload: { chapter_id: chapterId } });
    assert.equal(response.statusCode, 410); assert.match(response.json().detail, /直写时间线已停用/);
    assert.equal((await db.get('SELECT visual_prompt FROM scene WHERE id=?', scene.lastID)).visual_prompt, 'Existing verified shot.');
  } finally { await app.close(); }
});

test('Director scene edit canonicalizes a shot contract without changing screenplay provenance', async () => {
  await initDb();
  const projectId = 89901;
  const chapterId = 'contract-edit-chapter';
  const sceneId = 89911;
  const source = { type: 'script' as const, script_id: 9, script_revision: 2, script_scene_id: 'scene_1', block_ids: ['b_1'] };
  await db.run('INSERT INTO project (id,title) VALUES (?,?)', projectId, 'Contract edit');
  await db.run('INSERT INTO chapter (id,project_id,"index",title) VALUES (?,?,1,?)', chapterId, projectId, 'Chapter');
  const oldSpec = packShotSpec({ location: '场景：石井台', primary_action: '主角走到井边', key_props: ['道具：旧铜铃'], source });
  await db.run('INSERT INTO scene (id,chapter_id,"index",visual_prompt,shot_spec) VALUES (?,?,1,?,?)', sceneId, chapterId, 'old prompt', oldSpec);
  const app = Fastify();
  await app.register(timelineRoutes, { prefix: '/api/timeline' });
  setVisualPromptTranslatorForTests(async (prompt) => draftEnglishFromCues(prompt) || 'adult figures, visible action preserved');
  setVisualPromptVerifierForTests(async (facts, english) => ({ facts: facts.map((_, id) => ({ id, status: 'preserved', evidence: english })) }));
  try {
    const nextSpec = packShotSpec({ location: '石井台', primary_action: '主角走到井边', key_props: ['旧铜铃'], source });
    const edited = await app.inject({ method: 'PUT', url: `/api/timeline/scene/${sceneId}`, payload: { shot_spec: nextSpec } });
    assert.equal(edited.statusCode, 200);
    const saved = JSON.parse(edited.body);
    assert.equal(JSON.parse(saved.shot_spec).location, '石井台');
    assert.equal(JSON.parse(saved.shot_spec).primary_action, '主角走到井边');
    assert.doesNotMatch(saved.visual_prompt, /[\u3400-\u9fff]/);
    assert.doesNotMatch(saved.visual_prompt, /场景：/);
    assert.match(saved.visual_prompt, /adult figures, visible action preserved/);

    const wrongSource = packShotSpec({ location: '药屋', primary_action: '主角走到井边', source: { ...source, block_ids: ['b_2'] } });
    const rejected = await app.inject({ method: 'PUT', url: `/api/timeline/scene/${sceneId}`, payload: { shot_spec: wrongSource } });
    assert.equal(rejected.statusCode, 409);
    await db.run("UPDATE scene SET asset_url='/static/rendered.png' WHERE id=?", sceneId);
    const rendered = await app.inject({ method: 'PUT', url: `/api/timeline/scene/${sceneId}`, payload: { shot_spec: nextSpec } });
    assert.equal(rendered.statusCode, 409);
  } finally {
    setVisualPromptTranslatorForTests(null);
    setVisualPromptVerifierForTests(null);
    await app.close();
    await db.run('DELETE FROM scene WHERE id=?', sceneId);
    await db.run('DELETE FROM chapter WHERE id=?', chapterId);
    await db.run('DELETE FROM project WHERE id=?', projectId);
  }
});
