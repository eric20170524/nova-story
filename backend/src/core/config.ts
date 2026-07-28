import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import {
  BACKEND_DIRECTORY,
  getConfigDirectory,
  getDataDirectory
} from './paths';

// Load .env from backend root
dotenv.config({ path: path.join(getConfigDirectory(), '.env') });

const DEFAULT_DB_FILE = path.join(getDataDirectory(), 'sql_app.db');

const resolveDatabaseFile = (configuredUrl?: string) => {
  if (!configuredUrl) {
    return DEFAULT_DB_FILE;
  }

  const configuredPath = configuredUrl.startsWith('sqlite:///')
    ? configuredUrl.slice('sqlite:///'.length)
    : configuredUrl;

  if (configuredPath === ':memory:') {
    return configuredPath;
  }

  const absolutePath = path.isAbsolute(configuredPath)
    ? path.normalize(configuredPath)
    : path.resolve(BACKEND_DIRECTORY, configuredPath);

  // A checked-out repository may have moved since .env was created. Prefer the
  // repository-local database when the configured absolute file no longer exists.
  if (!fs.existsSync(absolutePath) && fs.existsSync(DEFAULT_DB_FILE)) {
    return DEFAULT_DB_FILE;
  }

  return absolutePath;
};

export const settings = {
  PROJECT_NAME: process.env.PROJECT_NAME || 'NovaStory',

  DATABASE_URL: resolveDatabaseFile(process.env.DATABASE_URL),

  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379/0',

  AI_IMAGE_PROVIDER: process.env.AI_IMAGE_PROVIDER || 'gemini',

  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GOOGLE_CLOUD_PROJECT_ID: process.env.GOOGLE_CLOUD_PROJECT_ID || '',

  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',

  GROK_API_KEY: process.env.GROK_API_KEY || '',

  NEBULA_API_URL: process.env.NEBULA_API_URL || 'https://api.chuangyi.chat/api/v1',
  NEBULA_JWT_SECRET: process.env.NEBULA_JWT_SECRET || ''
};
