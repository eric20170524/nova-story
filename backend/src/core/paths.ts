import fs from 'node:fs';
import path from 'node:path';

/**
 * Backend package root (`backend/`), whether running from `src/` or compiled `dist/`.
 */
export const BACKEND_DIRECTORY = path.resolve(__dirname, '../../');

export const getConfigDirectory = () =>
  path.resolve(process.env.NOVASTORY_CONFIG_DIR || BACKEND_DIRECTORY);

export const getDataDirectory = () =>
  path.resolve(process.env.NOVASTORY_DATA_DIR || BACKEND_DIRECTORY);

/**
 * On-disk static asset root (workflows + generated images + comics).
 *
 * Default: `backend/static/`
 * Override: `NOVASTORY_STATIC_DIR` (absolute or relative path)
 *
 * Served by Fastify at HTTP prefix `/static/` (URL path unchanged).
 * Legacy Python-era path was `backend/app/static/` — no longer used.
 */
export const getStaticDirectory = () => {
  if (process.env.NOVASTORY_STATIC_DIR) {
    return path.resolve(process.env.NOVASTORY_STATIC_DIR);
  }
  return path.join(BACKEND_DIRECTORY, 'static');
};

/** Generated images: `backend/static/generated/` → `/static/generated/...` */
export const getGeneratedDirectory = () => {
  const dir = path.join(getStaticDirectory(), 'generated');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Bundled ComfyUI workflow JSON: `backend/static/workflows/` */
export const getWorkflowsDirectory = () => {
  const dir = path.join(getStaticDirectory(), 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Comic exports: `backend/static/comics/` */
export const getComicsDirectory = () => {
  const dir = path.join(getStaticDirectory(), 'comics');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Bundled video workflows and sidecar manifests: `backend/static/video-workflows/` */
export const getVideoWorkflowsDirectory = () => {
  const dir = path.join(getStaticDirectory(), 'video-workflows');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Generated video directory: `backend/static/generated/videos/` */
export const getGeneratedVideosDirectory = () => {
  const dir = path.join(getGeneratedDirectory(), 'videos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Video staging directory: `backend/static/staging/` */
export const getVideoStagingDirectory = () => {
  const dir = path.join(getStaticDirectory(), 'staging');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export interface AssetPathResult {
  dir: string;
  filepath: string;
  url: string;
}

export interface SceneAssetPathOptions {
  projectId?: number | string | null;
  sceneId: number | string;
  version?: number | string | null;
  filename: string;
}

export interface CharacterAssetPathOptions {
  projectId?: number | string | null;
  characterId: number | string;
  version?: number | string | null;
  filename: string;
}

/**
 * Standardized path for scene-generated images and assets:
 * If projectId: `backend/static/generated/projects/:projectId/scenes/:sceneId/v:version/:filename`
 * Else: `backend/static/generated/scenes/:sceneId/v:version/:filename`
 */
export const getSceneAssetPath = (options: SceneAssetPathOptions): AssetPathResult => {
  const versionStr = options.version != null ? `v${options.version}` : 'v1';
  const subpathParts = options.projectId != null
    ? ['generated', 'projects', String(options.projectId), 'scenes', String(options.sceneId), versionStr]
    : ['generated', 'scenes', String(options.sceneId), versionStr];

  const dir = path.join(getStaticDirectory(), ...subpathParts);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, options.filename);
  const url = `/static/${subpathParts.join('/')}/${options.filename}`;
  return { dir, filepath, url };
};

/**
 * Standardized path for character assets (avatars, turnarounds, face crops, uploads):
 * If projectId: `backend/static/generated/projects/:projectId/characters/:characterId/v:version/:filename`
 * Else: `backend/static/generated/characters/:characterId/v:version/:filename`
 */
export const getCharacterAssetPath = (options: CharacterAssetPathOptions): AssetPathResult => {
  const versionStr = options.version != null ? `v${options.version}` : 'v1';
  const subpathParts = options.projectId != null
    ? ['generated', 'projects', String(options.projectId), 'characters', String(options.characterId), versionStr]
    : ['generated', 'characters', String(options.characterId), versionStr];

  const dir = path.join(getStaticDirectory(), ...subpathParts);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, options.filename);
  const url = `/static/${subpathParts.join('/')}/${options.filename}`;
  return { dir, filepath, url };
};

/**
 * Standardized path for general/standalone uploads:
 * `backend/static/generated/uploads/:filename`
 */
export const getUploadAssetPath = (filename: string, subfolder: string = 'uploads'): AssetPathResult => {
  const subpathParts = ['generated', subfolder];
  const dir = path.join(getStaticDirectory(), ...subpathParts);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  const url = `/static/${subpathParts.join('/')}/${filename}`;
  return { dir, filepath, url };
};

export interface ComicSceneAssetPathOptions {
  projectId?: number | string | null;
  chapterId?: string | null;
  sceneId: number | string;
}

export interface ComicChapterAssetPathOptions {
  projectId?: number | string | null;
  chapterId: string;
}

export interface ComicProjectAssetPathOptions {
  projectId: number | string;
}

/**
 * Standardized path for comic scene pages:
 * If projectId & chapterId: `backend/static/comics/projects/:projectId/chapters/:chapterId/scenes/comic_scene_:sceneId.jpg`
 * If projectId: `backend/static/comics/projects/:projectId/scenes/comic_scene_:sceneId.jpg`
 * Else: `backend/static/comics/scenes/comic_scene_:sceneId.jpg`
 */
export const getComicSceneAssetPath = (options: ComicSceneAssetPathOptions): AssetPathResult => {
  const filename = `comic_scene_${String(options.sceneId).replace(/[^a-zA-Z0-9._-]+/g, '_')}.jpg`;
  const subpathParts = options.projectId != null
    ? (options.chapterId != null
        ? ['comics', 'projects', String(options.projectId), 'chapters', String(options.chapterId), 'scenes']
        : ['comics', 'projects', String(options.projectId), 'scenes'])
    : (options.chapterId != null
        ? ['comics', 'chapters', String(options.chapterId), 'scenes']
        : ['comics', 'scenes']);

  const dir = path.join(getStaticDirectory(), ...subpathParts);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  const url = `/static/${subpathParts.join('/')}/${filename}`;
  return { dir, filepath, url };
};

/**
 * Standardized path for chapter comic PDF export:
 * If projectId: `backend/static/comics/projects/:projectId/chapters/:chapterId/chapter_:chapterId_comic.pdf`
 * Else: `backend/static/comics/chapters/:chapterId/chapter_:chapterId_comic.pdf`
 */
export const getComicChapterAssetPath = (options: ComicChapterAssetPathOptions): AssetPathResult => {
  const safeChapterId = String(options.chapterId).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'chapter';
  const filename = `chapter_${safeChapterId}_comic.pdf`;
  const subpathParts = options.projectId != null
    ? ['comics', 'projects', String(options.projectId), 'chapters', String(options.chapterId)]
    : ['comics', 'chapters', String(options.chapterId)];

  const dir = path.join(getStaticDirectory(), ...subpathParts);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  const url = `/static/${subpathParts.join('/')}/${filename}`;
  return { dir, filepath, url };
};

/**
 * Standardized path for project comic PDF export:
 * `backend/static/comics/projects/:projectId/project_:projectId_comic.pdf`
 */
export const getComicProjectAssetPath = (options: ComicProjectAssetPathOptions): AssetPathResult => {
  const safeProjectId = String(options.projectId).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'project';
  const filename = `project_${safeProjectId}_comic.pdf`;
  const subpathParts = ['comics', 'projects', String(options.projectId)];

  const dir = path.join(getStaticDirectory(), ...subpathParts);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  const url = `/static/${subpathParts.join('/')}/${filename}`;
  return { dir, filepath, url };
};

/**
 * Resolves any static URL (or relative/absolute path) to its absolute on-disk filesystem path.
 * Supports both new structured URLs (/static/generated/projects/..., /static/comics/projects/...) and legacy flat URLs.
 */
export const resolveStaticAssetPath = (urlOrPath: string): string => {
  const staticRoot = path.resolve(getStaticDirectory());
  const raw = String(urlOrPath || '').trim();

  // Strip HTTP scheme and domain if full URL passed (e.g., http://localhost:3000/static/...)
  const withoutOrigin = raw.replace(/^[a-zA-Z0-9]+:\/\/[^/]+/, '');

  // If starts with /static/ or static/
  if (/^\/?static\//.test(withoutOrigin)) {
    const relativePart = withoutOrigin.replace(/^\/?static\//, '');
    const candidate = path.resolve(staticRoot, relativePart);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    // Check if it exists in legacy flat generated directory
    const legacyCandidate = path.join(getGeneratedDirectory(), path.basename(relativePart));
    if (fs.existsSync(legacyCandidate)) {
      return legacyCandidate;
    }
    // Check if it exists in legacy flat comics directory
    const legacyComicCandidate = path.join(getComicsDirectory(), path.basename(relativePart));
    if (fs.existsSync(legacyComicCandidate)) {
      return legacyComicCandidate;
    }
    return candidate;
  }

  // If already absolute filesystem path
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return path.resolve(raw);
  }

  const candidate = path.resolve(staticRoot, raw);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const legacyCandidate = path.join(getGeneratedDirectory(), path.basename(raw));
  if (fs.existsSync(legacyCandidate)) {
    return legacyCandidate;
  }
  const legacyComicCandidate = path.join(getComicsDirectory(), path.basename(raw));
  if (fs.existsSync(legacyComicCandidate)) {
    return legacyComicCandidate;
  }
  return candidate;
};

