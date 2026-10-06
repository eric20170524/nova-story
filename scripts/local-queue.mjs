import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Same default as the backend data directory: NOVASTORY_DATA_DIR or backend/. */
export function localQueueDir(envName, folderName) {
  const override = process.env[envName];
  if (override) return path.resolve(override);
  const dataDir = process.env.NOVASTORY_DATA_DIR
    ? path.resolve(process.env.NOVASTORY_DATA_DIR)
    : path.join(root, 'backend');
  return path.join(dataDir, folderName);
}
