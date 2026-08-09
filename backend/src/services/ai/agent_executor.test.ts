import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = ':memory:';

test('AgentExecutor structure ops: rename, move, delete with project guard', async () => {
  const { db } = await import('../../db/database');
  const { AgentExecutor } = await import('./agent_executor');

  const project = await db.run(
    "INSERT INTO project (title, settings, user_id) VALUES ('Exec', '{}', 'local')"
  );
  const projectId = Number(project.lastID);
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, status)
     VALUES ('ch-a', ?, 0, 'Alpha', 'text a', 'draft')`,
    projectId
  );
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, status)
     VALUES ('ch-b', ?, 1, 'Beta', 'text b', 'draft')`,
    projectId
  );

  const other = await db.run(
    "INSERT INTO project (title, settings, user_id) VALUES ('Other', '{}', 'local')"
  );
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, status)
     VALUES ('ch-x', ?, 0, 'Foreign', 'x', 'draft')`,
    other.lastID
  );

  const rename = await AgentExecutor.executeAll(
    [{ op: 'RENAME_CHAPTER', chapterId: 'ch-a', newTitle: 'Alpha Renamed' }],
    { projectId, apply: true }
  );
  assert.equal(rename[0]?.status, 'success');
  const renamed = await db.get('SELECT title FROM chapter WHERE id = ?', 'ch-a');
  assert.equal(renamed.title, 'Alpha Renamed');

  const bad = await AgentExecutor.executeAll(
    [{ op: 'RENAME_CHAPTER', chapterId: 'ch-x', newTitle: 'Hacked' }],
    { projectId, apply: true }
  );
  assert.equal(bad[0]?.status, 'error');

  const move = await AgentExecutor.executeAll(
    [{ op: 'MOVE_CHAPTER', chapterId: 'ch-a', positionIndex: 1 }],
    { projectId, apply: true }
  );
  assert.equal(move[0]?.status, 'success');
  const a = await db.get('SELECT "index" AS idx FROM chapter WHERE id = ?', 'ch-a');
  const b = await db.get('SELECT "index" AS idx FROM chapter WHERE id = ?', 'ch-b');
  assert.equal(a.idx, 1);
  assert.equal(b.idx, 0);

  const del = await AgentExecutor.executeAll(
    [{ op: 'DELETE_CHAPTER', chapterId: 'ch-b', reason: 'test' }],
    { projectId, apply: true }
  );
  assert.equal(del[0]?.status, 'success');
  const gone = await db.get('SELECT id FROM chapter WHERE id = ?', 'ch-b');
  assert.equal(gone, undefined);
});

test('AgentExecutor batch continues after error (non-atomic)', async () => {
  const { db } = await import('../../db/database');
  const { AgentExecutor } = await import('./agent_executor');

  const project = await db.run(
    "INSERT INTO project (title, settings, user_id) VALUES ('Batch', '{}', 'local')"
  );
  const projectId = Number(project.lastID);
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, status)
     VALUES ('batch-1', ?, 0, 'One', '', 'draft')`,
    projectId
  );

  const results = await AgentExecutor.executeAll(
    [
      { op: 'RENAME_CHAPTER', chapterId: 'missing', newTitle: 'Nope' },
      { op: 'RENAME_CHAPTER', chapterId: 'batch-1', newTitle: 'Still Works' },
    ],
    { projectId, apply: true }
  );
  assert.equal(results[0]?.status, 'error');
  assert.equal(results[1]?.status, 'success');
  const row = await db.get('SELECT title FROM chapter WHERE id = ?', 'batch-1');
  assert.equal(row.title, 'Still Works');
});

test('generateAndReplaceNarrativeTimeline is transactional with scene_version baseline', async () => {
  const { db } = await import('../../db/database');
  const { LLMService } = await import('../llm');
  const { generateAndReplaceNarrativeTimeline } = await import(
    '../timeline_generation_service'
  );

  const project = await db.run(
    "INSERT INTO project (title, settings, user_id) VALUES ('TL', '{}', 'local')"
  );
  const projectId = Number(project.lastID);
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, status)
     VALUES ('tl-ch', ?, 0, 'Scene Ch', 'Hero fights.', 'draft')`,
    projectId
  );
  await db.run(
    `INSERT INTO scene (chapter_id, "index", visual_prompt, asset_status)
     VALUES ('tl-ch', 1, 'old', 'idle')`
  );

  const prev = LLMService.generateTimeline;
  LLMService.generateTimeline = async () => [
    {
      visual_prompt: 'new shot',
      audio_prompt: 'bgm',
      dialogue: '',
      duration: 3,
      shot_type: 'medium',
      camera_movement: 'static',
      camera_angle: 'eye_level',
    },
    {
      visual_prompt: 'close up',
      audio_prompt: '',
      dialogue: 'Go!',
      duration: 2.5,
      shot_type: 'close_up',
      camera_movement: 'static',
      camera_angle: 'eye_level',
    },
  ];

  try {
    const result = await generateAndReplaceNarrativeTimeline({
      chapterId: 'tl-ch',
      projectId,
      content: 'Hero fights.',
    });
    assert.equal(result.count, 2);
    const scenes = await db.all(
      'SELECT id, visual_prompt FROM scene WHERE chapter_id = ? ORDER BY "index"',
      'tl-ch'
    );
    assert.equal(scenes.length, 2);
    assert.equal(scenes[0].visual_prompt, 'new shot');
    for (const s of scenes) {
      const versions = await db.all(
        'SELECT version FROM scene_version WHERE scene_id = ?',
        s.id
      );
      assert.equal(versions.length, 1);
      assert.equal(Number(versions[0].version), 1);
    }

    // Agent path uses the same service
    const { AgentExecutor } = await import('./agent_executor');
    LLMService.generateTimeline = async () => [
      {
        visual_prompt: 'from agent',
        duration: 3,
        shot_type: 'wide',
      },
    ];
    const exec = await AgentExecutor.executeAll(
      [{ op: 'GENERATE_TIMELINE', chapterId: 'tl-ch' }],
      { projectId, chapterId: 'tl-ch', apply: true }
    );
    assert.equal(exec[0]?.status, 'success');
    assert.equal((exec[0]?.data as any)?.count, 1);
    const after = await db.all(
      'SELECT visual_prompt FROM scene WHERE chapter_id = ?',
      'tl-ch'
    );
    assert.equal(after.length, 1);
    assert.equal(after[0].visual_prompt, 'from agent');
  } finally {
    LLMService.generateTimeline = prev;
  }
});
