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
import { GpuLeaseService } from '../services/gpu_lease_service';
import { createSceneVersion, ensureSceneVersionBaseline, syncActiveVersionAssets } from '../services/scene_versions';
import { subscribeTaskProgress } from '../services/task_progress_bus';

export const assetRoutes: FastifyPluginAsync = async (app) => {

  const parseProgressMetadata = (raw?: string | null) => {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return {
        ...(typeof parsed?.width === 'number' ? { width: parsed.width } : {}),
        ...(typeof parsed?.height === 'number' ? { height: parsed.height } : {}),
        ...(typeof parsed?.aspect_ratio === 'string' ? { aspect_ratio: parsed.aspect_ratio } : {}),
      };
    } catch {
      return {};
    }
  };

  app.post('/generate', async (request, reply) => {
    const req = GenerateRequestSchema.parse(request.body);

    logger.info(`Received generation request for Scene ${req.scene_id} (Mode: ${req.mode || 'standard'})`);
    const taskId = randomUUID();

    // Optional: fork a new scene version before generating (A/B test slot)
    const asNewVersion = Boolean(
      req.new_version
      || req.workflow?.new_version
      || req.workflow?.create_new_version
    );
    if (req.scene_id < 90000000) {
      // Skip synthetic character scene ids (99999xxx)
      if (asNewVersion) {
        await createSceneVersion(req.scene_id, {
          clearAsset: true,
          activate: true,
          label: null
        });
      } else {
        await ensureSceneVersionBaseline(req.scene_id);
      }
      await db.run(
        'UPDATE scene SET asset_status = ?, task_id = ? WHERE id = ?',
        'generating',
        taskId,
        req.scene_id
      );
      await syncActiveVersionAssets(req.scene_id, {
        asset_status: 'generating',
        task_id: taskId,
        asset_url: null
      });
    }

    // Persist task row before fire-and-forget so status survives mid-flight
    await AssetTaskStore.processing(taskId, req.scene_id);

    // Fire and forget background task
    GenerationService.generateAssets(taskId, req.workflow, req.scene_id, undefined, req.mode, req.generation_params).catch(err => {
      logger.error(`Background task execution failed: ${err}`);
    });

    const scene = req.scene_id < 90000000
      ? await db.get('SELECT id, active_version FROM scene WHERE id = ?', req.scene_id)
      : null;

    return {
      task_id: taskId,
      status: 'processing',
      active_version: scene?.active_version ?? null,
      new_version: asNewVersion
    };
  });

  app.get('/status/:task_id', async (request, reply) => {
    const paramsSchema = z.object({ task_id: z.string() });
    const { task_id } = paramsSchema.parse(request.params);
    const task = await AssetTaskStore.get(task_id);
    if (task) {
      return {
        task_id: task.task_id,
        scene_id: task.scene_id,
        status: task.status,
        image_url: task.image_url,
        error: task.error,
        comfy_prompt_id: task.comfy_prompt_id ?? null,
        updated_at: task.updated_at,
        ...parseProgressMetadata(task.progress_json),
      };
    }
    // Fallback: scene row may still know about a historical task
    const scene = await db.get(
      'SELECT id, asset_status, asset_url, task_id FROM scene WHERE task_id = ?',
      task_id
    );
    if (scene) {
      const status =
        scene.asset_status === 'completed'
          ? 'completed'
          : scene.asset_status === 'failed'
            ? 'failed'
            : scene.asset_status === 'generating'
              ? 'processing'
              : scene.asset_status;
      return {
        task_id,
        scene_id: scene.id,
        status,
        image_url: scene.asset_url || null,
        detail: 'Recovered from scene row (no generation_task memory)'
      };
    }
    return {
      task_id,
      status: 'UNKNOWN',
      detail: 'Task was not found in this server process or generation_task table'
    };
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
    // Hijacked responses bypass Fastify's normal CORS onSend hook — mirror policy.
    const allowLan =
      process.env.NOVASTORY_ALLOW_LAN === '1' || process.env.NOVASTORY_ALLOW_LAN === 'true';
    const origin = request.headers.origin;
    if (allowLan) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else if (
      !origin
      || origin === 'http://127.0.0.1:3000'
      || origin === 'http://localhost:3000'
    ) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin || 'http://127.0.0.1:3000');
    }

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

    let closed = false;
    const endStream = () => {
      if (closed) return;
      closed = true;
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    };

    const writeEvent = (payload: unknown) => {
      if (closed) return;
      try {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        /* ignore */
      }
    };

    reply.raw.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Initial check just in case it already finished
    const task = await AssetTaskStore.get(task_id);
    if (task?.status === 'completed' && task.image_url) {
        writeEvent({
          type: 'complete',
          status: 'completed',
          image_url: task.image_url,
          ...parseProgressMetadata(task.progress_json),
        });
        if (redis) redis.disconnect();
        endStream();
        return;
    } else if (task?.status === 'failed' || task?.status === 'cancelled' || task?.status === 'interrupted') {
        writeEvent({ type: 'complete', status: 'failed', error: task.error || 'Generation failed' });
        if (redis) redis.disconnect();
        endStream();
        return;
    }

    // Replay last known progress phase (e.g. client connected mid-handoff)
    if (task?.progress_json) {
      try {
        const progress = JSON.parse(task.progress_json);
        if (progress?.type) writeEvent(progress);
      } catch {
        /* ignore */
      }
    }

    const scene = await db.get('SELECT * FROM scene WHERE task_id = ?', task_id);
    if (scene && scene.asset_status === 'completed' && scene.asset_url) {
        writeEvent({ type: 'complete', status: 'completed', image_url: scene.asset_url });
        if (redis) redis.disconnect();
        endStream();
        return;
    } else if (scene && scene.asset_status === 'failed') {
        writeEvent({ type: 'complete', status: 'failed', error: 'Generation failed' });
        if (redis) redis.disconnect();
        endStream();
        return;
    }

    // In-process bus: real-time VRAM handoff + progress without Redis
    const unsubBus = subscribeTaskProgress(task_id, (payload) => {
      writeEvent(payload);
      if (
        payload.type === 'complete'
        || payload.status === 'completed'
        || payload.status === 'failed'
      ) {
        if (redis) {
          try {
            redis.disconnect();
          } catch {
            /* ignore */
          }
        }
        endStream();
      }
    });

    if (redis) {
      redis.on('message', (chan, message) => {
          if (chan === channel) {
              // Prefer bus when both fire; still accept Redis for multi-process setups
              try {
                  const dataDict = JSON.parse(message);
                  writeEvent(dataDict);
                  if (dataDict.type === 'complete' || ['completed', 'failed'].includes(dataDict.status)) {
                      redis!.disconnect();
                      endStream();
                  }
              } catch (e) {
                  reply.raw.write(`data: ${message}\n\n`);
              }
          }
      });

      redis.on('error', (err) => {
          logger.error(`Redis error in SSE: ${err}`);
      });
    }

    // Poll fallback for completion + progress_json (covers process restart / missed bus events)
    let lastProgressJson = task?.progress_json || '';
    const pollInterval = setInterval(async () => {
        if (closed) {
          clearInterval(pollInterval);
          return;
        }
        const taskState = await AssetTaskStore.get(task_id);
        if (taskState?.progress_json && taskState.progress_json !== lastProgressJson) {
          lastProgressJson = taskState.progress_json;
          try {
            writeEvent(JSON.parse(taskState.progress_json));
          } catch {
            /* ignore */
          }
        }
        if (taskState?.status === 'completed' && taskState.image_url) {
            writeEvent({ type: 'complete', status: 'completed', image_url: taskState.image_url });
            clearInterval(pollInterval);
            endStream();
            return;
        } else if (
          taskState?.status === 'failed'
          || taskState?.status === 'cancelled'
          || taskState?.status === 'interrupted'
        ) {
            writeEvent({ type: 'complete', status: 'failed', error: taskState.error || 'Generation failed' });
            clearInterval(pollInterval);
            endStream();
            return;
        }

        const checkScene = await db.get('SELECT * FROM scene WHERE task_id = ?', task_id);
        if (checkScene && checkScene.asset_status === 'completed' && checkScene.asset_url) {
            writeEvent({ type: 'complete', status: 'completed', image_url: checkScene.asset_url });
            clearInterval(pollInterval);
            endStream();
        } else if (checkScene && checkScene.asset_status === 'failed') {
            writeEvent({ type: 'complete', status: 'failed', error: 'Generation failed' });
            clearInterval(pollInterval);
            endStream();
        }
    }, 1500);

    reply.raw.on('close', () => {
        logger.info(`SSE Client disconnected: ${task_id}`);
        closed = true;
        clearInterval(pollInterval);
        unsubBus();
        if (redis) {
          try {
            redis.disconnect();
          } catch {
            /* ignore */
          }
        }
    });
  });

  app.post('/cancel', async (request, reply) => {
    logger.info('Cancel asset generation endpoint triggered.');
    try {
      const bodySchema = z.object({
        task_id: z.string().min(1).optional(),
        prompt_id: z.string().min(1).optional()
      });
      const body = bodySchema.parse(request.body || {});

      if (!body.task_id && !body.prompt_id) {
        return reply.status(400).send({
          status: 'error',
          message: 'task_id or prompt_id is required; unscoped ComfyUI cancellation is forbidden'
        });
      }

      const settings = SettingsManager.loadSettings();
      const comfySettings = settings.comfyui || {};
      const baseUrl = comfySettings.base_url || 'http://127.0.0.1:8188';
      const comfyService = new ComfyUIService(baseUrl);

      let promptId = body.prompt_id || null;
      let taskId = body.task_id || null;
      let sceneId = 0;
      let task = null as Awaited<ReturnType<typeof AssetTaskStore.get>> | null;

      // prompt_id-only cancellation is accepted only when the prompt belongs to a
      // canonical non-video generation_task. This prevents the image endpoint from
      // being used to interrupt an H3 prompt by guessing/providing its prompt id.
      if (!taskId && promptId) {
        const owner = await db.get(
          `SELECT task_id FROM generation_task
           WHERE comfy_prompt_id = ?
             AND COALESCE(kind, 'image') <> 'video'
           LIMIT 1`,
          promptId
        );
        if (!owner?.task_id) {
          return reply.status(404).send({
            status: 'error',
            comfy_prompt_id: promptId,
            message: 'No owned static-image task matches this prompt_id'
          });
        }
        taskId = String(owner.task_id);
      }

      if (taskId) {
        task = await AssetTaskStore.get(taskId) || null;
        if (!task) {
          return reply.status(404).send({
            status: 'error',
            task_id: taskId,
            message: `Asset generation task ${taskId} was not found`
          });
        }

        sceneId = task.scene_id;
        const guardedPromptId = GpuLeaseService.getGuardedPromptId(taskId);
        const canonicalPromptId = task.comfy_prompt_id || guardedPromptId;

        if (body.prompt_id && canonicalPromptId && body.prompt_id !== canonicalPromptId) {
          return reply.status(409).send({
            status: 'error',
            task_id: taskId,
            comfy_prompt_id: canonicalPromptId,
            message: 'prompt_id does not belong to the supplied task_id'
          });
        }
        if (canonicalPromptId) promptId = canonicalPromptId;

        if (task.status !== 'processing') {
          return {
            status: 'noop',
            task_id: taskId,
            comfy_prompt_id: promptId,
            message: `Task is already terminal (${task.status}); no ComfyUI interrupt attempted`
          };
        }
      }

      // The task may still be waiting for a GPU lease or may own the image lease but
      // have not submitted /prompt yet. Prove that ownership first. Mark cancelled
      // BEFORE rejecting a queued waiter so a resumed worker cannot win the CAS race
      // by reporting failed. For an active pre-prompt owner, retain the lease until
      // the worker observes cancellation and unwinds its finally block; releasing it
      // here would create a narrow cancel-vs-/prompt overlap window with the next H3.
      if (taskId && !promptId) {
        const queued = GpuLeaseService.isQueued(taskId);
        const activeLease = GpuLeaseService.getCurrentLease();
        const ownsActiveImageLease = Boolean(
          activeLease
          && activeLease.owner_task_id === taskId
          && activeLease.kind === 'image'
        );

        if (!queued && !ownsActiveImageLease) {
          return reply.status(409).send({
            status: 'failed',
            task_id: taskId,
            message: 'Task has no owned queued/active image lease and no Comfy prompt to cancel'
          });
        }

        await AssetTaskStore.cancelled(taskId, sceneId, 'Cancelled before ComfyUI prompt submission');
        const cancelledQueuedLease = queued
          ? GpuLeaseService.cancelQueuedTask(taskId)
          : false;

        if (sceneId > 0 && sceneId < 90_000_000) {
          await db.run(
            `UPDATE scene SET asset_status = ? WHERE id = ? AND task_id = ? AND asset_status = 'generating'`,
            'failed',
            sceneId,
            taskId
          );
        }

        return {
          status: 'success',
          task_id: taskId,
          comfy_prompt_id: null,
          deleted_from_queue: cancelledQueuedLease,
          interrupted: false,
          message: cancelledQueuedLease
            ? 'Cancelled while waiting for GPU lease'
            : 'Cancellation recorded before ComfyUI prompt submission; active lease retained until worker unwind'
        };
      }

      const result = await comfyService.cancelExecution(promptId);
      if (!result.ok) {
        // Do not declare the task cancelled while Comfy ownership is still unknown or
        // confirmed active. In particular, never free the GPU merely because the UI
        // requested cancellation.
        return reply.status(409).send({
          status: 'failed',
          task_id: taskId,
          comfy_prompt_id: promptId,
          deleted_from_queue: result.deleted_from_queue,
          interrupted: result.interrupted,
          message: result.message
        });
      }

      if (taskId) {
        await AssetTaskStore.cancelled(
          taskId,
          sceneId,
          `Cancelled: ${result.message}`
        );

        const activeLease = GpuLeaseService.getCurrentLease();
        if (activeLease?.owner_task_id === taskId && activeLease.kind === 'image') {
          // cancelExecution() only reports ok after prompt absence is confirmed, so
          // this exact-id release is now safe and unblocks a queued H3 immediately.
          GpuLeaseService.releaseLease(activeLease.lease_id, taskId);
        }

        if (sceneId > 0 && sceneId < 90_000_000) {
          await db.run(
            `UPDATE scene SET asset_status = ? WHERE id = ? AND task_id = ? AND asset_status = 'generating'`,
            'failed',
            sceneId,
            taskId
          );
        }
      }

      return {
        status: 'success',
        task_id: taskId,
        comfy_prompt_id: promptId,
        deleted_from_queue: result.deleted_from_queue,
        interrupted: result.interrupted,
        message: result.message
      };
    } catch (error: any) {
      logger.error(`Error cancelling asset generation: ${error}`);
      return reply.status(500).send({ status: 'error', message: error.toString() });
    }
  });
};
