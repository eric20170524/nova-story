import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_VIDEO_WORKFLOW_ID,
  VideoPreflightRequestSchema,
  VideoGenerationRequestSchema,
  VideoReprocessRequestSchema,
  VideoWorkflowIdSchema
} from '../schemas/video';
import { VideoGenerationService } from '../services/video/video_generation_service';
import { VideoRuntimeInspector } from '../services/video/video_runtime_inspector';
import { MediaAssetService } from '../services/video/media_asset_service';
import { VideoPostprocessService } from '../services/video/video_postprocess_service';
import { subscribeTaskProgress } from '../services/task_progress_bus';
import { getGeneratedDirectory } from '../core/paths';

const taskForClient = <T extends Record<string, any> | null>(task: T): T => {
  if (!task || task.status !== 'review_required') return task;
  // Legacy Director terminal handling does not yet recognize review_required.
  // Preserve the semantic stage/QA while reporting completion so the client stops
  // polling and reloads the review_required MediaAsset instead of hanging forever.
  return { ...task, status: 'completed', stage: 'review_required' } as T;
};

export const videoRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // GET /api/videos/capabilities?workflow_id=...
  fastify.get('/capabilities', async (request, reply) => {
    const rawWorkflow = (request.query as any)?.workflow_id || DEFAULT_VIDEO_WORKFLOW_ID;
    const parsedWorkflow = VideoWorkflowIdSchema.safeParse(rawWorkflow);
    if (!parsedWorkflow.success) {
      return reply.status(400).send({ error: `Unknown video workflow '${rawWorkflow}'` });
    }
    return VideoRuntimeInspector.inspect(parsedWorkflow.data);
  });

  // POST /api/videos/preflight
  fastify.post('/preflight', async (request, reply) => {
    const parseResult = VideoPreflightRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid video preflight request',
        details: parseResult.error.flatten()
      });
    }

    const [inputPreflight, runtime] = await Promise.all([
      VideoGenerationService.preflight(parseResult.data as any),
      VideoRuntimeInspector.inspect(parseResult.data.workflow_id)
    ]);

    const blockers = [...new Set([
      ...inputPreflight.blockers,
      ...runtime.missing_components
    ])];
    const warnings = [...inputPreflight.warnings];
    if (runtime.workflow_stability !== 'stable') {
      warnings.push(
        `Workflow ${runtime.workflow_id} is ${runtime.workflow_stability}; real-machine validation is required before production promotion.`
      );
    }

    return {
      ...inputPreflight,
      ready: inputPreflight.ready && runtime.video_generation_enabled,
      blockers,
      warnings,
      runtime: {
        workflow_id: runtime.workflow_id,
        workflow_family: runtime.workflow_family,
        workflow_stability: runtime.workflow_stability,
        comfyui_online: runtime.comfyui_online,
        h3_workflow_ready: runtime.h3_workflow_ready,
        ffmpeg_available: runtime.ffmpeg_available,
        ffprobe_available: runtime.ffprobe_available,
        missing_components: runtime.missing_components
      }
    };
  });

  // POST /api/videos/references/upload
  fastify.post('/references/upload', async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: 'Please upload the file as multipart/form-data' });
    }
    const data = await request.file({ limits: { fileSize: 150 * 1024 * 1024 } });
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const fields = data.fields as any;
    const projectId = Number(fields.project_id?.value || 1);
    const sceneId = fields.scene_id?.value ? Number(fields.scene_id.value) : undefined;
    const characterId = fields.character_id?.value ? Number(fields.character_id.value) : undefined;
    const role = fields.role?.value || 'character_reference';

    const allowedRoles = ['character_reference', 'motion_reference', 'video_keyframe'];
    if (!allowedRoles.includes(role)) {
      return reply.status(400).send({ error: `Direct upload not allowed for role '${role}'. Allowed roles: ${allowedRoles.join(', ')}` });
    }

    const mediaType = data.mimetype.startsWith('video/') ? 'video' : 'image';
    const requiredMediaType = role === 'motion_reference' ? 'video' : 'image';
    if (mediaType !== requiredMediaType) {
      return reply.status(400).send({
        error: `Role '${role}' requires media_type '${requiredMediaType}', received '${mediaType}'`
      });
    }

    const ext = path.extname(data.filename) || (mediaType === 'video' ? '.mp4' : '.png');
    const safeBase = `ref_${randomUUID().slice(0, 12)}${ext}`;
    const uploadDir = path.join(getGeneratedDirectory(), 'references', String(projectId));
    fs.mkdirSync(uploadDir, { recursive: true });
    const targetPath = path.join(uploadDir, safeBase);

    const buffer = await data.toBuffer();
    fs.writeFileSync(targetPath, buffer);

    const sha256 = MediaAssetService.computeBufferSha256(buffer);
    let probeInfo = null;
    let width: number | undefined;
    let height: number | undefined;
    let fps: number | undefined;
    let durationMs: number | undefined;

    if (mediaType === 'video') {
      try {
        probeInfo = await VideoPostprocessService.probeVideo(targetPath);
        width = probeInfo.width;
        height = probeInfo.height;
        fps = probeInfo.fps;
        durationMs = Math.round(probeInfo.duration_s * 1000);
      } catch (err: any) {
        try { fs.unlinkSync(targetPath); } catch {}
        return reply.status(400).send({
          error: `Uploaded video validation failed: ${err?.message || err}`
        });
      }
    }

    const asset = await MediaAssetService.createAsset({
      project_id: projectId,
      scene_id: sceneId,
      character_id: characterId,
      media_type: mediaType,
      role: role as any,
      status: 'ready',
      url: `/static/generated/references/${projectId}/${safeBase}`,
      mime_type: data.mimetype,
      width,
      height,
      fps,
      duration_ms: durationMs,
      sha256,
      metadata_json: probeInfo ? JSON.stringify({ probe: probeInfo }) : undefined
    });

    return asset;
  });

  // POST /api/videos/assets/register
  fastify.post('/assets/register', async (request, reply) => {
    const body = request.body as any;
    if (!body || !body.url || !body.role) {
      return reply.status(400).send({ error: 'Missing required asset fields (url, role)' });
    }

    const allowedRoles = ['character_reference', 'motion_reference', 'video_keyframe'];
    if (!allowedRoles.includes(body.role)) {
      return reply.status(400).send({
        error: `External asset registration not allowed for role '${body.role}'`
      });
    }
    const mediaType = body.media_type || 'image';
    const requiredMediaType = body.role === 'motion_reference' ? 'video' : 'image';
    if (mediaType !== requiredMediaType) {
      return reply.status(400).send({
        error: `Role '${body.role}' requires media_type '${requiredMediaType}', received '${mediaType}'`
      });
    }

    const asset = await MediaAssetService.createAsset({
      project_id: Number(body.project_id || 1),
      scene_id: body.scene_id != null ? Number(body.scene_id) : undefined,
      scene_version: body.scene_version != null ? Number(body.scene_version) : 1,
      character_id: body.character_id != null ? Number(body.character_id) : undefined,
      media_type: mediaType,
      role: body.role,
      profile: body.profile,
      status: body.status || 'ready',
      url: body.url,
      mime_type: body.mime_type,
      width: body.width,
      height: body.height,
      fps: body.fps,
      duration_ms: body.duration_ms,
      sha256: body.sha256,
      parent_asset_id: body.parent_asset_id,
      metadata_json: body.metadata_json
    });
    return asset;
  });

  // POST /api/videos/generate
  fastify.post('/generate', async (request, reply) => {
    const parseResult = VideoGenerationRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid video generation request',
        details: parseResult.error.flatten()
      });
    }

    const runtime = await VideoRuntimeInspector.inspect(parseResult.data.workflow_id);
    if (!runtime.video_generation_enabled) {
      return reply.status(503).send({
        error: 'Video runtime is not ready',
        workflow_id: runtime.workflow_id,
        missing_components: runtime.missing_components
      });
    }

    try {
      const result = await VideoGenerationService.createTask(parseResult.data);
      return reply.status(202).send(result);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message || String(err) });
    }
  });

  fastify.get('/tasks/:task_id', async (request, reply) => {
    const { task_id } = request.params as { task_id: string };
    const task = await VideoGenerationService.getTask(task_id);
    if (!task) {
      return reply.status(404).send({ error: `Task ${task_id} not found` });
    }
    return taskForClient(task);
  });

  fastify.get('/tasks/:task_id/stream', (request, reply) => {
    const { task_id } = request.params as { task_id: string };

    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    const origin = request.headers.origin;
    reply.raw.setHeader('Access-Control-Allow-Origin', origin || '*');
    reply.raw.flushHeaders?.();

    VideoGenerationService.getTask(task_id).then((task) => {
      if (task) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'snapshot', task: taskForClient(task) })}\n\n`);
      }
    });

    const unsubscribe = subscribeTaskProgress(task_id, (payload) => {
      try {
        const outgoing = payload?.status === 'review_required'
          ? { ...payload, status: 'completed', stage: 'review_required' }
          : payload;
        reply.raw.write(`data: ${JSON.stringify(outgoing)}\n\n`);
      } catch {}
    });

    request.raw.on('close', () => unsubscribe());
  });

  fastify.post('/tasks/:task_id/cancel', async (request, reply) => {
    const { task_id } = request.params as { task_id: string };
    const ok = await VideoGenerationService.cancelTask(task_id);
    return { ok, task_id };
  });

  fastify.get('/scenes/:scene_id/media', async (request, reply) => {
    const { scene_id } = request.params as { scene_id: string };
    const version = (request.query as any)?.version ? Number((request.query as any).version) : undefined;
    const assets = await MediaAssetService.listAssetsByScene(Number(scene_id), version);
    return { scene_id: Number(scene_id), assets };
  });

  fastify.post('/assets/:asset_id/promote', async (request, reply) => {
    const { asset_id } = request.params as { asset_id: string };
    try {
      const asset = await MediaAssetService.promoteAsset(Number(asset_id));
      return asset;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message || String(err) });
    }
  });

  fastify.post('/assets/:asset_id/reprocess', async (request, reply) => {
    const { asset_id } = request.params as { asset_id: string };
    const parsed = VideoReprocessRequestSchema.safeParse({
      asset_id: Number(asset_id),
      run_loop_closer: (request.body as any)?.run_loop_closer
    });
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid reprocess request',
        details: parsed.error.flatten()
      });
    }

    try {
      return await VideoGenerationService.reprocessAsset(
        parsed.data.asset_id,
        parsed.data.run_loop_closer
      );
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message || String(err) });
    }
  });
};
