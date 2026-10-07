import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/database';
import { ProjectCreateSchema, ProjectUpdateSchema } from '../schemas/project';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { ProjectImportInputError } from '../services/import/import_file';
import { commitProjectImportFile } from '../services/import/project_import';
import { DEFAULT_PROJECT_IMAGE_SETTINGS, PROJECT_VIDEO_WORKFLOW_IDS, canonicalProjectSettings, getProjectImageSettings, getProjectVideoSettings, parseProjectSettings } from '../services/project_settings';
import { inferComfyWorkflowFamily } from '../services/comfy_workflow_selection';
import { remapScriptDocumentCharacters, remapShotSpecScriptId, remapScriptSourceSnapshot } from '../schemas/script';
import { remapCopiedScriptChanges } from '../services/script_copy';
import { StoryPlanDocumentSchema, newPlanEntryId } from '../schemas/story_plan';
import { exportAssetLibrary, restoreAssetLibrary } from '../services/asset_library_backup';

const exportStoryPlan = async (projectId: number) => {
  if (!(await tableExists('story_plan'))) return null;
  const row = await db.get(
    'SELECT revision, document_json FROM story_plan WHERE project_id = ?',
    projectId
  );
  if (!row) return null;
  return {
    revision: Number(row.revision),
    document: parseStoredJson(row.document_json),
  };
};

// Dummy implementation of current_user auth
// Real implementation should parse JWT/headers as needed
const mockGetCurrentUser = (request: any) => ({
  id: 'local_admin'
});

