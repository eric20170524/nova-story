import { FastifyPluginAsync } from 'fastify';
import { MediaAssetService } from '../services/video/media_asset_service';

/**
 * Canonical scene media surface.
 *
 * MediaAsset is shared infrastructure used by Director/H3, but the resource being
 * queried here is a Scene. Keep this route under /api/scenes instead of making the
 * UI depend on a video-provider namespace.
 */
export const sceneMediaRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:scene_id/media', async (request, reply) => {
    const { scene_id } = request.params as { scene_id: string };
    const sceneId = Number(scene_id);
    if (!Number.isFinite(sceneId) || sceneId <= 0) {
      return reply.status(400).send({ error: `Invalid scene id '${scene_id}'` });
    }

    const rawVersion = (request.query as any)?.version;
    const version = rawVersion != null && rawVersion !== '' ? Number(rawVersion) : undefined;
    if (version != null && (!Number.isFinite(version) || version <= 0)) {
      return reply.status(400).send({ error: `Invalid scene version '${rawVersion}'` });
    }

    const assets = await MediaAssetService.listSceneContextAssets(sceneId, version);
    return { scene_id: sceneId, assets };
  });
};
