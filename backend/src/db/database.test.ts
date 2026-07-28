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
      'schema_migration'
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

    const migrationCount = await legacyDatabase.get(
      'SELECT COUNT(*) AS count FROM schema_migration'
    );
    assert.equal(migrationCount.count, 3);
  } finally {
    await legacyDatabase.close();
  }
});
