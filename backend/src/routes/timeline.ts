import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/database';
import { z } from 'zod';
import {
  activateSceneVersion,
  annotateScenesWithVersions,
  annotateSceneWithVersions,
  createSceneVersion,
  listSceneVersions,
  syncActiveVersionFromScene
} from '../services/scene_versions';
import { generateAndReplaceNarrativeTimeline } from '../services/timeline_generation_service';

export const timelineRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:chapter_id', async (request, reply) => {
    const paramsSchema = z.object({ chapter_id: z.string() });
    const { chapter_id } = paramsSchema.parse(request.params);

    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapter_id);
    if (!chapter) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    const scenes = await db.all('SELECT * FROM scene WHERE chapter_id = ? ORDER BY `index` ASC', chapter_id);
    const timeline = await annotateScenesWithVersions(scenes || []);

    return {
      chapter_id: chapter.id,
      storyboard_mode: 'narrative',
      timeline
    };
  });

  app.post('/generate', async (request, reply) => {
    const bodySchema = z.object({
      chapter_id: z.string(),
      mode: z.string().default('narrative').optional().nullable()
    });

    const req = bodySchema.parse(request.body);
    const rawMode = (req.mode || 'narrative').toLowerCase();

    if (['cinematic_grid', 'nine_shot_coverage'].includes(rawMode)) {
      return reply.status(400).send({
        detail: "Chapter-level nine_shot_coverage is deprecated. Please generate 9-shot coverage on individual scenes via /api/scenes/{scene_id}/coverage instead."
      });
    }

    if (!['narrative', 'standard'].includes(rawMode)) {
      return reply.status(400).send({
        detail: `Invalid mode '${req.mode}'. Chapter-level auto-storyboard only supports 'narrative' mode.`
      });
    }

    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', req.chapter_id);
    if (!chapter) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    if (!chapter.content) {
      return reply.status(400).send({ detail: 'Chapter has no content' });
    }

    try {
      const result = await generateAndReplaceNarrativeTimeline({
        chapterId: chapter.id,
        projectId: chapter.project_id,
        content: chapter.content,
        mode: rawMode,
      });
      return {
        chapter_id: result.chapter_id,
        storyboard_mode: result.storyboard_mode,
        timeline: result.timeline,
      };
    } catch (error: any) {
      const message = error?.message || String(error);
      return reply.status(500).send({
        detail: message.startsWith('Failed')
          ? message
          : `Failed to generate timeline: ${message}`,
      });
    }
  });

  app.put('/scene/:scene_id', async (request, reply) => {
    const paramsSchema = z.object({ scene_id: z.coerce.number() });
    const { scene_id } = paramsSchema.parse(request.params);

    const bodySchema = z.object({
      visual_prompt: z.string().optional().nullable(),
      audio_prompt: z.string().optional().nullable(),
      dialogue: z.string().optional().nullable(),
      duration: z.coerce.number().optional().nullable(),
      shot_type: z.string().optional().nullable(),
      camera_movement: z.string().optional().nullable(),
      camera_angle: z.string().optional().nullable(),
      negative_prompt: z.string().optional().nullable()
    });

    const data = bodySchema.parse(request.body);

    const scene = await db.get('SELECT * FROM scene WHERE id = ?', scene_id);
    if (!scene) {
      return reply.status(404).send({ detail: 'Scene not found' });
    }

    const updateFields = [];
    const params = [];

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        updateFields.push(`${key} = ?`);
        params.push(value);
      }
    }

    if (updateFields.length > 0) {
      params.push(scene_id);
      await db.run(`UPDATE scene SET ${updateFields.join(', ')} WHERE id = ?`, ...params);
      await syncActiveVersionFromScene(scene_id);
    }

    const updatedScene = await db.get('SELECT * FROM scene WHERE id = ?', scene_id);
    return annotateSceneWithVersions(updatedScene);
  });

  // --- Scene versions (A/B test copy + images) ---

  app.get('/scene/:scene_id/versions', async (request, reply) => {
    const { scene_id } = z.object({ scene_id: z.coerce.number() }).parse(request.params);
    const scene = await db.get('SELECT * FROM scene WHERE id = ?', scene_id);
    if (!scene) return reply.status(404).send({ detail: 'Scene not found' });
    const versions = await listSceneVersions(scene_id);
    return {
      scene_id,
      active_version: Number(scene.active_version || 1),
      versions
    };
  });

  app.post('/scene/:scene_id/versions', async (request, reply) => {
    const { scene_id } = z.object({ scene_id: z.coerce.number() }).parse(request.params);
    const body = z
      .object({
        from_version: z.coerce.number().optional().nullable(),
        clear_asset: z.boolean().optional().default(true),
        label: z.string().optional().nullable(),
        activate: z.boolean().optional().default(true)
      })
      .parse(request.body || {});

    const scene = await db.get('SELECT * FROM scene WHERE id = ?', scene_id);
    if (!scene) return reply.status(404).send({ detail: 'Scene not found' });

    const created = await createSceneVersion(scene_id, {
      fromVersion: body.from_version,
      clearAsset: body.clear_asset,
      label: body.label,
      activate: body.activate
    });
    if (!created) return reply.status(500).send({ detail: 'Failed to create version' });

    const annotated = await annotateSceneWithVersions(
      await db.get('SELECT * FROM scene WHERE id = ?', scene_id)
    );
    return {
      scene: annotated,
      version: created.version,
      versions: annotated.versions
    };
  });

  app.post('/scene/:scene_id/versions/:version/activate', async (request, reply) => {
    const params = z
      .object({ scene_id: z.coerce.number(), version: z.coerce.number() })
      .parse(request.params);
    const scene = await activateSceneVersion(params.scene_id, params.version);
    if (!scene) return reply.status(404).send({ detail: 'Version not found' });
    return annotateSceneWithVersions(scene);
  });
};
