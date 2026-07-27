import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/database';
import { z } from 'zod';

export const comicRoutes: FastifyPluginAsync = async (app) => {
  app.post('/:chapter_id/generate', async (request, reply) => {
    const paramsSchema = z.object({ chapter_id: z.string() });
    const { chapter_id } = paramsSchema.parse(request.params);

    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapter_id);
    if (!chapter) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    const scenes = await db.all('SELECT * FROM scene WHERE chapter_id = ? ORDER BY `index` ASC', chapter_id);
    if (!scenes || scenes.length === 0) {
      return reply.status(400).send({ detail: 'No scenes found in chapter' });
    }

    const validScenes = scenes.filter(s => s.asset_url);
    if (validScenes.length === 0) {
      return reply.status(400).send({ detail: 'No scenes have generated images' });
    }

    // In Phase 3, we mock the ComicService PDF Generation logic.
    // Full implementation requires mapping Python's ComicService to a Node library like PDFKit or puppeteer.
    const generatedPages = validScenes.map(scene => ({
      scene_id: scene.id,
      url: `/static/generated/mock_comic_${scene.id}.png`
    }));

    return {
      status: "completed",
      chapter_id,
      total_scenes: scenes.length,
      generated_count: generatedPages.length,
      pages: generatedPages,
      pdf_url: `/static/generated/mock_comic_${chapter_id}.pdf`
    };
  });
};
