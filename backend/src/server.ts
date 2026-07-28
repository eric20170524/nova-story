import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fs from 'node:fs';
import { ZodError } from 'zod';
import { getStaticDirectory } from './core/paths';
import { db } from './db/database';
import { projectRoutes } from './routes/projects';
import { settingsRoutes } from './routes/settings';
import { workflowRoutes } from './routes/workflows';
import { characterRoutes } from './routes/characters';
import { comicRoutes } from './routes/comics';
import { timelineRoutes } from './routes/timeline';
import { assetRoutes } from './routes/assets';
import { chapterRoutes } from './routes/chapters';
import { creativeRoutes } from './routes/creative';
import { assistantRoutes } from './routes/assistant';
import { coverageRoutes } from './routes/coverage';

export const buildApp = async (options: { logger?: boolean } = {}) => {
  const app = Fastify({
    logger: options.logger ?? true
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(422).send({
        detail: error.issues.map((issue) => ({
          type: issue.code,
          loc: issue.path,
          msg: issue.message
        }))
      });
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return reply.send(error);
  });

  await app.register(cors, {
    origin: '*'
  });
  const staticDirectory = getStaticDirectory();
  fs.mkdirSync(staticDirectory, { recursive: true });
  await app.register(fastifyStatic, {
    root: staticDirectory,
    prefix: '/static/'
  });
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024
    }
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'NovaStory Engine',
        description: 'NovaStory Fastify backend API',
        version: '1.0.0'
      },
      servers: [{
        url: 'http://127.0.0.1:8087',
        description: 'Local NovaStory backend'
      }]
    }
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true
    }
  });

  app.get('/', async () => ({
    message: 'NovaStory Fastify+SQLite Backend Operational'
  }));
  app.get('/api/test-db', async () => {
    const result = await db.get('SELECT sqlite_version() as version');
    return { db_version: result.version };
  });
  app.get('/openapi.json', async () => app.swagger());

  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(chapterRoutes, { prefix: '/api/chapters' });
  await app.register(settingsRoutes, { prefix: '/api/settings' });
  await app.register(workflowRoutes, { prefix: '/api/workflows' });
  await app.register(characterRoutes, { prefix: '/api/characters' });
  await app.register(comicRoutes, { prefix: '/api/comics' });
  await app.register(timelineRoutes, { prefix: '/api/timeline' });
  await app.register(assetRoutes, { prefix: '/api/assets' });
  await app.register(creativeRoutes, { prefix: '/api/agent' });
  await app.register(assistantRoutes, { prefix: '/api/assistant' });
  await app.register(coverageRoutes, { prefix: '/api' });

  return app;
};

export const startServer = async () => {
  const app = await buildApp();
  try {
    await app.listen({ port: 8087, host: '0.0.0.0' });
    app.log.info(`Server listening on ${app.server.address()}`);
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
};

if (require.main === module) {
  void startServer();
}
