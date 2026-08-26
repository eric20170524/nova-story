import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  PROJECT_DOCUMENT_TYPES,
  ProjectDocumentInputError,
  createProjectDocument,
  deleteProjectDocument,
  listProjectDocuments,
  previewProjectDocument,
} from '../services/project_documents';

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
const documentParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  documentId: z.coerce.number().int().positive(),
});
const importQuerySchema = z.object({
  document_type: z.enum(PROJECT_DOCUMENT_TYPES),
  name: z.string().trim().min(1).max(255).optional(),
});

const sendInputError = (error: unknown, reply: any) => {
  if (error instanceof ProjectDocumentInputError) {
    return reply.status(error.statusCode).send({ detail: error.message });
  }
  throw error;
};

export const projectDocumentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/documents', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    try {
      return await listProjectDocuments(id);
    } catch (error) {
      return sendInputError(error, reply);
    }
  });

  app.post('/:id/documents/preview', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const query = importQuerySchema.parse(request.query);

    let file;
    try {
      file = await request.file();
    } catch {
      return reply.status(400).send({ detail: 'Please upload the document as multipart/form-data' });
    }
    if (!file) {
      return reply.status(400).send({ detail: 'Please select a supplemental document' });
    }

    try {
      return await previewProjectDocument({
        projectId: id,
        data: await file.toBuffer(),
        filename: file.filename || '',
        mimeType: file.mimetype,
        documentType: query.document_type,
      });
    } catch (error) {
      return sendInputError(error, reply);
    }
  });

  app.post('/:id/documents', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const query = importQuerySchema.parse(request.query);

    let file;
    try {
      file = await request.file();
    } catch {
      return reply.status(400).send({ detail: 'Please upload the document as multipart/form-data' });
    }
    if (!file) {
      return reply.status(400).send({ detail: 'Please select a supplemental document' });
    }

    try {
      const document = await createProjectDocument({
        projectId: id,
        data: await file.toBuffer(),
        filename: file.filename || '',
        mimeType: file.mimetype,
        documentType: query.document_type,
        name: query.name,
      });
      return reply.status(201).send(document);
    } catch (error) {
      return sendInputError(error, reply);
    }
  });

  app.delete('/:id/documents/:documentId', async (request, reply) => {
    const { id, documentId } = documentParamsSchema.parse(request.params);
    try {
      return await deleteProjectDocument(id, documentId);
    } catch (error) {
      return sendInputError(error, reply);
    }
  });
};
