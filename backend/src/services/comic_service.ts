import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/database';
import { getStaticDirectory } from '../core/paths';

export class ComicServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 500,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ComicServiceError';
  }
}

export interface ComicPageResult {
  scene_id: number;
  chapter_id?: string;
  url: string;
  filePath: string;
  width: number;
  height: number;
}

export interface ProjectComicChapterStatus {
  chapter_id: string;
  index: number;
  title: string;
  total_scenes: number;
  ready_scenes: number;
  missing_scene_ids: number[];
  ready: boolean;
  blocker: 'no_scenes' | 'missing_assets' | null;
}

export interface ProjectComicStatus {
  project_id: number;
  title: string;
  ready: boolean;
  total_chapters: number;
  ready_chapters: number;
  total_scenes: number;
  ready_scenes: number;
  chapters: ProjectComicChapterStatus[];
}

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

const safeFilenamePart = (value: string | number) =>
  String(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'item';

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

  const filename = `comic_scene_${safeFilenamePart(sceneId)}.jpg`;
  const filePath = path.join(comicDirectory, filename);
  await output.jpeg({ quality: 90 }).toFile(filePath);
  return {
    url: `/static/comics/${filename}`,
    filePath,
    width,
    height
  };
};

const writeComicPdf = async (
  pages: Array<Pick<ComicPageResult, 'filePath' | 'width' | 'height'>>,
  pdfFilePath: string
) => {
  const document = new PDFDocument({ autoFirstPage: false, margin: 0 });
  const stream = fs.createWriteStream(pdfFilePath);
  document.pipe(stream);

  for (const page of pages) {
    document.addPage({ size: [page.width, page.height], margin: 0 });
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
};

const ensureComicDirectory = () => {
  const staticDirectory = getStaticDirectory();
  const comicDirectory = path.join(staticDirectory, 'comics');
  fs.mkdirSync(comicDirectory, { recursive: true });
  return { staticDirectory, comicDirectory };
};

export const generateChapterComic = async (
  chapterId: string,
  options: {
    strict?: boolean;
    onPageError?: (error: unknown, sceneId: number) => void;
  } = {}
) => {
  const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapterId);
  if (!chapter) {
    throw new ComicServiceError('Chapter not found', 404);
  }

  const scenes = await db.all(
    'SELECT * FROM scene WHERE chapter_id = ? ORDER BY "index" ASC',
    chapterId
  );
  if (scenes.length === 0) {
    throw new ComicServiceError('No scenes found in chapter', 400);
  }

  const missingSceneIds = scenes
    .filter((scene: any) => !scene.asset_url)
    .map((scene: any) => Number(scene.id));
  const validScenes = scenes.filter((scene: any) => scene.asset_url);
  if (validScenes.length === 0) {
    throw new ComicServiceError('No scenes have generated images', 400);
  }
  if (options.strict && missingSceneIds.length > 0) {
    throw new ComicServiceError(
      'Chapter comic is not ready: some scenes do not have generated images',
      409,
      { chapter_id: chapterId, missing_scene_ids: missingSceneIds }
    );
  }

  const { staticDirectory, comicDirectory } = ensureComicDirectory();
  const pages: ComicPageResult[] = [];
  for (const scene of validScenes) {
    try {
      const page = await renderComicPage(
        Number(scene.id),
        scene.asset_url,
        scene.dialogue || '',
        staticDirectory,
        comicDirectory
      );
      pages.push({ scene_id: Number(scene.id), chapter_id: chapterId, ...page });
    } catch (error) {
      if (options.strict) {
        throw new ComicServiceError(
          `Comic page generation failed for scene ${scene.id}`,
          500,
          { chapter_id: chapterId, scene_id: Number(scene.id) }
        );
      }
      options.onPageError?.(error, Number(scene.id));
    }
  }

  if (pages.length === 0) {
    throw new ComicServiceError('Failed to generate any comic pages', 500);
  }

  const pdfFilename = `chapter_${safeFilenamePart(chapterId)}_comic.pdf`;
  await writeComicPdf(pages, path.join(comicDirectory, pdfFilename));

  return {
    status: 'completed' as const,
    chapter_id: chapterId,
    total_scenes: scenes.length,
    generated_count: pages.length,
    pages: pages.map(({ scene_id, url }) => ({ scene_id, url })),
    pdf_url: `/static/comics/${pdfFilename}`
  };
};

