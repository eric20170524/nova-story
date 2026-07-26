import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';

let dbInstance: Database;

export const initDb = async () => {
  if (dbInstance) return dbInstance;
  dbInstance = await open({
    filename: path.join(__dirname, '../../sql_app.db'), // match fastAPI's default path or use a new one
    driver: sqlite3.Database
  });

  // enable foreign keys
  await dbInstance.exec('PRAGMA foreign_keys = ON;');

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
