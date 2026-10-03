import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AssetLibraryError, AssetLibraryService } from '../services/asset_library_service';
import { SettingsManager } from '../core/settings_manager';

export const assetLibraryRoutes: FastifyPluginAsync = async app => {
  const idOf = (params: unknown) => z.object({ id: z.coerce.number().int().positive() }).parse(params).id;
  const handle = async (reply: any, work: () => Promise<unknown>) => {
    try { return await work(); } catch (error) {
      if (error instanceof AssetLibraryError) return reply.status(error.statusCode).send({ detail: error.message });
      if (String((error as any)?.code).startsWith('SQLITE_CONSTRAINT')) return reply.status(409).send({ detail: 'Asset name already exists or is referenced' });
      throw error;
    }
  };
  app.get('/projects/:id/asset-library', (req, reply) => handle(reply, () => AssetLibraryService.list(idOf(req.params))));
  app.post('/projects/:id/asset-library', (req, reply) => handle(reply, () => AssetLibraryService.create(idOf(req.params), req.body)));
  app.post('/asset-library/extract', (req, reply) => handle(reply, () => {
    const body = z.object({ chapter_id: z.string().min(1), instructions: z.string().trim().max(3000).optional() }).parse(req.body);
    return AssetLibraryService.extract(body.chapter_id, body.instructions);
  }));
  app.put('/asset-library/:id', (req, reply) => handle(reply, () => {
    const body = z.object({ expected_revision: z.number().int().positive(), asset: z.unknown() }).parse(req.body);
    return AssetLibraryService.update(idOf(req.params), body.expected_revision, body.asset);
  }));
  app.delete('/asset-library/:id', (req, reply) => handle(reply, async () => { await AssetLibraryService.remove(idOf(req.params)); return { status: 'success' }; }));
  app.post('/asset-library/:id/generate', (req, reply) => handle(reply, async () => {
    const settings = SettingsManager.loadSettings();
    if (!settings.comfyui?.enabled && settings.image_provider !== 'codex') throw new AssetLibraryError('An image provider must be enabled');
    return AssetLibraryService.generate(idOf(req.params));
  }));
  app.get('/timeline/scenes/:id/asset-references', (req, reply) => handle(reply, () => AssetLibraryService.references(idOf(req.params))));
  app.put('/timeline/scenes/:id/asset-references', (req, reply) => handle(reply, () => AssetLibraryService.bind(idOf(req.params), z.object({ asset_ids: z.array(z.number().int().positive()).max(12) }).parse(req.body).asset_ids)));
};
