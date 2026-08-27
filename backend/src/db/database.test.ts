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
      'project_document'
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

    const migrationCount = await legacyDatabase.get(
      'SELECT COUNT(*) AS count FROM schema_migration'
    );
    // 001_core through 011_coverage_shot_contract
    assert.equal(migrationCount.count, 11);
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
