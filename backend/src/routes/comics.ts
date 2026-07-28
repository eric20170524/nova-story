import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/database';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { getStaticDirectory } from '../core/paths';

const escapeXml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const wrapSubtitle = (text: string, charactersPerLine: number) => {
  if (!text) return [];
  const characters = Array.from(text);
  const lines: string[] = [];
  for (let index = 0; index < characters.length; index += charactersPerLine) {
    lines.push(characters.slice(index, index + charactersPerLine).join(''));
  }
  return lines;
};

const loadImage = async (assetUrl: string, staticDirectory: string) => {
  if (/^https?:\/\//i.test(assetUrl)) {
    const response = await fetch(assetUrl, {
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) {
      throw new Error(`Could not download ${assetUrl}: HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  const localPath = assetUrl.startsWith('/static/')
    ? path.join(staticDirectory, assetUrl.slice('/static/'.length))
    : path.isAbsolute(assetUrl)
      ? assetUrl
      : path.join(staticDirectory, assetUrl);
  return fs.promises.readFile(localPath);
};

export const renderComicPage = async (
  sceneId: number,
  assetUrl: string,
  subtitle: string,
  staticDirectory: string,
  comicDirectory: string
) => {
  const input = await loadImage(assetUrl, staticDirectory);
  const image = sharp(input).rotate();
  const metadata = await image.metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;
  const fontSize = Math.max(22, Math.round(width * 0.027));
  const lines = wrapSubtitle(
    subtitle,
    Math.max(12, Math.floor((width - 60) / (fontSize * 0.85)))
  );

  let output = image;
  if (lines.length > 0) {
    const lineHeight = Math.round(fontSize * 1.45);
    const overlayHeight = lines.length * lineHeight + 30;
    const textElements = lines.map((line, index) =>
      `<text x="50%" y="${22 + fontSize + index * lineHeight}" text-anchor="middle" fill="white">${escapeXml(line)}</text>`
    ).join('');
    const overlay = Buffer.from(
      `<svg width="${width}" height="${overlayHeight}">
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.65)"/>
        <g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${fontSize}" font-weight="500">
          ${textElements}
        </g>
      </svg>`
    );
    output = image.composite([{ input: overlay, gravity: 'south' }]);
  }

  const filename = `comic_scene_${sceneId}.jpg`;
  const filePath = path.join(comicDirectory, filename);
  await output.jpeg({ quality: 90 }).toFile(filePath);
  return {
    url: `/static/comics/${filename}`,
    filePath,
    width,
    height
  };
};

export const comicRoutes: FastifyPluginAsync = async (app) => {
  app.post('/:chapter_id/generate', async (request, reply) => {
    const { chapter_id } = z.object({
      chapter_id: z.string().min(1)
    }).parse(request.params);
    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapter_id);
    if (!chapter) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    const scenes = await db.all(
      'SELECT * FROM scene WHERE chapter_id = ? ORDER BY "index" ASC',
      chapter_id
    );
    if (scenes.length === 0) {
      return reply.status(400).send({ detail: 'No scenes found in chapter' });
    }

    const validScenes = scenes.filter((scene: any) => scene.asset_url);
    if (validScenes.length === 0) {
      return reply.status(400).send({ detail: 'No scenes have generated images' });
    }

    const staticDirectory = getStaticDirectory();
    const comicDirectory = path.join(staticDirectory, 'comics');
    fs.mkdirSync(comicDirectory, { recursive: true });

    const pages: Array<{
      scene_id: number;
      url: string;
      filePath: string;
      width: number;
      height: number;
    }> = [];
    for (const scene of validScenes) {
      try {
        const page = await renderComicPage(
          scene.id,
          scene.asset_url,
          scene.dialogue || '',
          staticDirectory,
          comicDirectory
        );
        pages.push({ scene_id: scene.id, ...page });
      } catch (error) {
        request.log.warn({ err: error, sceneId: scene.id }, 'Comic page generation failed');
      }
    }

    if (pages.length === 0) {
      return reply.status(500).send({ detail: 'Failed to generate any comic pages' });
    }

    const pdfFilename = `chapter_${chapter_id}_comic.pdf`;
    const pdfFilePath = path.join(comicDirectory, pdfFilename);
    const document = new PDFDocument({ autoFirstPage: false, margin: 0 });
    const stream = fs.createWriteStream(pdfFilePath);
    document.pipe(stream);

    for (const page of pages) {
      document.addPage({
        size: [page.width, page.height],
        margin: 0
      });
      document.image(page.filePath, 0, 0, {
        width: page.width,
        height: page.height
      });
    }
    document.end();
    await new Promise<void>((resolve, reject) => {
      stream.on('finish', () => resolve());
      stream.on('error', reject);
    });

    return {
      status: 'completed',
      chapter_id,
      total_scenes: scenes.length,
      generated_count: pages.length,
      pages: pages.map(({ scene_id, url }) => ({ scene_id, url })),
      pdf_url: `/static/comics/${pdfFilename}`
    };
  });
};
