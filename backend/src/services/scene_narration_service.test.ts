import assert from 'node:assert/strict';
import test from 'node:test';

test('local narration backfill updates scenes and active versions without touching assets', async () => {
  process.env.DATABASE_URL = ':memory:';
  const [{ db }, { LLMService }, { generateSceneNarrationForChapter }] = await Promise.all([
    import('../db/database'),
    import('./llm'),
    import('./scene_narration_service')
  ]);

  const project = await db.run("INSERT INTO project (title) VALUES ('Narration Test')");
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content)
     VALUES ('narration-chapter', ?, 1, '第一章', '我走进一座无声的游乐园。')`,
    project.lastID
  );
  const first = await db.run(
    `INSERT INTO scene (chapter_id, "index", visual_prompt, asset_status, asset_url)
     VALUES ('narration-chapter', 1, 'An empty entrance', 'completed', '/static/generated/a.png')`
  );
  const second = await db.run(
    `INSERT INTO scene (chapter_id, "index", visual_prompt, asset_status, asset_url)
     VALUES ('narration-chapter', 2, 'A dark corridor', 'completed', '/static/generated/b.png')`
  );

  const previous = LLMService.generateStructuredLocallyWithRetry;
  (LLMService as any).generateStructuredLocallyWithRetry = async () => ({
    scenes: [
      { scene_id: Number(first.lastID), narration: '我走进了寂静的迎宾广场。' },
      { scene_id: Number(second.lastID), narration: '黑暗的长廊在前方等待。' }
    ]
  });

  try {
    const result = await generateSceneNarrationForChapter('narration-chapter');
    assert.equal(result.generated_count, 2);
    const scenes = await db.all(
      `SELECT id, narration, asset_url FROM scene
       WHERE chapter_id = 'narration-chapter' ORDER BY "index" ASC`
    );
    assert.deepEqual(scenes.map((scene: any) => scene.narration), [
      '我走进了寂静的迎宾广场。',
      '黑暗的长廊在前方等待。'
    ]);
    assert.deepEqual(scenes.map((scene: any) => scene.asset_url), [
      '/static/generated/a.png',
      '/static/generated/b.png'
    ]);
    const versions = await db.all(
      `SELECT narration FROM scene_version
       WHERE scene_id IN (?, ?) ORDER BY scene_id ASC`,
      first.lastID,
      second.lastID
    );
    assert.deepEqual(versions.map((version: any) => version.narration), [
      '我走进了寂静的迎宾广场。',
      '黑暗的长廊在前方等待。'
    ]);
  } finally {
    (LLMService as any).generateStructuredLocallyWithRetry = previous;
  }
});
