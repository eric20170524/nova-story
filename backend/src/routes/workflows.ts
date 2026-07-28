import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/database';
import { WorkflowCreateSchema, WorkflowUpdateSchema } from '../schemas/workflow';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

export const workflowRoutes: FastifyPluginAsync = async (app) => {
  app.get('/files', async (request, reply) => {
    const staticWorkflowsDir = path.join(__dirname, '../../app/static/workflows');
    const diskFiles = fs.existsSync(staticWorkflowsDir)
      ? fs.readdirSync(staticWorkflowsDir).filter(f => f.endsWith('.json'))
      : [];
    const rows = await db.all('SELECT name FROM workflow WHERE is_active = 1 ORDER BY name');
    const databaseFiles = rows
      .map((row: any) => String(row.name || '').trim())
      .filter(Boolean)
      .map((name: string) => name.endsWith('.json') ? name : `${name}.json`);

    return Array.from(new Set([...diskFiles, ...databaseFiles])).sort();
  });

  app.get('/', async (request, reply) => {
    const querySchema = z.object({
      skip: z.coerce.number().default(0),
      limit: z.coerce.number().default(100)
    });
    const { skip, limit } = querySchema.parse(request.query);

    // SQLite boolean might be stored as 1 or 0
    const rows = await db.all('SELECT * FROM workflow WHERE is_active = 1 LIMIT ? OFFSET ?', limit, skip);
    return rows.map(row => ({
      ...row,
      content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content,
      is_active: row.is_active === 1
    }));
  });

  app.get('/:id', async (request, reply) => {
    const paramsSchema = z.object({ id: z.coerce.number() });
    const { id } = paramsSchema.parse(request.params);

    const workflow = await db.get('SELECT * FROM workflow WHERE id = ?', id);
    if (!workflow) {
      return reply.status(404).send({ detail: 'Workflow not found' });
    }

    return {
      ...workflow,
      content: typeof workflow.content === 'string' ? JSON.parse(workflow.content) : workflow.content,
      is_active: workflow.is_active === 1
    };
  });

  app.post('/', async (request, reply) => {
    const data = WorkflowCreateSchema.parse(request.body);
    const contentStr = typeof data.content === 'string' ? data.content : JSON.stringify(data.content);

    const result = await db.run(
      'INSERT INTO workflow (name, description, content, is_active) VALUES (?, ?, ?, ?)',
      data.name,
      data.description || null,
      contentStr,
      data.is_active ? 1 : 0
    );

    const newWorkflow = await db.get('SELECT * FROM workflow WHERE id = ?', result.lastID);
    return {
      ...newWorkflow,
      content: typeof newWorkflow.content === 'string' ? JSON.parse(newWorkflow.content) : newWorkflow.content,
      is_active: newWorkflow.is_active === 1
    };
  });

  app.put('/:id', async (request, reply) => {
    const paramsSchema = z.object({ id: z.coerce.number() });
    const { id } = paramsSchema.parse(request.params);

    const workflow = await db.get('SELECT * FROM workflow WHERE id = ?', id);
    if (!workflow) {
      return reply.status(404).send({ detail: 'Workflow not found' });
    }

    const data = WorkflowUpdateSchema.parse(request.body);
    const updateFields = [];
    const params = [];

    if (data.name !== undefined) {
      updateFields.push('name = ?');
      params.push(data.name);
    }
    if (data.description !== undefined) {
      updateFields.push('description = ?');
      params.push(data.description);
    }
    if (data.content !== undefined) {
      updateFields.push('content = ?');
      params.push(typeof data.content === 'string' ? data.content : JSON.stringify(data.content));
    }
    if (data.is_active !== undefined) {
      updateFields.push('is_active = ?');
      params.push(data.is_active ? 1 : 0);
    }

    if (updateFields.length > 0) {
      params.push(id);
      await db.run(`UPDATE workflow SET ${updateFields.join(', ')} WHERE id = ?`, ...params);
    }

    const updatedWorkflow = await db.get('SELECT * FROM workflow WHERE id = ?', id);
    return {
      ...updatedWorkflow,
      content: typeof updatedWorkflow.content === 'string' ? JSON.parse(updatedWorkflow.content) : updatedWorkflow.content,
      is_active: updatedWorkflow.is_active === 1
    };
  });

  app.delete('/:id', async (request, reply) => {
    const paramsSchema = z.object({ id: z.coerce.number() });
    const { id } = paramsSchema.parse(request.params);

    const workflow = await db.get('SELECT * FROM workflow WHERE id = ?', id);
    if (!workflow) {
      return reply.status(404).send({ detail: 'Workflow not found' });
    }

    await db.run('DELETE FROM workflow WHERE id = ?', id);
    return {
      ...workflow,
      content: typeof workflow.content === 'string' ? JSON.parse(workflow.content) : workflow.content,
      is_active: workflow.is_active === 1
    };
  });
};