export const getProjectComicStatus = async (projectId: number): Promise<ProjectComicStatus> => {
  const project = await db.get('SELECT id, title FROM project WHERE id = ?', projectId);
  if (!project) {
    throw new ComicServiceError('Project not found', 404);
  }

  const chapters = await db.all(
    'SELECT id, "index", title FROM chapter WHERE project_id = ? ORDER BY "index" ASC',
    projectId
  );

  const chapterStatuses: ProjectComicChapterStatus[] = [];
  for (const chapter of chapters) {
    const scenes = await db.all(
      'SELECT id, asset_url FROM scene WHERE chapter_id = ? ORDER BY "index" ASC',
      chapter.id
    );
    const missingSceneIds = scenes
      .filter((scene: any) => !scene.asset_url)
      .map((scene: any) => Number(scene.id));
    const readyScenes = scenes.length - missingSceneIds.length;
    const blocker: ProjectComicChapterStatus['blocker'] = scenes.length === 0
      ? 'no_scenes'
      : missingSceneIds.length > 0
        ? 'missing_assets'
        : null;

    chapterStatuses.push({
      chapter_id: chapter.id,
      index: Number(chapter.index),
      title: chapter.title,
      total_scenes: scenes.length,
      ready_scenes: readyScenes,
      missing_scene_ids: missingSceneIds,
      ready: blocker === null,
      blocker
    });
  }

  const totalScenes = chapterStatuses.reduce((sum, chapter) => sum + chapter.total_scenes, 0);
  const readyScenes = chapterStatuses.reduce((sum, chapter) => sum + chapter.ready_scenes, 0);
  const readyChapters = chapterStatuses.filter((chapter) => chapter.ready).length;

  return {
    project_id: projectId,
    title: project.title,
    ready: chapterStatuses.length > 0 && readyChapters === chapterStatuses.length,
    total_chapters: chapterStatuses.length,
    ready_chapters: readyChapters,
    total_scenes: totalScenes,
    ready_scenes: readyScenes,
    chapters: chapterStatuses
  };
};

export const generateProjectComic = async (projectId: number) => {
  const readiness = await getProjectComicStatus(projectId);
  if (!readiness.ready) {
    throw new ComicServiceError(
      'Project comic is not ready: every chapter needs a timeline and every scene needs an image',
      409,
      readiness
    );
  }

  const chapters = await db.all(
    'SELECT id, "index", title FROM chapter WHERE project_id = ? ORDER BY "index" ASC',
    projectId
  );
  const { staticDirectory, comicDirectory } = ensureComicDirectory();
  const pages: ComicPageResult[] = [];
  const chapterResults: Array<{
    chapter_id: string;
    index: number;
    title: string;
    total_scenes: number;
    page_count: number;
  }> = [];

  for (const chapter of chapters) {
    const scenes = await db.all(
      'SELECT * FROM scene WHERE chapter_id = ? ORDER BY "index" ASC',
      chapter.id
    );
    const chapterStart = pages.length;
    for (const scene of scenes) {
      if (!scene.asset_url) {
        throw new ComicServiceError(
          `Project comic became incomplete while rendering scene ${scene.id}`,
          409,
          { chapter_id: chapter.id, scene_id: Number(scene.id) }
        );
      }
      try {
        const page = await renderComicPage(
          Number(scene.id),
          scene.asset_url,
          scene.dialogue || '',
          staticDirectory,
          comicDirectory
        );
        pages.push({
          scene_id: Number(scene.id),
          chapter_id: chapter.id,
          ...page
        });
      } catch (error) {
        throw new ComicServiceError(
          `Project comic page generation failed for scene ${scene.id}`,
          500,
          { chapter_id: chapter.id, scene_id: Number(scene.id) }
        );
      }
    }
    chapterResults.push({
      chapter_id: chapter.id,
      index: Number(chapter.index),
      title: chapter.title,
      total_scenes: scenes.length,
      page_count: pages.length - chapterStart
    });
  }

  const pdfFilename = `project_${safeFilenamePart(projectId)}_comic.pdf`;
  await writeComicPdf(pages, path.join(comicDirectory, pdfFilename));

  return {
    status: 'completed' as const,
    project_id: projectId,
    title: readiness.title,
    total_chapters: chapters.length,
    total_scenes: readiness.total_scenes,
    generated_count: pages.length,
    chapters: chapterResults,
    pages: pages.map(({ chapter_id, scene_id, url }) => ({
      chapter_id,
      scene_id,
      url
    })),
    pdf_url: `/static/comics/${pdfFilename}`
  };
};