const parseStoredJson = (value: unknown) => {
  if (typeof value !== 'string' || value.trim() === '') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const tableExists = async (tableName: string) => {
  const table = await db.get(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName
  );
  return Boolean(table);
};

export const projectRoutes: FastifyPluginAsync = async (app) => {
  const validateImageSettings = async (raw: string, reply: any): Promise<string | null> => {
    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(raw);
    } catch {
      reply.status(400).send({ detail: 'Project settings must be valid JSON' });
      return null;
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || !settings.image_generation || typeof settings.image_generation !== 'object') {
      reply.status(400).send({ detail: 'image_generation is required in project settings' });
      return null;
    }
    const image = settings.image_generation as Record<string, unknown>;
    if (image.model !== 'pony' && image.model !== 'sd15' && image.model !== 'redcraft_krea2') {
      reply.status(400).send({ detail: 'Invalid project image model' });
      return null;
    }
    if (image.workflow_id != null) {
      if (!Number.isSafeInteger(image.workflow_id) || Number(image.workflow_id) <= 0) {
        reply.status(400).send({ detail: 'Invalid project workflow ID' });
        return null;
      }
      const workflow = await db.get('SELECT id, name, content FROM workflow WHERE id = ? AND is_active = 1', image.workflow_id);
      let family: string | null = null;
      try { family = workflow ? inferComfyWorkflowFamily(workflow) : null; } catch { /* Invalid graph. */ }
      if (family !== image.model) {
        reply.status(400).send({ detail: 'Project workflow must be active and match the project model' });
        return null;
      }
    }
    const video = settings.video_generation;
    if (video != null) {
      if (typeof video !== 'object' || Array.isArray(video)) {
        reply.status(400).send({ detail: 'video_generation must be an object' });
        return null;
      }
      const workflowId = (video as { workflow_id?: unknown }).workflow_id;
      if (workflowId != null && workflowId !== ''
        && !(PROJECT_VIDEO_WORKFLOW_IDS as readonly string[]).includes(String(workflowId))) {
        reply.status(400).send({ detail: 'Invalid project video workflow' });
        return null;
      }
    }
    const parsed = parseProjectSettings(settings);
    return JSON.stringify({
      ...settings,
      image_generation: getProjectImageSettings(parsed),
      video_generation: getProjectVideoSettings(parsed),
    });
  };
  app.get('/:id/export', async (request, reply) => {
    const { id } = z.object({
      id: z.coerce.number()
    }).parse(request.params);
    const user = mockGetCurrentUser(request);
    const project = await db.get('SELECT * FROM project WHERE id = ?', id);

    if (!project) {
      return reply.status(404).send({ detail: 'Project not found' });
    }

    if (user.id !== 'local_admin' && project.user_id !== user.id) {
      return reply.status(403).send({ detail: 'Not authorized to export this project' });
    }

    const availableTables = new Set(
      (
        await Promise.all(
          ['character', 'scene', 'coverage_group', 'coverage_shot', 'chapter_script', 'script_change', 'glossary'].map(async (name) => ({
            name,
            exists: await tableExists(name)
          }))
        )
      )
        .filter(({ exists }) => exists)
        .map(({ name }) => name)
    );

    const [chapters, rawCharacters, rawScenes, coverageGroups, coverageShots, rawScripts, glossary] = await Promise.all([
      db.all(
        'SELECT * FROM chapter WHERE project_id = ? ORDER BY "index" ASC, id ASC',
        id
      ),
      availableTables.has('character')
        ? db.all('SELECT * FROM character WHERE project_id = ? ORDER BY id ASC', id)
        : Promise.resolve([]),
      availableTables.has('scene')
        ? db.all(
            `SELECT scene.*
             FROM scene
             INNER JOIN chapter ON chapter.id = scene.chapter_id
             WHERE chapter.project_id = ?
             ORDER BY chapter."index" ASC, scene."index" ASC, scene.id ASC`,
            id
          )
        : Promise.resolve([]),
      availableTables.has('scene') && availableTables.has('coverage_group')
        ? db.all(
            `SELECT coverage_group.*
             FROM coverage_group
             INNER JOIN scene ON scene.id = coverage_group.source_scene_id
             INNER JOIN chapter ON chapter.id = scene.chapter_id
             WHERE chapter.project_id = ?
             ORDER BY chapter."index" ASC, scene."index" ASC,
                      coverage_group.version ASC, coverage_group.id ASC`,
            id
          )
        : Promise.resolve([]),
      availableTables.has('scene')
        && availableTables.has('coverage_group')
        && availableTables.has('coverage_shot')
        ? db.all(
            `SELECT coverage_shot.*
             FROM coverage_shot
             INNER JOIN coverage_group
               ON coverage_group.id = coverage_shot.coverage_group_id
             INNER JOIN scene ON scene.id = coverage_group.source_scene_id
             INNER JOIN chapter ON chapter.id = scene.chapter_id
             WHERE chapter.project_id = ?
             ORDER BY chapter."index" ASC, scene."index" ASC,
                      coverage_group.version ASC, coverage_shot.slot ASC,
                      coverage_shot.id ASC`,
            id
          )
        : Promise.resolve([]),
      availableTables.has('chapter_script')
        ? db.all(
            `SELECT cs.*
             FROM chapter_script cs
             INNER JOIN chapter c ON c.id = cs.chapter_id
             WHERE c.project_id = ?
             ORDER BY c."index" ASC, cs.id ASC`,
            id
          )
        : Promise.resolve([]),
      availableTables.has('glossary')
        ? db.all(
            'SELECT term, definition, category FROM glossary WHERE project_id = ? ORDER BY id ASC',
            id
          )
        : Promise.resolve([])
    ]);

    const characters = rawCharacters.map((character: any) => ({
      ...character,
      visual_tags: parseStoredJson(character.visual_tags)
    }));
    const scenes = rawScenes.map((scene: any) => ({
      ...scene,
      shot_spec: parseStoredJson(scene.shot_spec)
    }));

    const scriptChanges = availableTables.has('script_change') && rawScripts.length > 0
      ? await db.all(
          `SELECT sc.*
           FROM script_change sc
           INNER JOIN chapter_script cs ON cs.id = sc.script_id
           INNER JOIN chapter c ON c.id = cs.chapter_id
           WHERE c.project_id = ?
           ORDER BY cs.id ASC, sc.created_at ASC`,
          id
        )
      : [];

    const scripts = rawScripts.map((s: any) => ({
      id: s.id,
      chapter_id: s.chapter_id,
      revision: s.revision,
      status: s.status,
      document: parseStoredJson(s.document_json),
      source_snapshot: parseStoredJson(s.source_snapshot_json),
      source_content_hash: s.source_content_hash,
      source_context_hash: s.source_context_hash,
      changes: scriptChanges
        .filter((c: any) => c.script_id === s.id)
        .map((c: any) => ({
          id: c.id,
          kind: c.kind,
          base_revision: c.base_revision,
          candidate_revision: c.candidate_revision,
          request_key: c.request_key,
          state: c.state,
          before_json: parseStoredJson(c.before_json),
          after_json: parseStoredJson(c.after_json),
          source_snapshot_json: parseStoredJson(c.source_snapshot_json),
          generation_info_json: parseStoredJson(c.generation_info_json),
          applied_revision: c.applied_revision,
          result_json: parseStoredJson(c.result_json),
          created_at: c.created_at,
          updated_at: c.updated_at,
        }))
    }));

    const exportData = {
      format: 'novastory-project',
      version: 2,
      exported_at: new Date().toISOString(),
      project: {
        ...project,
        settings: parseStoredJson(project.settings)
      },
      screenplay: {
        chapters,
        scripts
      },
      character_center: {
        characters
      },
      director: {
        scenes,
        coverage_groups: coverageGroups,
        coverage_shots: coverageShots
      },
      glossary,
      story_plan: await exportStoryPlan(id),
      asset_library: await exportAssetLibrary(id),
      summary: {
        chapters: chapters.length,
        characters: characters.length,
        scripts: scripts.length,
        scenes: scenes.length,
        coverage_groups: coverageGroups.length,
        coverage_shots: coverageShots.length,
        glossary: glossary.length
      }
    };

    const safeTitle = String(project.title || `project-${id}`)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .trim() || `project-${id}`;

    return reply
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeTitle)}.novastory.json`)
      .send(exportData);
  });

  app.post('/:id/duplicate', async (request, reply) => {
    const { id } = z.object({
      id: z.coerce.number()
    }).parse(request.params);
    const { title } = z.object({
      title: z.string().trim().min(1).optional()
    }).parse(request.body || {});
    const sourceProject = await db.get('SELECT * FROM project WHERE id = ?', id);

    if (!sourceProject) {
      return reply.status(404).send({ detail: 'Project not found' });
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const projectResult = await db.run(
        `INSERT INTO project
          (title, description, settings, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        title || `${sourceProject.title}（副本）`,
        sourceProject.description || null,
        sourceProject.settings || '{}',
        sourceProject.user_id || 'local_admin'
      );
      const newProjectId = projectResult.lastID;
      if (newProjectId === undefined) {
        throw new Error('Could not create project duplicate');
      }

      const glossaryItems = await db.all(
        'SELECT term, definition, category FROM glossary WHERE project_id = ?',
        id
      );
      for (const item of glossaryItems) {
        await db.run(
          'INSERT INTO glossary (project_id, term, definition, category) VALUES (?, ?, ?, ?)',
          newProjectId,
          item.term,
          item.definition ?? null,
          item.category ?? null
        );
      }

      const chapterIdMap = new Map<string, string>();
      const entryIdMap = new Map<string, string>();
      const sourcePlan = await tableExists('story_plan')
        ? await db.get('SELECT revision, document_json FROM story_plan WHERE project_id = ?', id)
        : null;
      if (sourcePlan?.document_json) {
        const parsed = StoryPlanDocumentSchema.safeParse(JSON.parse(String(sourcePlan.document_json)));
        if (parsed.success) {
          for (const entry of parsed.data.chapters) entryIdMap.set(entry.id, newPlanEntryId());
        }
      }
      const chapters = await db.all(
        'SELECT * FROM chapter WHERE project_id = ? ORDER BY "index" ASC',
        id
      );
      for (const chapter of chapters) {
        const newChapterId = randomUUID();
        chapterIdMap.set(chapter.id, newChapterId);
        let planEntryId: string | null = null;
        if (chapter.plan_entry_id) {
          planEntryId = entryIdMap.get(String(chapter.plan_entry_id)) || newPlanEntryId();
          entryIdMap.set(String(chapter.plan_entry_id), planEntryId);
        }
        await db.run(
          `INSERT INTO chapter
            (id, project_id, "index", title, content, summary, status, condensed_content,
             plan_entry_id, target_word_count, finalized_content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newChapterId,
          newProjectId,
          chapter.index,
          chapter.title,
          chapter.content ?? null,
          chapter.summary ?? null,
          chapter.status || 'draft',
          chapter.condensed_content ?? null,
          planEntryId,
          chapter.target_word_count ?? null,
          chapter.finalized_content_hash ?? null
        );
      }
      if (sourcePlan?.document_json) {
        const parsed = StoryPlanDocumentSchema.safeParse(JSON.parse(String(sourcePlan.document_json)));
        if (parsed.success) {
          const document = {
            ...parsed.data,
            chapters: parsed.data.chapters.map((entry) => ({
              ...entry,
              id: entryIdMap.get(entry.id) || newPlanEntryId(),
            })),
          };
          await db.run(
            'INSERT INTO story_plan (project_id, revision, document_json) VALUES (?, ?, ?)',
            newProjectId,
            Number(sourcePlan.revision) || 1,
            JSON.stringify(document)
          );
        }
      }

      const characterIdMap = new Map<number, number>();
      const characters = await db.all(
        'SELECT * FROM character WHERE project_id = ? ORDER BY id ASC',
        id
      );
      for (const character of characters) {
        const charRes = await db.run(
          `INSERT INTO character
            (project_id, name, role, description, visual_tags, active_version, voice_id, voice_label)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          newProjectId,
          character.name,
          character.role ?? null,
          character.description ?? null,
          character.visual_tags || '{}',
          character.active_version || 1,
          character.voice_id ?? null,
          character.voice_label ?? null
        );
        const newCharId = charRes.lastID;
        if (newCharId !== undefined) {
          characterIdMap.set(character.id, Number(newCharId));
          const charVersions = await db.all(
            'SELECT * FROM character_version WHERE character_id = ? ORDER BY version ASC',
            character.id
          );
          for (const cv of charVersions) {
            await db.run(
              `INSERT INTO character_version (character_id, version, label, description, visual_tags)
               VALUES (?, ?, ?, ?, ?)`,
              newCharId,
              cv.version,
              cv.label ?? null,
              cv.description ?? null,
              cv.visual_tags ?? null
            );
          }
        }
      }

      const scriptIdMap = new Map<number, number>();
      const projectAvailableTables = new Set(
        (
          await Promise.all(
            ['chapter_script', 'script_change'].map(async (name) => ({
              name,
              exists: await tableExists(name)
            }))
          )
        )
          .filter(({ exists }) => exists)
          .map(({ name }) => name)
      );

      if (projectAvailableTables.has('chapter_script')) {
        const sourceScripts = await db.all(
          `SELECT cs.*
           FROM chapter_script cs
           INNER JOIN chapter c ON c.id = cs.chapter_id
           WHERE c.project_id = ?`,
          id
        );

        for (const script of sourceScripts) {
          const newChapterId = chapterIdMap.get(script.chapter_id);
          if (!newChapterId) continue;

          let document = parseStoredJson(script.document_json);
          document = remapScriptDocumentCharacters(document, characterIdMap);

          const snapshot = remapScriptSourceSnapshot(parseStoredJson(script.source_snapshot_json), newChapterId, characterIdMap);

          const scriptRes = await db.run(
            `INSERT INTO chapter_script (
              chapter_id, revision, status, document_json, source_snapshot_json,
              source_content_hash, source_context_hash, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            newChapterId,
            script.revision,
            script.status,
            JSON.stringify(document),
            JSON.stringify(snapshot),
            script.source_content_hash,
            script.source_context_hash
          );
          const newScriptId = Number(scriptRes.lastID);
          if (newScriptId) {
            scriptIdMap.set(script.id, newScriptId);
          }

          if (projectAvailableTables.has('script_change') && newScriptId) {
            const changes = await db.all(
              'SELECT * FROM script_change WHERE script_id = ? ORDER BY created_at ASC',
              script.id
            );
            for (const ch of changes) {
              const newChangeId = randomUUID();
              let beforeDoc = parseStoredJson(ch.before_json);
              let afterDoc = parseStoredJson(ch.after_json);

              await db.run(
                `INSERT INTO script_change (
                  id, script_id, kind, base_revision, candidate_revision,
                  request_key, state, before_json, after_json, source_snapshot_json,
                  generation_info_json, applied_revision, result_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                newChangeId,
                newScriptId,
                ch.kind,
                ch.base_revision,
                ch.candidate_revision,
                ch.request_key ? `dup_${newChangeId}_${ch.request_key}` : newChangeId,
                ch.state,
                beforeDoc ? JSON.stringify(beforeDoc) : ch.before_json,
                afterDoc ? JSON.stringify(afterDoc) : ch.after_json,
                ch.source_snapshot_json,
                ch.generation_info_json,
                ch.applied_revision,
                ch.result_json
              );
            }
          }
        }
      }

      const sceneIdMap = new Map<string, number>();
      let sceneCount = 0;
      for (const [sourceChapterId, newChapterId] of chapterIdMap.entries()) {
        const scenes = await db.all(
          'SELECT * FROM scene WHERE chapter_id = ? ORDER BY "index" ASC',
          sourceChapterId
        );
        for (const scene of scenes) {
          const remappedShotSpec = remapShotSpecScriptId(scene.shot_spec, scriptIdMap);
          const sceneRes = await db.run(
            `INSERT INTO scene (
              chapter_id, "index", visual_prompt, audio_prompt, dialogue, narration,
              duration, shot_type, camera_movement, camera_angle,
              negative_prompt, shot_spec, asset_status, asset_url, task_id, active_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            newChapterId,
            scene.index,
            scene.visual_prompt ?? null,
            scene.audio_prompt ?? null,
            scene.dialogue ?? null,
            scene.narration ?? null,
            scene.duration ?? 3,
            scene.shot_type ?? null,
            scene.camera_movement ?? null,
            scene.camera_angle ?? null,
            scene.negative_prompt ?? null,
            remappedShotSpec,
            scene.asset_status || 'idle',
            scene.asset_url ?? null,
            scene.task_id ?? null,
            scene.active_version || 1
          );
          const newSceneId = sceneRes.lastID;
          sceneCount += 1;

          if (newSceneId !== undefined) {
            sceneIdMap.set(String(scene.id), Number(newSceneId));
            const sceneVersions = await db.all(
              'SELECT * FROM scene_version WHERE scene_id = ? ORDER BY version ASC',
              scene.id
            );
            for (const sv of sceneVersions) {
              await db.run(
                `INSERT INTO scene_version (
                  scene_id, version, label, visual_prompt, audio_prompt, dialogue, narration,
                  duration, shot_type, camera_movement, camera_angle, negative_prompt,
                  asset_status, task_id, asset_url
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                newSceneId,
                sv.version,
                sv.label ?? null,
                sv.visual_prompt ?? null,
                sv.audio_prompt ?? null,
                sv.dialogue ?? null,
                sv.narration ?? null,
                sv.duration ?? 3,
                sv.shot_type ?? null,
                sv.camera_movement ?? null,
                sv.camera_angle ?? null,
                sv.negative_prompt ?? null,
                sv.asset_status || 'idle',
                sv.task_id ?? null,
                sv.asset_url ?? null
              );
            }

            const coverageGroups = await db.all(
              'SELECT * FROM coverage_group WHERE source_scene_id = ? ORDER BY version ASC',
              scene.id
            );
            for (const cg of coverageGroups) {
              const cgRes = await db.run(
                'INSERT INTO coverage_group (source_scene_id, version, status) VALUES (?, ?, ?)',
                newSceneId,
                cg.version ?? 1,
                cg.status || 'completed'
              );
              const newCgId = cgRes.lastID;
              if (newCgId !== undefined) {
                const shots = await db.all(
                  'SELECT * FROM coverage_shot WHERE coverage_group_id = ? ORDER BY slot ASC',
                  cg.id
                );
                for (const shot of shots) {
                  const remappedCoverageShotSpec = remapShotSpecScriptId(shot.shot_spec, scriptIdMap);
                  await db.run(
                    `INSERT INTO coverage_shot (
                      coverage_group_id, slot, shot_size, camera_angle, camera_movement,
                      narrative_purpose, visual_prompt, negative_prompt, shot_spec, shot_intent,
                      asset_status, task_id, asset_url
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    newCgId,
                    shot.slot ?? 1,
                    shot.shot_size ?? null,
                    shot.camera_angle ?? null,
                    shot.camera_movement ?? null,
                    shot.narrative_purpose ?? null,
                    shot.visual_prompt ?? null,
                    shot.negative_prompt ?? null,
                    remappedCoverageShotSpec,
                    shot.shot_intent ?? null,
                    shot.asset_status || 'idle',
                    shot.task_id ?? null,
                    shot.asset_url ?? null
                  );
                }
              }
            }
          }
        }
      }

      await remapCopiedScriptChanges({ scripts: scriptIdMap, characters: characterIdMap, chapters: chapterIdMap, scenes: sceneIdMap }, [...scriptIdMap.values()]);
      await restoreAssetLibrary(await exportAssetLibrary(id), newProjectId, chapterIdMap, sceneIdMap);
      await db.exec('COMMIT');
      return reply.status(201).send({
        project: await db.get('SELECT * FROM project WHERE id = ?', newProjectId),
        counts: {
          chapters: chapters.length,
          characters: characters.length,
          scripts: scriptIdMap.size,
          scenes: sceneCount,
          glossary: glossaryItems.length
        }
      });
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  });

  app.post('/import', async (request, reply) => {
    const user = mockGetCurrentUser(request);
    let file;
    try {
      file = await request.file();
    } catch {
      return reply.status(400).send({ detail: 'Please upload the file as multipart/form-data' });
    }

    if (!file) {
      return reply.status(400).send({ detail: 'Please select a text, Markdown, or JSON file to import' });
    }

    try {
      const buffer = await file.toBuffer();
      const project = await commitProjectImportFile(
        buffer,
        file.filename || '',
        user.id
      );
      return reply.status(201).send(project);
    } catch (error) {
      if (error instanceof ProjectImportInputError) {
        return reply.status(error.statusCode).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.get('/', async (request, reply) => {
    const user = mockGetCurrentUser(request);

    // We get skip and limit from query string
    const querySchema = z.object({
      skip: z.coerce.number().default(0),
      limit: z.coerce.number().default(100)
    });

    const { skip, limit } = querySchema.parse(request.query);

    let sql = 'SELECT * FROM project';
    let params: any[] = [];

    if (user.id !== 'local_admin') {
      sql += ' WHERE user_id = ?';
      params.push(user.id);
    }

    sql += ' ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?';
    params.push(limit, skip);

    const rows = await db.all(sql, ...params);
    return rows;
  });

  app.get('/:id', async (request, reply) => {
    const paramsSchema = z.object({
      id: z.coerce.number()
    });
    const { id } = paramsSchema.parse(request.params);
    const user = mockGetCurrentUser(request);

    const project = await db.get('SELECT * FROM project WHERE id = ?', id);
    if (!project) {
      return reply.status(404).send({ detail: 'Project not found' });
    }

    if (user.id !== 'local_admin' && project.user_id !== user.id) {
      return reply.status(403).send({ detail: 'Not authorized to access this project' });
    }

    const { buildStoryBibleView } = await import('../services/story_bible');
    const storyBible = await buildStoryBibleView(id);
    const fresh = await db.get('SELECT * FROM project WHERE id = ?', id);
    return {
      ...fresh,
      settings: JSON.stringify(canonicalProjectSettings(fresh.settings)),
      story_bible: storyBible,
    };
  });

  // --- Glossary (Agent OS / story bible) ---
  app.get('/:id/glossary', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const project = await db.get('SELECT id FROM project WHERE id = ?', id);
    if (!project) {
      return reply.status(404).send({ detail: 'Project not found' });
    }
    return db.all(
      'SELECT * FROM glossary WHERE project_id = ? ORDER BY id ASC',
      id
    );
  });

  app.post('/:id/glossary', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const body = z
      .object({
        term: z.string().min(1),
        definition: z.string().optional().nullable(),
        category: z.string().optional().nullable(),
      })
      .parse(request.body);
    const project = await db.get('SELECT id FROM project WHERE id = ?', id);
    if (!project) {
      return reply.status(404).send({ detail: 'Project not found' });
    }
    const result = await db.run(
      'INSERT INTO glossary (project_id, term, definition, category) VALUES (?, ?, ?, ?)',
      id,
      body.term,
      body.definition ?? null,
      body.category ?? null
    );
    return reply.status(201).send(
      await db.get('SELECT * FROM glossary WHERE id = ?', result.lastID)
    );
  });

  app.put('/:id/glossary/:glossaryId', async (request, reply) => {
    const { id, glossaryId } = z
      .object({ id: z.coerce.number(), glossaryId: z.coerce.number() })
      .parse(request.params);
    const body = z
      .object({
        term: z.string().min(1).optional(),
        definition: z.string().optional().nullable(),
        category: z.string().optional().nullable(),
      })
      .parse(request.body);
    const existing = await db.get(
      'SELECT * FROM glossary WHERE id = ? AND project_id = ?',
      glossaryId,
      id
    );
    if (!existing) {
      return reply.status(404).send({ detail: 'Glossary term not found' });
    }
    const fields: string[] = [];
    const values: unknown[] = [];
    if (body.term !== undefined) {
      fields.push('term = ?');
      values.push(body.term);
    }
    if (body.definition !== undefined) {
      fields.push('definition = ?');
      values.push(body.definition);
    }
    if (body.category !== undefined) {
      fields.push('category = ?');
      values.push(body.category);
    }
    if (fields.length) {
      values.push(glossaryId);
      await db.run(
        `UPDATE glossary SET ${fields.join(', ')} WHERE id = ?`,
        ...values
      );
    }
    return db.get('SELECT * FROM glossary WHERE id = ?', glossaryId);
  });

  app.delete('/:id/glossary/:glossaryId', async (request, reply) => {
    const { id, glossaryId } = z
      .object({ id: z.coerce.number(), glossaryId: z.coerce.number() })
      .parse(request.params);
    const existing = await db.get(
      'SELECT id FROM glossary WHERE id = ? AND project_id = ?',
      glossaryId,
      id
    );
    if (!existing) {
      return reply.status(404).send({ detail: 'Glossary term not found' });
    }
    await db.run('DELETE FROM glossary WHERE id = ?', glossaryId);
    return { status: 'success', id: glossaryId };
  });

  app.post('/', async (request, reply) => {
    const user = mockGetCurrentUser(request);
    const data = ProjectCreateSchema.parse(request.body);

    const settingsJson = data.settings
      ? await validateImageSettings(data.settings, reply)
      : JSON.stringify({ image_generation: DEFAULT_PROJECT_IMAGE_SETTINGS });
    if (settingsJson == null) return;
    const result = await db.run(
      'INSERT INTO project (title, description, settings, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      data.title,
      data.description || null,
      settingsJson,
      user.id
    );

    const newProject = await db.get('SELECT * FROM project WHERE id = ?', result.lastID);
    return newProject;
  });

  app.put('/:id', async (request, reply) => {
    const paramsSchema = z.object({
      id: z.coerce.number()
    });
    const { id } = paramsSchema.parse(request.params);
    const user = mockGetCurrentUser(request);

    const project = await db.get('SELECT * FROM project WHERE id = ?', id);
    if (!project) {
      return reply.status(404).send({ detail: 'Project not found' });
    }

    if (user.id !== 'local_admin' && project.user_id !== user.id) {
      return reply.status(403).send({ detail: 'Not authorized to update this project' });
    }

    const data = ProjectUpdateSchema.parse(request.body);

    const updateFields = [];
    const params = [];

    if (data.title !== undefined) {
      updateFields.push('title = ?');
      params.push(data.title);
    }
    if (data.description !== undefined) {
      updateFields.push('description = ?');
      params.push(data.description);
    }
    let settingsJson: string | null | undefined;
    if (data.settings !== undefined) {
      if (data.settings == null) {
        settingsJson = null;
      } else {
        let incoming: Record<string, unknown>;
        try {
          incoming = JSON.parse(data.settings);
        } catch {
          return reply.status(400).send({ detail: 'Project settings must be valid JSON' });
        }
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
          return reply.status(400).send({ detail: 'Project settings must be valid JSON' });
        }
        await db.exec('BEGIN IMMEDIATE TRANSACTION');
        try {
          const fresh = await db.get('SELECT settings FROM project WHERE id = ?', id);
          const { patchProjectSettings } = await import('../services/story_bible');
          const merged = patchProjectSettings(parseProjectSettings(fresh?.settings), incoming);
          settingsJson = await validateImageSettings(JSON.stringify(merged), reply);
          if (settingsJson == null) {
            await db.exec('ROLLBACK');
            return;
          }
          updateFields.push('settings = ?');
          params.push(settingsJson);
          updateFields.push('updated_at = CURRENT_TIMESTAMP');
          params.push(id);
          await db.run(`UPDATE project SET ${updateFields.join(', ')} WHERE id = ?`, ...params);
          await db.exec('COMMIT');
        } catch (error) {
          await db.exec('ROLLBACK');
          throw error;
        }
        const updatedProject = await db.get('SELECT * FROM project WHERE id = ?', id);
        return updatedProject;
      }
    }

    if (settingsJson === null) {
      updateFields.push('settings = ?');
      params.push(null);
    }

    if (updateFields.length > 0) {
      updateFields.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);
      await db.run(
        `UPDATE project SET ${updateFields.join(', ')} WHERE id = ?`,
        ...params
      );
    }

    const updatedProject = await db.get('SELECT * FROM project WHERE id = ?', id);
    return updatedProject;
  });

  app.delete('/:id', async (request, reply) => {
    const paramsSchema = z.object({
      id: z.coerce.number()
    });
    const { id } = paramsSchema.parse(request.params);
    const user = mockGetCurrentUser(request);

    const project = await db.get('SELECT * FROM project WHERE id = ?', id);
    if (!project) {
      return reply.status(404).send({ detail: 'Project not found' });
    }

    if (user.id !== 'local_admin' && project.user_id !== user.id) {
      return reply.status(403).send({ detail: 'Not authorized to delete this project' });
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      await db.run(
        `DELETE FROM script_change
         WHERE script_id IN (
           SELECT cs.id
           FROM chapter_script cs
           INNER JOIN chapter c ON c.id = cs.chapter_id
           WHERE c.project_id = ?
         )`,
        id
      );
      await db.run(
        `DELETE FROM chapter_script
         WHERE chapter_id IN (
           SELECT id FROM chapter WHERE project_id = ?
         )`,
        id
      );
      await db.run(
        `DELETE FROM coverage_shot
         WHERE coverage_group_id IN (
           SELECT coverage_group.id
           FROM coverage_group
           INNER JOIN scene ON scene.id = coverage_group.source_scene_id
           INNER JOIN chapter ON chapter.id = scene.chapter_id
           WHERE chapter.project_id = ?
         )`,
        id
      );
      await db.run(
        `DELETE FROM coverage_group
         WHERE source_scene_id IN (
           SELECT scene.id
           FROM scene
           INNER JOIN chapter ON chapter.id = scene.chapter_id
           WHERE chapter.project_id = ?
         )`,
        id
      );
      await db.run(
        `DELETE FROM scene_version
         WHERE scene_id IN (
           SELECT scene.id
           FROM scene
           INNER JOIN chapter ON chapter.id = scene.chapter_id
           WHERE chapter.project_id = ?
         )`,
        id
      );
      await db.run(
        `DELETE FROM scene
         WHERE chapter_id IN (
           SELECT id FROM chapter WHERE project_id = ?
         )`,
        id
      );
      await db.run(
        `DELETE FROM character_version
         WHERE character_id IN (
           SELECT character.id
           FROM character
           WHERE character.project_id = ?
         )`,
        id
      );
      await db.run('DELETE FROM character WHERE project_id = ?', id);
      await db.run('DELETE FROM glossary WHERE project_id = ?', id);
      await db.run('DELETE FROM chapter WHERE project_id = ?', id);
      await db.run('DELETE FROM project WHERE id = ?', id);
      await db.exec('COMMIT');
      return project;
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  });
};
