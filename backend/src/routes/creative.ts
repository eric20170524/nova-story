import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/database';
import { LLMService } from '../services/llm';

export const creativeRoutes: FastifyPluginAsync = async (app) => {
  app.post('/storyboard-grid', async (request, reply) => {
    const { story_text } = z.object({
      story_text: z.string().trim().min(1)
    }).parse(request.body);

    try {
      return { prompt: await LLMService.generateStoryboardGrid(story_text) };
    } catch (error: any) {
      return reply.status(500).send({
        detail: `Storyboard grid generation failed: ${error?.message || String(error)}`
      });
    }
  });

  app.post('/draft', async (request, reply) => {
    const body = z.object({
      instructions: z.string().trim().min(1),
      context_chapter_id: z.string().optional().nullable(),
      context_text: z.string().optional().nullable()
    }).parse(request.body);

    let contextText = body.context_text || '';
    if (!contextText && body.context_chapter_id) {
      const chapter = await db.get(
        'SELECT title, summary FROM chapter WHERE id = ?',
        body.context_chapter_id
      );
      if (chapter) {
        contextText = `Previous Chapter: ${chapter.title}\nSummary: ${chapter.summary || 'No summary'}`;
      }
    }

    try {
      return {
        content: await LLMService.generateDraft(body.instructions, contextText)
      };
    } catch (error: any) {
      return reply.status(500).send({
        detail: `Draft generation failed: ${error?.message || String(error)}`
      });
    }
  });

  app.post('/analyze', async (request, reply) => {
    const { content } = z.object({
      content: z.string().trim().min(1)
    }).parse(request.body);

    try {
      return await LLMService.analyzeContent(content);
    } catch (error: any) {
      return reply.status(500).send({
        detail: `Content analysis failed: ${error?.message || String(error)}`
      });
    }
  });

  app.get('/context/:chapter_id', async (request, reply) => {
    const { chapter_id } = z.object({
      chapter_id: z.string().min(1)
    }).parse(request.params);
    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapter_id);
    if (!chapter) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    const [chapters, characters] = await Promise.all([
      db.all(
        'SELECT id, title, "index" FROM chapter WHERE project_id = ? ORDER BY "index" ASC',
        chapter.project_id
      ),
      db.all(
        'SELECT id, name, role, description FROM character WHERE project_id = ? ORDER BY id ASC',
        chapter.project_id
      )
    ]);

    return {
      project_structure: chapters,
      focus: chapter.summary || 'No summary available',
      characters
    };
  });
};
