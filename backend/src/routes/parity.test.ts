import assert from 'node:assert/strict';
import test from 'node:test';

test('initializes the complete schema and exposes the migrated parity routes', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [
    { default: Fastify },
    { db },
    { creativeRoutes },
    { assistantRoutes },
    { coverageRoutes },
    { characterRoutes },
    { projectRoutes },
    { LLMService },
    { AgentService },
    { WritingService }
  ] = await Promise.all([
    import('fastify'),
    import('../db/database'),
    import('./creative'),
    import('./assistant'),
    import('./coverage'),
    import('./characters'),
    import('./projects'),
    import('../services/llm'),
    import('../services/ai/agent_service'),
    import('../services/ai/writing_service')
  ]);

  const tables = (await db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  )).map((row: any) => row.name);
  for (const requiredTable of [
    'project',
    'chapter',
    'character',
    'scene',
    'coverage_group',
    'coverage_shot',
    'workflow',
    'glossary',
    'schema_migration'
  ]) {
    assert.ok(tables.includes(requiredTable), `missing table ${requiredTable}`);
  }

  const project = await db.run(
    "INSERT INTO project (title, settings, user_id) VALUES ('Parity', '{}', 'local_admin')"
  );
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, status)
     VALUES ('chapter-1', ?, 1, 'Chapter One', 'Hero opens the door.', 'draft')`,
    project.lastID
  );
  await db.run(
    `INSERT INTO character (project_id, name, description, visual_tags)
     VALUES (?, 'Hero', 'A determined hero', '{}')`,
    project.lastID
  );
  const scene = await db.run(
    `INSERT INTO scene (
       chapter_id, "index", visual_prompt, dialogue, duration, asset_status
     ) VALUES ('chapter-1', 1, 'Hero opens the door', 'Hero: Go.', 3, 'idle')`
  );

  LLMService.generateDraft = async () => 'Generated draft';
  WritingService.generateChapterDraft = async () => ({
    content: 'Generated draft',
    condensed: 'condensed',
    nextPlot: 'hook',
  });
  LLMService.analyzeContent = async () => ({
    new_entities: ['Hero'],
    updates: ['Door opened']
  });
  LLMService.generateStoryboardGrid = async () => 'Nine-panel prompt';
  LLMService.generateSceneCoverage = async () => Array.from(
    { length: 9 },
    (_, index) => ({
      slot: index + 1,
      shot_type: index === 0 ? 'Extreme Long Shot' : 'Medium Shot',
      shot_intent: index === 0 ? 'establish' : index === 6 ? 'insert' : 'medium-action',
      camera_angle: index === 8 ? 'High Angle' : 'Eye-level',
      camera_movement: 'Static',
      narrative_purpose: `Purpose ${index + 1}`,
      location: 'european arcade corridor',
      primary_action: index === 6
        ? 'paw presses music-note button'
        : 'Hero opens a door',
      key_props: index === 6 ? ['music-note button'] : ['door'],
      primary_subject: index === 6 ? 'paw-only' : 'Hero',
      subject_scale: index === 6 ? 'absent' : 'medium-20-40',
      visual_prompt: '',
    })
  );
  LLMService.extractCharacterProfiles = async () => [{
    name: 'Hero',
    role: 'main',
    description: 'Updated hero',
    visual_tags: {
      hair: 'black',
      eyes: 'brown',
      skin_tone: 'warm',
      face_features: 'sharp',
      build: 'athletic',
      clothing: 'coat',
      accessories: 'none'
    }
  }];
  LLMService.analyzeCharacterEvolution = async () => ({
    action: 'new_variant',
    reason: 'New outfit',
    new_variant: {
      name: 'Chapter coat',
      tags: 'dark travel coat'
    }
  });
  AgentService.prototype.processRequest = async () => ({
    thought: 'Test',
    response: 'Assistant response',
    actions: [],
    results: [],
    needs_confirmation: false,
    action: null
  });

  const app = Fastify();
  await app.register(creativeRoutes, { prefix: '/api/agent' });
  await app.register(assistantRoutes, { prefix: '/api/assistant' });
  await app.register(coverageRoutes, { prefix: '/api' });
  await app.register(characterRoutes, { prefix: '/api/characters' });
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.ready();

  const draftResponse = await app.inject({
    method: 'POST',
    url: '/api/agent/draft',
    payload: {
      instructions: 'Continue',
      context_chapter_id: 'chapter-1'
    }
  });
  assert.equal(draftResponse.statusCode, 200, draftResponse.body);
  assert.equal(draftResponse.json().content, 'Generated draft');

  const analysisResponse = await app.inject({
    method: 'POST',
    url: '/api/agent/analyze',
    payload: { content: 'Hero opens the door.' }
  });
  assert.equal(analysisResponse.statusCode, 200, analysisResponse.body);
  assert.deepEqual(analysisResponse.json().new_entities, ['Hero']);

  const storyboardResponse = await app.inject({
    method: 'POST',
    url: '/api/agent/storyboard-grid',
    payload: { story_text: 'Hero opens the door.' }
  });
  assert.equal(storyboardResponse.statusCode, 200, storyboardResponse.body);

  const contextResponse = await app.inject({
    method: 'GET',
    url: '/api/agent/context/chapter-1'
  });
  assert.equal(contextResponse.statusCode, 200, contextResponse.body);
  assert.equal(contextResponse.json().characters[0].name, 'Hero');

  const assistantResponse = await app.inject({
    method: 'POST',
    url: '/api/assistant/chat',
    payload: {
      message: 'Help',
      context: { chapter_id: 'chapter-1', language: 'en' },
      history: []
    }
  });
  assert.equal(assistantResponse.statusCode, 200, assistantResponse.body);
  assert.equal(assistantResponse.json().response, 'Assistant response');

  const extractionResponse = await app.inject({
    method: 'POST',
    url: '/api/characters/extract',
    payload: { chapter_id: 'chapter-1' }
  });
  assert.equal(extractionResponse.statusCode, 200, extractionResponse.body);
  const evolvedTags = extractionResponse.json()[0].visual_tags;
  assert.match(evolvedTags.timeline_map['chapter-1'], /^var_/);
  assert.equal(evolvedTags.variants.at(-1).name, 'Chapter coat');

  const coverageResponse = await app.inject({
    method: 'POST',
    url: `/api/scenes/${scene.lastID}/coverage`
  });
  assert.equal(coverageResponse.statusCode, 200, coverageResponse.body);
  assert.equal(coverageResponse.json().shots.length, 9);
  const firstShotId = coverageResponse.json().shots[0].id;

  const listResponse = await app.inject({
    method: 'GET',
    url: `/api/scenes/${scene.lastID}/coverage`
  });
  assert.equal(listResponse.statusCode, 200, listResponse.body);
  assert.equal(listResponse.json()[0].shots.length, 9);

  const applyResponse = await app.inject({
    method: 'POST',
    url: `/api/scenes/coverage/${firstShotId}/apply`
  });
  assert.equal(applyResponse.statusCode, 200, applyResponse.body);
  assert.equal(applyResponse.json().scene.shot_type, 'Extreme Long Shot');

  const promoteResponse = await app.inject({
    method: 'POST',
    url: `/api/scenes/coverage/${firstShotId}/promote`,
    payload: { position: 'after' }
  });
  assert.equal(promoteResponse.statusCode, 200, promoteResponse.body);
  assert.ok(promoteResponse.json().scene_id);

  const deleteProjectResponse = await app.inject({
    method: 'DELETE',
    url: `/api/projects/${project.lastID}`
  });
  assert.equal(deleteProjectResponse.statusCode, 200, deleteProjectResponse.body);
  for (const tableName of [
    'project',
    'chapter',
    'character',
    'scene',
    'coverage_group',
    'coverage_shot'
  ]) {
    const row = await db.get(`SELECT COUNT(*) AS count FROM ${tableName}`);
    assert.equal(row.count, 0, `${tableName} rows were not deleted`);
  }

  await app.close();
});
