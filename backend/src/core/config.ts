import dotenv from 'dotenv';
import path from 'path';

// Load .env from backend root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const BACKEND_DIR = path.resolve(__dirname, '../../');
const DEFAULT_DB_FILE = path.join(BACKEND_DIR, 'sql_app.db');

export const settings = {
  PROJECT_NAME: process.env.PROJECT_NAME || 'NovaStory',

  DATABASE_URL: process.env.DATABASE_URL || DEFAULT_DB_FILE, // For knex/sqlite, we just need the file path

  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379/0',

  AI_IMAGE_PROVIDER: process.env.AI_IMAGE_PROVIDER || 'gemini',

  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GOOGLE_CLOUD_PROJECT_ID: process.env.GOOGLE_CLOUD_PROJECT_ID || '',

  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',

  GROK_API_KEY: process.env.GROK_API_KEY || '',

  NEBULA_API_URL: process.env.NEBULA_API_URL || 'https://api.chuangyi.chat/api/v1',
  NEBULA_JWT_SECRET: process.env.NEBULA_JWT_SECRET || ''
};
