import { randomUUID } from 'crypto';
import { db } from '../../db/database';
import type { NovaStoryJsonImportProject } from './novastory_json_model';
import { canonicalProjectSettings } from '../project_settings';
import { remapScriptDocumentCharacters, remapShotSpecScriptId, remapScriptSourceSnapshot } from '../../schemas/script';
import { remapCopiedScriptChanges } from '../script_copy';
import { ScriptService } from '../script_service';
import { StoryPlanDocumentSchema, newPlanEntryId } from '../../schemas/story_plan';
import { ensureSceneVersionBaseline } from '../scene_versions';
import { restoreAssetLibrary } from '../asset_library_backup';

const tableExists = async (tableName: string) => {
  const table = await db.get(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName
  );
  return Boolean(table);
};

const withoutCharacterModel = (raw: string) => {
  const tags = JSON.parse(raw || '{}');
  if (tags && typeof tags === 'object' && !Array.isArray(tags)) {
    delete tags.model_type;
    if (tags.assets && typeof tags.assets === 'object') delete tags.assets.model_type;
    if (tags.base_model && typeof tags.base_model === 'object') delete tags.base_model.model_type;
  }
  return JSON.stringify(tags);
};

export const restoreNovaStoryJsonProject = async (
  importProject: NovaStoryJsonImportProject,
  userId: string
) => {
  const availableTables = new Set(
    (
      await Promise.all(
        ['character', 'scene', 'coverage_group', 'coverage_shot', 'chapter_script', 'script_change', 'scene_version', 'glossary'].map(async (name) => ({
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
      JSON.stringify(canonicalProjectSettings(importProject.project.settings)),
      userId
    );

    const projectId = result.lastID;
    if (projectId === undefined) {
      throw new Error('Could not create the imported project');
    }

    const chapterIdMap = new Map<string, string>();
    const entryIdMap = new Map<string, string>();
    const parsedPlan = importProject.storyPlan
      ? StoryPlanDocumentSchema.safeParse(importProject.storyPlan.document)
      : null;
    if (parsedPlan?.success) {
      for (const entry of parsedPlan.data.chapters) entryIdMap.set(entry.id, newPlanEntryId());
    }
    for (const chapter of importProject.chapters) {
      const newChapterId = randomUUID();
      if (chapter.sourceId) {
        chapterIdMap.set(chapter.sourceId, newChapterId);
      }
      let planEntryId: string | null = null;
      if (parsedPlan?.success && chapter.planEntryId) {
        planEntryId = entryIdMap.get(chapter.planEntryId) || newPlanEntryId();
        entryIdMap.set(chapter.planEntryId, planEntryId);
      }
      await db.run(
        `INSERT INTO chapter
          (id, project_id, "index", title, content, summary, status, plan_entry_id, target_word_count, finalized_content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newChapterId,
        projectId,
        chapter.index,
        chapter.title,
        chapter.content,
        chapter.summary,
        chapter.status,
        planEntryId,
        chapter.targetWordCount ?? null,
        chapter.finalizedContentHash ?? null
      );
    }
    if (parsedPlan?.success && importProject.storyPlan) {
      const document = {
        ...parsedPlan.data,
        chapters: parsedPlan.data.chapters.map((entry) => ({
          ...entry,
          id: entryIdMap.get(entry.id) || newPlanEntryId(),
        })),
      };
      await db.run(
        'INSERT INTO story_plan (project_id, revision, document_json) VALUES (?, ?, ?)',
        projectId,
        importProject.storyPlan.revision || 1,
        JSON.stringify(StoryPlanDocumentSchema.parse(document))
      );
    }

    const characterIdMap = new Map<number, number>();
    if (availableTables.has('character')) {
      for (const character of importProject.characters) {
        const charRes = await db.run(
          `INSERT INTO character
            (project_id, name, role, description, visual_tags, voice_id, voice_label)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          projectId,
          character.name,
          character.role ?? null,
          character.description ?? null,
          withoutCharacterModel(character.visualTags),
          character.voiceId ?? null,
          character.voiceLabel ?? null
        );
        const newCharId = charRes.lastID;
        if (character.sourceId !== undefined && newCharId !== undefined) {
          characterIdMap.set(Number(character.sourceId), Number(newCharId));
        }
      }
    }

    if (availableTables.has('glossary')) {
      for (const item of importProject.glossary) {
        await db.run(
          'INSERT INTO glossary (project_id, term, definition, category) VALUES (?, ?, ?, ?)',
          projectId,
          item.term,
          item.definition,
          item.category
        );
      }
    }

    const scriptIdMap = new Map<number, number>();
    if (availableTables.has('chapter_script') && Array.isArray(importProject.scripts)) {
      for (const script of importProject.scripts) {
        const newChapterId = chapterIdMap.get(script.sourceChapterId);
        if (!newChapterId) continue;

        const remappedDocument = remapScriptDocumentCharacters(script.document, characterIdMap);

        const targetChapter = await db.get(
          'SELECT title, content FROM chapter WHERE id = ?',
          newChapterId
        );

        let snapshot = remapScriptSourceSnapshot(script.sourceSnapshot, newChapterId, characterIdMap);
        let contentHash = script.sourceContentHash;
        let contextHash = script.sourceContextHash;

        if (!snapshot || !contentHash) {
          const fresh = await ScriptService.createSourceSnapshot(
            newChapterId,
            targetChapter?.title || '',
            targetChapter?.content || '',
            projectId
          );
          snapshot = fresh;
          contentHash = fresh.contentHash;
          contextHash = fresh.contextHash;
        } else if (!importProject.glossaryProvided) {
          const restored = await ScriptService.loadSourceContext(projectId);
          contextHash = restored.contextHash;
          snapshot = { ...snapshot, contextHash };
        }

        const scriptResult = await db.run(
          `INSERT INTO chapter_script (
            chapter_id, revision, status, document_json, source_snapshot_json,
            source_content_hash, source_context_hash, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          newChapterId,
          script.revision,
          script.status,
          JSON.stringify(remappedDocument),
          JSON.stringify(snapshot),
          contentHash,
          contextHash
        );

        const newScriptId = Number(scriptResult.lastID);
        if (script.sourceId !== undefined && newScriptId) {
          scriptIdMap.set(Number(script.sourceId), newScriptId);
        }

        if (availableTables.has('script_change') && newScriptId && Array.isArray(script.changes)) {
          for (const ch of script.changes) {
            const changeId = randomUUID();
            let beforeDoc = ch.beforeJson;
            let afterDoc = ch.afterJson;

            await db.run(
              `INSERT INTO script_change (
                id, script_id, kind, base_revision, candidate_revision,
                request_key, state, before_json, after_json, source_snapshot_json,
                generation_info_json, applied_revision, result_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              changeId,
              newScriptId,
              ch.kind,
              ch.baseRevision,
              ch.candidateRevision,
              ch.requestKey ? `imp_${changeId}_${ch.requestKey}` : changeId,
              ch.state,
              beforeDoc,
              afterDoc,
              ch.sourceSnapshotJson,
              ch.generationInfoJson,
              ch.appliedRevision,
              ch.resultJson
            );
          }
        }
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

        const remappedShotSpec = remapShotSpecScriptId(scene.shotSpec, scriptIdMap);

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
          remappedShotSpec,
          scene.assetStatus,
          scene.taskId,
          scene.assetUrl
        );

        const newSceneId = Number(sceneResult.lastID);
        if (scene.sourceId && sceneResult.lastID !== undefined) {
          sceneIdMap.set(scene.sourceId, newSceneId);
        }

        if (availableTables.has('scene_version') && newSceneId) {
          await ensureSceneVersionBaseline(newSceneId);
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

        const remappedCoverageShotSpec = remapShotSpecScriptId(shot.shotSpec, scriptIdMap);

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
          remappedCoverageShotSpec,
          shot.shotIntent ?? null,
          shot.assetStatus,
          shot.taskId,
          shot.assetUrl
        );
      }
    }

    const destinationScripts = await db.all(`SELECT cs.id FROM chapter_script cs JOIN chapter c ON c.id = cs.chapter_id WHERE c.project_id = ?`, projectId);
    await remapCopiedScriptChanges({ scripts: scriptIdMap, characters: characterIdMap, chapters: chapterIdMap, scenes: sceneIdMap }, destinationScripts.map((script: any) => script.id));
    await restoreAssetLibrary(importProject.assetLibrary, projectId, chapterIdMap, sceneIdMap);
    await db.exec('COMMIT');
    return await db.get('SELECT * FROM project WHERE id = ?', projectId);
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
};
