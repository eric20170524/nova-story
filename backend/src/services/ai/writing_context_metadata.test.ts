import assert from 'node:assert/strict';
import test from 'node:test';

test('imported story tags, POV, and tone reach the layered writing context', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [{ db, initDb }, { WritingService }] = await Promise.all([
    import('../../db/database'),
    import('./writing_service'),
  ]);

  await initDb();

  const projectResult = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Context Import Test',
    'desc',
    JSON.stringify({
      genre: '梦核幻想',
      story_tags: ['梦核幻想', '小动物视角', '治愈系探索'],
      pov: '第三人称限知',
      tone: '温柔、轻微诡异',
    }),
    'local_admin'
  );
  const projectId = Number(projectResult.lastID);
  const chapterId = `context-meta-${Date.now()}`;

  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, ?, ?, ?, 'draft')`,
    chapterId,
    projectId,
    '第一章',
    '',
    '开篇概要'
  );

  const bundle = await WritingService.loadBundleForAgent(projectId, chapterId);

  assert.deepEqual(bundle.bible.story_tags, [
    '梦核幻想',
    '小动物视角',
    '治愈系探索',
  ]);
  assert.equal(bundle.bible.pov, '第三人称限知');
  assert.equal(bundle.bible.tone, '温柔、轻微诡异');
  assert.ok(bundle.layered);
  assert.match(bundle.layered!.worldBible, /Story tags: 梦核幻想, 小动物视角, 治愈系探索/);
  assert.match(bundle.layered!.worldBible, /POV: 第三人称限知/);
  assert.match(bundle.layered!.worldBible, /Tone: 温柔、轻微诡异/);
});
