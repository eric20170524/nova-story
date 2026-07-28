import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/database';
import { LLMService } from '../services/llm';

const serializeGroup = async (group: any) => ({
  ...group,
  shots: await db.all(
    'SELECT * FROM coverage_shot WHERE coverage_group_id = ? ORDER BY slot ASC',
    group.id
  )
});

export const coverageRoutes: FastifyPluginAsync = async (app) => {
  app.post('/scenes/:scene_id/coverage', async (request, reply) => {
    const { scene_id } = z.object({
      scene_id: z.coerce.number().int()
    }).parse(request.params);
    const sourceScene = await db.get('SELECT * FROM scene WHERE id = ?', scene_id);
    if (!sourceScene) {
      return reply.status(404).send({ detail: 'Source scene not found' });
    }

    const chapter = await db.get(
      'SELECT project_id FROM chapter WHERE id = ?',
      sourceScene.chapter_id
    );
    const characters = chapter
      ? await db.all(
          'SELECT name, description FROM character WHERE project_id = ? ORDER BY id ASC',
          chapter.project_id
        )
      : [];
    const characterProfiles = characters
      .map((character: any) => `- Name: ${character.name}\n  Description: ${character.description || ''}`)
      .join('\n');

    const candidates = await LLMService.generateSceneCoverage(
      sourceScene,
      characterProfiles
    );
    if (candidates.length !== 9) {
      return reply.status(500).send({
        detail: 'Coverage generation failed to return 9 candidate shots'
      });
    }

    const latestGroup = await db.get(
      `SELECT version FROM coverage_group
       WHERE source_scene_id = ?
       ORDER BY version DESC LIMIT 1`,
      scene_id
    );

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const groupResult = await db.run(
        `INSERT INTO coverage_group (source_scene_id, version, status)
         VALUES (?, ?, 'completed')`,
        scene_id,
        Number(latestGroup?.version || 0) + 1
      );
      const groupId = Number(groupResult.lastID);

      for (const [index, candidate] of candidates.entries()) {
        await db.run(
          `INSERT INTO coverage_shot (
             coverage_group_id, slot, shot_size, camera_angle,
             camera_movement, narrative_purpose, visual_prompt, asset_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle')`,
          groupId,
          candidate.slot || index + 1,
          candidate.shot_size || candidate.shot_type || 'Medium Shot',
          candidate.camera_angle || 'Eye-level',
          candidate.camera_movement || 'Static',
          candidate.narrative_purpose || '',
          candidate.visual_prompt || ''
        );
      }

      await db.exec('COMMIT');
      return serializeGroup(
        await db.get('SELECT * FROM coverage_group WHERE id = ?', groupId)
      );
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  });

  app.get('/scenes/:scene_id/coverage', async (request) => {
    const { scene_id } = z.object({
      scene_id: z.coerce.number().int()
    }).parse(request.params);
    const groups = await db.all(
      `SELECT * FROM coverage_group
       WHERE source_scene_id = ?
       ORDER BY version DESC`,
      scene_id
    );
    return Promise.all(groups.map(serializeGroup));
  });

  app.post('/scenes/coverage/:shot_id/apply', async (request, reply) => {
    const { shot_id } = z.object({
      shot_id: z.coerce.number().int()
    }).parse(request.params);
    const candidate = await db.get(
      `SELECT coverage_shot.*, coverage_group.source_scene_id
       FROM coverage_shot
       INNER JOIN coverage_group
         ON coverage_group.id = coverage_shot.coverage_group_id
       WHERE coverage_shot.id = ?`,
      shot_id
    );
    if (!candidate) {
      return reply.status(404).send({ detail: 'Candidate shot not found' });
    }

    await db.run(
      `UPDATE scene
       SET shot_type = ?, camera_angle = ?, camera_movement = ?,
           visual_prompt = COALESCE(?, visual_prompt)
       WHERE id = ?`,
      candidate.shot_size,
      candidate.camera_angle,
      candidate.camera_movement,
      candidate.visual_prompt || null,
      candidate.source_scene_id
    );
    const scene = await db.get(
      'SELECT * FROM scene WHERE id = ?',
      candidate.source_scene_id
    );
    return {
      status: 'success',
      message: 'Candidate shot applied to source scene',
      scene
    };
  });

  app.post('/scenes/coverage/:shot_id/promote', async (request, reply) => {
    const { shot_id } = z.object({
      shot_id: z.coerce.number().int()
    }).parse(request.params);
    const { position } = z.object({
      position: z.enum(['before', 'after', 'replace']).default('after')
    }).parse(request.body || {});
    const candidate = await db.get(
      `SELECT coverage_shot.*, coverage_group.source_scene_id
       FROM coverage_shot
       INNER JOIN coverage_group
         ON coverage_group.id = coverage_shot.coverage_group_id
       WHERE coverage_shot.id = ?`,
      shot_id
    );
    if (!candidate) {
      return reply.status(404).send({ detail: 'Candidate shot not found' });
    }

    const sourceScene = await db.get(
      'SELECT * FROM scene WHERE id = ?',
      candidate.source_scene_id
    );
    if (!sourceScene) {
      return reply.status(404).send({ detail: 'Source scene no longer exists' });
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      if (position === 'replace') {
        await db.run(
          `UPDATE scene
           SET shot_type = ?, camera_angle = ?, camera_movement = ?,
               visual_prompt = COALESCE(?, visual_prompt)
           WHERE id = ?`,
          candidate.shot_size,
          candidate.camera_angle,
          candidate.camera_movement,
          candidate.visual_prompt || null,
          sourceScene.id
        );
        await db.run(
          'UPDATE coverage_shot SET promoted_scene_id = ? WHERE id = ?',
          sourceScene.id,
          shot_id
        );
        await db.exec('COMMIT');
        return {
          status: 'success',
          message: 'Source scene replaced by candidate shot',
          scene_id: sourceScene.id
        };
      }

      const insertIndex = position === 'before'
        ? sourceScene.index
        : sourceScene.index + 1;
      await db.run(
        `UPDATE scene SET "index" = "index" + 1
         WHERE chapter_id = ? AND "index" >= ?`,
        sourceScene.chapter_id,
        insertIndex
      );
      const result = await db.run(
        `INSERT INTO scene (
           chapter_id, "index", visual_prompt, audio_prompt, dialogue,
           duration, shot_type, camera_movement, camera_angle,
           negative_prompt, asset_status, asset_url
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sourceScene.chapter_id,
        insertIndex,
        candidate.visual_prompt || sourceScene.visual_prompt,
        sourceScene.audio_prompt,
        sourceScene.dialogue,
        sourceScene.duration,
        candidate.shot_size,
        candidate.camera_movement,
        candidate.camera_angle,
        sourceScene.negative_prompt,
        candidate.asset_status || 'idle',
        candidate.asset_url
      );
      const newSceneId = Number(result.lastID);
      await db.run(
        'UPDATE coverage_shot SET promoted_scene_id = ? WHERE id = ?',
        newSceneId,
        shot_id
      );
      await db.exec('COMMIT');
      return {
        status: 'success',
        message: 'Candidate shot promoted to main timeline',
        scene_id: newSceneId
      };
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  });
};
