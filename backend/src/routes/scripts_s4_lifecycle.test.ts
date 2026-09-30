import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { db, initDb } from '../db/database';
import { scriptRoutes } from './scripts';
import { projectRoutes } from './projects';
import { chapterRoutes } from './chapters';
import { timelineRoutes } from './timeline';
import { projectImportRoutes } from './project_import';
import { ScriptService } from '../services/script_service';
import type { ScriptDocument } from '../schemas/script';
import { packShotSpec } from '../schemas/shot_contract';

const createMultipartPayload = async (filename: string, content: string) => {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'application/json' }), filename);
  const request = new Request('http://localhost/api/projects/import/commit', {
    method: 'POST',
    body: form,
  });
  return {
    headers: Object.fromEntries(request.headers.entries()),
    payload: Buffer.from(await request.arrayBuffer()),
  };
};

test('Track 5 S4: Lifecycle, Cascade Deletion, Project Duplicate, JSON Export/Import & SC11 Outdated Source', async (t) => {
  await initDb();

  const app = Fastify();
  await app.register(multipart);
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(chapterRoutes, { prefix: '/api/chapters' });
  await app.register(scriptRoutes, { prefix: '/api' });
  await app.register(timelineRoutes, { prefix: '/api/timeline' });
  await app.register(projectImportRoutes, { prefix: '/api/projects' });
  await app.ready();

  const timestamp = Date.now();
  const projId = Number(`${timestamp}${Math.floor(Math.random() * 1000)}`.slice(-8));

  await db.run(
    `INSERT INTO project (id, title, description, settings, user_id)
     VALUES (?, 'S4测试项目', 'S4整链备份恢复测试', '{}', 'local_admin')`,
    projId
  );

  const charRes = await db.run(
    `INSERT INTO character (project_id, name, role, description, visual_tags)
     VALUES (?, '林夏', 'protagonist', '年轻女摄影师', '{}')`,
    projId
  );
  const charId = Number(charRes.lastID);

  const chapterId = `ch_s4_${projId}`;
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, '第1章 雨夜偶遇', '雨夜的咖啡馆，门口铃声响起。林夏收起相机。', '偶遇开端', 'draft')`,
    chapterId,
    projId
  );

  // 1. Initialize script
  const scriptDoc: ScriptDocument = {
    schemaVersion: 1,
    title: '雨夜偶遇 短剧版',
    targetDurationSec: 120,
    outline: {
      logline: '摄影师在雨夜避雨时偶遇神秘人',
      mustKeepEvents: [
        { id: 'ev_1', text: '林夏收起相机避雨', sourceParagraphIds: ['p_1'] }
      ],
      beats: [
        { id: 'b_1', purpose: '入场建立氛围', eventIds: ['ev_1'] }
      ],
      endingHook: '门铃突然再次响起'
    },
    locations: [
      { id: 'loc_cafe', name: '街角咖啡馆', description: '昏暗温暖' }
    ],
    props: [
      { id: 'prop_cam', name: '复古胶卷相机', description: '带划痕' }
    ],
    scenes: [
      {
        id: 'sc_1',
        beatIds: ['b_1'],
        eventIds: ['ev_1'],
        sourceParagraphIds: ['p_1'],
        locationId: 'loc_cafe',
        interiorExterior: 'interior',
        timeOfDay: 'night',
        characterIds: [charId],
        propIds: ['prop_cam'],
        blocks: [
          { id: 'blk_1', type: 'action', text: '雨滴猛烈敲击窗户，林夏坐在窗边小心擦拭镜头。' },
          { id: 'blk_2', type: 'dialogue', characterId: charId, text: '这场雨不知要下多久。', delivery: '轻声自语' },
          { id: 'blk_3', type: 'sound', text: '门口铜铃清脆声响' }
        ],
        estimatedDurationSec: 15
      }
    ]
  };

  const initialScript = await ScriptService.createOrGetScript(chapterId, '雨夜偶遇 短剧版');
  const savedScript = await ScriptService.saveManualScript({
    scriptId: initialScript.id,
    document: scriptDoc,
    expectedRevision: 1
  });
  const confirmedScript = await ScriptService.confirmScript({
    scriptId: savedScript.id,
    expectedRevision: 2
  });

  const scriptId = confirmedScript.id;

  // Add a shot in timeline linked to this script
  const shotSpec = packShotSpec({
    shot_type: 'close_up',
    source: {
      type: 'script',
      script_id: scriptId,
      script_revision: confirmedScript.revision,
      script_scene_id: 'sc_1',
      block_ids: ['blk_1', 'blk_2']
    }
  });

  const sceneRes = await db.run(
    `INSERT INTO scene (
      chapter_id, "index", visual_prompt, audio_prompt, dialogue, narration,
      duration, shot_type, camera_movement, camera_angle, shot_spec, asset_status, active_version
    ) VALUES (?, 1, ?, 'rain sound', '这场雨不知要下多久。', null, 3, 'close_up', 'static', 'eye_level', ?, 'idle', 1)`,
    chapterId,
    'score_9, 1girl, wiping camera lens',
    shotSpec
  );
  const sceneId = Number(sceneRes.lastID);

  await t.test('SC11 Part 4: Timeline returns script metadata and detects outdated source when script advances', async () => {
    // Current script revision is 3 (confirmed revision)
    // Scene shot_spec was created with script_revision = 3
    const res1 = await app.inject({
      method: 'GET',
      url: `/api/timeline/${chapterId}`
    });
    assert.equal(res1.statusCode, 200);
    const body1 = JSON.parse(res1.body);
    assert.ok(body1.script);
    assert.equal(body1.script.revision, 3);
    assert.equal(body1.script.status, 'confirmed');

    // Advance script revision by making another manual edit
    const modifiedDoc = JSON.parse(JSON.stringify(scriptDoc));
    modifiedDoc.title = '雨夜偶遇 (修订稿)';
    const advancedScript = await ScriptService.saveManualScript({
      scriptId,
      document: modifiedDoc,
      expectedRevision: 3
    });
    assert.equal(advancedScript.revision, 4);

    // Timeline now reports script revision = 4, while scene has script_revision = 3 -> outdated!
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/timeline/${chapterId}`
    });
    assert.equal(res2.statusCode, 200);
    const body2 = JSON.parse(res2.body);
    assert.equal(body2.script.revision, 4);

    const shot = body2.timeline[0];
    const parsedShotSpec = JSON.parse(shot.shot_spec);
    assert.equal(parsedShotSpec.source.script_revision, 3);
    assert.ok(parsedShotSpec.source.script_revision < body2.script.revision, 'Shot script source is outdated');
  });

  await t.test('SC11 Part 2: Project duplicate clones scripts, remapping character IDs and shot_spec script_id', async () => {
    const dupRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${projId}/duplicate`,
      payload: { title: 'S4测试项目（副本）' }
    });
    assert.equal(dupRes.statusCode, 201);
    const dupBody = JSON.parse(dupRes.body);
    assert.ok(dupBody.project);
    assert.equal(dupBody.counts.scripts, 1);
    assert.equal(dupBody.counts.chapters, 1);
    assert.equal(dupBody.counts.characters, 1);
    assert.equal(dupBody.counts.scenes, 1);

    const newProjId = dupBody.project.id;
    assert.notEqual(newProjId, projId);

    // Verify duplicated character
    const newChars = await db.all('SELECT * FROM character WHERE project_id = ?', newProjId);
    assert.equal(newChars.length, 1);
    const newCharId = newChars[0].id;
    assert.notEqual(newCharId, charId);

    // Verify duplicated chapter
    const newChapters = await db.all('SELECT * FROM chapter WHERE project_id = ?', newProjId);
    assert.equal(newChapters.length, 1);
    const newChapterId = newChapters[0].id;
    assert.notEqual(newChapterId, chapterId);

    // Verify duplicated chapter_script
    const newScripts = await db.all('SELECT * FROM chapter_script WHERE chapter_id = ?', newChapterId);
    assert.equal(newScripts.length, 1);
    const newScript = newScripts[0];
    assert.notEqual(newScript.id, scriptId);
    assert.equal(newScript.revision, 4);

    // Verify character ID remapping in duplicated script document
    const newDoc = JSON.parse(newScript.document_json);
    assert.deepEqual(newDoc.scenes[0].characterIds, [newCharId]);
    assert.equal(newDoc.scenes[0].blocks[1].characterId, newCharId);

    // Verify duplicated scene has remapped shot_spec.source.script_id
    const newScenes = await db.all('SELECT * FROM scene WHERE chapter_id = ?', newChapterId);
    assert.equal(newScenes.length, 1);
    const newScene = newScenes[0];
    assert.notEqual(newScene.id, sceneId);
    const newSpec = JSON.parse(newScene.shot_spec);
    assert.equal(newSpec.source.script_id, newScript.id);
    assert.equal(newSpec.source.type, 'script');
  });

  await t.test('SC11 Part 3: Project export (version: 2) and import roundtrip preserves script semantics and remaps IDs', async () => {
    // Export the project
    const exportRes = await app.inject({
      method: 'GET',
      url: `/api/projects/${projId}/export`
    });
    assert.equal(exportRes.statusCode, 200);
    const exportData = JSON.parse(exportRes.body);
    assert.equal(exportData.format, 'novastory-project');
    assert.equal(exportData.version, 2);
    assert.ok(exportData.screenplay.scripts);
    assert.equal(exportData.screenplay.scripts.length, 1);
    assert.equal(exportData.summary.scripts, 1);

    const exportedScript = exportData.screenplay.scripts[0];
    assert.equal(exportedScript.document.title, '雨夜偶遇 (修订稿)');
    assert.ok(exportedScript.changes.length > 0);

    // Import into a new project
    const upload = await createMultipartPayload(
      's4_roundtrip_project.novastory.json',
      JSON.stringify(exportData)
    );

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/projects/import/commit',
      headers: upload.headers,
      payload: upload.payload
    });
    assert.equal(importRes.statusCode, 201, importRes.body);
    const importedProject = JSON.parse(importRes.body);
    const importedProjId = importedProject.id;
    assert.notEqual(importedProjId, projId);

    // Check restored characters
    const impChars = await db.all('SELECT * FROM character WHERE project_id = ?', importedProjId);
    assert.equal(impChars.length, 1);
    const impCharId = impChars[0].id;
    assert.notEqual(impCharId, charId);

    // Check restored chapters
    const impChapters = await db.all('SELECT * FROM chapter WHERE project_id = ?', importedProjId);
    assert.equal(impChapters.length, 1);
    const impChapterId = impChapters[0].id;
    assert.notEqual(impChapterId, chapterId);

    // Check restored script
    const impScripts = await db.all('SELECT * FROM chapter_script WHERE chapter_id = ?', impChapterId);
    assert.equal(impScripts.length, 1);
    const impScript = impScripts[0];
    assert.notEqual(impScript.id, scriptId);
    assert.equal(impScript.revision, 4);

    // Check remapped characters in restored script
    const impDoc = JSON.parse(impScript.document_json);
    assert.equal(impDoc.title, '雨夜偶遇 (修订稿)');
    assert.deepEqual(impDoc.scenes[0].characterIds, [impCharId]);
    assert.equal(impDoc.scenes[0].blocks[1].characterId, impCharId);
    assert.equal(impDoc.scenes[0].blocks[1].text, '这场雨不知要下多久。');

    // Check restored script_change
    const impChanges = await db.all('SELECT * FROM script_change WHERE script_id = ?', impScript.id);
    assert.ok(impChanges.length > 0);

    // Check restored scene with remapped shot_spec.source.script_id
    const impScenes = await db.all('SELECT * FROM scene WHERE chapter_id = ?', impChapterId);
    assert.equal(impScenes.length, 1);
    const impSpec = JSON.parse(impScenes[0].shot_spec);
    assert.equal(impSpec.source.type, 'script');
    assert.equal(impSpec.source.script_id, impScript.id);

    // Check scene version baseline created
    const impVersions = await db.all('SELECT * FROM scene_version WHERE scene_id = ?', impScenes[0].id);
    assert.ok(impVersions.length >= 1);
  });

  await t.test('Backward Compatibility: V1 JSON backup without scripts imports cleanly', async () => {
    const v1Backup = {
      format: 'novastory-project',
      version: 1,
      project: {
        title: 'Legacy V1 Backup',
        settings: {}
      },
      screenplay: {
        chapters: [
          { id: 'ch_v1', index: 1, title: 'Chapter 1', content: 'Legacy content' }
        ]
      },
      character_center: {
        characters: [
          { name: 'Old Hero', visual_tags: {} }
        ]
      },
      director: {
        scenes: []
      }
    };

    const upload = await createMultipartPayload(
      'legacy_v1.novastory.json',
      JSON.stringify(v1Backup)
    );

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/projects/import/commit',
      headers: upload.headers,
      payload: upload.payload
    });
    assert.equal(importRes.statusCode, 201);
    const impProj = JSON.parse(importRes.body);
    assert.equal(impProj.title, 'Legacy V1 Backup');
  });

  await t.test('SC11 Part 1: Chapter and project deletion cleans up script and changes without orphans', async () => {
    // Delete chapter
    const delChapterRes = await app.inject({
      method: 'DELETE',
      url: `/api/chapters/${chapterId}`
    });
    assert.equal(delChapterRes.statusCode, 200);

    // Check no orphan chapter_script or script_change for this chapter
    const orphanScripts = await db.all('SELECT * FROM chapter_script WHERE chapter_id = ?', chapterId);
    assert.equal(orphanScripts.length, 0);
    const orphanChanges = await db.all('SELECT * FROM script_change WHERE script_id = ?', scriptId);
    assert.equal(orphanChanges.length, 0);

    // Delete project
    const delProjectRes = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projId}`
    });
    assert.equal(delProjectRes.statusCode, 200);

    // Verify complete project cleanup
    const remainingProj = await db.get('SELECT * FROM project WHERE id = ?', projId);
    assert.equal(remainingProj, undefined);
  });

  await app.close();
});
