import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/database';
import { ProjectCreateSchema, ProjectUpdateSchema } from '../schemas/project';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import path from 'path';
import { decodeTextFile, parseTextProject } from '../services/text_import';

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
          ['character', 'scene', 'coverage_group', 'coverage_shot'].map(async (name) => ({
            name,
            exists: await tableExists(name)
          }))
        )
      )
        .filter(({ exists }) => exists)
        .map(({ name }) => name)
    );

    const [chapters, rawCharacters, rawScenes, coverageGroups, coverageShots] = await Promise.all([
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

    const exportData = {
      format: 'novastory-project',
      version: 1,
      exported_at: new Date().toISOString(),
      project: {
        ...project,
        settings: parseStoredJson(project.settings)
      },
      screenplay: {
        chapters
      },
      character_center: {
        characters
      },
      director: {
        scenes,
        coverage_groups: coverageGroups,
        coverage_shots: coverageShots
      },
      summary: {
        chapters: chapters.length,
        characters: characters.length,
        scenes: scenes.length,
        coverage_groups: coverageGroups.length,
        coverage_shots: coverageShots.length
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
      const chapters = await db.all(
        'SELECT * FROM chapter WHERE project_id = ? ORDER BY "index" ASC',
        id
      );
      for (const chapter of chapters) {
        const newChapterId = randomUUID();
        chapterIdMap.set(chapter.id, newChapterId);
        await db.run(
          `INSERT INTO chapter
            (id, project_id, "index", title, content, summary, status, condensed_content)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          newChapterId,
          newProjectId,
          chapter.index,
          chapter.title,
          chapter.content ?? null,
          chapter.summary ?? null,
          chapter.status || 'draft',
          chapter.condensed_content ?? null
        );
      }

      const characters = await db.all(
        'SELECT * FROM character WHERE project_id = ? ORDER BY id ASC',
        id
      );
      for (const character of characters) {
        const charRes = await db.run(
          `INSERT INTO character
            (project_id, name, role, description, visual_tags, active_version)
           VALUES (?, ?, ?, ?, ?, ?)`,
          newProjectId,
          character.name,
          character.role ?? null,
          character.description ?? null,
          character.visual_tags || '{}',
          character.active_version || 1
        );
        const newCharId = charRes.lastID;
        if (newCharId !== undefined) {
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

      let sceneCount = 0;
      for (const [sourceChapterId, newChapterId] of chapterIdMap.entries()) {
        const scenes = await db.all(
          'SELECT * FROM scene WHERE chapter_id = ? ORDER BY "index" ASC',
          sourceChapterId
        );
        for (const scene of scenes) {
          const sceneRes = await db.run(
            `INSERT INTO scene (
              chapter_id, "index", visual_prompt, audio_prompt, dialogue,
              duration, shot_type, camera_movement, camera_angle,
              negative_prompt, shot_spec, asset_status, asset_url, task_id, active_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            newChapterId,
            scene.index,
            scene.visual_prompt ?? null,
            scene.audio_prompt ?? null,
            scene.dialogue ?? null,
            scene.duration ?? 3,
            scene.shot_type ?? null,
            scene.camera_movement ?? null,
            scene.camera_angle ?? null,
            scene.negative_prompt ?? null,
            scene.shot_spec ?? null,
            scene.asset_status || 'idle',
            scene.asset_url ?? null,
            scene.task_id ?? null,
            scene.active_version || 1
          );
          const newSceneId = sceneRes.lastID;
          sceneCount += 1;

          if (newSceneId !== undefined) {
            const sceneVersions = await db.all(
              'SELECT * FROM scene_version WHERE scene_id = ? ORDER BY version ASC',
              scene.id
            );
            for (const sv of sceneVersions) {
              await db.run(
                `INSERT INTO scene_version (
                  scene_id, version, label, visual_prompt, audio_prompt, dialogue,
                  duration, shot_type, camera_movement, camera_angle, negative_prompt,
                  asset_status, task_id, asset_url
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                newSceneId,
                sv.version,
                sv.label ?? null,
                sv.visual_prompt ?? null,
                sv.audio_prompt ?? null,
                sv.dialogue ?? null,
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
                  await db.run(
                    `INSERT INTO coverage_shot (
                      coverage_group_id, slot, shot_size, camera_angle, camera_movement,
                      narrative_purpose, visual_prompt, asset_status, task_id, asset_url
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    newCgId,
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
            }
          }
        }
      }

      await db.exec('COMMIT');
      return reply.status(201).send({
        project: await db.get('SELECT * FROM project WHERE id = ?', newProjectId),
        counts: {
          chapters: chapters.length,
          characters: characters.length,
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
      return reply.status(400).send({ detail: 'Please select a text or JSON file to import' });
    }

    const filename = file.filename || '';
    const ext = path.extname(filename).toLowerCase();
    const isJsonFile = ext === '.json' || filename.toLowerCase().endsWith('.novastory.json');

    if (ext !== '.txt' && !isJsonFile) {
      return reply.status(415).send({ detail: 'Only .txt or .json / .novastory.json files can be imported' });
    }

    const buffer = await file.toBuffer();
    const rawText = decodeTextFile(buffer);
    let jsonContent: any = null;

    if (isJsonFile || rawText.trim().startsWith('{')) {
      try {
        jsonContent = JSON.parse(rawText);
      } catch (e) {
        if (isJsonFile) {
          return reply.status(400).send({ detail: 'Could not parse the selected JSON file' });
        }
      }
    }

    if (jsonContent && typeof jsonContent === 'object') {
      const projectTitle = jsonContent.project?.title || jsonContent.title || path.basename(filename, ext) || 'Imported Project';
      const projectDescription = jsonContent.project?.description ?? jsonContent.description ?? null;
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
      const rawCoverageGroups = Array.isArray(directorData.coverage_groups) ? directorData.coverage_groups : [];
      const rawCoverageShots = Array.isArray(directorData.coverage_shots) ? directorData.coverage_shots : [];

      const availableTables = new Set(
        (
          await Promise.all(
            ['character', 'scene', 'coverage_group', 'coverage_shot'].map(async (name) => ({
              name,
              exists: await tableExists(name)
            }))
          )
        )
          .filter(({ exists }) => exists)
          .map(({ name }) => name)
      );

      await db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        const result = await db.run(
          'INSERT INTO project (title, description, settings, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
          projectTitle,
          projectDescription,
          projectSettings,
          user.id
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
            'INSERT INTO chapter (id, project_id, "index", title, content, summary, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            newChapterId,
            projectId,
            chapter.index ?? (index + 1),
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
              `INSERT INTO character (
                 project_id, name, role, description, visual_tags
               ) VALUES (?, ?, ?, ?, ?)`,
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
          for (const cg of rawCoverageGroups) {
            const newSceneId = sceneIdMap.get(Number(cg.source_scene_id));
            if (newSceneId === undefined) continue;

            const cgResult = await db.run(
              `INSERT INTO coverage_group (source_scene_id, version, status)
               VALUES (?, ?, ?)`,
              newSceneId,
              cg.version ?? 1,
              cg.status || 'completed'
            );

            if (cg.id !== undefined && cg.id !== null && cgResult.lastID !== undefined) {
              groupIdMap.set(Number(cg.id), Number(cgResult.lastID));
            }
          }
        }

        if (availableTables.has('coverage_shot') && rawCoverageShots.length > 0) {
          for (const cs of rawCoverageShots) {
            const newGroupId = groupIdMap.get(Number(cs.coverage_group_id));
            if (newGroupId === undefined) continue;

            await db.run(
              `INSERT INTO coverage_shot (
                coverage_group_id, slot, shot_size, camera_angle, camera_movement,
                narrative_purpose, visual_prompt, asset_status, task_id, asset_url
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              newGroupId,
              cs.slot ?? 1,
              cs.shot_size ?? null,
              cs.camera_angle ?? null,
              cs.camera_movement ?? null,
              cs.narrative_purpose ?? null,
              cs.visual_prompt ?? null,
              cs.asset_status || 'idle',
              cs.task_id ?? null,
              cs.asset_url ?? null
            );
          }
        }

        await db.exec('COMMIT');
        const project = await db.get('SELECT * FROM project WHERE id = ?', projectId);
        return reply.status(201).send(project);
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    }

    let parsed;
    try {
      parsed = parseTextProject(rawText, filename);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Could not parse the selected file';
      return reply.status(400).send({ detail });
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const result = await db.run(
        'INSERT INTO project (title, description, settings, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
        parsed.title,
        parsed.description || null,
        '{}',
        user.id
      );

      const projectId = result.lastID;
      if (projectId === undefined) {
        throw new Error('Could not create the imported project');
      }

      for (const [index, chapter] of parsed.chapters.entries()) {
        await db.run(
          'INSERT INTO chapter (id, project_id, "index", title, content, status) VALUES (?, ?, ?, ?, ?, ?)',
          randomUUID(),
          projectId,
          index + 1,
          chapter.title,
          chapter.content,
          'draft'
        );
      }

      for (const character of parsed.characters) {
        await db.run(
          `INSERT INTO character (
             project_id, name, role, description, visual_tags
           ) VALUES (?, ?, ?, ?, ?)`,
          projectId,
          character.name,
          character.role,
          character.description,
          '{}'
        );
      }

      await db.exec('COMMIT');
      const project = await db.get('SELECT * FROM project WHERE id = ?', projectId);
      return reply.status(201).send(project);
    } catch (error) {
      await db.exec('ROLLBACK');
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

    sql += ' LIMIT ? OFFSET ?';
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

    return project;
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

    const result = await db.run(
      'INSERT INTO project (title, description, settings, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      data.title,
      data.description || null,
      data.settings || '{}',
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
    if (data.settings !== undefined) {
      updateFields.push('settings = ?');
      params.push(data.settings);
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
