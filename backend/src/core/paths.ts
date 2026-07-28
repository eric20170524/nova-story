import path from 'node:path';

export const BACKEND_DIRECTORY = path.resolve(__dirname, '../../');

export const getConfigDirectory = () => path.resolve(
  process.env.NOVASTORY_CONFIG_DIR || BACKEND_DIRECTORY
);

export const getDataDirectory = () => path.resolve(
  process.env.NOVASTORY_DATA_DIR || BACKEND_DIRECTORY
);

export const getStaticDirectory = () => path.resolve(
  process.env.NOVASTORY_STATIC_DIR
    || path.join(BACKEND_DIRECTORY, 'app', 'static')
);

export const getGeneratedDirectory = () => path.join(
  getStaticDirectory(),
  'generated'
);
