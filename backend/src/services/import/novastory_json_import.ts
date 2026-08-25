import path from 'path';
import { randomUUID } from 'crypto';
import { db } from '../../db/database';

const tableExists = async (tableName: string) => {
  const table = await db.get(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName
  );
  return Boolean(table);
};

export const restoreNovaStoryJsonProject = async (
  jsonContent: Record<string, any>,
  filename: string,
  userId: string
) => {
  const ext = path.extname(filename).toLowerCase();
  const projectTitle = jsonContent.project?.title
    || jsonContent.title
    || path.basename(filename, ext)
    || 'Imported Project';
  const projectDescription = jsonContent.project?.description
    ?? jsonContent.description
    ?? null;
  const rawSettings = jsonContent.project?.settings;
  const projectSettings = typeof rawSettings === 'object'
    ? JSON.stringify(rawSettings)
    : (typeof rawSettings === 'string' ? rawSettings : '{}');

  const rawChapters = Array.isArray(jsonContent.screenplay?.chapters)
    ? jsonContent.screenplay.chapters
    : (Array.isArray(jsonContent.chapters) ? jsonContent.chapters : []);
  const rawCharacters = Array.isArray(jsonContent.character_center?.characters)
    ? jsonContent.character_center.characters
    : (Array.isArray(jsonContent.characters) ? jsonContent.characters : []);
  const directorData = jsonContent.director || {};
  const rawScenes = Array.isArray(directorData.scenes) ? directorData.scenes : [];
  const rawCoverageGroups = Array.isArray(directorData.coverage_groups)
    ? directorData.coverage_groups
    : [];
  const rawCoverageShots = Array.isArray(directorData.coverage_shots)
    ? directorData.coverage_shots
    : [];

  const availableTables = new Set(
    (
      await Promise.all(
        ['character', 'scene', 'coverage_group', 'coverage_shot'].map(async (name) => ({
          name,
          exists: await tableExists(name),
        }))
      )
    )
      .filter(({ exists }) => exists)
      .map(({ name }) => name)
  );

  await db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const result = await db.run(
      `INSERT INTO project
        (title, description, settings, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      projectTitle,
      projectDescription,
      projectSettings,
      userId
    );

    const projectId = result.lastID;
    if (projectId === undefined) {
      throw new Error('Could not create the imported project');
    }

    const chapterIdMap = new Map<string, string>();
    for (const [index, chapter] of rawChapters.entries()) {
      const newChapterId = randomUUID();
      if (chapter.id !== undefined && chapter.id !== null) {
        chapterIdMap.set(String(chapter.id), newChapterId);
      }
      await db.run(
        `INSERT INTO chapter
          (id, project_id, "index", title, content, summary, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        newChapterId,
        projectId,
        chapter.index ?? index + 1,
        chapter.title || `Chapter ${index + 1}`,
        chapter.content ?? null,
        chapter.summary ?? null,
        chapter.status || 'draft'
      );
    }

    if (availableTables.has('character')) {
      for (const character of rawCharacters) {
        const visualTagsStr = typeof character.visual_tags === 'object'
          ? JSON.stringify(character.visual_tags)
          : (character.visual_tags || '{}');

        await db.run(
          `INSERT INTO character
            (project_id, name, role, description, visual_tags)
           VALUES (?, ?, ?, ?, ?)`,
          projectId,
          character.name,
          character.role ?? null,
          character.description ?? null,
          visualTagsStr
        );
      }
    }

    const sceneIdMap = new Map<number, number>();
    if (availableTables.has('scene') && rawScenes.length > 0) {
      for (const scene of rawScenes) {
        const newChapterId = chapterIdMap.get(String(scene.chapter_id));
        if (!newChapterId) continue;

        const shotSpecStr = typeof scene.shot_spec === 'object'
          ? JSON.stringify(scene.shot_spec)
          : (scene.shot_spec || null);

        const sceneResult = await db.run(
          `INSERT INTO scene (
            chapter_id, "index", visual_prompt, audio_prompt, dialogue,
            duration, shot_type, camera_movement, camera_angle,
            negative_prompt, shot_spec, asset_status, task_id, asset_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newChapterId,
          scene.index ?? 1,
          scene.visual_prompt ?? null,
          scene.audio_prompt ?? null,
          scene.dialogue ?? null,
          scene.duration ?? 3,
          scene.shot_type ?? null,
          scene.camera_movement ?? null,
          scene.camera_angle ?? null,
          scene.negative_prompt ?? null,
          shotSpecStr,
          scene.asset_status || 'idle',
          scene.task_id ?? null,
          scene.asset_url ?? null
        );

        if (scene.id !== undefined && scene.id !== null && sceneResult.lastID !== undefined) {
          sceneIdMap.set(Number(scene.id), Number(sceneResult.lastID));
        }
      }
    }

    const groupIdMap = new Map<number, number>();
    if (availableTables.has('coverage_group') && rawCoverageGroups.length > 0) {
      for (const group of rawCoverageGroups) {
        const newSceneId = sceneIdMap.get(Number(group.source_scene_id));
        if (newSceneId === undefined) continue;

        const groupResult = await db.run(
          `INSERT INTO coverage_group (source_scene_id, version, status)
           VALUES (?, ?, ?)`,
          newSceneId,
          group.version ?? 1,
          group.status || 'completed'
        );

        if (group.id !== undefined && group.id !== null && groupResult.lastID !== undefined) {
          groupIdMap.set(Number(group.id), Number(groupResult.lastID));
        }
      }
    }

    if (availableTables.has('coverage_shot') && rawCoverageShots.length > 0) {
      for (const shot of rawCoverageShots) {
        const newGroupId = groupIdMap.get(Number(shot.coverage_group_id));
        if (newGroupId === undefined) continue;

        await db.run(
          `INSERT INTO coverage_shot (
            coverage_group_id, slot, shot_size, camera_angle, camera_movement,
            narrative_purpose, visual_prompt, asset_status, task_id, asset_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newGroupId,
          shot.slot ?? 1,
          shot.shot_size ?? null,
          shot.camera_angle ?? null,
          shot.camera_movement ?? null,
          shot.narrative_purpose ?? null,
          shot.visual_prompt ?? null,
          shot.asset_status || 'idle',
          shot.task_id ?? null,
          shot.asset_url ?? null
        );
      }
    }

    await db.exec('COMMIT');
    return await db.get('SELECT * FROM project WHERE id = ?', projectId);
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
};
