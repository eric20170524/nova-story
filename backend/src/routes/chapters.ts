import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/database';
import { hashChapterContent, PlanningError } from '../schemas/story_plan';
import { CHAPTER_CONTENT_UNFINALIZE_SQL, StoryPlanService } from '../services/story_plan_service';

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
  summary: z.string().nullable().optional(),
  status: z.string().optional(),
  condensed_content: z.string().nullable().optional(),
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
    try {
      const created = await StoryPlanService.createManualChapter({
        projectId: chapter.project_id,
        id: chapter.id,
        title: chapter.title,
        content: chapter.content,
      });
      return reply.status(201).send(created);
    } catch (error) {
      if (error instanceof PlanningError && error.code === 'PREVIOUS_CHAPTER_NOT_FINALIZED') {
        return reply.status(400).send({ detail: error.message });
      }
      if (error instanceof PlanningError && error.code === 'PROJECT_NOT_FOUND') {
        return reply.status(404).send({ detail: 'Project not found' });
      }
      if (error instanceof PlanningError) {
        return reply.status(error.status).send({ code: error.code, detail: error.message });
      }
      throw error;
    }
  });

  app.patch('/:id', async (request, reply) => {
    const { id } = ChapterIdSchema.parse(request.params);
    const update = ChapterUpdateSchema.parse(request.body);
    const existing = await db.get('SELECT * FROM chapter WHERE id = ?', id);
    if (!existing) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    const contentChanged = update.content !== undefined && update.content !== existing.content;
    const outlineChanged = update.title !== undefined || update.summary !== undefined;
    const completeWithoutContentChange = update.status === 'completed' && !contentChanged;

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (update.title !== undefined) {
        fields.push('title = ?');
        values.push(update.title);
      }
      if (update.summary !== undefined) {
        fields.push('summary = ?');
        values.push(update.summary);
      }
      if (update.condensed_content !== undefined) {
        fields.push('condensed_content = ?');
        values.push(update.condensed_content);
      }
      if (contentChanged) {
        fields.push('content = ?');
        values.push(update.content);
        fields.push(CHAPTER_CONTENT_UNFINALIZE_SQL);
      } else if (completeWithoutContentChange) {
        fields.push('status = ?');
        values.push('completed');
        fields.push('finalized_content_hash = ?');
        values.push(hashChapterContent(existing.content));
      } else if (update.status !== undefined) {
        fields.push('status = ?');
        values.push(update.status);
      }
      if (fields.length > 0) {
        await db.run(
          `UPDATE chapter SET ${fields.join(', ')} WHERE id = ?`,
          ...values,
          id
        );
      }
      if (outlineChanged) {
        await StoryPlanService.syncLinkedOutlineUnlocked(existing.project_id, id);
      }
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      if (error instanceof PlanningError) {
        return reply.status(error.status).send({ code: error.code, detail: error.message });
      }
      throw error;
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
        `DELETE FROM script_change
         WHERE script_id IN (
           SELECT id FROM chapter_script WHERE chapter_id = ?
         )`,
        id
      );
      await db.run('DELETE FROM chapter_script WHERE chapter_id = ?', id);

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
      await db.run(
        `DELETE FROM scene_version
         WHERE scene_id IN (
           SELECT id FROM scene WHERE chapter_id = ?
         )`,
        id
      );
      await db.run('DELETE FROM scene WHERE chapter_id = ?', id);
      await StoryPlanService.retireLinkedChapter(existing.project_id, id);
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
      await StoryPlanService.reorderFromChapters(chapter.project_id);
      await db.exec('COMMIT');
      return { status: 'moved', new_index };
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  });
};
