import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';

let dbInstance: Database;

import { settings } from '../core/config';

export const initDb = async () => {
  if (dbInstance) return dbInstance;
  dbInstance = await open({
    filename: settings.DATABASE_URL.replace('sqlite:///', ''),
    driver: sqlite3.Database
  });

  // enable foreign keys
  await dbInstance.exec('PRAGMA foreign_keys = ON;');
  await dbInstance.exec(`
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

    CREATE INDEX IF NOT EXISTS ix_chapter_project_index
      ON chapter(project_id, "index");
  `);

  return dbInstance;
};

// Top level await requires ES modules, or we can use a proxy/getter if we don't want top level await.
// For simplicity, we initialize it on first import (which is async, so we'll just export a promise or init function).

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
