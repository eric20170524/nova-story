import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/database';
import { z } from 'zod';
import { LLMService } from '../services/llm';

export const timelineRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:chapter_id', async (request, reply) => {
    const paramsSchema = z.object({ chapter_id: z.string() });
    const { chapter_id } = paramsSchema.parse(request.params);

    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapter_id);
    if (!chapter) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    const scenes = await db.all('SELECT * FROM scene WHERE chapter_id = ? ORDER BY `index` ASC', chapter_id);

    return {
      chapter_id: chapter.id,
      storyboard_mode: 'narrative',
      timeline: scenes
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

    // Extract character profiles
    const characters = await db.all('SELECT * FROM character WHERE project_id = ?', chapter.project_id);
    let charProfilesStr = "";

    if (characters && characters.length > 0) {
      const profiles = characters.map(c => {
        let tags = typeof c.visual_tags === 'string' ? JSON.parse(c.visual_tags) : (c.visual_tags || {});
        let tagStr = "";

        if (tags && tags.base_model) {
           let baseTags = tags.base_model.tags || {};
           if (typeof baseTags === 'string') baseTags = { base: baseTags };
           let activeVariantTags = {};

           const timelineMap = tags.timeline_map || {};
           let activeVariantId = timelineMap[chapter.id];
           const variants = tags.variants || [];

           if (!activeVariantId && variants.length > 0) {
               activeVariantId = variants[0].id;
           }

           if (activeVariantId) {
               const variant = variants.find((v: any) => v.id === activeVariantId);
               if (variant) {
                   activeVariantTags = variant.tags || {};
                   if (typeof activeVariantTags === 'string') activeVariantTags = { variant: activeVariantTags };
               }
           }

           const combined = { ...baseTags, ...activeVariantTags };
           tagStr = Object.entries(combined).map(([k, v]) => `${k}: ${v}`).join(', ');
        } else if (tags) {
           tagStr = Object.entries(tags).map(([k, v]) => `${k}: ${v}`).join(', ');
        }

        return `- Name: ${c.name}\n  Description: ${c.description}\n  Visual Tags: ${tagStr}`;
      });
      charProfilesStr = profiles.join('\n');
    }

    // Attempt to generate timeline via LLM
    let timelineData: any[] = [];
    try {
      // Dummy token injection could be handled in interceptors
      const token = undefined;
      timelineData = await LLMService.generateTimeline(chapter.content, charProfilesStr, 'narrative', token);
    } catch (error: any) {
      return reply.status(500).send({ detail: `Failed to generate timeline: ${error.message}` });
    }

    if (!timelineData || timelineData.length === 0) {
      return reply.status(500).send({ detail: "LLM returned empty timeline data" });
    }

    // Delete existing and insert new within a try/catch
    try {
      await db.run('BEGIN TRANSACTION');
      await db.run('DELETE FROM scene WHERE chapter_id = ?', chapter.id);

      const newScenes = [];
      for (let i = 0; i < timelineData.length; i++) {
         const item = timelineData[i];
         const result = await db.run(`
            INSERT INTO scene (
               chapter_id, \`index\`, visual_prompt, audio_prompt, dialogue, duration, shot_type, camera_movement, camera_angle, negative_prompt, asset_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle')
         `,
         chapter.id,
         i + 1,
         item.visual_prompt || "",
         item.audio_prompt || "",
         item.dialogue || "",
         item.duration || 3.0,
         item.shot_type || "",
         item.camera_movement || "",
         item.camera_angle || "",
         item.negative_prompt || null);

         const newScene = await db.get('SELECT * FROM scene WHERE id = ?', result.lastID);
         newScenes.push(newScene);
      }

      await db.run('COMMIT');

      return {
        chapter_id: chapter.id,
        storyboard_mode: 'narrative',
        timeline: newScenes
      };

    } catch (error: any) {
      await db.run('ROLLBACK');
      return reply.status(500).send({ detail: `Failed to save generated scenes to database: ${error.message}` });
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
    }

    const updatedScene = await db.get('SELECT * FROM scene WHERE id = ?', scene_id);
    return updatedScene;
  });
};
