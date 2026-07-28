import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';
import fs from 'fs';
import path from 'path';
import { settings } from '../core/config';
import { logger } from '../core/logging';

let dbInstance: Database | undefined;
let dbInitialization: Promise<Database> | undefined;

type Migration = {
  version: string;
  up: (database: Database) => Promise<void>;
};

const databaseFilename = () => {
  const configuredUrl = settings.DATABASE_URL || 'sqlite:///./sql_app.db';
  return configuredUrl.startsWith('sqlite:///')
    ? configuredUrl.slice('sqlite:///'.length)
    : configuredUrl;
};

const ensureColumns = async (
  database: Database,
  tableName: string,
  columns: Record<string, string>
) => {
  const table = await database.get(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName
  );
  if (!table) return;

  const existingColumns = new Set(
    (await database.all(`PRAGMA table_info("${tableName}")`))
      .map((column: any) => String(column.name))
  );

  for (const [columnName, definition] of Object.entries(columns)) {
    if (!existingColumns.has(columnName)) {
      await database.exec(
        `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`
      );
    }
  }
};

const migrations: Migration[] = [
  {
    version: '001_core_schema',
    up: async (database) => {
      await database.exec(`
        CREATE TABLE IF NOT EXISTS project (
          id INTEGER PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME,
          user_id VARCHAR(100),
          settings TEXT
        );

        CREATE TABLE IF NOT EXISTS chapter (
          id VARCHAR(36) PRIMARY KEY,
          project_id INTEGER,
          "index" INTEGER NOT NULL,
          title VARCHAR(255) NOT NULL,
          content TEXT,
          summary TEXT,
          status VARCHAR(50) DEFAULT 'draft',
          FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS character (
          id INTEGER PRIMARY KEY,
          project_id INTEGER,
          name VARCHAR(100) NOT NULL,
          role VARCHAR(50),
          description TEXT,
          visual_tags TEXT,
          FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS scene (
          id INTEGER PRIMARY KEY,
          chapter_id VARCHAR(36) NOT NULL,
          "index" INTEGER NOT NULL,
          visual_prompt TEXT,
          audio_prompt TEXT,
          dialogue TEXT,
          duration REAL DEFAULT 3.0,
          shot_type VARCHAR(50),
          camera_movement VARCHAR(50),
          camera_angle VARCHAR(50),
          negative_prompt TEXT,
          shot_spec TEXT,
          asset_status VARCHAR(50) DEFAULT 'idle',
          task_id VARCHAR(255),
          asset_url VARCHAR(500),
          FOREIGN KEY(chapter_id) REFERENCES chapter(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS coverage_group (
          id INTEGER PRIMARY KEY,
          source_scene_id INTEGER NOT NULL,
          version INTEGER DEFAULT 1,
          status VARCHAR(50) DEFAULT 'completed',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(source_scene_id) REFERENCES scene(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS coverage_shot (
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
          promoted_scene_id INTEGER,
          FOREIGN KEY(coverage_group_id) REFERENCES coverage_group(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS workflow (
          id INTEGER PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          content TEXT NOT NULL,
          is_active INTEGER DEFAULT 1
        );
      `);
    }
  },
  {
    version: '002_legacy_column_compatibility',
    up: async (database) => {
      await ensureColumns(database, 'project', {
        updated_at: 'DATETIME',
        user_id: 'VARCHAR(100)',
        settings: 'TEXT'
      });
      await ensureColumns(database, 'chapter', {
        summary: 'TEXT',
        status: "VARCHAR(50) DEFAULT 'draft'"
      });
      await ensureColumns(database, 'character', {
        role: 'VARCHAR(50)',
        description: 'TEXT',
        visual_tags: 'TEXT'
      });
      await ensureColumns(database, 'scene', {
        audio_prompt: 'TEXT',
        dialogue: 'TEXT',
        duration: 'REAL DEFAULT 3.0',
        shot_type: 'VARCHAR(50)',
        camera_movement: 'VARCHAR(50)',
        camera_angle: 'VARCHAR(50)',
        negative_prompt: 'TEXT',
        shot_spec: 'TEXT',
        asset_status: "VARCHAR(50) DEFAULT 'idle'",
        task_id: 'VARCHAR(255)',
        asset_url: 'VARCHAR(500)'
      });
    }
  },
  {
    version: '003_indexes',
    up: async (database) => {
      await database.exec(`
        CREATE INDEX IF NOT EXISTS ix_project_user_id
          ON project(user_id);
        CREATE INDEX IF NOT EXISTS ix_chapter_project_index
          ON chapter(project_id, "index");
        CREATE INDEX IF NOT EXISTS ix_character_project_id
          ON character(project_id);
        CREATE INDEX IF NOT EXISTS ix_scene_chapter_index
          ON scene(chapter_id, "index");
        CREATE INDEX IF NOT EXISTS ix_scene_task_id
          ON scene(task_id);
        CREATE INDEX IF NOT EXISTS ix_coverage_group_source_scene
          ON coverage_group(source_scene_id, version);
        CREATE INDEX IF NOT EXISTS ix_coverage_shot_group_slot
          ON coverage_shot(coverage_group_id, slot);
      `);
    }
  }
];

