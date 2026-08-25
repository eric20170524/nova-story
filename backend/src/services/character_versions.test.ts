import assert from 'node:assert/strict';
import test from 'node:test';
import { db, initDb } from '../db/database';
import {
  activateCharacterVersion,
  createCharacterVersion,
  ensureCharacterVersionBaseline,
  listCharacterVersions,
  syncActiveCharacterVersion
} from './character_versions';

test('character versions: baseline, create, activate, sync', async () => {
  await initDb();

  const projectId = Number(`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9));
  await db.run(
    `INSERT INTO project (id, title, settings, user_id)
     VALUES (?, 'character-version-test', '{}', 'test')`,
    projectId
  );

  const tags = JSON.stringify({
    base_model: { tags: { hair: 'black', clothing: 'white dress' } },
    assets: { avatar_url: '/static/a.png', turnaround_url: '/static/t.png' },
    model_type: 'pony'
  });

  const ins = await db.run(
    `INSERT INTO character (project_id, name, role, description, visual_tags)
     VALUES (?, 'TestHero', 'main', 'desc A', ?)`,
    projectId,
    tags
  );
  const charId = Number(ins.lastID);

  await ensureCharacterVersionBaseline(charId);
  let versions = await listCharacterVersions(charId);
  assert.equal(versions.length, 1);

  const created = await createCharacterVersion(charId, { clearAssets: true, activate: true });
  assert.ok(created);
  assert.equal(created!.version.version, 2);
  assert.equal(created!.character.active_version, 2);
  const tags2 = JSON.parse(created!.character.visual_tags || '{}');
  assert.equal(tags2.assets?.avatar_url, null);

  await db.run(
    `UPDATE character SET description = ?, visual_tags = ? WHERE id = ?`,
    'desc B',
    JSON.stringify({
      base_model: { tags: { hair: 'red' } },
      assets: { avatar_url: '/static/b.png' },
      model_type: 'pony'
    }),
    charId
  );
  await syncActiveCharacterVersion(charId);

  versions = await listCharacterVersions(charId);
  const v2 = versions.find((v) => v.version === 2)!;
  assert.equal(v2.description, 'desc B');
  assert.match(String(v2.visual_tags), /b\.png/);

  const restored = await activateCharacterVersion(charId, 1);
  assert.equal(restored.active_version, 1);
  assert.equal(restored.description, 'desc A');
  const tags1 = JSON.parse(restored.visual_tags || '{}');
  assert.equal(tags1.assets?.avatar_url, '/static/a.png');

  await db.run('DELETE FROM character WHERE id = ?', charId);
  await db.run('DELETE FROM project WHERE id = ?', projectId);
});
