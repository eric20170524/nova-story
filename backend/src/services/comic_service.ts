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
  text_ready_scenes: number;
  missing_scene_ids: number[];
  missing_text_scene_ids: number[];
  asset_ready: boolean;
  text_ready: boolean;
  ready: boolean;
  blocker: 'no_scenes' | 'missing_assets' | 'missing_text' | null;
}

export interface ProjectComicStatus {
  project_id: number;
  title: string;
  ready: boolean;
  total_chapters: number;
  ready_chapters: number;
  total_scenes: number;
  ready_scenes: number;
  text_ready_scenes: number;
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
  text: string | { narration?: string | null; dialogue?: string | null },
  staticDirectory: string,
  comicDirectory: string
) => {
  const input = await loadImage(assetUrl, staticDirectory);
  const image = sharp(input).rotate();
  const metadata = await image.metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;
  const fontSize = Math.max(22, Math.round(width * 0.027));
  const narration = typeof text === 'string' ? '' : String(text.narration || '').trim();
  const dialogue = typeof text === 'string' ? text : String(text.dialogue || '').trim();
  const charactersPerLine = Math.max(12, Math.floor((width - 60) / (fontSize * 0.85)));
  const narrationLines = wrapSubtitle(
    narration,
    charactersPerLine
  );
  const dialogueLines = wrapSubtitle(
    dialogue,
    Math.max(12, Math.floor((width - 60) / (fontSize * 0.85)))
  );

  let output = image;
  const overlays: Array<{ input: Buffer; gravity: 'north' | 'south' }> = [];
  if (narrationLines.length > 0) {
    const lineHeight = Math.round(fontSize * 1.45);
    const overlayHeight = narrationLines.length * lineHeight + 30;
    const textElements = narrationLines.map((line, index) =>
      `<text x="50%" y="${22 + fontSize + index * lineHeight}" text-anchor="middle" fill="#fff7d6">${escapeXml(line)}</text>`
    ).join('');
    overlays.push({
      input: Buffer.from(
        `<svg width="${width}" height="${overlayHeight}">
          <rect width="100%" height="100%" fill="rgba(54,38,8,0.78)"/>
          <g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${fontSize}" font-weight="500">
            ${textElements}
          </g>
        </svg>`
      ),
      gravity: 'north'
    });
  }
  if (dialogueLines.length > 0) {
    const lineHeight = Math.round(fontSize * 1.45);
    const overlayHeight = dialogueLines.length * lineHeight + 30;
    const textElements = dialogueLines.map((line, index) =>
      `<text x="50%" y="${22 + fontSize + index * lineHeight}" text-anchor="middle" fill="white">${escapeXml(line)}</text>`
    ).join('');
    overlays.push({
      input: Buffer.from(
        `<svg width="${width}" height="${overlayHeight}">
          <rect width="100%" height="100%" fill="rgba(0,0,0,0.68)"/>
          <g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${fontSize}" font-weight="500">
            ${textElements}
          </g>
        </svg>`
      ),
      gravity: 'south'
    });
  }
  if (overlays.length > 0) {
    output = image.composite(overlays);
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
    requireText?: boolean;
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
  const missingTextSceneIds = scenes
    .filter((scene: any) => !String(scene.narration || '').trim() && !String(scene.dialogue || '').trim())
    .map((scene: any) => Number(scene.id));
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
  if ((options.requireText ?? true) && missingTextSceneIds.length > 0) {
    throw new ComicServiceError(
      'Chapter comic is not ready: some scenes do not have narration or dialogue',
      409,
      { chapter_id: chapterId, missing_text_scene_ids: missingTextSceneIds }
    );
  }

  const { staticDirectory, comicDirectory } = ensureComicDirectory();
  const pages: ComicPageResult[] = [];
  for (const scene of validScenes) {
    try {
      const page = await renderComicPage(
        Number(scene.id),
        scene.asset_url,
        { narration: scene.narration || '', dialogue: scene.dialogue || '' },
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
      'SELECT id, asset_url, narration, dialogue FROM scene WHERE chapter_id = ? ORDER BY "index" ASC',
      chapter.id
    );
    const missingSceneIds = scenes
      .filter((scene: any) => !scene.asset_url)
      .map((scene: any) => Number(scene.id));
    const readyScenes = scenes.length - missingSceneIds.length;
    const missingTextSceneIds = scenes
      .filter((scene: any) => !String(scene.narration || '').trim() && !String(scene.dialogue || '').trim())
      .map((scene: any) => Number(scene.id));
    const textReadyScenes = scenes.length - missingTextSceneIds.length;
    const assetReady = scenes.length > 0 && missingSceneIds.length === 0;
    const textReady = scenes.length > 0 && missingTextSceneIds.length === 0;
    const blocker: ProjectComicChapterStatus['blocker'] = scenes.length === 0
      ? 'no_scenes'
      : missingSceneIds.length > 0
        ? 'missing_assets'
        : missingTextSceneIds.length > 0
          ? 'missing_text'
        : null;

    chapterStatuses.push({
      chapter_id: chapter.id,
      index: Number(chapter.index),
      title: chapter.title,
      total_scenes: scenes.length,
      ready_scenes: readyScenes,
      text_ready_scenes: textReadyScenes,
      missing_scene_ids: missingSceneIds,
      missing_text_scene_ids: missingTextSceneIds,
      asset_ready: assetReady,
      text_ready: textReady,
      ready: blocker === null,
      blocker
    });
  }

  const totalScenes = chapterStatuses.reduce((sum, chapter) => sum + chapter.total_scenes, 0);
  const readyScenes = chapterStatuses.reduce((sum, chapter) => sum + chapter.ready_scenes, 0);
  const textReadyScenes = chapterStatuses.reduce((sum, chapter) => sum + chapter.text_ready_scenes, 0);
  const readyChapters = chapterStatuses.filter((chapter) => chapter.ready).length;

  return {
    project_id: projectId,
    title: project.title,
    ready: chapterStatuses.length > 0 && readyChapters === chapterStatuses.length,
    total_chapters: chapterStatuses.length,
    ready_chapters: readyChapters,
    total_scenes: totalScenes,
    ready_scenes: readyScenes,
    text_ready_scenes: textReadyScenes,
    chapters: chapterStatuses
  };
};

export const generateProjectComic = async (projectId: number) => {
  const readiness = await getProjectComicStatus(projectId);
  if (!readiness.ready) {
    throw new ComicServiceError(
      'Project comic is not ready: every scene needs an image and narration or dialogue',
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
          { narration: scene.narration || '', dialogue: scene.dialogue || '' },
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

  const renderedSceneCount = chapterResults.reduce(
    (sum, chapter) => sum + chapter.total_scenes,
    0
  );
  if (
    chapters.length !== readiness.total_chapters
    || renderedSceneCount !== readiness.total_scenes
    || pages.length !== readiness.total_scenes
  ) {
    throw new ComicServiceError(
      'Project comic structure changed during assembly; re-check readiness before retrying',
      409,
      {
        readiness: {
          total_chapters: readiness.total_chapters,
          total_scenes: readiness.total_scenes,
        },
        rendered: {
          total_chapters: chapters.length,
          total_scenes: renderedSceneCount,
          generated_pages: pages.length,
        },
      }
    );
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
