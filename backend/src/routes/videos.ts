import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  VideoPreflightRequestSchema,
  VideoGenerationRequestSchema,
  VideoPromoteRequestSchema,
  VideoReprocessRequestSchema
} from '../schemas/video';
import { VideoGenerationService } from '../services/video/video_generation_service';
import { MediaAssetService } from '../services/video/media_asset_service';
import { VideoPostprocessService } from '../services/video/video_postprocess_service';
import { LoopCloser } from '../services/video/loop_closer';
import { subscribeTaskProgress } from '../services/task_progress_bus';
import { getGeneratedDirectory } from '../core/paths';

export const videoRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // GET /api/videos/capabilities
  fastify.get('/capabilities', async () => {
    return VideoGenerationService.getCapabilities();
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
    const preflight = await VideoGenerationService.preflight(parseResult.data as any);
    return preflight;
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

    // Only allow uploading references and keyframes via upload endpoint.
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
    const asset = await MediaAssetService.createAsset({
      project_id: Number(body.project_id || 1),
      scene_id: body.scene_id != null ? Number(body.scene_id) : undefined,
      scene_version: body.scene_version != null ? Number(body.scene_version) : 1,
      character_id: body.character_id != null ? Number(body.character_id) : undefined,
      media_type: body.media_type || 'image',
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

    try {
      const result = await VideoGenerationService.createTask(parseResult.data);
      return reply.status(202).send(result);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message || String(err) });
    }
  });

  // GET /api/videos/tasks/:task_id
  fastify.get('/tasks/:task_id', async (request, reply) => {
    const { task_id } = request.params as { task_id: string };
    const task = await VideoGenerationService.getTask(task_id);
    if (!task) {
      return reply.status(404).send({ error: `Task ${task_id} not found` });
    }
    return task;
  });

  // GET /api/videos/tasks/:task_id/stream
  fastify.get('/tasks/:task_id/stream', (request, reply) => {
    const { task_id } = request.params as { task_id: string };

    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    const allowLan = process.env.NOVASTORY_ALLOW_LAN === '1' || process.env.NOVASTORY_ALLOW_LAN === 'true';
    const origin = request.headers.origin;
    if (allowLan) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    reply.raw.flushHeaders?.();

    // Send initial snapshot
    VideoGenerationService.getTask(task_id).then((task) => {
      if (task) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'snapshot', task })}\n\n`);
      }
    });

    const unsubscribe = subscribeTaskProgress(task_id, (payload) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {}
    });

    request.raw.on('close', () => {
      unsubscribe();
    });
  });

  // POST /api/videos/tasks/:task_id/cancel
  fastify.post('/tasks/:task_id/cancel', async (request, reply) => {
    const { task_id } = request.params as { task_id: string };
    const ok = await VideoGenerationService.cancelTask(task_id);
    return { ok, task_id };
  });

  // GET /api/scenes/:scene_id/media
  fastify.get('/scenes/:scene_id/media', async (request, reply) => {
    const { scene_id } = request.params as { scene_id: string };
    const version = (request.query as any)?.version ? Number((request.query as any).version) : undefined;
    const assets = await MediaAssetService.listAssetsByScene(Number(scene_id), version);
    return { scene_id: Number(scene_id), assets };
  });

  // POST /api/videos/assets/:asset_id/promote
  fastify.post('/assets/:asset_id/promote', async (request, reply) => {
    const { asset_id } = request.params as { asset_id: string };
    try {
      const asset = await MediaAssetService.promoteAsset(Number(asset_id));
      return asset;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message || String(err) });
    }
  });

  // POST /api/videos/assets/:asset_id/reprocess
  fastify.post('/assets/:asset_id/reprocess', async (request, reply) => {
    const { asset_id } = request.params as { asset_id: string };
    const asset = await MediaAssetService.getAssetById(Number(asset_id));
    if (!asset || asset.role !== 'raw_video') {
      return reply.status(400).send({ error: 'Asset must be an existing raw_video asset' });
    }

    const runLoopCloser = (request.body as any)?.run_loop_closer !== false;
    const rawPath = MediaAssetService.resolveSafePath(asset.url);
    const outputDir = path.dirname(rawPath);
    const taskId = path.basename(outputDir);

    const result = await LoopCloser.process({
      taskId,
      profile: asset.profile || 'character_loop',
      rawVideoPath: rawPath,
      outputDirectory: outputDir,
      runLoopCloser
    });

    return { ok: true, result };
  });
};
