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
    assert.match(turnaroundData.prompt, /matching reference character design/i);

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
  } finally {
    await app.close();
  }
});

