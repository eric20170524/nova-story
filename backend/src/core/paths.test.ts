import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  getStaticDirectory,
  getGeneratedDirectory,
  getSceneAssetPath,
  getCharacterAssetPath,
  getUploadAssetPath,
  getComicSceneAssetPath,
  getComicChapterAssetPath,
  getComicProjectAssetPath,
  resolveStaticAssetPath
} from './paths';

test('generates structured scene asset paths with project and version', () => {
  const result = getSceneAssetPath({
    projectId: 42,
    sceneId: 101,
    version: 2,
    filename: '101_task123.png'
  });

  assert.equal(
    result.url,
    '/static/generated/projects/42/scenes/101/v2/101_task123.png'
  );
  assert.ok(result.filepath.endsWith(path.join('generated', 'projects', '42', 'scenes', '101', 'v2', '101_task123.png')));
  assert.ok(fs.existsSync(result.dir));
});

test('generates fallback scene asset paths without project', () => {
  const result = getSceneAssetPath({
    sceneId: 999,
    filename: '999_task456.png'
  });

  assert.equal(
    result.url,
    '/static/generated/scenes/999/v1/999_task456.png'
  );
  assert.ok(result.filepath.endsWith(path.join('generated', 'scenes', '999', 'v1', '999_task456.png')));
  assert.ok(fs.existsSync(result.dir));
});

test('generates structured character asset paths with project and version', () => {
  const result = getCharacterAssetPath({
    projectId: 12,
    characterId: 7,
    version: 3,
    filename: 'avatar_7_task789.png'
  });

  assert.equal(
    result.url,
    '/static/generated/projects/12/characters/7/v3/avatar_7_task789.png'
  );
  assert.ok(result.filepath.endsWith(path.join('generated', 'projects', '12', 'characters', '7', 'v3', 'avatar_7_task789.png')));
  assert.ok(fs.existsSync(result.dir));
});

test('generates upload asset paths', () => {
  const result = getUploadAssetPath('upload_abc123.png');
  assert.equal(result.url, '/static/generated/uploads/upload_abc123.png');
  assert.ok(result.filepath.endsWith(path.join('generated', 'uploads', 'upload_abc123.png')));
  assert.ok(fs.existsSync(result.dir));
});

test('resolves static URL to on-disk path for both structured and flat paths', () => {
  const staticDir = getStaticDirectory();
  const testFile = path.join(staticDir, 'generated', 'projects', '99', 'scenes', '1', 'v1', 'test.png');
  fs.mkdirSync(path.dirname(testFile), { recursive: true });
  fs.writeFileSync(testFile, 'test-bytes');

  const resolved = resolveStaticAssetPath('/static/generated/projects/99/scenes/1/v1/test.png');
  assert.equal(path.resolve(resolved), path.resolve(testFile));

  // Also supports full HTTP URLs
  const resolvedFromHttp = resolveStaticAssetPath('http://localhost:3000/static/generated/projects/99/scenes/1/v1/test.png');
  assert.equal(path.resolve(resolvedFromHttp), path.resolve(testFile));

  // Cleanup
  try {
    fs.unlinkSync(testFile);
  } catch {}
});

test('resolves legacy flat static path gracefully', () => {
  const genDir = getGeneratedDirectory();
  const legacyFile = path.join(genDir, 'legacy_sample.png');
  fs.writeFileSync(legacyFile, 'legacy-content');

  const resolved = resolveStaticAssetPath('/static/generated/legacy_sample.png');
  assert.equal(path.resolve(resolved), path.resolve(legacyFile));

  try {
    fs.unlinkSync(legacyFile);
  } catch {}
});

test('generates structured comic paths for scenes, chapters, and projects', () => {
  const sceneResult = getComicSceneAssetPath({
    projectId: 10,
    chapterId: 'ch-1',
    sceneId: 55,
  });
  assert.equal(
    sceneResult.url,
    '/static/comics/projects/10/chapters/ch-1/scenes/comic_scene_55.jpg'
  );
  assert.ok(fs.existsSync(sceneResult.dir));

  const chapterResult = getComicChapterAssetPath({
    projectId: 10,
    chapterId: 'ch-1',
  });
  assert.equal(
    chapterResult.url,
    '/static/comics/projects/10/chapters/ch-1/chapter_ch-1_comic.pdf'
  );
  assert.ok(fs.existsSync(chapterResult.dir));

  const projectResult = getComicProjectAssetPath({
    projectId: 10,
  });
  assert.equal(
    projectResult.url,
    '/static/comics/projects/10/project_10_comic.pdf'
  );
  assert.ok(fs.existsSync(projectResult.dir));
});


