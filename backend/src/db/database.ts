import { AsyncLocalStorage } from 'node:async_hooks';
import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';
import fs from 'fs';
import path from 'path';
import { settings } from '../core/config';
import { logger } from '../core/logging';
import { getWorkflowsDirectory } from '../core/paths';
import { DEFAULT_PROJECT_IMAGE_SETTINGS, getProjectImageSettings, parseProjectSettings } from '../services/project_settings';
import { inferComfyWorkflowFamily } from '../services/comfy_workflow_selection';

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
          narration TEXT,
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
          narration TEXT,
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
            scene_id, version, label, visual_prompt, audio_prompt, dialogue, narration, duration,
            shot_type, camera_movement, camera_angle, negative_prompt,
            asset_status, task_id, asset_url
          ) VALUES (?, 1, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          scene.id,
          scene.visual_prompt ?? null,
          scene.audio_prompt ?? null,
          scene.dialogue ?? null,
          scene.narration ?? null,
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
  },
  {
    version: '010_scene_narration',
    up: async (database) => {
      await ensureColumns(database, 'scene', {
        narration: 'TEXT'
      });
      await ensureColumns(database, 'scene_version', {
        narration: 'TEXT'
      });
    }
  },
  {
    version: '011_coverage_shot_contract',
    up: async (database) => {
      await ensureColumns(database, 'coverage_shot', {
        negative_prompt: 'TEXT',
        shot_spec: 'TEXT',
        shot_intent: 'VARCHAR(50)',
      });
    }
  },
  {
    version: '012_video_generation',
    up: async (database) => {
      await database.exec(`
        CREATE TABLE IF NOT EXISTS media_asset (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          scene_id INTEGER,
          scene_version INTEGER,
          character_id INTEGER,
          parent_asset_id INTEGER,
          media_type VARCHAR(20) NOT NULL,
          role VARCHAR(50) NOT NULL,
          profile VARCHAR(50),
          status VARCHAR(50) NOT NULL DEFAULT 'ready',
          url TEXT NOT NULL,
          mime_type TEXT,
          width INTEGER,
          height INTEGER,
          fps REAL,
          frame_count INTEGER,
          duration_ms INTEGER,
          sha256 TEXT,
          metadata_json TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE,
          FOREIGN KEY(parent_asset_id) REFERENCES media_asset(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS ix_media_asset_project
          ON media_asset(project_id);
        CREATE INDEX IF NOT EXISTS ix_media_asset_scene
          ON media_asset(scene_id, scene_version);
        CREATE INDEX IF NOT EXISTS ix_media_asset_character
          ON media_asset(character_id);
        CREATE INDEX IF NOT EXISTS ix_media_asset_role
          ON media_asset(role);
        CREATE INDEX IF NOT EXISTS ix_media_asset_parent
          ON media_asset(parent_asset_id);
      `);

      await ensureColumns(database, 'generation_task', {
        kind: "VARCHAR(20) DEFAULT 'image'",
        stage: 'VARCHAR(50)',
        output_url: 'TEXT',
        request_json: 'TEXT',
        metadata_json: 'TEXT',
        heartbeat_at: 'DATETIME',
        started_at: 'DATETIME',
        completed_at: 'DATETIME',
      });
    }
  },
  {
    version: '013_project_image_generation',
    up: async (database) => {
      const hasProject = await database.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project'");
      if (!hasProject) return;
      const projects = await database.all('SELECT id, settings FROM project');
      const clearedWorkflows: number[] = [];
      for (const project of projects) {
        const settings = parseProjectSettings(project.settings);
        const legacy = settings as Record<string, any>;
        const oldSpec = legacy.output_spec && typeof legacy.output_spec === 'object'
          ? legacy.output_spec : {};
        const model = legacy.default_model_type === 'sd15' || legacy.default_model_type === 'redcraft_krea2'
          ? legacy.default_model_type : 'pony';
        let workflowId = Number.isSafeInteger(legacy.default_workflow_id) && legacy.default_workflow_id > 0
          ? legacy.default_workflow_id : null;
        if (workflowId != null) {
          const workflow = await database.get('SELECT id, name, content FROM workflow WHERE id = ? AND is_active = 1', workflowId);
          try {
            if (!workflow || inferComfyWorkflowFamily(workflow) !== model) workflowId = null;
          } catch { workflowId = null; }
          if (workflowId == null) clearedWorkflows.push(project.id);
        }
        const image_generation = getProjectImageSettings({
          image_generation: {
            ...DEFAULT_PROJECT_IMAGE_SETTINGS,
            model,
            workflow_id: workflowId,
            style: typeof legacy.default_style === 'string' && legacy.default_style.trim()
              ? legacy.default_style : DEFAULT_PROJECT_IMAGE_SETTINGS.style,
            output_spec: {
              aspect_ratio: oldSpec.aspect_ratio === 'auto' ? '16:9' : oldSpec.aspect_ratio,
              resolution: oldSpec.resolution,
              orientation_policy: oldSpec.aspect_ratio === 'auto' ? 'auto_by_shot' : oldSpec.orientation_policy,
            },
            nsfw_mode: legacy.nsfw_mode === 'on' || legacy.nsfw_mode === 'off'
              ? legacy.nsfw_mode
              : legacy.nsfw_enabled === true ? 'on' : legacy.nsfw_enabled === false ? 'off' : 'inherit',
          }
        });
        delete legacy.default_style;
        delete legacy.default_model_type;
        delete legacy.default_workflow_id;
        delete legacy.output_spec;
        delete legacy.nsfw_mode;
        delete legacy.nsfw_enabled;
        legacy.image_generation = image_generation;
        await database.run('UPDATE project SET settings = ? WHERE id = ?', JSON.stringify(legacy), project.id);
      }

      for (const table of ['character', 'character_version']) {
        const exists = await database.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table);
        if (!exists) continue;
        const rows = await database.all(`SELECT id, visual_tags FROM ${table}`);
        for (const row of rows) {
          if (!row.visual_tags) continue;
          let tags: any;
          try { tags = JSON.parse(row.visual_tags); } catch { continue; }
          if (!tags || typeof tags !== 'object' || Array.isArray(tags)) continue;
          delete tags.model_type;
          if (tags.assets && typeof tags.assets === 'object') delete tags.assets.model_type;
          if (tags.base_model && typeof tags.base_model === 'object') delete tags.base_model.model_type;
          await database.run(`UPDATE ${table} SET visual_tags = ? WHERE id = ?`, JSON.stringify(tags), row.id);
        }
      }
      logger.info(`Normalized image settings for ${projects.length} projects`);
      if (clearedWorkflows.length) {
        logger.warn(`Cleared unavailable or incompatible image workflows for project IDs: ${clearedWorkflows.join(', ')}`);
      }
    }
  },
  {
    version: '014_chapter_script',
    up: async (database) => {
      await database.exec(`
        CREATE TABLE IF NOT EXISTS chapter_script (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chapter_id VARCHAR(36) NOT NULL UNIQUE,
          revision INTEGER NOT NULL DEFAULT 1,
          status VARCHAR(20) NOT NULL DEFAULT 'draft',
          document_json TEXT NOT NULL,
          source_snapshot_json TEXT NOT NULL,
          source_content_hash VARCHAR(64) NOT NULL,
          source_context_hash VARCHAR(64) NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(chapter_id) REFERENCES chapter(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS ix_chapter_script_chapter
          ON chapter_script(chapter_id);

        CREATE TABLE IF NOT EXISTS script_change (
          id VARCHAR(36) PRIMARY KEY,
          script_id INTEGER NOT NULL,
          kind VARCHAR(30) NOT NULL,
          base_revision INTEGER NOT NULL,
          candidate_revision INTEGER NOT NULL,
          request_key VARCHAR(100) NOT NULL,
          state VARCHAR(20) NOT NULL DEFAULT 'pending',
          before_json TEXT,
          after_json TEXT,
          source_snapshot_json TEXT,
          generation_info_json TEXT,
          applied_revision INTEGER,
          result_json TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(script_id) REFERENCES chapter_script(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS ix_script_change_script
          ON script_change(script_id);

        CREATE UNIQUE INDEX IF NOT EXISTS ix_script_change_script_req_key
          ON script_change(script_id, request_key);
      `);
    }
  },
  {
    version: '015_story_plan',
    up: async (database) => {
      const projectTable = await database.get(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project'"
      );
      if (!projectTable) return;
      await database.exec(`
        CREATE TABLE IF NOT EXISTS story_plan (
          project_id INTEGER PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL DEFAULT 1,
          document_json TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS story_plan_change (
          id TEXT PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES story_plan(project_id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('generating','pending','applied','rejected','failed','stale')),
          request_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          request_payload_json TEXT,
          base_revision INTEGER NOT NULL,
          candidate_revision INTEGER NOT NULL DEFAULT 1,
          source_snapshot_json TEXT,
          before_json TEXT,
          after_json TEXT,
          patches_json TEXT,
          apply_payload_hash TEXT,
          result_json TEXT,
          error_code TEXT,
          applied_revision INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(project_id, request_key)
        );

        CREATE INDEX IF NOT EXISTS ix_story_plan_change_project
          ON story_plan_change(project_id, state);
      `);
      const chapterTable = await database.get(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chapter'"
      );
      if (chapterTable) {
        const chapterColumns = await database.all('PRAGMA table_info(chapter)');
        const names = new Set((chapterColumns as Array<{ name: string }>).map((column) => column.name));
        if (!names.has('plan_entry_id')) {
          await database.exec('ALTER TABLE chapter ADD COLUMN plan_entry_id TEXT');
        }
        if (!names.has('target_word_count')) {
          await database.exec('ALTER TABLE chapter ADD COLUMN target_word_count INTEGER');
        }
        if (!names.has('finalized_content_hash')) {
          await database.exec('ALTER TABLE chapter ADD COLUMN finalized_content_hash TEXT');
        }
        await database.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS ix_chapter_plan_entry
            ON chapter(project_id, plan_entry_id)
            WHERE plan_entry_id IS NOT NULL;
        `);
      }
    }
  },
  {
    version: '016_asset_library',
    up: async (database) => {
      await database.exec(`
        CREATE TABLE IF NOT EXISTS library_asset (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('location', 'prop')),
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          visual_prompt TEXT NOT NULL DEFAULT '',
          image_url TEXT,
          status TEXT NOT NULL DEFAULT 'idle',
          task_id TEXT,
          revision INTEGER NOT NULL DEFAULT 1,
          source_chapter_ids TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(project_id, kind, name)
        );
        CREATE TABLE IF NOT EXISTS scene_asset_reference (
          scene_id INTEGER NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
          asset_id INTEGER NOT NULL REFERENCES library_asset(id) ON DELETE RESTRICT,
          asset_revision INTEGER NOT NULL,
          PRIMARY KEY(scene_id, asset_id)
        );
        CREATE INDEX IF NOT EXISTS ix_library_asset_project ON library_asset(project_id, kind);
        CREATE TABLE IF NOT EXISTS scene_asset_image_snapshot (
          scene_id INTEGER NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
          image_url TEXT NOT NULL,
          references_json TEXT NOT NULL DEFAULT '[]',
          PRIMARY KEY(scene_id, image_url)
        );
      `);
    }
  },
  {
    version: '017_image_request_idempotency',
    up: async (database) => {
      await database.exec(`CREATE TABLE IF NOT EXISTS image_generation_request (
        request_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES generation_task(task_id)
      );
      CREATE TABLE IF NOT EXISTS video_generation_request (
        request_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES generation_task(task_id)
      )`);
    }
  },
  {
    version: '018_character_voice',
    up: async (database) => {
      await ensureColumns(database, 'character', {
        voice_id: 'TEXT',
        voice_label: 'TEXT'
      });
    }
  },
  {
    version: '019_shot_master_character_versions',
    up: async (database) => {
      await ensureColumns(database, 'scene_asset_image_snapshot', {
        character_versions_json: 'TEXT'
      });
    }
  },
  {
    version: '020_character_persona',
    up: async (database) => {
      await ensureColumns(database, 'character', {
        personality: 'TEXT',
        growth_path: 'TEXT'
      });
    }
  },
  {
    version: '021_scene_version_english_prompt',
    up: async (database) => {
      await ensureColumns(database, 'scene_version', { english_visual_prompt: 'TEXT' });
      // Only the active version has a trustworthy legacy prompt. Historical
      // versions remain unknown rather than inheriting another image's prompt.
      await database.exec(`UPDATE scene_version SET english_visual_prompt = (
        SELECT json_extract(scene.shot_spec, '$.english_visual_prompt') FROM scene
        WHERE scene.id = scene_version.scene_id AND scene.active_version = scene_version.version
          AND json_valid(scene.shot_spec)
      ) WHERE english_visual_prompt IS NULL`);
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

const transactionContext = new AsyncLocalStorage<true>();
let transactionTail: Promise<void> = Promise.resolve();
let openTransactionRelease: (() => void) | null = null;

const isTransactionStart = (sql: string) => /^\s*BEGIN\b/i.test(sql);
const isTransactionEnd = (sql: string) =>
  /^\s*COMMIT\b/i.test(sql) || /^\s*ROLLBACK(?!\s+TO\b)/i.test(sql);

// One shared sqlite3 connection. A second BEGIN on that connection throws
// "cannot start a transaction within a transaction", so BEGIN waits until the
// open transaction COMMITs or ROLLBACKs. The wait token lives here, not in
// AsyncLocalStorage: enterWith does not survive from db.exec back to its caller.
const acquireTransactionLock = (): Promise<() => void> => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = transactionTail;
  transactionTail = gate;
  return previous.then(() => release);
};

export async function withImmediateTransaction<T>(work: () => Promise<T>): Promise<T> {
  const database = await initDb();
  // A direct db.exec('BEGIN') inside this work must not take the lock again.
  // The store is only visible to the caller of run(); sqlite still rejects the
  // nested BEGIN instead of waiting on the lock this function already holds.
  if (transactionContext.getStore()) {
    await database.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const result = await work();
      await database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        await database.exec('ROLLBACK');
      } catch {
        /* The transaction may already be closed. */
      }
      throw error;
    }
  }

  const release = await acquireTransactionLock();
  try {
    await database.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const result = await transactionContext.run(true, () => work());
      await database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        await database.exec('ROLLBACK');
      } catch {
        /* The transaction may already be closed. */
      }
      throw error;
    }
  } finally {
    release();
  }
}

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
    if (isTransactionStart(sql)) {
      if (transactionContext.getStore()) return database.exec(sql);
      const release = await acquireTransactionLock();
      try {
        const result = await database.exec(sql);
        openTransactionRelease = release;
        return result;
      } catch (error) {
        release();
        throw error;
      }
    }
    if (isTransactionEnd(sql)) {
      const release = transactionContext.getStore() ? null : openTransactionRelease;
      if (!transactionContext.getStore()) openTransactionRelease = null;
      try {
        return await database.exec(sql);
      } finally {
        release?.();
      }
    }
    return database.exec(sql);
  }
};
