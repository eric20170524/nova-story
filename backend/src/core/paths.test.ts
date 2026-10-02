import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  BACKEND_DIRECTORY,
  resolveBackendDirectory,
  getStaticDirectory,
  getGeneratedDirectory,
  getSceneAssetPath,
  getCharacterAssetPath,
  getUploadAssetPath,
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



test('source, standalone backend build and full-stack bundle share canonical backend paths', () => {
  const root = path.dirname(BACKEND_DIRECTORY);
  assert.equal(resolveBackendDirectory(path.join(BACKEND_DIRECTORY, 'src/core')), BACKEND_DIRECTORY);
  assert.equal(resolveBackendDirectory(path.join(BACKEND_DIRECTORY, 'dist/src/core')), BACKEND_DIRECTORY);
  assert.equal(resolveBackendDirectory(path.join(root, 'dist')), BACKEND_DIRECTORY);
});
