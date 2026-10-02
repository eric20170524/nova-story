import assert from 'node:assert/strict';
import test from 'node:test';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { runMigrations } from './database';

test('upgrades a legacy main database schema idempotently', async () => {
  const legacyDatabase = await open({
    filename: ':memory:',
    driver: sqlite3.Database
  });

  try {
    await legacyDatabase.exec(`
      CREATE TABLE project (
        id INTEGER PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        created_at DATETIME
      );
      CREATE TABLE chapter (
        id VARCHAR(36) PRIMARY KEY,
        project_id INTEGER,
        "index" INTEGER NOT NULL,
        title VARCHAR(255) NOT NULL,
        content TEXT
      );
      CREATE TABLE scene (
        id INTEGER PRIMARY KEY,
        chapter_id VARCHAR(36) NOT NULL,
        "index" INTEGER NOT NULL,
        visual_prompt TEXT
      );
    `);

    await runMigrations(legacyDatabase);
    await runMigrations(legacyDatabase);

    const tables = new Set(
      (await legacyDatabase.all(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      )).map((row: any) => row.name)
    );
    for (const tableName of [
      'character',
      'coverage_group',
      'coverage_shot',
      'workflow',
      'schema_migration',
      'project_document',
      'media_asset'
    ]) {
      assert.ok(tables.has(tableName), `legacy upgrade did not create ${tableName}`);
    }

    const sceneColumns = new Set(
      (await legacyDatabase.all('PRAGMA table_info("scene")'))
        .map((column: any) => column.name)
    );
    for (const columnName of [
      'audio_prompt',
      'dialogue',
      'narration',
      'shot_spec',
      'asset_status',
      'task_id',
      'asset_url'
    ]) {
      assert.ok(
        sceneColumns.has(columnName),
        `legacy upgrade did not add scene.${columnName}`
      );
    }

    const documentColumns = new Set(
      (await legacyDatabase.all('PRAGMA table_info("project_document")'))
        .map((column: any) => column.name)
    );
    assert.ok(documentColumns.has('context_enabled'));

    const coverageShotColumns = new Set(
      (await legacyDatabase.all('PRAGMA table_info("coverage_shot")'))
        .map((column: any) => column.name)
    );
    for (const columnName of ['negative_prompt', 'shot_spec', 'shot_intent']) {
      assert.ok(
        coverageShotColumns.has(columnName),
        `legacy upgrade did not add coverage_shot.${columnName}`
      );
    }

    const scriptTable = await legacyDatabase.get(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chapter_script'"
    );
    assert.ok(scriptTable, 'legacy upgrade did not create chapter_script table');

    const changeTable = await legacyDatabase.get(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'script_change'"
    );
    assert.ok(changeTable, 'legacy upgrade did not create script_change table');

    const migrationCount = await legacyDatabase.get(
      'SELECT COUNT(*) AS count FROM schema_migration'
    );
    // 001_core through 018_character_voice
    assert.equal(migrationCount.count, 18);

    const characterColumns = new Set(
      (await legacyDatabase.all('PRAGMA table_info("character")'))
        .map((column: any) => column.name)
    );
    assert.ok(characterColumns.has('voice_id'), 'character should have voice_id');
    assert.ok(characterColumns.has('voice_label'), 'character should have voice_label');

    for (const name of ['library_asset', 'scene_asset_reference', 'scene_asset_image_snapshot']) {
      assert.ok(await legacyDatabase.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name));
    }
  } finally {
    await legacyDatabase.close();
  }
});

test('011 adds coverage_shot contract columns when only 001-010 were applied', async () => {
  const database = await open({
    filename: ':memory:',
    driver: sqlite3.Database
  });
  try {
    await database.exec(`
      CREATE TABLE schema_migration (
        version VARCHAR(100) PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE coverage_group (
        id INTEGER PRIMARY KEY,
        source_scene_id INTEGER NOT NULL,
        version INTEGER DEFAULT 1,
        status VARCHAR(50) DEFAULT 'completed'
      );
      CREATE TABLE coverage_shot (
        id INTEGER PRIMARY KEY,
        coverage_group_id INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        shot_size VARCHAR(50),
        camera_angle VARCHAR(50),
        camera_movement VARCHAR(50),
        narrative_purpose VARCHAR(255),
        visual_prompt TEXT,
        asset_status VARCHAR(50) DEFAULT 'idle',
        task_id VARCHAR(255),
        asset_url VARCHAR(500),
        promoted_scene_id INTEGER
      );
    `);
    for (const version of [
      '001_core_schema',
      '002_legacy_column_compatibility',
      '003_indexes',
      '004_scene_versions',
      '005_character_versions',
      '006_generation_task',
      '007_agent_os_writing',
      '008_project_documents',
      '009_project_document_context',
      '010_scene_narration',
    ]) {
      await database.run('INSERT INTO schema_migration (version) VALUES (?)', version);
    }

    const before = new Set(
      (await database.all('PRAGMA table_info("coverage_shot")')).map((c: any) => c.name)
    );
    assert.equal(before.has('negative_prompt'), false);
    assert.equal(before.has('shot_spec'), false);

    await runMigrations(database);

    const after = new Set(
      (await database.all('PRAGMA table_info("coverage_shot")')).map((c: any) => c.name)
    );
    assert.ok(after.has('negative_prompt'));
    assert.ok(after.has('shot_spec'));
    assert.ok(after.has('shot_intent'));
    const row = await database.get(
      `SELECT version FROM schema_migration WHERE version = '011_coverage_shot_contract'`
    );
    assert.ok(row);
  } finally {
    await database.close();
  }
});

test('013 rewrites existing project image settings and removes character models once', async () => {
  const database = await open({ filename: ':memory:', driver: sqlite3.Database });
  try {
    await runMigrations(database);
    await database.run(
      'INSERT INTO project (id, title, settings) VALUES (?, ?, ?)',
      1, 'existing', JSON.stringify({
        default_model_type: 'sd15', default_style: 'anime', default_workflow_id: 99,
        output_spec: { aspect_ratio: 'auto', resolution: 'high' }, nsfw_enabled: true,
        genre: 'fantasy',
      })
    );
    await database.run('INSERT INTO character (id, project_id, name, visual_tags) VALUES (?, ?, ?, ?)',
      1, 1, 'hero', JSON.stringify({ model_type: 'pony', assets: { model_type: 'pony', avatar_url: '/a.png' } }));
    await database.run("DELETE FROM schema_migration WHERE version = '013_project_image_generation'");
    await runMigrations(database);
    await runMigrations(database);

    const project = await database.get('SELECT settings FROM project WHERE id = 1');
    const settings = JSON.parse(project.settings);
    assert.equal(settings.image_generation.model, 'sd15');
    assert.equal(settings.image_generation.workflow_id, null);
    assert.equal(settings.image_generation.style, 'anime');
    assert.equal(settings.image_generation.output_spec.orientation_policy, 'auto_by_shot');
    assert.equal(settings.image_generation.nsfw_mode, 'on');
    assert.equal(settings.genre, 'fantasy');
    assert.equal('default_model_type' in settings, false);
    const character = await database.get('SELECT visual_tags FROM character WHERE id = 1');
    const tags = JSON.parse(character.visual_tags);
    assert.equal('model_type' in tags, false);
    assert.equal('model_type' in tags.assets, false);
    assert.equal(tags.assets.avatar_url, '/a.png');
  } finally {
    await database.close();
  }
});
