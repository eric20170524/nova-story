import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fs from 'node:fs';
import path from 'node:path';
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
import { AssetTaskStore } from './services/task_store';

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

  // Default: same-origin / localhost only. Set NOVASTORY_ALLOW_LAN=1 only when
  // intentionally exposing on a trusted LAN (still no auth — prefer tunnel/VPN).
  const allowLan = process.env.NOVASTORY_ALLOW_LAN === '1' || process.env.NOVASTORY_ALLOW_LAN === 'true';
  const corsOrigins = [
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    process.env.NOVASTORY_CORS_ORIGIN
  ].filter(Boolean) as string[];
  await app.register(cors, {
    origin: allowLan
      ? true
      : (origin, callback) => {
          // Non-browser clients / same-origin have no Origin header
          if (!origin) {
            callback(null, true);
            return;
          }
          if (corsOrigins.includes(origin)) {
            callback(null, true);
            return;
          }
          callback(null, false);
        },
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
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
        url: 'http://127.0.0.1:3000',
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

  app.get('/api/test-db', async () => {
    const result = await db.get('SELECT sqlite_version() as version');
    return { db_version: result?.version || 'mocked' };
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

  // After DB migrations (import of routes/db already ran them via proxy),
  // mark orphaned processing tasks so clients don't hang after restart.
  try {
    await AssetTaskStore.markOrphanedProcessingInterrupted();
  } catch {
    /* table may not exist in pure unit tests without full migrate */
  }

  // Serve Vite build in production
  const frontendDist = path.join(__dirname, '../../dist');
  if (process.env.NODE_ENV === 'production' && fs.existsSync(frontendDist)) {
    await app.register(fastifyStatic, {
      root: frontendDist,
      prefix: '/',
      decorateReply: false
    });
    
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.status(404).send({ error: 'Not found' });
      } else {
        reply.sendFile('index.html', frontendDist);
      }
    });
  }

  return app;
};

export const startServer = async () => {
  const app = await buildApp();
  // Default loopback-only so API keys / settings are not reachable on the LAN.
  // Override with HOST=0.0.0.0 only when you intentionally expose the service.
  const host = process.env.HOST || process.env.NOVASTORY_HOST || '127.0.0.1';
  const port = Number(process.env.PORT || process.env.NOVASTORY_PORT || 3000);
  try {
    await app.listen({ port, host });
    app.log.info(`Server listening on http://${host}:${port}`);
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
};
