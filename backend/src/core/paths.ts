import fs from 'node:fs';
import path from 'node:path';

/**
 * Backend package root (`backend/`), whether running from `src/` or compiled `dist/`.
 */
export const BACKEND_DIRECTORY = path.resolve(__dirname, '../../');

export const getConfigDirectory = () =>
  path.resolve(process.env.NOVASTORY_CONFIG_DIR || BACKEND_DIRECTORY);

export const getDataDirectory = () =>
  path.resolve(process.env.NOVASTORY_DATA_DIR || BACKEND_DIRECTORY);

/**
 * On-disk static asset root (workflows + generated images + comics).
 *
 * Default: `backend/static/`
 * Override: `NOVASTORY_STATIC_DIR` (absolute or relative path)
 *
 * Served by Fastify at HTTP prefix `/static/` (URL path unchanged).
 * Legacy Python-era path was `backend/app/static/` — no longer used.
 */
export const getStaticDirectory = () => {
  if (process.env.NOVASTORY_STATIC_DIR) {
    return path.resolve(process.env.NOVASTORY_STATIC_DIR);
  }
  return path.join(BACKEND_DIRECTORY, 'static');
};

/** Generated images: `backend/static/generated/` → `/static/generated/...` */
export const getGeneratedDirectory = () => {
  const dir = path.join(getStaticDirectory(), 'generated');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Bundled ComfyUI workflow JSON: `backend/static/workflows/` */
export const getWorkflowsDirectory = () => {
  const dir = path.join(getStaticDirectory(), 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Comic exports: `backend/static/comics/` */
export const getComicsDirectory = () => {
  const dir = path.join(getStaticDirectory(), 'comics');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
