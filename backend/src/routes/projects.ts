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

export const projectRoutes: FastifyPluginAsync = async (app) => {
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
            (id, project_id, "index", title, content, summary, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          newChapterId,
          newProjectId,
          chapter.index,
          chapter.title,
          chapter.content ?? null,
          chapter.summary ?? null,
          chapter.status || 'draft'
        );
      }

      const characters = await db.all(
        'SELECT name, role, description, visual_tags FROM character WHERE project_id = ? ORDER BY id ASC',
        id
      );
      for (const character of characters) {
        await db.run(
          `INSERT INTO character
            (project_id, name, role, description, visual_tags)
           VALUES (?, ?, ?, ?, ?)`,
          newProjectId,
          character.name,
          character.role ?? null,
          character.description ?? null,
          character.visual_tags || '{}'
        );
      }

      let sceneCount = 0;
      for (const [sourceChapterId, newChapterId] of chapterIdMap.entries()) {
        const scenes = await db.all(
          'SELECT * FROM scene WHERE chapter_id = ? ORDER BY "index" ASC',
          sourceChapterId
        );
        for (const scene of scenes) {
          await db.run(
            `INSERT INTO scene (
              chapter_id, "index", visual_prompt, audio_prompt, dialogue,
              duration, shot_type, camera_movement, camera_angle,
              negative_prompt, asset_status, asset_url, task_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            scene.asset_status || 'idle',
            scene.asset_url ?? null,
            scene.task_id ?? null
          );
          sceneCount += 1;
        }
      }

      await db.exec('COMMIT');
      return reply.status(201).send({
        project: await db.get('SELECT * FROM project WHERE id = ?', newProjectId),
        counts: {
          chapters: chapters.length,
          characters: characters.length,
          scenes: sceneCount
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
      return reply.status(400).send({ detail: 'Please select a text file to import' });
    }

    if (path.extname(file.filename).toLowerCase() !== '.txt') {
      return reply.status(415).send({ detail: 'Only .txt files can be imported' });
    }

    let parsed;
    try {
      const content = decodeTextFile(await file.toBuffer());
      parsed = parseTextProject(content, file.filename);
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

    sql += ` LIMIT ${limit} OFFSET ${skip}`;

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

    await db.run('DELETE FROM project WHERE id = ?', id);
    return project;
  });
};
