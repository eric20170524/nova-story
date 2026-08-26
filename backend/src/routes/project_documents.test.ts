import assert from 'node:assert/strict';
import test from 'node:test';

const multipartPayload = async (filename: string, content: string, type: string) => {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), filename);
  const request = new Request('http://localhost', { method: 'POST', body: form });
  return {
    headers: Object.fromEntries(request.headers.entries()),
    payload: Buffer.from(await request.arrayBuffer()),
  };
};

test('supplemental document preview, commit, duplicate detection, list, and delete are non-destructive', async () => {
  process.env.DATABASE_URL = ':memory:';

  const [
    { default: Fastify },
    { default: multipart },
    { projectDocumentRoutes },
    { db, initDb },
  ] = await Promise.all([
    import('fastify'),
    import('@fastify/multipart'),
    import('./project_documents'),
    import('../db/database'),
  ]);

  await initDb();
  const projectResult = await db.run(
    `INSERT INTO project (title, description, settings, user_id)
     VALUES (?, ?, ?, ?)`,
    'Existing Novel',
    'existing description',
    JSON.stringify({ genre: 'fantasy', tone: 'warm' }),
    'local_admin'
  );
  const projectId = Number(projectResult.lastID);
  await db.run(
    `INSERT INTO chapter (id, project_id, "index", title, content, summary, status)
     VALUES (?, ?, 1, ?, ?, ?, 'draft')`,
    'existing-chapter',
    projectId,
    '第一章',
    '不可被附加资料修改的正文。',
    '原始概要'
  );

  const app = Fastify();
  await app.register(multipart);
  await app.register(projectDocumentRoutes, { prefix: '/api/projects' });
  await app.ready();

  const markdown = [
    '# 世界观补充',
    '',
    '## 游乐场规则',
    '',
    '午夜后旋转木马会记录访客留下的声音。',
  ].join('\n');

  const previewUpload = await multipartPayload('世界观.md', markdown, 'text/markdown');
  const preview = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/documents/preview?document_type=worldbuilding`,
    headers: previewUpload.headers,
    payload: previewUpload.payload,
  });

  assert.equal(preview.statusCode, 200, preview.body);
  const previewBody = preview.json();
  assert.equal(previewBody.title, '世界观补充');
  assert.equal(previewBody.document_type, 'worldbuilding');
  assert.equal(previewBody.source.format, 'markdown');
  assert.equal(previewBody.heading_count, 2);
  assert.equal(previewBody.duplicate_document, null);
  assert.deepEqual(previewBody.impact, {
    modifies_chapters: false,
    modifies_story_bible: false,
    ai_context_enabled: false,
  });

  const commitUpload = await multipartPayload('世界观.md', markdown, 'text/markdown');
  const committed = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/documents?document_type=worldbuilding`,
    headers: commitUpload.headers,
    payload: commitUpload.payload,
  });

  assert.equal(committed.statusCode, 201, committed.body);
  const document = committed.json();
  assert.equal(document.name, '世界观补充');
  assert.equal(document.document_type, 'worldbuilding');
  assert.equal(document.source_filename, '世界观.md');
  assert.equal(document.source_format, 'markdown');
  assert.match(document.checksum, /^[a-f0-9]{64}$/);

  const chapterAfter = await db.get('SELECT * FROM chapter WHERE id = ?', 'existing-chapter');
  assert.equal(chapterAfter.content, '不可被附加资料修改的正文。');
  assert.equal(chapterAfter.summary, '原始概要');

  const projectAfter = await db.get('SELECT settings FROM project WHERE id = ?', projectId);
  assert.deepEqual(JSON.parse(projectAfter.settings), { genre: 'fantasy', tone: 'warm' });

  const duplicatePreviewUpload = await multipartPayload('copy.md', markdown, 'text/markdown');
  const duplicatePreview = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/documents/preview?document_type=reference`,
    headers: duplicatePreviewUpload.headers,
    payload: duplicatePreviewUpload.payload,
  });
  assert.equal(duplicatePreview.statusCode, 200, duplicatePreview.body);
  assert.equal(duplicatePreview.json().duplicate_document.id, document.id);

  const duplicateCommitUpload = await multipartPayload('copy.md', markdown, 'text/markdown');
  const duplicateCommit = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/documents?document_type=reference`,
    headers: duplicateCommitUpload.headers,
    payload: duplicateCommitUpload.payload,
  });
  assert.equal(duplicateCommit.statusCode, 409, duplicateCommit.body);

  const listed = await app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/documents`,
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().length, 1);
  assert.equal(listed.json()[0].id, document.id);

  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/projects/${projectId}/documents/${document.id}`,
  });
  assert.equal(deleted.statusCode, 200, deleted.body);

  const afterDelete = await db.get('SELECT COUNT(*) AS count FROM project_document WHERE project_id = ?', projectId);
  assert.equal(Number(afterDelete.count), 0);

  const migration = await db.get(
    'SELECT version FROM schema_migration WHERE version = ?',
    '008_project_documents'
  );
  assert.equal(migration.version, '008_project_documents');

  await app.close();
});

test('supplemental documents reject unsupported formats', async () => {
  process.env.DATABASE_URL = ':memory:';
  const { parseProjectDocument, ProjectDocumentInputError } = await import('../services/project_documents');

  assert.throws(
    () => parseProjectDocument(Buffer.from('PDF bytes'), 'notes.pdf', 'application/pdf'),
    (error: unknown) => (
      error instanceof ProjectDocumentInputError
      && error.statusCode === 415
    )
  );
});
