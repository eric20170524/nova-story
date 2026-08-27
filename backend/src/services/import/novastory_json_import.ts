import { randomUUID } from 'crypto';
import { db } from '../../db/database';
import type { NovaStoryJsonImportProject } from './novastory_json_model';

const tableExists = async (tableName: string) => {
  const table = await db.get(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName
  );
  return Boolean(table);
};

export const restoreNovaStoryJsonProject = async (
  importProject: NovaStoryJsonImportProject,
  userId: string
) => {
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
      importProject.project.title,
      importProject.project.description,
      JSON.stringify(importProject.project.settings),
      userId
    );

    const projectId = result.lastID;
    if (projectId === undefined) {
      throw new Error('Could not create the imported project');
    }

    const chapterIdMap = new Map<string, string>();
    for (const chapter of importProject.chapters) {
      const newChapterId = randomUUID();
      if (chapter.sourceId) {
        chapterIdMap.set(chapter.sourceId, newChapterId);
      }
      await db.run(
        `INSERT INTO chapter
          (id, project_id, "index", title, content, summary, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        newChapterId,
        projectId,
        chapter.index,
        chapter.title,
        chapter.content,
        chapter.summary,
        chapter.status
      );
    }

    if (availableTables.has('character')) {
      for (const character of importProject.characters) {
        await db.run(
          `INSERT INTO character
            (project_id, name, role, description, visual_tags)
           VALUES (?, ?, ?, ?, ?)`,
          projectId,
          character.name,
          character.role,
          character.description,
          character.visualTags
        );
      }
    }

    const sceneIdMap = new Map<string, number>();
    if (availableTables.has('scene')) {
      for (const scene of importProject.scenes) {
        const newChapterId = chapterIdMap.get(scene.sourceChapterId);
        if (!newChapterId) {
          throw new Error(
            `Normalized scene still references missing chapter "${scene.sourceChapterId}"`
          );
        }

        const sceneResult = await db.run(
          `INSERT INTO scene (
            chapter_id, "index", visual_prompt, audio_prompt, dialogue, narration,
            duration, shot_type, camera_movement, camera_angle,
            negative_prompt, shot_spec, asset_status, task_id, asset_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newChapterId,
          scene.index,
          scene.visualPrompt,
          scene.audioPrompt,
          scene.dialogue,
          scene.narration,
          scene.duration,
          scene.shotType,
          scene.cameraMovement,
          scene.cameraAngle,
          scene.negativePrompt,
          scene.shotSpec,
          scene.assetStatus,
          scene.taskId,
          scene.assetUrl
        );

        if (scene.sourceId && sceneResult.lastID !== undefined) {
          sceneIdMap.set(scene.sourceId, Number(sceneResult.lastID));
        }
      }
    }

    const groupIdMap = new Map<string, number>();
    if (availableTables.has('coverage_group')) {
      for (const group of importProject.coverageGroups) {
        const newSceneId = sceneIdMap.get(group.sourceSceneId);
        if (newSceneId === undefined) {
          throw new Error(
            `Normalized coverage group still references missing scene "${group.sourceSceneId}"`
          );
        }

        const groupResult = await db.run(
          `INSERT INTO coverage_group (source_scene_id, version, status)
           VALUES (?, ?, ?)`,
          newSceneId,
          group.version,
          group.status
        );

        if (group.sourceId && groupResult.lastID !== undefined) {
          groupIdMap.set(group.sourceId, Number(groupResult.lastID));
        }
      }
    }

    if (availableTables.has('coverage_shot')) {
      for (const shot of importProject.coverageShots) {
        const newGroupId = groupIdMap.get(shot.sourceCoverageGroupId);
        if (newGroupId === undefined) {
          throw new Error(
            `Normalized coverage shot still references missing group "${shot.sourceCoverageGroupId}"`
          );
        }

        await db.run(
          `INSERT INTO coverage_shot (
            coverage_group_id, slot, shot_size, camera_angle, camera_movement,
            narrative_purpose, visual_prompt, negative_prompt, shot_spec, shot_intent,
            asset_status, task_id, asset_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newGroupId,
          shot.slot,
          shot.shotSize,
          shot.cameraAngle,
          shot.cameraMovement,
          shot.narrativePurpose,
          shot.visualPrompt,
          shot.negativePrompt ?? null,
          shot.shotSpec ?? null,
          shot.shotIntent ?? null,
          shot.assetStatus,
          shot.taskId,
          shot.assetUrl
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
