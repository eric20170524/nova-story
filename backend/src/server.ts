import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { BACKEND_DIRECTORY, getStaticDirectory } from './core/paths';
import { db } from './db/database';
import { projectRoutes } from './routes/projects';
import { projectImportRoutes } from './routes/project_import';
import { projectDocumentRoutes } from './routes/project_documents';
import { storyPlanRoutes } from './routes/story_plan';
import { settingsRoutes } from './routes/settings';
import { workflowRoutes } from './routes/workflows';
import { characterRoutes } from './routes/characters';
import { timelineRoutes } from './routes/timeline';
import { assetRoutes } from './routes/assets';
import { assetLibraryRoutes } from './routes/asset_library';
import { chapterRoutes } from './routes/chapters';
import { creativeRoutes } from './routes/creative';
import { assistantRoutes } from './routes/assistant';
import { coverageRoutes } from './routes/coverage';
import { videoRoutes } from './routes/videos';
import { scriptRoutes } from './routes/scripts';
import { ttsRoutes } from './routes/tts';
import { AssetTaskStore } from './services/task_store';
import { VideoGenerationService } from './services/video/video_generation_service';
import { VideoStartupRecoveryService } from './services/video/video_startup_recovery';
import { StoryPlanService } from './services/story_plan_service';
import { ScriptAudioService } from './services/script_audio_service';
import { logger } from './core/logging';

export const buildApp = async (options: { logger?: boolean } = {}) => {
  const app = Fastify(
    options.logger === false
      ? { logger: false }
      : { loggerInstance: logger }
  );

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

  await app.register(projectImportRoutes, { prefix: '/api/projects' });
  await app.register(projectDocumentRoutes, { prefix: '/api/projects' });
  await app.register(storyPlanRoutes, { prefix: '/api/projects' });
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(chapterRoutes, { prefix: '/api/chapters' });
  await app.register(settingsRoutes, { prefix: '/api/settings' });
  await app.register(workflowRoutes, { prefix: '/api/workflows' });
  await app.register(characterRoutes, { prefix: '/api/characters' });
  await app.register(timelineRoutes, { prefix: '/api/timeline' });
  await app.register(assetRoutes, { prefix: '/api/assets' });
  await app.register(assetLibraryRoutes, { prefix: '/api' });
  await app.register(creativeRoutes, { prefix: '/api/agent' });
  await app.register(assistantRoutes, { prefix: '/api/assistant' });
  await app.register(coverageRoutes, { prefix: '/api' });
  await app.register(videoRoutes, { prefix: '/api/videos' });
  await app.register(scriptRoutes, { prefix: '/api' });
  await app.register(ttsRoutes, { prefix: '/api/tts' });

  // Recovery order is intentional:
  // 1) restore exclusive GPU ownership for any Comfy prompt that may have survived
  //    the NovaStory process;
  // 2) let video-specific recovery resume raw/history-backed work;
  // 3) only then interrupt generic/image tasks that have no durable worker.
  try {
    await StoryPlanService.markInterruptedGenerations();
    await ScriptAudioService.markInterruptedRequests();
    await VideoStartupRecoveryService.reconcileActivePromptsOnStartup();
    await VideoGenerationService.markOrphanedTasks();
    await AssetTaskStore.markOrphanedProcessingInterrupted();
    await db.run(`UPDATE library_asset SET
      status = CASE WHEN (SELECT status FROM generation_task WHERE task_id = library_asset.task_id) = 'completed' THEN 'completed' ELSE 'failed' END,
      image_url = COALESCE((SELECT image_url FROM generation_task WHERE task_id = library_asset.task_id), image_url)
      WHERE status = 'generating' AND task_id IN (SELECT task_id FROM generation_task WHERE status <> 'processing')`);
  } catch {
    /* table may not exist in pure unit tests without full migrate */
  }

  // Serve Vite build in production
  const frontendDist = path.resolve(BACKEND_DIRECTORY, '../dist');
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
