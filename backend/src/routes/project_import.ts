import type { FastifyPluginAsync } from 'fastify';
import {
  buildProjectImportPreview,
  ProjectImportInputError,
} from '../services/import/import_preview';

export const projectImportRoutes: FastifyPluginAsync = async (app) => {
  app.post('/import/preview', async (request, reply) => {
    let file;
    try {
      file = await request.file();
    } catch {
      return reply.status(400).send({
        detail: 'Please upload the file as multipart/form-data',
      });
    }

    if (!file) {
      return reply.status(400).send({
        detail: 'Please select a text, Markdown, or JSON file to preview',
      });
    }

    try {
      const buffer = await file.toBuffer();
      return buildProjectImportPreview(buffer, file.filename || '');
    } catch (error) {
      if (error instanceof ProjectImportInputError) {
        return reply.status(error.statusCode).send({ detail: error.message });
      }
      throw error;
    }
  });
};
