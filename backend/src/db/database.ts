import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';
import fs from 'fs';
import path from 'path';
import { settings } from '../core/config';
import { logger } from '../core/logging';
import { getWorkflowsDirectory } from '../core/paths';

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
  },
  {
    version: '004_scene_versions',
    up: async (database) => {
      await ensureColumns(database, 'scene', {
        active_version: 'INTEGER DEFAULT 1'
      });

      await database.exec(`
        CREATE TABLE IF NOT EXISTS scene_version (
          id INTEGER PRIMARY KEY,
          scene_id INTEGER NOT NULL,
          version INTEGER NOT NULL,
          label VARCHAR(100),
          visual_prompt TEXT,
          audio_prompt TEXT,
          dialogue TEXT,
          duration REAL DEFAULT 3.0,
          shot_type VARCHAR(50),
          camera_movement VARCHAR(50),
          camera_angle VARCHAR(50),
          negative_prompt TEXT,
          asset_status VARCHAR(50) DEFAULT 'idle',
          task_id VARCHAR(255),
          asset_url VARCHAR(500),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(scene_id, version),
          FOREIGN KEY(scene_id) REFERENCES scene(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS ix_scene_version_scene
          ON scene_version(scene_id, version);
      `);

      const scenes = await database.all('SELECT * FROM scene');
      for (const scene of scenes as any[]) {
        const existing = await database.get(
          'SELECT id FROM scene_version WHERE scene_id = ? AND version = 1',
          scene.id
        );
        if (existing) continue;
        await database.run(
          `INSERT INTO scene_version (
            scene_id, version, label, visual_prompt, audio_prompt, dialogue, duration,
            shot_type, camera_movement, camera_angle, negative_prompt,
            asset_status, task_id, asset_url
          ) VALUES (?, 1, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          scene.id,
          scene.visual_prompt ?? null,
          scene.audio_prompt ?? null,
          scene.dialogue ?? null,
          scene.duration ?? 3.0,
          scene.shot_type ?? null,
          scene.camera_movement ?? null,
          scene.camera_angle ?? null,
          scene.negative_prompt ?? null,
          scene.asset_status || 'idle',
          scene.task_id ?? null,
          scene.asset_url ?? null
        );
        if (scene.active_version == null) {
          await database.run('UPDATE scene SET active_version = 1 WHERE id = ?', scene.id);
        }
      }
    }
  },
  {
    version: '005_character_versions',
    up: async (database) => {
      await ensureColumns(database, 'character', {
        active_version: 'INTEGER DEFAULT 1'
      });

      await database.exec(`
        CREATE TABLE IF NOT EXISTS character_version (
          id INTEGER PRIMARY KEY,
          character_id INTEGER NOT NULL,
          version INTEGER NOT NULL,
          label VARCHAR(100),
          description TEXT,
          visual_tags TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(character_id, version),
          FOREIGN KEY(character_id) REFERENCES character(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS ix_character_version_char
          ON character_version(character_id, version);
      `);

      const chars = await database.all('SELECT * FROM character');
      for (const char of chars as any[]) {
        const existing = await database.get(
          'SELECT id FROM character_version WHERE character_id = ? AND version = 1',
          char.id
        );
        if (existing) continue;
        const tagsStr =
          typeof char.visual_tags === 'string'
            ? char.visual_tags
            : JSON.stringify(char.visual_tags || {});
        await database.run(
          `INSERT INTO character_version (character_id, version, label, description, visual_tags)
           VALUES (?, 1, 'v1', ?, ?)`,
          char.id,
          char.description ?? null,
          tagsStr
        );
        if (char.active_version == null) {
          await database.run(
            'UPDATE character SET active_version = 1 WHERE id = ?',
            char.id
          );
        }
      }
    }
  },
  {
    version: '006_generation_task',
    up: async (database) => {
      await database.exec(`
        CREATE TABLE IF NOT EXISTS generation_task (
          task_id TEXT PRIMARY KEY,
          scene_id INTEGER,
          status VARCHAR(50) NOT NULL DEFAULT 'processing',
          image_url TEXT,
          error TEXT,
          comfy_prompt_id TEXT,
          progress_json TEXT,
          retry_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS ix_generation_task_scene
          ON generation_task(scene_id);
        CREATE INDEX IF NOT EXISTS ix_generation_task_status
          ON generation_task(status);
        CREATE INDEX IF NOT EXISTS ix_generation_task_comfy
          ON generation_task(comfy_prompt_id);
      `);
    }
  },
  {
    version: '007_agent_os_writing',
    up: async (database) => {
      await ensureColumns(database, 'chapter', {
        condensed_content: 'TEXT'
      });

      await database.exec(`
        CREATE TABLE IF NOT EXISTS glossary (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          term VARCHAR(200) NOT NULL,
          definition TEXT,
          category VARCHAR(100),
          FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS ix_glossary_project
          ON glossary(project_id);
      `);
    }
  },
  {
    version: '008_project_documents',
    up: async (database) => {
      await database.exec(`
        CREATE TABLE IF NOT EXISTS project_document (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          name VARCHAR(255) NOT NULL,
          document_type VARCHAR(50) NOT NULL,
          source_filename VARCHAR(255),
          source_format VARCHAR(20) NOT NULL,
          mime_type VARCHAR(100),
          content TEXT NOT NULL,
          checksum VARCHAR(64) NOT NULL,
          metadata_json TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(project_id, checksum),
          FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS ix_project_document_project_type
          ON project_document(project_id, document_type);
        CREATE INDEX IF NOT EXISTS ix_project_document_project_created
          ON project_document(project_id, created_at);
      `);
    }
  },
  {
    version: '009_project_document_context',
    up: async (database) => {
      await ensureColumns(database, 'project_document', {
        context_enabled: 'INTEGER NOT NULL DEFAULT 0'
      });
      await database.exec(`
        CREATE INDEX IF NOT EXISTS ix_project_document_context
          ON project_document(project_id, context_enabled, document_type);
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
    await database.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const applied = await database.get(
        'SELECT version FROM schema_migration WHERE version = ?',
        migration.version
      );
      if (!applied) {
        await migration.up(database);
        await database.run(
          'INSERT OR IGNORE INTO schema_migration (version) VALUES (?)',
          migration.version
        );
        logger.info(`Applied database migration ${migration.version}`);
      }
      await database.exec('COMMIT');
    } catch (error) {
      await database.exec('ROLLBACK');
      throw error;
    }
  }
};

const seedBundledWorkflows = async (database: Database) => {
  const workflowDirectory = getWorkflowsDirectory();
  if (!fs.existsSync(workflowDirectory)) return;

  const workflowFiles = fs.readdirSync(workflowDirectory)
    .filter((filename) => filename.toLowerCase().endsWith('.json'));
  const bundledNames = new Set(
    workflowFiles.map((filename) => path.basename(filename, '.json'))
  );

  const retiredFluxNames = ['flux_dev_gguf_12gb', 'flux_dev_example'];
  for (const name of retiredFluxNames) {
    if (bundledNames.has(name)) continue;
    const result = await database.run(
      `DELETE FROM workflow WHERE name = ? AND description LIKE 'Bundled workflow%'`,
      name
    );
    if ((result as { changes?: number }).changes) {
      logger.info(`Removed retired bundled workflow: ${name}`);
    }
  }

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
    await database.exec('PRAGMA journal_mode = WAL;');
    await database.exec('PRAGMA busy_timeout = 10000;');
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