export const runMigrations = async (database: Database) => {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version VARCHAR(100) PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  for (const migration of migrations) {
    const applied = await database.get(
      'SELECT version FROM schema_migration WHERE version = ?',
      migration.version
    );
    if (applied) continue;

    await database.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      await migration.up(database);
      await database.run(
        'INSERT INTO schema_migration (version) VALUES (?)',
        migration.version
      );
      await database.exec('COMMIT');
      logger.info(`Applied database migration ${migration.version}`);
    } catch (error) {
      await database.exec('ROLLBACK');
      throw error;
    }
  }
};

const seedBundledWorkflows = async (database: Database) => {
  const workflowDirectory = path.resolve(__dirname, '../../app/static/workflows');
  if (!fs.existsSync(workflowDirectory)) return;

  const workflowFiles = fs.readdirSync(workflowDirectory)
    .filter((filename) => filename.toLowerCase().endsWith('.json'));

  for (const filename of workflowFiles) {
    const name = path.basename(filename, '.json');
    const existing = await database.get(
      'SELECT id FROM workflow WHERE name = ?',
      name
    );
    if (existing) continue;

    const content = JSON.parse(
      fs.readFileSync(path.join(workflowDirectory, filename), 'utf-8')
    );
    await database.run(
      `INSERT INTO workflow (name, description, content, is_active)
       VALUES (?, ?, ?, 1)`,
      name,
      `Bundled workflow imported from ${filename}`,
      JSON.stringify(content)
    );
  }
};

export const initDb = async () => {
  if (dbInstance) return dbInstance;
  if (dbInitialization) return dbInitialization;

  dbInitialization = (async () => {
    const database = await open({
      filename: databaseFilename(),
      driver: sqlite3.Database
    });

    await database.exec('PRAGMA foreign_keys = ON;');
    await database.exec('PRAGMA busy_timeout = 5000;');
    await runMigrations(database);
    await seedBundledWorkflows(database);
    dbInstance = database;
    return database;
  })();

  try {
    return await dbInitialization;
  } catch (error) {
    dbInitialization = undefined;
    throw error;
  }
};

export const db = {
  get: async (sql: string, ...params: any[]) => {
    const database = await initDb();
    return database.get(sql, ...params);
  },
  all: async (sql: string, ...params: any[]) => {
    const database = await initDb();
    return database.all(sql, ...params);
  },
  run: async (sql: string, ...params: any[]) => {
    const database = await initDb();
    return database.run(sql, ...params);
  },
  exec: async (sql: string) => {
    const database = await initDb();
    return database.exec(sql);
  }
};
