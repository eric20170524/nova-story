import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/database';

const ChapterCreateSchema = z.object({
  id: z.string().min(1),
  project_id: z.coerce.number().int(),
  index: z.coerce.number().int(),
  title: z.string().min(1),
  content: z.string().nullable().optional()
});

const ChapterUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().nullable().optional(),
  summary: z.string().nullable().optional()
});

const ChapterIdSchema = z.object({
  id: z.string().min(1)
});

export const chapterRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request) => {
    const { project_id } = z.object({
      project_id: z.coerce.number().int()
    }).parse(request.query);

    return db.all(
      'SELECT * FROM chapter WHERE project_id = ? ORDER BY "index" ASC',
      project_id
    );
  });

  app.post('/', async (request, reply) => {
    const chapter = ChapterCreateSchema.parse(request.body);
    const project = await db.get('SELECT id FROM project WHERE id = ?', chapter.project_id);
    if (!project) {
      return reply.status(404).send({ detail: 'Project not found' });
    }

    await db.run(
      'INSERT INTO chapter (id, project_id, "index", title, content, status) VALUES (?, ?, ?, ?, ?, ?)',
      chapter.id,
      chapter.project_id,
      chapter.index,
      chapter.title,
      chapter.content ?? null,
      'draft'
    );

    return reply.status(201).send(
      await db.get('SELECT * FROM chapter WHERE id = ?', chapter.id)
    );
  });

  app.patch('/:id', async (request, reply) => {
    const { id } = ChapterIdSchema.parse(request.params);
    const update = ChapterUpdateSchema.parse(request.body);
    const existing = await db.get('SELECT * FROM chapter WHERE id = ?', id);
    if (!existing) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    for (const field of ['title', 'content', 'summary'] as const) {
      if (update[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(update[field]);
      }
    }

    if (fields.length > 0) {
      await db.run(
        `UPDATE chapter SET ${fields.join(', ')} WHERE id = ?`,
        ...values,
        id
      );
    }

    return db.get('SELECT * FROM chapter WHERE id = ?', id);
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = ChapterIdSchema.parse(request.params);
    const existing = await db.get('SELECT * FROM chapter WHERE id = ?', id);
    if (!existing) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      await db.run(
        `DELETE FROM coverage_shot
         WHERE coverage_group_id IN (
           SELECT coverage_group.id
           FROM coverage_group
           INNER JOIN scene ON scene.id = coverage_group.source_scene_id
           WHERE scene.chapter_id = ?
         )`,
        id
      );
      await db.run(
        `DELETE FROM coverage_group
         WHERE source_scene_id IN (
           SELECT id FROM scene WHERE chapter_id = ?
         )`,
        id
      );
      await db.run('DELETE FROM scene WHERE chapter_id = ?', id);
      await db.run('DELETE FROM chapter WHERE id = ?', id);
      await db.exec('COMMIT');
      return { status: 'success', id };
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  });

  app.put('/:id/move', async (request, reply) => {
    const { id } = ChapterIdSchema.parse(request.params);
    const { new_index } = z.object({
      new_index: z.coerce.number().int().min(0)
    }).parse(request.body);
    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', id);

    if (!chapter) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }
    if (chapter.index === new_index) {
      return { status: 'no_change', new_index };
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      if (new_index > chapter.index) {
        await db.run(
          'UPDATE chapter SET "index" = "index" - 1 WHERE project_id = ? AND id <> ? AND "index" > ? AND "index" <= ?',
          chapter.project_id,
          id,
          chapter.index,
          new_index
        );
      } else {
        await db.run(
          'UPDATE chapter SET "index" = "index" + 1 WHERE project_id = ? AND id <> ? AND "index" >= ? AND "index" < ?',
          chapter.project_id,
          id,
          new_index,
          chapter.index
        );
      }

      await db.run('UPDATE chapter SET "index" = ? WHERE id = ?', new_index, id);
      await db.exec('COMMIT');
      return { status: 'moved', new_index };
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  });
};
