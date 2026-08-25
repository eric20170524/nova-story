import type { FastifyPluginAsync } from 'fastify';
import {
  parseProjectImportFile,
  ProjectImportInputError,
  type ParsedProjectImportFile,
} from '../services/import/import_file';
import { buildProjectImportPreview } from '../services/import/import_preview';
import { importNovelDraft } from '../services/import/project_import';
import { restoreNovaStoryJsonProject } from '../services/import/novastory_json_import';

const mockGetCurrentUser = (_request: unknown) => ({
  id: 'local_admin',
});

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

  app.post('/import/commit', async (request, reply) => {
    const user = mockGetCurrentUser(request);
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
        detail: 'Please select a text, Markdown, or JSON file to import',
      });
    }

    let parsed: ParsedProjectImportFile;
    try {
      const buffer = await file.toBuffer();
      parsed = parseProjectImportFile(buffer, file.filename || '');
    } catch (error) {
      if (error instanceof ProjectImportInputError) {
        return reply.status(error.statusCode).send({ detail: error.message });
      }
      throw error;
    }

    // Persistence errors deliberately escape this block and become 5xx errors.
    // They must not be mislabeled as malformed manuscript input.
    const project = parsed.kind === 'novel-draft'
      ? await importNovelDraft(parsed.draft, user.id)
      : await restoreNovaStoryJsonProject(
          parsed.jsonContent,
          file.filename || '',
          user.id
        );

    return reply.status(201).send(project);
  });
};
