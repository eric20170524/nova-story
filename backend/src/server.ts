import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { db } from './db/database';

const app = Fastify({
  logger: true
});

app.register(cors, {
  origin: '*'
});

app.register(fastifyStatic, {
  root: path.join(__dirname, '../app/static'),
  prefix: '/static/'
});

import { projectRoutes } from './routes/projects';
import { settingsRoutes } from './routes/settings';
import { workflowRoutes } from './routes/workflows';
import { characterRoutes } from './routes/characters';
import { comicRoutes } from './routes/comics';
import { timelineRoutes } from './routes/timeline';
import { assetRoutes } from './routes/assets';
import { chapterRoutes } from './routes/chapters';
import multipart from '@fastify/multipart';

app.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
});

app.get('/', async (request, reply) => {
  return { message: 'NovaStory Fastify+SQLite Backend Operational' };
});

app.get('/api/test-db', async (request, reply) => {
  const result = await db.get('SELECT sqlite_version() as version');
  return { db_version: result.version };
});

// Register routes
app.register(projectRoutes, { prefix: '/api/projects' });
app.register(chapterRoutes, { prefix: '/api/chapters' });
app.register(settingsRoutes, { prefix: '/api/settings' });
app.register(workflowRoutes, { prefix: '/api/workflows' });
app.register(characterRoutes, { prefix: '/api/characters' });
app.register(comicRoutes, { prefix: '/api/comics' });
app.register(timelineRoutes, { prefix: '/api/timeline' });
app.register(assetRoutes, { prefix: '/api/assets' });

const start = async () => {
  try {
    await app.listen({ port: 8087, host: '0.0.0.0' });
    app.log.info(`Server listening on ${app.server.address()}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
