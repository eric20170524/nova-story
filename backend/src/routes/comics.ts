import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/database';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

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

    const staticDir = path.join(__dirname, '../../app/static/generated');
    if (!fs.existsSync(staticDir)) {
      fs.mkdirSync(staticDir, { recursive: true });
    }

    const generatedPages: any[] = [];

    // We will create the PDF and append images into it
    const pdfFilename = `comic_${chapter_id}.pdf`;
    const pdfFilepath = path.join(staticDir, pdfFilename);
    const doc = new PDFDocument({ autoFirstPage: false });
    const stream = fs.createWriteStream(pdfFilepath);
    doc.pipe(stream);

    for (const scene of validScenes) {
        if (!scene.asset_url) continue;
        const imgFilename = path.basename(scene.asset_url);
        const imgFilepath = path.join(staticDir, imgFilename);

        if (fs.existsSync(imgFilepath)) {
            // Very simple comic page mapping: 1 image per page with text below it
            doc.addPage();
            try {
                doc.image(imgFilepath, {
                    fit: [500, 600],
                    align: 'center',
                    valign: 'center'
                });
                doc.moveDown(2);
                doc.fontSize(14).text(scene.dialogue || scene.visual_prompt || "", {
                    align: 'center'
                });

                generatedPages.push({
                    scene_id: scene.id,
                    url: scene.asset_url
                });
            } catch(e) {
                // Ignore bad image format errors
            }
        }
    }

    doc.end();

    await new Promise(resolve => {
        stream.on('finish', resolve);
    });

    return {
      status: "completed",
      chapter_id,
      total_scenes: scenes.length,
      generated_count: generatedPages.length,
      pages: generatedPages,
      pdf_url: `/static/generated/${pdfFilename}`
    };
  });
};
