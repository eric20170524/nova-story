import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = ':memory:';

test('character age dimension and dual-stream portrait/turnaround support', async () => {
  const [
    { default: Fastify },
    { db, initDb },
    { characterRoutes },
    { Prompts },
    { CharacterProfileSchema },
  ] = await Promise.all([
    import('fastify'),
    import('../db/database'),
    import('./characters'),
    import('../services/prompts'),
    import('../schemas/llm'),
  ]);

  await initDb();

  const app = Fastify();
  await app.register(characterRoutes, { prefix: '/api/characters' });
  await app.ready();

  try {
    // 1. Verify 'age' column in database tables
    const characterColumns = new Set(
      (await db.all('PRAGMA table_info("character")')).map((col: any) => col.name)
    );
    assert.ok(characterColumns.has('age'), 'character table must have age column');

    const versionColumns = new Set(
      (await db.all('PRAGMA table_info("character_version")')).map((col: any) => col.name)
    );
    assert.ok(versionColumns.has('age'), 'character_version table must have age column');

    // Create a mock project
    await db.run('INSERT INTO project (id, title) VALUES (1, "Test Project")');

    // 2. Create character with age
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/characters/',
      payload: {
        project_id: 1,
        name: '沈烟',
        role: 'protagonist',
        description: '青云门弟子',
        age: '24岁',
      },
    });
    assert.equal(createRes.statusCode, 200);
    const created = JSON.parse(createRes.payload);
    assert.equal(created.name, '沈烟');
    assert.equal(created.age, '24岁');

    // Verify persisted in DB
    const dbRow = await db.get('SELECT * FROM character WHERE id = ?', created.id);
    assert.equal(dbRow.age, '24岁');

    // 3. Update character age
    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/characters/${created.id}`,
      payload: {
        age: '26岁',
      },
    });
    assert.equal(updateRes.statusCode, 200);
    const updated = JSON.parse(updateRes.payload);
    assert.equal(updated.age, '26岁');

    const updatedDbRow = await db.get('SELECT * FROM character WHERE id = ?', created.id);
    assert.equal(updatedDbRow.age, '26岁');

    const avatarOnly = await app.inject({
      method: 'PUT',
      url: `/api/characters/${created.id}`,
      payload: { avatar_url: '/static/generated/projects/1/characters/1/v1/portrait.png' },
    });
    assert.equal(avatarOnly.statusCode, 200);
    assert.equal(JSON.parse(avatarOnly.payload).age, '26岁');
    const avatarOnlyRow = await db.get('SELECT age FROM character WHERE id = ?', created.id);
    assert.equal(avatarOnlyRow.age, '26岁');

    // 4. Test portrait prompt generation (upper-body front portrait, eye-level, visible shoulders, detailed face)
    const portraitPromptRes = await app.inject({
      method: 'POST',
      url: `/api/characters/${created.id}/build-prompt`,
      payload: {
        gen_type: 'portrait',
      },
    });
    assert.equal(portraitPromptRes.statusCode, 200);
    const portraitData = JSON.parse(portraitPromptRes.payload);
    assert.match(portraitData.prompt, /high quality character portrait/i);
    assert.match(portraitData.prompt, /upper body, waist-up, front view, facing camera, both shoulders visible, eye-level, detailed face and eyes/i);
    assert.match(portraitData.prompt, /26岁/);

    // 5. Test turnaround prompt generation with automatic reuse of portrait as IP-Adapter ref
    // First, set an avatar (定妆照)
    await app.inject({
      method: 'PUT',
      url: `/api/characters/${created.id}`,
      payload: {
        avatar_url: '/static/generated/projects/1/characters/1/v1/portrait.png',
      },
    });

    const turnaroundPromptRes = await app.inject({
      method: 'POST',
      url: `/api/characters/${created.id}/build-prompt`,
      payload: {
        gen_type: 'turnaround',
        use_ref_portrait: true,
      },
    });
    assert.equal(turnaroundPromptRes.statusCode, 200);
    const turnaroundData = JSON.parse(turnaroundPromptRes.payload);
    assert.equal(turnaroundData.ref_image_url, '/static/generated/projects/1/characters/1/v1/portrait.png');
    assert.equal(turnaroundData.character_ref_url, '/static/generated/projects/1/characters/1/v1/portrait.png');
    assert.equal(turnaroundData.turnaround_front_adapter, true);
    assert.match(turnaroundData.prompt, /matching reference character design|Match the supplied portrait for identity/i);

    // 6. Test LLM extraction prompt & schema for age dimension
    const extractPrompt = Prompts.extractCharacterProfiles('测试内容');
    assert.match(extractPrompt, /- age:/);

    const parsedProfile = CharacterProfileSchema.parse({
      name: '陆雪琪',
      role: 'protagonist',
      age: '19',
      description: '小竹峰弟子',
      visual_tags: {
        age: '19',
        hair: 'black hair',
      },
    });
    assert.equal(parsedProfile.age, '19');

    // 7. Verify oriental bone structure anchors are injected for human characters and skipped for nonhuman characters
    assert.match(portraitData.prompt, /East Asian facial features, delicate classical oriental bone structure/i);
    assert.match(portraitData.negative_prompt, /caucasian, western face, european facial structure/i);

    const beastRes = await app.inject({
      method: 'POST',
      url: '/api/characters/',
      payload: {
        project_id: 1,
        name: '玄冰灵狐',
        role: 'supporting',
        description: '雪山灵兽，white fox animal creature with fluffy tail and furry paws',
        visual_tags: {
          subject_type: 'nonhuman',
          hair: 'white fur',
        },
      },
    });
    assert.equal(beastRes.statusCode, 200);
    const beast = JSON.parse(beastRes.payload);
    const beastPromptRes = await app.inject({
      method: 'POST',
      url: `/api/characters/${beast.id}/build-prompt`,
      payload: {
        gen_type: 'portrait',
      },
    });
    assert.equal(beastPromptRes.statusCode, 200);
    const beastPromptData = JSON.parse(beastPromptRes.payload);
    assert.doesNotMatch(beastPromptData.prompt, /East Asian facial features/i);
    assert.doesNotMatch(beastPromptData.negative_prompt, /caucasian|western face/i);

    await db.run(
      'UPDATE project SET settings = ? WHERE id = 1',
      JSON.stringify({ image_generation: { style: 'oriental_realistic', model: 'redcraft_krea2' } }),
    );
    await db.run(
      'UPDATE character SET visual_tags = ? WHERE id = ?',
      JSON.stringify({
        face_features: 'refined classical East Asian mature beauty, delicate oriental bone structure',
        hair: 'long_silky_white',
      }),
      created.id,
    );
    const orientalRes = await app.inject({
      method: 'POST',
      url: `/api/characters/${created.id}/build-prompt`,
      payload: { gen_type: 'portrait' },
    });
    assert.equal(orientalRes.statusCode, 200);
    const oriental = JSON.parse(orientalRes.payload);
    assert.match(oriental.prompt, /^oriental realistic style, photorealistic, delicate East Asian facial features/i);
    assert.match(oriental.prompt, /soft East Asian eyelids/i);
    assert.match(oriental.negative_prompt, /3d render, doll, illustration, flat color/i);

    const omittedRef = await app.inject({
      method: 'POST',
      url: `/api/characters/${created.id}/build-prompt`,
      payload: { gen_type: 'turnaround' },
    });
    assert.equal(omittedRef.statusCode, 200);
    const omittedBody = JSON.parse(omittedRef.payload);
    assert.equal(omittedBody.ref_image_url, null);
    assert.equal(omittedBody.character_ref_url, null);

    const refusedRef = await app.inject({
      method: 'POST',
      url: `/api/characters/${created.id}/build-prompt`,
      payload: { gen_type: 'turnaround', use_ref_portrait: false, ref_image_url: '/static/generated/projects/1/characters/1/v1/portrait.png' },
    });
    const refusedBody = JSON.parse(refusedRef.payload);
    assert.equal(refusedBody.ref_image_url, null);
    assert.equal(refusedBody.turnaround_front_adapter, false);
  } finally {
    await app.close();
  }
});

test('age survives an ageless extract and a version switch, and empty shots skip the face negative', async () => {
  const [
    { default: Fastify },
    { db, initDb },
    { characterRoutes },
    { CharacterProfileSchema },
    { LLMService },
    { shotImageMaterialsFromSpec },
    { buildTurnaroundViewPrompt, TURNAROUND_VIEWS },
    { ORIENTAL_REALISTIC_FACE_LOCK },
    { shotUsesOrientalFaceNegative },
    { activateCharacterVersion },
  ] = await Promise.all([
    import('fastify'),
    import('../db/database'),
    import('./characters'),
    import('../schemas/llm'),
    import('../services/llm'),
    import('../services/english_visual_prompt'),
    import('../services/turnaround_composite'),
    import('../services/image_generation_policy'),
    import('../services/generation_service'),
    import('../services/character_versions'),
  ]);

  await initDb();
  const app = Fastify();
  await app.register(characterRoutes, { prefix: '/api/characters' });
  await app.ready();
  const originalExtract = LLMService.extractCharacterProfiles;
  const originalEvolution = LLMService.analyzeCharacterEvolution;
  try {
    await db.run('INSERT INTO project (id, title) VALUES (2, "Age Project")');
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/characters/',
      payload: { project_id: 2, name: '沈烟', role: 'protagonist', description: '青云门弟子', age: '24岁' },
    });
    const created = JSON.parse(createRes.payload);
    const tags = JSON.parse((await db.get('SELECT visual_tags FROM character WHERE id = ?', created.id)).visual_tags);
    assert.equal(tags.base_model?.tags?.age || tags.age, '24岁');

    await db.run(
      `INSERT INTO chapter (id, project_id, "index", title, content, status) VALUES ('age-ch', 2, 1, '第1章', '沈烟走进房间。', 'draft')`
    );
    const parsed = CharacterProfileSchema.parse({
      name: '沈烟',
      role: 'protagonist',
      description: '仍无新年龄',
      visual_tags: { hair: 'black hair' },
    });
    assert.equal(parsed.age, '');
    assert.equal(parsed.visual_tags.age, '');
    LLMService.extractCharacterProfiles = async () => [parsed];
    LLMService.analyzeCharacterEvolution = async () => ({ action: 'keep_current', reason: '年龄未变', modifier_tags: null });
    const extractRes = await app.inject({ method: 'POST', url: '/api/characters/extract', payload: { chapter_id: 'age-ch' } });
    assert.equal(extractRes.statusCode, 200);
    const after = await db.get('SELECT age, visual_tags FROM character WHERE id = ?', created.id);
    assert.equal(after.age, '24岁');
    const afterTags = JSON.parse(after.visual_tags);
    assert.notEqual(afterTags.base_model?.tags?.age, '');
    assert.equal(afterTags.age || afterTags.base_model?.tags?.age, '24岁');
    const card = JSON.parse((await app.inject({ method: 'GET', url: `/api/characters/${created.id}` })).payload);
    assert.equal(card.age, '24岁');
    const shot = shotImageMaterialsFromSpec(
      { location: '房间', primary_action: '站着', visible_subjects: ['沈烟'] },
      [{ name: '沈烟', age: after.age, visual_tags: afterTags }],
    );
    assert.equal(shot.characters[0]?.appearance.age, '24岁');

    await app.inject({
      method: 'PUT',
      url: `/api/characters/${created.id}`,
      payload: { avatar_url: '/static/v2-portrait.png' },
    });
    await app.inject({ method: 'PUT', url: `/api/characters/${created.id}`, payload: { age: '30岁' } });
    const active = await db.get('SELECT active_version, age FROM character WHERE id = ?', created.id);
    assert.equal(active.age, '30岁');
    assert.ok(Number(active.active_version) > 1);
    const restored = await activateCharacterVersion(created.id, 1);
    assert.equal(restored.age, '24岁');
    const restoredShot = shotImageMaterialsFromSpec(
      { location: '房间', primary_action: '站着', visible_subjects: ['沈烟'] },
      [{ name: '沈烟', age: restored.age, visual_tags: restored.visual_tags }],
    );
    assert.equal(restoredShot.characters[0]?.appearance.age, '24岁');
    const again = await activateCharacterVersion(created.id, Number(active.active_version));
    assert.equal(again.age, '30岁');
    const againTags = typeof again.visual_tags === 'string' ? JSON.parse(again.visual_tags) : again.visual_tags;
    const againShot = shotImageMaterialsFromSpec(
      { location: '房间', primary_action: '站着', visible_subjects: ['沈烟'] },
      [{ name: '沈烟', age: null, visual_tags: { hair: 'black hair' } }],
    );
    assert.equal(againShot.characters[0]?.appearance.age, undefined);
    const columnShot = shotImageMaterialsFromSpec(
      { location: '房间', primary_action: '站着', visible_subjects: ['沈烟'] },
      [{ name: '沈烟', age: again.age, visual_tags: againTags }],
    );
    assert.equal(columnShot.characters[0]?.appearance.age, '30岁');

    const lock = `${ORIENTAL_REALISTIC_FACE_LOCK}, long black hair, moon-white dress`;
    const back = buildTurnaroundViewPrompt(lock, TURNAROUND_VIEWS[2]!, 'pony');
    assert.doesNotMatch(back.prompt, /East Asian facial features/i);
    const front = buildTurnaroundViewPrompt(lock, TURNAROUND_VIEWS[0]!, 'pony');
    assert.match(front.prompt, /East Asian facial features/i);
    assert.equal(shotUsesOrientalFaceNegative({ gen_type: 'scene', shot_spec: { visible_subjects: [] } }), false);
    assert.equal(shotUsesOrientalFaceNegative({ gen_type: 'scene', shot_spec: { visible_subjects: ['林岚'] } }), true);
    assert.equal(shotUsesOrientalFaceNegative({ gen_type: 'portrait' }), true);
    const cleared = await app.inject({ method: 'PUT', url: `/api/characters/${created.id}`, payload: { age: '' } });
    assert.equal(JSON.parse(cleared.payload).age, null);
    assert.equal((await db.get('SELECT age FROM character WHERE id = ?', created.id)).age, null);
  } finally {
    LLMService.extractCharacterProfiles = originalExtract;
    LLMService.analyzeCharacterEvolution = originalEvolution;
    await app.close();
  }
});

