import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = ':memory:';

test('T6.3: character voice columns, saving rules, version isolation and prompt building', async () => {
  const [
    { default: Fastify },
    { db, initDb },
    { characterRoutes }
  ] = await Promise.all([
    import('fastify'),
    import('../db/database'),
    import('./characters')
  ]);

  await initDb();

  const fixturePath = path.join(__dirname, '../services/fixtures/tts_voices_sample.json');
  const rawFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  const app = Fastify();
  await app.register(characterRoutes, { prefix: '/api/characters' });
  await app.ready();

  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;

  const mockHealthyFetch = async (url: string) => {
    fetchCallCount++;
    if (url.endsWith('/api/voices')) {
      return {
        ok: true,
        status: 200,
        json: async () => rawFixture
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const mockFailingFetch = async () => {
    fetchCallCount++;
    const err: any = new Error('connect ECONNREFUSED 127.0.0.1:8765');
    err.code = 'ECONNREFUSED';
    throw err;
  };

  try {
    // 0. Verify columns exist on character table
    const characterColumns = new Set(
      (await db.all('PRAGMA table_info("character")')).map((col: any) => col.name)
    );
    assert.ok(characterColumns.has('voice_id'), 'character table must have voice_id');
    assert.ok(characterColumns.has('voice_label'), 'character table must have voice_label');

    // Verify character_version does NOT have voice columns
    const versionColumns = new Set(
      (await db.all('PRAGMA table_info("character_version")')).map((col: any) => col.name)
    );
    assert.equal(versionColumns.has('voice_id'), false, 'character_version must not store voice_id');
    assert.equal(versionColumns.has('voice_label'), false, 'character_version must not store voice_label');

    // Create a project
    const project = await db.run(
      "INSERT INTO project (title, settings, user_id) VALUES ('TTS Voice Test', '{}', 'local_admin')"
    );
    const projectId = Number(project.lastID);

    // 1. Create character without voice_id: voice_id and voice_label are NULL
    const resCreateDefault = await app.inject({
      method: 'POST',
      url: '/api/characters/',
      payload: {
        project_id: projectId,
        name: '无音色角色',
        description: '未指定音色的角色'
      }
    });
    assert.equal(resCreateDefault.statusCode, 200);
    const charDefault = resCreateDefault.json();
    assert.equal(charDefault.voice_id, null);
    assert.equal(charDefault.voice_label, null);

    const dbRowDefault = await db.get('SELECT voice_id, voice_label FROM character WHERE id = ?', charDefault.id);
    assert.equal(dbRowDefault.voice_id, null);
    assert.equal(dbRowDefault.voice_label, null);

    // 2. Create character with valid voice_id (e.g. clone voice Lu Xueqi)
    (globalThis as any).fetch = mockHealthyFetch;
    fetchCallCount = 0;

    const resCreateWithVoice = await app.inject({
      method: 'POST',
      url: '/api/characters/',
      payload: {
        project_id: projectId,
        name: '陆雪琪',
        description: '青云门弟子',
        voice_id: 'C_1785664414_d700a8',
        voice_label: 'client_ignored_label' // Should be discarded
      }
    });
    assert.equal(resCreateWithVoice.statusCode, 200);
    const charLu = resCreateWithVoice.json();
    assert.equal(charLu.voice_id, 'C_1785664414_d700a8');
    assert.equal(charLu.voice_label, 'C_1785664414_d700a8 · 陆雪琪 · 专属复刻');
    assert.equal(fetchCallCount, 1, 'Should query TTS voices catalog once');

    // 3. Create character with unknown voice_id fails with 400 VOICE_NOT_FOUND and does not write to DB
    const countBefore400 = (await db.get('SELECT COUNT(*) AS c FROM character')).c;
    const resCreateUnknown = await app.inject({
      method: 'POST',
      url: '/api/characters/',
      payload: {
        project_id: projectId,
        name: '未知音色',
        voice_id: 'UNKNOWN_VOICE_123'
      }
    });
    assert.equal(resCreateUnknown.statusCode, 400);
    assert.equal(resCreateUnknown.json().code, 'VOICE_NOT_FOUND');
    const countAfter400 = (await db.get('SELECT COUNT(*) AS c FROM character')).c;
    assert.equal(countAfter400, countBefore400, 'No row should be written on 400');

    // 4. Create character with voice_id when TTS is unreachable fails with 503 and does not write to DB
    (globalThis as any).fetch = mockFailingFetch;
    const resCreateUnavailable = await app.inject({
      method: 'POST',
      url: '/api/characters/',
      payload: {
        project_id: projectId,
        name: '服务离线',
        voice_id: 'QF1'
      }
    });
    assert.equal(resCreateUnavailable.statusCode, 503);
    assert.equal(resCreateUnavailable.json().code, 'TTS_UNAVAILABLE');
    const countAfter503 = (await db.get('SELECT COUNT(*) AS c FROM character')).c;
    assert.equal(countAfter503, countBefore400, 'No row should be written on 503');

    // 5. Partial PUT { avatar_url } preserves voice_id and voice_label, and does NOT access TTS
    fetchCallCount = 0;
    const resPartialPut = await app.inject({
      method: 'PUT',
      url: `/api/characters/${charLu.id}`,
      payload: {
        avatar_url: '/static/avatars/lu_xueqi.png'
      }
    });
    assert.equal(resPartialPut.statusCode, 200);
    const partialChar = resPartialPut.json();
    assert.equal(partialChar.avatar_url, '/static/avatars/lu_xueqi.png');
    assert.equal(partialChar.voice_id, 'C_1785664414_d700a8');
    assert.equal(partialChar.voice_label, 'C_1785664414_d700a8 · 陆雪琪 · 专属复刻');
    assert.equal(fetchCallCount, 0, 'Partial PUT without voice_id must not access TTS');

    // 6. PUT with identical voice_id does NOT access TTS
    fetchCallCount = 0;
    const resSameVoicePut = await app.inject({
      method: 'PUT',
      url: `/api/characters/${charLu.id}`,
      payload: {
        name: '陆雪琪（修改后）',
        voice_id: 'C_1785664414_d700a8'
      }
    });
    assert.equal(resSameVoicePut.statusCode, 200);
    assert.equal(resSameVoicePut.json().name, '陆雪琪（修改后）');
    assert.equal(resSameVoicePut.json().voice_id, 'C_1785664414_d700a8');
    assert.equal(fetchCallCount, 0, 'PUT with identical voice_id must not access TTS');

    // 7. Explicit clear (null or "") clears both columns and does NOT access TTS, even if TTS is offline
    (globalThis as any).fetch = mockFailingFetch;
    fetchCallCount = 0;

    // 7a. Clear with null
    const resClearNull = await app.inject({
      method: 'PUT',
      url: `/api/characters/${charLu.id}`,
      payload: {
        voice_id: null
      }
    });
    assert.equal(resClearNull.statusCode, 200);
    assert.equal(resClearNull.json().voice_id, null);
    assert.equal(resClearNull.json().voice_label, null);
    assert.equal(fetchCallCount, 0, 'Clearing voice_id with null must not access TTS');

    // Reset voice for 7b
    await db.run('UPDATE character SET voice_id = ?, voice_label = ? WHERE id = ?', 'QF1', 'QF1 · Serena · 高质温柔', charLu.id);

    // 7b. Clear with empty string ""
    fetchCallCount = 0;
    const resClearEmpty = await app.inject({
      method: 'PUT',
      url: `/api/characters/${charLu.id}`,
      payload: {
        voice_id: ''
      }
    });
    assert.equal(resClearEmpty.statusCode, 200);
    assert.equal(resClearEmpty.json().voice_id, null);
    assert.equal(resClearEmpty.json().voice_label, null);
    assert.equal(fetchCallCount, 0, 'Clearing voice_id with "" must not access TTS');

    // 8. PUT with new valid voice_id binds new voice and updates label
    (globalThis as any).fetch = mockHealthyFetch;
    fetchCallCount = 0;
    const resBindNew = await app.inject({
      method: 'PUT',
      url: `/api/characters/${charLu.id}`,
      payload: {
        voice_id: 'QF1'
      }
    });
    assert.equal(resBindNew.statusCode, 200);
    assert.equal(resBindNew.json().voice_id, 'QF1');
    assert.equal(resBindNew.json().voice_label, 'QF1 · Serena · 高质温柔');
    assert.equal(fetchCallCount, 1, 'Changing voice must query catalog');

    // 9. Fail-Closed: Unknown voice_id on PUT returns 400 and does NOT write any columns
    const charBeforeFailedPut = await db.get('SELECT * FROM character WHERE id = ?', charLu.id);
    const resFailUnknown = await app.inject({
      method: 'PUT',
      url: `/api/characters/${charLu.id}`,
      payload: {
        name: 'Should Not Save',
        description: 'Should not change',
        voice_id: 'NON_EXISTENT_VOICE'
      }
    });
    assert.equal(resFailUnknown.statusCode, 400);
    assert.equal(resFailUnknown.json().code, 'VOICE_NOT_FOUND');

    const charAfterFailedPut = await db.get('SELECT * FROM character WHERE id = ?', charLu.id);
    assert.deepEqual(charAfterFailedPut, charBeforeFailedPut, 'Row must be strictly unchanged when PUT voice validation fails');

    // 9b. Fail-Closed: TTS unavailable on PUT returns 503 and does NOT write any columns
    (globalThis as any).fetch = mockFailingFetch;
    const resFailUnavailable = await app.inject({
      method: 'PUT',
      url: `/api/characters/${charLu.id}`,
      payload: {
        name: 'Should Not Save 2',
        voice_id: 'K01'
      }
    });
    assert.equal(resFailUnavailable.statusCode, 503);
    assert.equal(resFailUnavailable.json().code, 'TTS_UNAVAILABLE');

    const charAfterFailedPut503 = await db.get('SELECT * FROM character WHERE id = ?', charLu.id);
    assert.deepEqual(charAfterFailedPut503, charBeforeFailedPut, 'Row must be strictly unchanged when TTS is unavailable on PUT');

    // 10. Prompt assembly does NOT include voice_label or voice_id
    const resPrompt = await app.inject({
      method: 'POST',
      url: `/api/characters/${charLu.id}/build-prompt`,
      payload: {
        gen_type: 'portrait',
        use_ref_portrait: false
      }
    });
    assert.equal(resPrompt.statusCode, 200);
    const promptData = resPrompt.json();
    assert.doesNotMatch(promptData.prompt, /QF1/);
    assert.doesNotMatch(promptData.prompt, /Serena/);
    assert.doesNotMatch(promptData.prompt, /高质温柔/);
    assert.doesNotMatch(promptData.negative_prompt, /QF1/);

  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test('T6.5: Project duplicate, backup export/restore, and text extract character voice preservation', async () => {
  const [
    { default: Fastify },
    { db, initDb },
    { characterRoutes },
    { projectRoutes },
    { normalizeNovaStoryJsonProject },
    { restoreNovaStoryJsonProject },
    { LLMService }
  ] = await Promise.all([
    import('fastify'),
    import('../db/database'),
    import('./characters'),
    import('./projects'),
    import('../services/import/novastory_json_model'),
    import('../services/import/novastory_json_import'),
    import('../services/llm')
  ]);

  await initDb();

  const app = Fastify();
  await app.register(characterRoutes, { prefix: '/api/characters' });
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.ready();

  try {
    // Create base project
    const projRes = await db.run(
      "INSERT INTO project (title, settings, user_id) VALUES ('Project Voice Persistence', '{}', 'local_admin')"
    );
    const projectId = Number(projRes.lastID);

    // Insert 2 characters: one with voice, one without
    const charWithVoiceRes = await db.run(
      `INSERT INTO character (project_id, name, role, description, visual_tags, voice_id, voice_label)
       VALUES (?, '陆雪琪', '主角', '青云门弟子', '{}', 'C_1785664414_d700a8', 'C_1785664414_d700a8 · 陆雪琪 · 专属复刻')`,
      projectId
    );
    const char1Id = Number(charWithVoiceRes.lastID);

    const charWithoutVoiceRes = await db.run(
      `INSERT INTO character (project_id, name, role, description, visual_tags, voice_id, voice_label)
       VALUES (?, '普通配角', '配角', '普通路人', '{}', NULL, NULL)`,
      projectId
    );
    const char2Id = Number(charWithoutVoiceRes.lastID);

    // 1. Duplicate project: POST /api/projects/:id/duplicate
    const dupRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/duplicate`
    });
    assert.equal(dupRes.statusCode, 201);
    const dupBody = dupRes.json();
    const dupProjectId = Number(dupBody.project.id);
    assert.notEqual(dupProjectId, projectId);

    const dupChars = await db.all('SELECT * FROM character WHERE project_id = ? ORDER BY id ASC', dupProjectId);
    assert.equal(dupChars.length, 2);

    const dupCharWithVoice = dupChars.find((c: any) => c.name === '陆雪琪');
    assert.ok(dupCharWithVoice);
    assert.notEqual(dupCharWithVoice.id, char1Id, 'Duplicated character must receive a new ID');
    assert.equal(dupCharWithVoice.voice_id, 'C_1785664414_d700a8', 'voice_id must be preserved across duplicate without remapping');
    assert.equal(dupCharWithVoice.voice_label, 'C_1785664414_d700a8 · 陆雪琪 · 专属复刻');

    const dupCharWithoutVoice = dupChars.find((c: any) => c.name === '普通配角');
    assert.ok(dupCharWithoutVoice);
    assert.equal(dupCharWithoutVoice.voice_id, null);
    assert.equal(dupCharWithoutVoice.voice_label, null);

    // 2. Export project: GET /api/projects/:id/export
    const exportRes = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/export`
    });
    assert.equal(exportRes.statusCode, 200);
    const exportData = exportRes.json();
    assert.equal(exportData.format, 'novastory-project');
    assert.equal(exportData.version, 2);

    const exportedChars = exportData.character_center.characters;
    const expChar1 = exportedChars.find((c: any) => c.name === '陆雪琪');
    assert.equal(expChar1.voice_id, 'C_1785664414_d700a8');
    assert.equal(expChar1.voice_label, 'C_1785664414_d700a8 · 陆雪琪 · 专属复刻');

    const expChar2 = exportedChars.find((c: any) => c.name === '普通配角');
    assert.equal(expChar2.voice_id, null);
    assert.equal(expChar2.voice_label, null);

    // 3. Restore / import JSON with voice columns
    const normalized = normalizeNovaStoryJsonProject(exportData, 'backup.novastory.json');
    const restoredProject = await restoreNovaStoryJsonProject(normalized, 'local_admin');
    const restoredProjectId = Number(restoredProject.id);

    const restoredChars = await db.all('SELECT * FROM character WHERE project_id = ? ORDER BY id ASC', restoredProjectId);
    assert.equal(restoredChars.length, 2);

    const restChar1 = restoredChars.find((c: any) => c.name === '陆雪琪');
    assert.equal(restChar1.voice_id, 'C_1785664414_d700a8');
    assert.equal(restChar1.voice_label, 'C_1785664414_d700a8 · 陆雪琪 · 专属复刻');

    const restChar2 = restoredChars.find((c: any) => c.name === '普通配角');
    assert.equal(restChar2.voice_id, null);
    assert.equal(restChar2.voice_label, null);

    // 4. Import legacy JSON without voice columns -> voice_id and voice_label are NULL
    const legacyExportData = {
      ...exportData,
      character_center: {
        characters: [
          {
            name: '旧版角色',
            role: '长老',
            description: '来自无音色列旧版备份',
            visual_tags: '{}'
          }
        ]
      }
    };
    const legacyNormalized = normalizeNovaStoryJsonProject(legacyExportData, 'legacy.novastory.json');
    const legacyProject = await restoreNovaStoryJsonProject(legacyNormalized, 'local_admin');
    const legacyProjectId = Number(legacyProject.id);

    const legacyChars = await db.all('SELECT * FROM character WHERE project_id = ?', legacyProjectId);
    assert.equal(legacyChars.length, 1);
    assert.equal(legacyChars[0].voice_id, null);
    assert.equal(legacyChars[0].voice_label, null);

    // 5. POST /api/characters/extract does NOT overwrite existing character voice_id / voice_label
    const chapterId = 'ch-voice-extract-1';
    await db.run(
      `INSERT INTO chapter (id, project_id, "index", title, content, status)
       VALUES (?, ?, 1, '第1章', '陆雪琪御剑而来，遇到新同门曾书书。', 'draft')`,
      chapterId,
      projectId
    );

    const originalExtract = LLMService.extractCharacterProfiles;
    const originalEvolution = LLMService.analyzeCharacterEvolution;

    LLMService.extractCharacterProfiles = async () => [
      {
        name: '陆雪琪',
        role: '九天玄刹执剑人',
        description: '白衣胜雪，神情冷清',
        visual_tags: { outfit: '白衣仙裙' }
      },
      {
        name: '曾书书',
        role: '风回峰弟子',
        description: '活泼好动，喜好奇珍异兽',
        visual_tags: { outfit: '青衫' }
      }
    ];
    LLMService.analyzeCharacterEvolution = async () => ({
      action: 'scene_modifier',
      reason: '冷清气场',
      modifier_tags: '冷清'
    });

    try {
      const extractRes = await app.inject({
        method: 'POST',
        url: '/api/characters/extract',
        payload: {
          chapter_id: chapterId
        }
      });
      assert.equal(extractRes.statusCode, 200);

      const luAfterExtract = await db.get('SELECT * FROM character WHERE id = ?', char1Id);
      assert.equal(luAfterExtract.role, '九天玄刹执剑人');
      assert.equal(luAfterExtract.description, '白衣胜雪，神情冷清');
      // Crucial: voice_id and voice_label MUST remain intact!
      assert.equal(luAfterExtract.voice_id, 'C_1785664414_d700a8', 'Extract must never overwrite existing voice_id');
      assert.equal(luAfterExtract.voice_label, 'C_1785664414_d700a8 · 陆雪琪 · 专属复刻', 'Extract must never overwrite existing voice_label');

      // Newly extracted character has NULL voice columns
      const zengRow = await db.get('SELECT * FROM character WHERE project_id = ? AND name = ?', projectId, '曾书书');
      assert.ok(zengRow);
      assert.equal(zengRow.voice_id, null, 'Newly extracted character must have NULL voice_id');
      assert.equal(zengRow.voice_label, null, 'Newly extracted character must have NULL voice_label');
    } finally {
      LLMService.extractCharacterProfiles = originalExtract;
      LLMService.analyzeCharacterEvolution = originalEvolution;
    }
  } finally {
    await app.close();
  }
});

