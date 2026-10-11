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
  let calls = 0;
  (LLMService as any).generateStructuredLocallyWithRetry = async () => { calls++; return ({
    scenes: [
      { scene_id: Number(first.lastID), narration: '我走进了寂静的迎宾广场。' },
      { scene_id: Number(second.lastID), narration: '黑暗的长廊在前方等待。' }
    ]
  }); };

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
    await generateSceneNarrationForChapter('narration-chapter');
    assert.equal(calls, 1);
    await generateSceneNarrationForChapter('narration-chapter', { forceRegenerate: true });
    assert.equal(calls, 2);
    await db.run("UPDATE scene SET dialogue='我到了。' WHERE id=?", first.lastID);
    await generateSceneNarrationForChapter('narration-chapter');
    assert.equal(calls, 3);
  } finally {
    (LLMService as any).generateStructuredLocallyWithRetry = previous;
  }
});

test('chapter narration leaves continuity-bound shot text and status unchanged', async () => {
  process.env.DATABASE_URL = ':memory:';
  const [{ db }, { LLMService }, { generateSceneNarrationForChapter }] = await Promise.all([
    import('../db/database'),
    import('./llm'),
    import('./scene_narration_service')
  ]);
  const project = await db.run("INSERT INTO project (title) VALUES ('Bound Narration')");
  await db.run(`INSERT INTO chapter (id, project_id, "index", title, content) VALUES ('bound-chapter', ?, 1, '第二章', '我停在门口。')`, project.lastID);
  const bound = await db.run(
    `INSERT INTO scene (chapter_id, "index", visual_prompt, narration, dialogue, continuity_status, asset_url, shot_spec)
     VALUES ('bound-chapter', 1, 'Door', '原来的旁白', '原来的对白', 'current', '/static/bound.png', ?)`,
    JSON.stringify({ source: { continuity: { story_position: { moment_id: 's1:exit' } } } })
  );
  const open = await db.run(
    `INSERT INTO scene (chapter_id, "index", visual_prompt, narration, continuity_status, asset_url)
     VALUES ('bound-chapter', 2, 'Hall', '', 'legacy', '/static/open.png')`
  );
  await db.run('UPDATE scene SET active_version=1 WHERE id=?', bound.lastID);
  await db.run("INSERT INTO scene_version(scene_id,version,label,narration,dialogue,asset_url,continuity_status) VALUES(?,1,'v1','原来的旁白','原来的对白','/static/bound.png','current')", bound.lastID);
  const previous = LLMService.generateStructuredLocallyWithRetry;
  (LLMService as any).generateStructuredLocallyWithRetry = async () => ({
    scenes: [{ scene_id: Number(open.lastID), narration: '我看见空荡的门厅。' }]
  });
  try {
    const result = await generateSceneNarrationForChapter('bound-chapter');
    assert.equal(result.generated_count, 1);
    const kept = await db.get('SELECT narration, dialogue, continuity_status, asset_url FROM scene WHERE id=?', bound.lastID);
    assert.equal(kept.narration, '原来的旁白');
    assert.equal(kept.dialogue, '原来的对白');
    assert.equal(kept.continuity_status, 'current');
    assert.equal(kept.asset_url, '/static/bound.png');
    const version = await db.get('SELECT narration, continuity_status FROM scene_version WHERE scene_id=? AND version=1', bound.lastID);
    assert.equal(version.narration, '原来的旁白');
    assert.equal(version.continuity_status, 'current');
    assert.equal((await db.get('SELECT narration FROM scene WHERE id=?', open.lastID)).narration, '我看见空荡的门厅。');
  } finally {
    (LLMService as any).generateStructuredLocallyWithRetry = previous;
  }
});
