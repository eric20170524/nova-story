import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/database';
import { LLMService } from '../services/llm';
import { SettingsManager } from '../core/settings_manager';
import { parseProjectSettings, resolveEffectiveNsfw } from '../services/project_settings';
import {
  createSceneVersion,
  ensureSceneVersionBaseline,
  syncActiveVersionFromScene,
} from '../services/scene_versions';
import { formatVisualLockTokens } from '../services/reference_generation_policy';
import { compilePonyPrompt, type CharacterLockRef } from '../services/pony_prompt_compiler';
import { compileNegativePrompt } from '../services/negative_prompt_compiler';
import { packShotSpec } from '../schemas/shot_contract';
import { sanitizeVisualPrompt } from '../services/visual_prompt_sanitizer';

const parseTags = (raw: unknown): any => {
  try {
    return typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
  } catch {
    return {};
  }
};

const buildCharacterLockRefs = (characters: any[], chapterId?: string | number | null): CharacterLockRef[] =>
  (characters || [])
    .map((c: any) => {
      const tags = parseTags(c.visual_tags);
      const lock = formatVisualLockTokens(tags, { chapterId });
      if (!lock || /^\(none/i.test(lock)) return null;
      const aliases = Array.isArray(tags?.aliases)
        ? tags.aliases.map((a: unknown) => String(a || '').trim()).filter(Boolean)
        : [];
      return {
        name: String(c.name || '').trim() || null,
        aliases,
        lock,
      } satisfies CharacterLockRef;
    })
    .filter(Boolean) as CharacterLockRef[];

const buildCharacterProfiles = (characters: any[], chapterId?: string | number | null): string =>
  (characters || [])
    .map((c: any) => {
      const tags = parseTags(c.visual_tags);
      const lock = formatVisualLockTokens(tags, { chapterId });
      return `- Name: ${c.name}\n  Visual Lock: ${lock || '(none — do not invent appearance tags)'}`;
    })
    .join('\n');

/** Compile one coverage candidate from contract fields (never trust LLM prose). */
export const compileCoverageCandidate = (
  candidate: any,
  characterLocks: CharacterLockRef[],
  index: number
) => {
  const location = String(candidate.location || '').trim();
  const primary_action = String(candidate.primary_action || '').trim();
  if (location.length < 2 || primary_action.length < 2) {
    throw new Error(
      `Coverage candidate slot ${candidate.slot || index + 1} missing location/primary_action`
    );
  }
  const shot_type = candidate.shot_size || candidate.shot_type || 'Medium Shot';
  const shot_intent = candidate.shot_intent || null;
  const key_props = Array.isArray(candidate.key_props) ? candidate.key_props : [];
  const primary_subject = candidate.primary_subject ?? null;
  const visible_subjects = Array.isArray(candidate.visible_subjects)
    ? candidate.visible_subjects
    : [];
  const subject_scale = candidate.subject_scale || null;

  const compiled = compilePonyPrompt(
    {
      shot_intent,
      shot_type,
      location,
      primary_action,
      primary_subject,
      visible_subjects,
      key_props,
      subject_scale,
      must_not: candidate.must_not || [],
    },
    characterLocks
  );
  const sanitized = sanitizeVisualPrompt(compiled.visual_prompt);
  const negative = compileNegativePrompt({
    shot_type,
    shot_intent: compiled.shot_intent || shot_intent,
    visual_prompt: sanitized.visual_prompt,
    location,
    key_props,
    character_lock: characterLocks.map((ref) => ref.lock).join(', '),
    identity_mode: 'auto',
  });
  const shot_spec = packShotSpec({
    shot_intent: compiled.shot_intent || shot_intent,
    location,
    primary_action,
    primary_subject,
    visible_subjects,
    key_props,
    subject_scale,
    must_not: candidate.must_not || [],
    shot_type,
  });

  return {
    slot: candidate.slot || index + 1,
    shot_size: shot_type,
    camera_angle: candidate.camera_angle || 'Eye-level',
    camera_movement: candidate.camera_movement || 'Static',
    narrative_purpose: candidate.narrative_purpose || '',
    visual_prompt: sanitized.visual_prompt,
    negative_prompt: [negative, ...compiled.negative_extras, ...sanitized.negative_extras]
      .filter(Boolean)
      .join(', '),
    shot_spec,
    shot_intent: compiled.shot_intent || shot_intent,
  };
};

const serializeGroup = async (group: any) => ({
  ...group,
  shots: await db.all(
    'SELECT * FROM coverage_shot WHERE coverage_group_id = ? ORDER BY slot ASC',
    group.id
  ),
});

const promptsChanged = (before: any, after: {
  visual_prompt: string;
  negative_prompt: string | null;
  shot_spec: string;
}) =>
  String(before?.visual_prompt || '') !== String(after.visual_prompt || '')
  || String(before?.negative_prompt || '') !== String(after.negative_prompt || '')
  || String(before?.shot_spec || '') !== String(after.shot_spec || '');

export const coverageRoutes: FastifyPluginAsync = async (app) => {
  app.post('/scenes/:scene_id/coverage', async (request, reply) => {
    const { scene_id } = z.object({
      scene_id: z.coerce.number().int(),
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
          'SELECT name, description, visual_tags FROM character WHERE project_id = ? ORDER BY id ASC',
          chapter.project_id
        )
      : [];
    const characterLocks = buildCharacterLockRefs(characters, sourceScene.chapter_id);
    const characterProfiles = buildCharacterProfiles(characters, sourceScene.chapter_id);

    const project = chapter
      ? await db.get('SELECT settings FROM project WHERE id = ?', chapter.project_id)
      : null;
    const nsfwEnabled = resolveEffectiveNsfw({
      systemNsfwEnabled: Boolean(SettingsManager.loadSettings()?.advanced?.nsfw_enabled),
      projectSettings: parseProjectSettings(project?.settings),
    });

    let candidates: any[];
    try {
      candidates = await LLMService.generateSceneCoverage(
        sourceScene,
        characterProfiles,
        undefined,
        { nsfwEnabled }
      );
    } catch (error: any) {
      return reply.status(500).send({
        detail: error?.message || 'Coverage generation failed',
      });
    }
    if (candidates.length !== 9) {
      return reply.status(500).send({
        detail: 'Coverage generation failed to return 9 candidate shots',
      });
    }

    let compiledCandidates;
    try {
      compiledCandidates = candidates.map((candidate, index) =>
        compileCoverageCandidate(candidate, characterLocks, index)
      );
    } catch (error: any) {
      return reply.status(500).send({
        detail: error?.message || 'Coverage compile failed',
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

      for (const compiled of compiledCandidates) {
        await db.run(
          `INSERT INTO coverage_shot (
             coverage_group_id, slot, shot_size, camera_angle,
             camera_movement, narrative_purpose, visual_prompt,
             negative_prompt, shot_spec, shot_intent, asset_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle')`,
          groupId,
          compiled.slot,
          compiled.shot_size,
          compiled.camera_angle,
          compiled.camera_movement,
          compiled.narrative_purpose,
          compiled.visual_prompt,
          compiled.negative_prompt,
          compiled.shot_spec,
          compiled.shot_intent
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
      scene_id: z.coerce.number().int(),
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
      shot_id: z.coerce.number().int(),
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

    const sourceScene = await db.get(
      'SELECT * FROM scene WHERE id = ?',
      candidate.source_scene_id
    );
    if (!sourceScene) {
      return reply.status(404).send({ detail: 'Source scene no longer exists' });
    }

    const next = {
      visual_prompt: candidate.visual_prompt || sourceScene.visual_prompt || '',
      negative_prompt: candidate.negative_prompt ?? null,
      shot_spec: candidate.shot_spec || sourceScene.shot_spec || null,
    };

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      if (promptsChanged(sourceScene, {
        visual_prompt: String(next.visual_prompt || ''),
        negative_prompt: next.negative_prompt,
        shot_spec: String(next.shot_spec || ''),
      })) {
        await createSceneVersion(candidate.source_scene_id, {
          clearAsset: true,
          label: `coverage-apply-${candidate.slot || shot_id}`,
        });
      }

      await db.run(
        `UPDATE scene
         SET shot_type = ?, camera_angle = ?, camera_movement = ?,
             visual_prompt = ?, negative_prompt = ?, shot_spec = ?,
             asset_status = CASE
               WHEN asset_url IS NULL OR asset_url = '' THEN asset_status
               ELSE 'idle'
             END,
             asset_url = CASE
               WHEN ? THEN NULL
               ELSE asset_url
             END
         WHERE id = ?`,
        candidate.shot_size,
        candidate.camera_angle,
        candidate.camera_movement,
        next.visual_prompt,
        next.negative_prompt,
        next.shot_spec,
        promptsChanged(sourceScene, {
          visual_prompt: String(next.visual_prompt || ''),
          negative_prompt: next.negative_prompt,
          shot_spec: String(next.shot_spec || ''),
        }) ? 1 : 0,
        candidate.source_scene_id
      );
      await syncActiveVersionFromScene(candidate.source_scene_id);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }

    const scene = await db.get(
      'SELECT * FROM scene WHERE id = ?',
      candidate.source_scene_id
    );
    return {
      status: 'success',
      message: 'Candidate shot applied to source scene',
      scene,
    };
  });

  app.post('/scenes/coverage/:shot_id/promote', async (request, reply) => {
    const { shot_id } = z.object({
      shot_id: z.coerce.number().int(),
    }).parse(request.params);
    const { position } = z.object({
      position: z.enum(['before', 'after', 'replace']).default('after'),
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
        const next = {
          visual_prompt: candidate.visual_prompt || sourceScene.visual_prompt || '',
          negative_prompt: candidate.negative_prompt ?? null,
          shot_spec: candidate.shot_spec || null,
        };
        const changed = promptsChanged(sourceScene, {
          visual_prompt: String(next.visual_prompt || ''),
          negative_prompt: next.negative_prompt,
          shot_spec: String(next.shot_spec || ''),
        });
        if (changed) {
          await createSceneVersion(sourceScene.id, {
            clearAsset: !candidate.asset_url,
            label: `coverage-replace-${candidate.slot || shot_id}`,
          });
        }
        await db.run(
          `UPDATE scene
           SET shot_type = ?, camera_angle = ?, camera_movement = ?,
               visual_prompt = ?, negative_prompt = ?, shot_spec = ?,
               asset_status = ?, asset_url = ?
           WHERE id = ?`,
          candidate.shot_size,
          candidate.camera_angle,
          candidate.camera_movement,
          next.visual_prompt,
          next.negative_prompt,
          next.shot_spec,
          candidate.asset_url ? (candidate.asset_status || 'completed') : 'idle',
          candidate.asset_url || null,
          sourceScene.id
        );
        await db.run(
          'UPDATE coverage_shot SET promoted_scene_id = ? WHERE id = ?',
          sourceScene.id,
          shot_id
        );
        await syncActiveVersionFromScene(sourceScene.id);
        await db.exec('COMMIT');
        return {
          status: 'success',
          message: 'Source scene replaced by candidate shot',
          scene_id: sourceScene.id,
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
           chapter_id, "index", visual_prompt, audio_prompt, dialogue, narration,
           duration, shot_type, camera_movement, camera_angle,
           negative_prompt, shot_spec, asset_status, asset_url
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sourceScene.chapter_id,
        insertIndex,
        candidate.visual_prompt || sourceScene.visual_prompt,
        sourceScene.audio_prompt,
        sourceScene.dialogue,
        sourceScene.narration,
        sourceScene.duration,
        candidate.shot_size,
        candidate.camera_movement,
        candidate.camera_angle,
        candidate.negative_prompt ?? null,
        candidate.shot_spec || null,
        candidate.asset_url ? (candidate.asset_status || 'completed') : 'idle',
        candidate.asset_url || null
      );
      const newSceneId = Number(result.lastID);
      await ensureSceneVersionBaseline(newSceneId);
      await db.run(
        'UPDATE coverage_shot SET promoted_scene_id = ? WHERE id = ?',
        newSceneId,
        shot_id
      );
      await db.exec('COMMIT');
      return {
        status: 'success',
        message: 'Candidate shot promoted to main timeline',
        scene_id: newSceneId,
      };
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  });
};
