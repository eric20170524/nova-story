import { FastifyPluginAsync } from 'fastify';
import { GenerateRequestSchema } from '../schemas/assets';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { logger } from '../core/logging';
import { GenerationService } from '../services/generation_service';
import { db } from '../db/database';
import { ComfyUIService } from '../services/ai/comfyui_service';
import { SettingsManager } from '../core/settings_manager';
import Redis from 'ioredis';
import { AssetTaskStore } from '../services/task_store';

export const assetRoutes: FastifyPluginAsync = async (app) => {

  app.post('/generate', async (request, reply) => {
    const req = GenerateRequestSchema.parse(request.body);

    logger.info(`Received generation request for Scene ${req.scene_id} (Mode: ${req.mode || 'standard'})`);
    const taskId = randomUUID();

    // Fire and forget background task
    GenerationService.generateAssets(taskId, req.workflow, req.scene_id, undefined, req.mode, req.generation_params).catch(err => {
      logger.error(`Background task execution failed: ${err}`);
    });

    return { task_id: taskId, status: "processing" };
  });

  app.get('/status/:task_id', async (request, reply) => {
    const paramsSchema = z.object({ task_id: z.string() });
    const { task_id } = paramsSchema.parse(request.params);
    const task = AssetTaskStore.get(task_id);
    return task || { task_id, status: "UNKNOWN", detail: "Task was not found in this server process" };
  });

  app.get('/stream/:task_id', async (request, reply) => {
    const paramsSchema = z.object({ task_id: z.string() });
    const { task_id } = paramsSchema.parse(request.params);

    // Fastify otherwise considers the async handler complete and may close the
    // raw response before the generation task publishes its next event.
    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    // Hijacked responses bypass Fastify's normal CORS onSend hook.
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');

    const redisUrl = process.env.REDIS_URL;
    let redis: Redis | null = null;

    if (redisUrl) {
      try {
          redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, retryStrategy: () => null });
      } catch (e) {
          logger.error(`Failed to connect to redis: ${e}`);
      }
    }

    const channel = `task_progress:${task_id}`;

    if (redis) {
      try {
          await redis.subscribe(channel);
      } catch (e) {
          logger.error(`Failed to subscribe to redis: ${e}`);
          redis = null; // Mark as failed
      }
    }

    reply.raw.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Initial check just in case it already finished
    const task = AssetTaskStore.get(task_id);
    if (task?.status === 'completed' && task.image_url) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'complete', status: 'completed', image_url: task.image_url })}\n\n`);
        if (redis) redis.disconnect();
        reply.raw.end();
        return;
    } else if (task?.status === 'failed') {
        reply.raw.write(`data: ${JSON.stringify({ type: 'complete', status: 'failed', error: task.error || 'Generation failed' })}\n\n`);
        if (redis) redis.disconnect();
        reply.raw.end();
        return;
    }

    const scene = await db.get('SELECT * FROM scene WHERE task_id = ?', task_id);
    if (scene && scene.asset_status === 'completed' && scene.asset_url) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'complete', status: 'completed', image_url: scene.asset_url })}\n\n`);
        if (redis) redis.disconnect();
        reply.raw.end();
        return;
    } else if (scene && scene.asset_status === 'failed') {
        reply.raw.write(`data: ${JSON.stringify({ type: 'complete', status: 'failed', error: 'Generation failed' })}\n\n`);
        if (redis) redis.disconnect();
        reply.raw.end();
        return;
    }

    if (redis) {
      redis.on('message', (chan, message) => {
          if (chan === channel) {
              reply.raw.write(`data: ${message}\n\n`);
              try {
                  const dataDict = JSON.parse(message);
                  if (dataDict.type === 'complete' || ['completed', 'failed'].includes(dataDict.status)) {
                      redis!.disconnect();
                      reply.raw.end();
                  }
              } catch (e) {}
          }
      });

      redis.on('error', (err) => {
          logger.error(`Redis error in SSE: ${err}`);
      });
    } else {
        // Fallback polling if redis is unavailable (e.g. running locally without redis installed)
        const pollInterval = setInterval(async () => {
            const taskState = AssetTaskStore.get(task_id);
            if (taskState?.status === 'completed' && taskState.image_url) {
                reply.raw.write(`data: ${JSON.stringify({ type: 'complete', status: 'completed', image_url: taskState.image_url })}\n\n`);
                clearInterval(pollInterval);
                reply.raw.end();
                return;
            } else if (taskState?.status === 'failed') {
                reply.raw.write(`data: ${JSON.stringify({ type: 'complete', status: 'failed', error: taskState.error || 'Generation failed' })}\n\n`);
                clearInterval(pollInterval);
                reply.raw.end();
                return;
            }

            const checkScene = await db.get('SELECT * FROM scene WHERE task_id = ?', task_id);
            if (checkScene && checkScene.asset_status === 'completed' && checkScene.asset_url) {
                reply.raw.write(`data: ${JSON.stringify({ type: 'complete', status: 'completed', image_url: checkScene.asset_url })}\n\n`);
                clearInterval(pollInterval);
                reply.raw.end();
            } else if (checkScene && checkScene.asset_status === 'failed') {
                reply.raw.write(`data: ${JSON.stringify({ type: 'complete', status: 'failed', error: 'Generation failed' })}\n\n`);
                clearInterval(pollInterval);
                reply.raw.end();
            } else {
                reply.raw.write(`data: ${JSON.stringify({ type: 'progress', data: { status: 'Polling DB fallback' } })}\n\n`);
            }
        }, 3000);

        reply.raw.on('close', () => {
            clearInterval(pollInterval);
        });
    }

    reply.raw.on('close', () => {
        logger.info(`SSE Client disconnected: ${task_id}`);
        if (redis) redis.disconnect();
    });
  });

  app.post('/cancel', async (request, reply) => {
    logger.info("Cancel asset generation endpoint triggered.");
    try {
        const settings = SettingsManager.loadSettings();
        const comfySettings = settings.comfyui || {};
        const baseUrl = comfySettings.base_url || "http://127.0.0.1:8188";

        const comfyService = new ComfyUIService(baseUrl);
        const cancelled = await comfyService.cancelExecution();
        return { status: cancelled ? "success" : "failed", message: "Interrupted active tasks." };
    } catch (error: any) {
        logger.error(`Error cancelling asset generation: ${error}`);
        return reply.status(500).send({ status: "error", message: error.toString() });
    }
  });
};
