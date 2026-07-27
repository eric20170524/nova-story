import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/database';
import { ProjectCreateSchema, ProjectUpdateSchema } from '../schemas/project';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// Dummy implementation of current_user auth
// Real implementation should parse JWT/headers as needed
const mockGetCurrentUser = (request: any) => ({
  id: 'local_admin'
});

export const projectRoutes: FastifyPluginAsync = async (app) => {
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

  // Note: /import endpoint for multipart/form-data upload will require fastify-multipart
  // Implementation for /import can be fleshed out later depending on how we handle parsing text.
};
