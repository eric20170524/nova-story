import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ComicServiceError,
  generateChapterComic,
  generateProjectComic,
  getProjectComicStatus,
} from '../services/comic_service';

const sendComicError = (error: unknown, reply: any) => {
  if (error instanceof ComicServiceError) {
    return reply.status(error.statusCode).send({
      detail: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
  }
  throw error;
};

export const comicRoutes: FastifyPluginAsync = async (app) => {
  app.get('/project/:project_id/status', async (request, reply) => {
    const { project_id } = z.object({
      project_id: z.coerce.number().int().positive(),
    }).parse(request.params);

    try {
      return await getProjectComicStatus(project_id);
    } catch (error) {
      return sendComicError(error, reply);
    }
  });

  app.post('/project/:project_id/generate', async (request, reply) => {
    const { project_id } = z.object({
      project_id: z.coerce.number().int().positive(),
    }).parse(request.params);

    try {
      return await generateProjectComic(project_id);
    } catch (error) {
      return sendComicError(error, reply);
    }
  });

  app.post('/:chapter_id/generate', async (request, reply) => {
    const { chapter_id } = z.object({
      chapter_id: z.string().min(1),
    }).parse(request.params);

    try {
      return await generateChapterComic(chapter_id, {
        onPageError: (error, sceneId) => {
          request.log.warn({ err: error, sceneId }, 'Comic page generation failed');
        },
      });
    } catch (error) {
      return sendComicError(error, reply);
    }
  });
};
