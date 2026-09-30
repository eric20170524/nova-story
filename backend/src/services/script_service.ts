import crypto from 'node:crypto';
import { db } from '../db/database';
import { parseProjectSettings } from './project_settings';
import {
  ScriptDocumentSchema,
  ScriptOutlineSchema,
  ScriptSceneSchema,
  StoryboardCandidatePayloadSchema,
  createEmptyScriptDocument,
  computeSourceContentHash,
  computeSourceContextHash,
  validateScriptForConfirmation,
  serializeScriptToMarkdown,
  type ScriptDocument,
  type ScriptSourceSnapshot,
  type SourceFreshnessResult,
  type ChapterScriptRow,
  type ScriptChangeRow,
  type ScriptStatus,
  type ScriptChangeKind,
  type ScriptChangeState,
} from '../schemas/script';

/** Full ScriptDocument JSON, or null when the payload is a scene/outline fragment. */
function canonicalScriptDocumentJson(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 1 || !Array.isArray(obj.scenes)) return null;
  const result = ScriptDocumentSchema.safeParse(obj);
  return result.success ? JSON.stringify(result.data) : null;
}

function candidateKeepsSourceSnapshot(kind: string): boolean {
  return kind === 'outline' || kind === 'scene';
}

function resolveSceneCandidateTargetId(change: ScriptChangeRow): string | null {
  if (change.generation_info_json) {
    try {
      const info = JSON.parse(change.generation_info_json) as { target_scene_id?: unknown };
      if (typeof info.target_scene_id === 'string' && info.target_scene_id.trim()) {
        return info.target_scene_id;
      }
    } catch {
      /* generation info is optional */
    }
  }
  if (!change.before_json) return null;
  try {
    const before = JSON.parse(change.before_json) as Record<string, unknown>;
    if (
      before &&
      typeof before.id === 'string' &&
      Array.isArray(before.blocks) &&
      !Array.isArray(before.scenes)
    ) {
      return before.id;
    }
  } catch {
    return null;
  }
  return null;
}

export class ScriptServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 500 = 400
  ) {
    super(message);
    this.name = 'ScriptServiceError';
  }
}

export interface ScriptWithDetails {
  id: number;
  chapterId: string;
  projectId: number;
  revision: number;
  status: ScriptStatus;
  document: ScriptDocument;
  sourceSnapshot: ScriptSourceSnapshot;
  sourceContentHash: string;
  sourceContextHash: string;
  freshness: SourceFreshnessResult;
  pendingChanges: ScriptChangeRow[];
  createdAt: string;
  updatedAt: string;
}

export class ScriptService {
  /**
   * Load project semantic context for source hashing: characters, glossary, bible.
   */
  static async loadSourceContext(projectId: number): Promise<{
    characters: Array<{ id: number; name: string; role?: string | null }>;
    glossary: Array<{ term: string; definition?: string | null }>;
    bible?: { genre?: string; style?: string; main_plot?: string };
    contextHash: string;
  }> {
    const chars = (await db.all(
      'SELECT id, name, role FROM character WHERE project_id = ? ORDER BY id ASC',
      projectId
    )) as Array<{ id: number; name: string; role?: string | null }>;

    const terms = (await db.all(
      'SELECT term, definition FROM glossary WHERE project_id = ? ORDER BY id ASC',
      projectId
    )) as Array<{ term: string; definition?: string | null }>;

    const projectRow = (await db.get(
      'SELECT description, settings FROM project WHERE id = ?',
      projectId
    )) as { description?: string | null; settings?: string | null } | undefined;

    let bible: { genre?: string; style?: string; main_plot?: string } | undefined;
    if (projectRow?.settings) {
      try {
        const parsed = parseProjectSettings(projectRow.settings);
        const rawBible =
          parsed.bible && typeof parsed.bible === 'object'
            ? (parsed.bible as Record<string, unknown>)
            : (parsed as Record<string, unknown>);

        bible = {
          genre: typeof rawBible['genre'] === 'string' ? rawBible['genre'] : undefined,
          style: typeof rawBible['style'] === 'string' ? rawBible['style'] : undefined,
          main_plot: typeof rawBible['main_plot'] === 'string' ? rawBible['main_plot'] : undefined,
        };
      } catch {
        // fallback if settings is invalid json
      }
    }

    const contextHash = computeSourceContextHash({
      characters: chars,
      glossary: terms,
      bible,
    });

    return {
      characters: chars,
      glossary: terms,
      bible,
      contextHash,
    };
  }

  /**
   * Check whether source novel content or semantic context has changed since script sync.
   */
  static async checkFreshness(
    script: Pick<ChapterScriptRow, 'source_content_hash' | 'source_context_hash'>,
    chapterContent: string,
    projectId: number
  ): Promise<SourceFreshnessResult> {
    const currentContentHash = computeSourceContentHash(chapterContent || '');
    const context = await this.loadSourceContext(projectId);
    const currentContextHash = context.contextHash;

    const contentChanged = currentContentHash !== script.source_content_hash;
    const contextChanged = currentContextHash !== script.source_context_hash;
    const sourceChanged = contentChanged || contextChanged;

    return {
      sourceChanged,
      contentChanged,
      contextChanged,
      currentContentHash,
      snapshotContentHash: script.source_content_hash,
      currentContextHash,
      snapshotContextHash: script.source_context_hash,
    };
  }

  /**
   * Build a source snapshot object from current chapter and project context.
   */
  static async createSourceSnapshot(
    chapterId: string,
    chapterTitle: string,
    chapterContent: string,
    projectId: number
  ): Promise<ScriptSourceSnapshot> {
    const content = chapterContent || '';
    const contentHash = computeSourceContentHash(content);
    const context = await this.loadSourceContext(projectId);

    const paragraphs = content
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((text, idx) => ({
        id: `p_${idx + 1}`,
        text,
      }));

    return {
      chapterId,
      chapterTitle: chapterTitle || '',
      content,
      contentHash,
      contextHash: context.contextHash,
      characterSnapshots: context.characters.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role || null,
      })),
      glossarySnapshots: context.glossary.map((g) => ({
        term: g.term,
        definition: g.definition || null,
      })),
      paragraphSnapshots: paragraphs,
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * Fetch script for a chapter by chapterId.
   * Returns null if no script has been created yet.
   */
  static async getScriptByChapterId(chapterId: string): Promise<ScriptWithDetails | null> {
    const chapter = (await db.get(
      'SELECT id, project_id, title, content FROM chapter WHERE id = ?',
      chapterId
    )) as { id: string; project_id: number; title: string; content?: string | null } | undefined;

    if (!chapter) {
      throw new ScriptServiceError(`Chapter "${chapterId}" not found`, 404);
    }

    const row = (await db.get(
      'SELECT * FROM chapter_script WHERE chapter_id = ?',
      chapterId
    )) as ChapterScriptRow | undefined;

    if (!row) {
      return null;
    }

    return this.buildScriptDetails(row, chapter.project_id, chapter.content || '');
  }

  /**
   * Fetch script by scriptId.
   */
  static async getScriptById(scriptId: number): Promise<ScriptWithDetails> {
    const row = (await db.get(
      `SELECT s.*, c.project_id, c.content AS chapter_content
       FROM chapter_script s
       JOIN chapter c ON s.chapter_id = c.id
       WHERE s.id = ?`,
      scriptId
    )) as (ChapterScriptRow & { project_id: number; chapter_content?: string | null }) | undefined;

    if (!row) {
      throw new ScriptServiceError(`Script "${scriptId}" not found`, 404);
    }

    return this.buildScriptDetails(row, row.project_id, row.chapter_content || '');
  }

  private static async buildScriptDetails(
    row: ChapterScriptRow,
    projectId: number,
    chapterContent: string
  ): Promise<ScriptWithDetails> {
    let document: ScriptDocument;
    try {
      document = JSON.parse(row.document_json);
    } catch {
      document = createEmptyScriptDocument();
    }

    let sourceSnapshot: ScriptSourceSnapshot;
    try {
      sourceSnapshot = JSON.parse(row.source_snapshot_json);
    } catch {
      sourceSnapshot = {
        chapterId: row.chapter_id,
        chapterTitle: '',
        content: '',
        contentHash: row.source_content_hash,
        contextHash: row.source_context_hash,
        characterSnapshots: [],
        glossarySnapshots: [],
        paragraphSnapshots: [],
        capturedAt: row.created_at,
      };
    }

    const freshness = await this.checkFreshness(row, chapterContent, projectId);

    const pendingChanges = (await db.all(
      `SELECT * FROM script_change
       WHERE script_id = ? AND state = 'pending'
       ORDER BY created_at DESC`,
      row.id
    )) as ScriptChangeRow[];

    return {
      id: row.id,
      chapterId: row.chapter_id,
      projectId,
      revision: row.revision,
      status: row.status,
      document,
      sourceSnapshot,
      sourceContentHash: row.source_content_hash,
      sourceContextHash: row.source_context_hash,
      freshness,
      pendingChanges,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Idempotently create an initial script document for a chapter.
   * If script already exists, returns existing script.
   */
  static async createOrGetScript(
    chapterId: string,
    initialTitle?: string
  ): Promise<ScriptWithDetails> {
    const existing = await this.getScriptByChapterId(chapterId);
    if (existing) {
      return existing;
    }

    const chapter = (await db.get(
      'SELECT id, project_id, title, content FROM chapter WHERE id = ?',
      chapterId
    )) as { id: string; project_id: number; title: string; content?: string | null } | undefined;

    if (!chapter) {
      throw new ScriptServiceError(`Chapter "${chapterId}" not found`, 404);
    }

    const title = initialTitle?.trim() || chapter.title?.trim() || '短剧剧本';
    const document = createEmptyScriptDocument(title);
    const snapshot = await this.createSourceSnapshot(
      chapter.id,
      chapter.title || '',
      chapter.content || '',
      chapter.project_id
    );

    const result = await db.run(
      `INSERT INTO chapter_script (
        chapter_id, revision, status, document_json, source_snapshot_json,
        source_content_hash, source_context_hash
      ) VALUES (?, 1, 'draft', ?, ?, ?, ?)`,
      chapter.id,
      JSON.stringify(document),
      JSON.stringify(snapshot),
      snapshot.contentHash,
      snapshot.contextHash
    );

    const scriptId = (result as { lastID?: number }).lastID;
    if (!scriptId) {
      throw new ScriptServiceError('Failed to initialize script document', 500);
    }

    return this.getScriptById(scriptId);
  }

  /**
   * Save manual script edits.
   * Validates document schema, verifies expectedRevision, increments revision,
   * resets status to 'draft', and records 'manual' script_change entry.
   */
  static async saveManualScript(params: {
    scriptId: number;
    document: unknown;
    expectedRevision: number;
    requestKey?: string;
  }): Promise<ScriptWithDetails> {
    const parsedDoc = ScriptDocumentSchema.safeParse(params.document);
    if (!parsedDoc.success) {
      throw new ScriptServiceError(
        `Invalid script document structure: ${parsedDoc.error.message}`,
        400
      );
    }
    const document = parsedDoc.data;

    // Idempotency check if requestKey provided
    if (params.requestKey) {
      const existingChange = (await db.get(
        `SELECT * FROM script_change
         WHERE script_id = ? AND request_key = ? AND state = 'applied'`,
        params.scriptId,
        params.requestKey
      )) as ScriptChangeRow | undefined;

      if (existingChange) {
        return this.getScriptById(params.scriptId);
      }
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const row = (await db.get(
        'SELECT * FROM chapter_script WHERE id = ?',
        params.scriptId
      )) as ChapterScriptRow | undefined;

      if (!row) {
        throw new ScriptServiceError(`Script "${params.scriptId}" not found`, 404);
      }

      if (row.revision !== params.expectedRevision) {
        throw new ScriptServiceError(
          `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${row.revision}`,
          409
        );
      }

      const newRevision = row.revision + 1;
      const docJson = JSON.stringify(document);

      await db.run(
        `UPDATE chapter_script
         SET revision = ?, status = 'draft', document_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        newRevision,
        docJson,
        row.id
      );

      const changeId = crypto.randomUUID();
      const requestKey = params.requestKey || `manual_${changeId}`;

      await db.run(
        `INSERT INTO script_change (
          id, script_id, kind, base_revision, candidate_revision,
          request_key, state, before_json, after_json, source_snapshot_json,
          applied_revision, result_json
        ) VALUES (?, ?, 'manual', ?, ?, ?, 'applied', ?, ?, ?, ?, ?)`,
        changeId,
        row.id,
        params.expectedRevision,
        newRevision,
        requestKey,
        row.document_json,
        docJson,
        row.source_snapshot_json,
        newRevision,
        docJson
      );

      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }

    return this.getScriptById(params.scriptId);
  }

  /**
   * Confirm script for production handover.
   * Validates completeness (at least 1 performable scene, valid blocks, etc.),
   * verifies source freshness (rejects if sourceChanged unless force_source_refresh),
   * sets status to 'confirmed', increments revision, records 'confirm' script_change.
   */
  static async confirmScript(params: {
    scriptId: number;
    expectedRevision: number;
    forceSourceRefresh?: boolean;
    requestKey?: string;
  }): Promise<ScriptWithDetails> {
    if (params.requestKey) {
      const existingChange = (await db.get(
        `SELECT * FROM script_change
         WHERE script_id = ? AND request_key = ? AND state = 'applied'`,
        params.scriptId,
        params.requestKey
      )) as ScriptChangeRow | undefined;

      if (existingChange) {
        return this.getScriptById(params.scriptId);
      }
    }

    const currentScript = await this.getScriptById(params.scriptId);

    if (currentScript.revision !== params.expectedRevision) {
      throw new ScriptServiceError(
        `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${currentScript.revision}`,
        409
      );
    }

    // Query project characters for validation (SC02)
    const projectChars = (await db.all(
      'SELECT id FROM character WHERE project_id = ?',
      currentScript.projectId
    )) as Array<{ id: number }>;
    const validProjectCharacterIds = new Set(projectChars.map((c) => c.id));

    // Validate completeness and references (SC02)
    const validation = validateScriptForConfirmation(currentScript.document, {
      validProjectCharacterIds,
    });
    if (!validation.valid) {
      throw new ScriptServiceError(
        `Cannot confirm incomplete script: ${validation.errors.join('; ')}`,
        400
      );
    }

    // Validate source freshness
    if (currentScript.freshness.sourceChanged && !params.forceSourceRefresh) {
      throw new ScriptServiceError(
        'Source novel content or project context has changed since script creation. Review differences or specify force_source_refresh=true to proceed.',
        409
      );
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const row = (await db.get(
        'SELECT * FROM chapter_script WHERE id = ?',
        params.scriptId
      )) as ChapterScriptRow | undefined;

      if (!row) {
        throw new ScriptServiceError(`Script "${params.scriptId}" not found`, 404);
      }

      if (row.revision !== params.expectedRevision) {
        throw new ScriptServiceError(
          `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${row.revision}`,
          409
        );
      }

      const newRevision = row.revision + 1;
      let snapshotJson = row.source_snapshot_json;
      let contentHash = row.source_content_hash;
      let contextHash = row.source_context_hash;

      if (params.forceSourceRefresh) {
        const chapter = (await db.get(
          'SELECT title, content FROM chapter WHERE id = ?',
          row.chapter_id
        )) as { title: string; content?: string | null } | undefined;

        const newSnapshot = await this.createSourceSnapshot(
          row.chapter_id,
          chapter?.title || '',
          chapter?.content || '',
          currentScript.projectId
        );
        snapshotJson = JSON.stringify(newSnapshot);
        contentHash = newSnapshot.contentHash;
        contextHash = newSnapshot.contextHash;
      }

      await db.run(
        `UPDATE chapter_script
         SET revision = ?, status = 'confirmed', source_snapshot_json = ?,
             source_content_hash = ?, source_context_hash = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        newRevision,
        snapshotJson,
        contentHash,
        contextHash,
        row.id
      );

      const changeId = crypto.randomUUID();
      const requestKey = params.requestKey || `confirm_${changeId}`;

      await db.run(
        `INSERT INTO script_change (
          id, script_id, kind, base_revision, candidate_revision,
          request_key, state, before_json, after_json, source_snapshot_json,
          applied_revision, result_json
        ) VALUES (?, ?, 'confirm', ?, ?, ?, 'applied', ?, ?, ?, ?, ?)`,
        changeId,
        row.id,
        params.expectedRevision,
        newRevision,
        requestKey,
        row.document_json,
        row.document_json,
        snapshotJson,
        newRevision,
        row.document_json
      );

      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }

    return this.getScriptById(params.scriptId);
  }

  /**
   * Restore the last restorable document change.
   * Only allows restoring when current revision equals expectedRevision.
   */
  static async restoreScript(params: {
    scriptId: number;
    expectedRevision: number;
    requestKey?: string;
  }): Promise<ScriptWithDetails> {
    if (params.requestKey) {
      const existingChange = (await db.get(
        `SELECT * FROM script_change
         WHERE script_id = ? AND request_key = ? AND state = 'applied'`,
        params.scriptId,
        params.requestKey
      )) as ScriptChangeRow | undefined;

      if (existingChange) {
        return this.getScriptById(params.scriptId);
      }
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const row = (await db.get(
        'SELECT * FROM chapter_script WHERE id = ?',
        params.scriptId
      )) as ChapterScriptRow | undefined;

      if (!row) {
        throw new ScriptServiceError(`Script "${params.scriptId}" not found`, 404);
      }

      if (row.revision !== params.expectedRevision) {
        throw new ScriptServiceError(
          `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${row.revision}`,
          409
        );
      }

      const currentCanonical = canonicalScriptDocumentJson(row.document_json);
      const appliedChanges = (await db.all(
        `SELECT before_json FROM script_change
         WHERE script_id = ? AND state = 'applied' AND before_json IS NOT NULL
         ORDER BY applied_revision DESC, rowid DESC`,
        params.scriptId
      )) as Array<{ before_json: string | null }>;

      let restoredDocJson: string | null = null;
      for (const change of appliedChanges) {
        const candidateJson = canonicalScriptDocumentJson(change.before_json);
        if (!candidateJson || candidateJson === currentCanonical) continue;
        restoredDocJson = candidateJson;
        break;
      }

      if (!restoredDocJson) {
        throw new ScriptServiceError(
          `No restorable previous version found for revision ${params.expectedRevision}`,
          409
        );
      }

      const newRevision = row.revision + 1;

      await db.run(
        `UPDATE chapter_script
         SET revision = ?, status = 'draft', document_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        newRevision,
        restoredDocJson,
        row.id
      );

      const changeId = crypto.randomUUID();
      const requestKey = params.requestKey || `restore_${changeId}`;

      await db.run(
        `INSERT INTO script_change (
          id, script_id, kind, base_revision, candidate_revision,
          request_key, state, before_json, after_json, source_snapshot_json,
          applied_revision, result_json
        ) VALUES (?, ?, 'restore', ?, ?, ?, 'applied', ?, ?, ?, ?, ?)`,
        changeId,
        row.id,
        params.expectedRevision,
        newRevision,
        requestKey,
        row.document_json,
        restoredDocJson,
        row.source_snapshot_json,
        newRevision,
        restoredDocJson
      );

      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }

    return this.getScriptById(params.scriptId);
  }

  /**
   * Create a pending candidate change (outline, whole script, scene rewrite).
   * Idempotent by script_id + request_key.
   */
  static async createPendingCandidate(params: {
    scriptId: number;
    kind: ScriptChangeKind;
    expectedRevision: number;
    requestKey: string;
    afterJson: string;
    beforeJson?: string;
    generationInfo?: Record<string, any>;
    sourceSnapshot?: ScriptSourceSnapshot;
  }): Promise<ScriptChangeRow> {
    const existing = (await db.get(
      'SELECT * FROM script_change WHERE script_id = ? AND request_key = ?',
      params.scriptId,
      params.requestKey
    )) as ScriptChangeRow | undefined;

    if (existing) {
      return existing;
    }

    const script = await this.getScriptById(params.scriptId);
    if (script.revision !== params.expectedRevision) {
      throw new ScriptServiceError(
        `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${script.revision}`,
        409
      );
    }

    const changeId = crypto.randomUUID();
    const candidateRevision = params.expectedRevision + 1;

    let parsedAfter: unknown;
    try {
      parsedAfter = JSON.parse(params.afterJson);
    } catch {
      throw new ScriptServiceError('Candidate payload must be valid JSON', 400);
    }

    if (params.kind === 'outline') {
      const outlineRes = ScriptOutlineSchema.safeParse(parsedAfter);
      if (!outlineRes.success) {
        throw new ScriptServiceError(
          `Invalid outline candidate payload: ${outlineRes.error.message}`,
          400
        );
      }
    } else if (params.kind === 'scene') {
      const sceneRes = ScriptSceneSchema.safeParse(parsedAfter);
      if (!sceneRes.success) {
        throw new ScriptServiceError(
          `Invalid scene candidate payload: ${sceneRes.error.message}`,
          400
        );
      }
    } else if (params.kind === 'script') {
      const scriptRes = ScriptDocumentSchema.safeParse(parsedAfter);
      if (!scriptRes.success) {
        throw new ScriptServiceError(
          `Invalid script candidate payload: ${scriptRes.error.message}`,
          400
        );
      }
    } else if (params.kind === 'storyboard') {
      const storyboardRes = StoryboardCandidatePayloadSchema.safeParse(parsedAfter);
      if (!storyboardRes.success) {
        throw new ScriptServiceError(
          `Invalid storyboard candidate payload: ${storyboardRes.error.message}`,
          400
        );
      }
    }

    let snapshotToSave = params.sourceSnapshot;
    if (!snapshotToSave && candidateKeepsSourceSnapshot(params.kind)) {
      snapshotToSave = script.sourceSnapshot;
    } else if (!snapshotToSave) {
      const chapter = (await db.get(
        'SELECT id, title, content FROM chapter WHERE id = ?',
        script.chapterId
      )) as { id: string; title: string; content?: string | null } | undefined;
      snapshotToSave = await this.createSourceSnapshot(
        script.chapterId,
        chapter?.title || '',
        chapter?.content || '',
        script.projectId
      );
    }

    await db.run(
      `INSERT INTO script_change (
        id, script_id, kind, base_revision, candidate_revision,
        request_key, state, before_json, after_json, source_snapshot_json,
        generation_info_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      changeId,
      params.scriptId,
      params.kind,
      params.expectedRevision,
      candidateRevision,
      params.requestKey,
      params.beforeJson || JSON.stringify(script.document),
      params.afterJson,
      JSON.stringify(snapshotToSave),
      params.generationInfo ? JSON.stringify(params.generationInfo) : null
    );

    const created = (await db.get(
      'SELECT * FROM script_change WHERE id = ?',
      changeId
    )) as ScriptChangeRow;

    return created;
  }

  /**
   * Update an existing pending candidate (e.g. user edits in review card).
   */
  static async updatePendingCandidate(params: {
    scriptId: number;
    changeId: string;
    expectedRevision: number;
    expectedCandidateRevision?: number;
    afterJson: string;
  }): Promise<ScriptChangeRow> {
    const change = (await db.get(
      'SELECT * FROM script_change WHERE id = ? AND script_id = ?',
      params.changeId,
      params.scriptId
    )) as ScriptChangeRow | undefined;

    if (!change) {
      throw new ScriptServiceError(`Candidate "${params.changeId}" not found`, 404);
    }

    if (change.state !== 'pending') {
      throw new ScriptServiceError(
        `Candidate is in "${change.state}" state and cannot be modified`,
        409
      );
    }

    if (change.base_revision !== params.expectedRevision) {
      throw new ScriptServiceError(
        `Revision conflict: expected candidate base revision ${params.expectedRevision}, but found ${change.base_revision}`,
        409
      );
    }

    if (
      params.expectedCandidateRevision !== undefined &&
      change.candidate_revision !== params.expectedCandidateRevision
    ) {
      throw new ScriptServiceError(
        `Revision conflict: candidate revision is ${change.candidate_revision}, but expected ${params.expectedCandidateRevision}`,
        409
      );
    }

    let parsedAfter: unknown;
    try {
      parsedAfter = JSON.parse(params.afterJson);
    } catch {
      throw new ScriptServiceError('Candidate payload must be valid JSON', 400);
    }

    if (change.kind === 'outline') {
      const res = ScriptOutlineSchema.safeParse(parsedAfter);
      if (!res.success) {
        throw new ScriptServiceError(`Invalid outline payload: ${res.error.message}`, 400);
      }
    } else if (change.kind === 'scene') {
      const res = ScriptSceneSchema.safeParse(parsedAfter);
      if (!res.success) {
        throw new ScriptServiceError(`Invalid scene payload: ${res.error.message}`, 400);
      }
    } else if (change.kind === 'script') {
      const res = ScriptDocumentSchema.safeParse(parsedAfter);
      if (!res.success) {
        throw new ScriptServiceError(`Invalid script payload: ${res.error.message}`, 400);
      }
    } else if (change.kind === 'storyboard') {
      const res = StoryboardCandidatePayloadSchema.safeParse(parsedAfter);
      if (!res.success) {
        throw new ScriptServiceError(`Invalid storyboard payload: ${res.error.message}`, 400);
      }
    }

    const updated = await db.run(
      `UPDATE script_change
       SET after_json = ?, candidate_revision = candidate_revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND script_id = ? AND state = 'pending' AND candidate_revision = ?`,
      params.afterJson,
      params.changeId,
      params.scriptId,
      change.candidate_revision
    );
    if (updated.changes !== 1) {
      throw new ScriptServiceError('Revision conflict: candidate changed during editing', 409);
    }

    return (await db.get(
      'SELECT * FROM script_change WHERE id = ?',
      params.changeId
    )) as ScriptChangeRow;
  }

  /**
   * Atomically apply a pending candidate.
   * Verifies base_revision, current revision, and freshness (fails if sourceChanged).
   */
  static async applyCandidate(params: {
    scriptId: number;
    changeId: string;
    expectedRevision: number;
    expectedCandidateRevision?: number;
    requestKey?: string;
  }): Promise<ScriptWithDetails> {
    const change = (await db.get(
      'SELECT * FROM script_change WHERE id = ? AND script_id = ?',
      params.changeId,
      params.scriptId
    )) as ScriptChangeRow | undefined;

    if (!change) {
      throw new ScriptServiceError(`Candidate "${params.changeId}" not found`, 404);
    }

    if (change.kind === 'storyboard') {
      throw new ScriptServiceError(
        'Storyboard candidates must be applied via /api/scripts/:scriptId/storyboard-candidates/:changeId/apply',
        400
      );
    }

    // Idempotency: if already applied, return current script
    if (change.state === 'applied') {
      return this.getScriptById(params.scriptId);
    }

    if (change.state !== 'pending') {
      throw new ScriptServiceError(
        `Candidate is in "${change.state}" state and cannot be applied`,
        409
      );
    }

    const currentScript = await this.getScriptById(params.scriptId);

    if (currentScript.revision !== params.expectedRevision) {
      throw new ScriptServiceError(
        `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${currentScript.revision}`,
        409
      );
    }

    if (change.base_revision !== params.expectedRevision) {
      throw new ScriptServiceError(
        `Candidate base revision (${change.base_revision}) does not match current script revision (${params.expectedRevision})`,
        409
      );
    }

    if (
      params.expectedCandidateRevision !== undefined &&
      change.candidate_revision !== params.expectedCandidateRevision
    ) {
      throw new ScriptServiceError(
        `Revision conflict: candidate revision is ${change.candidate_revision}, but expected ${params.expectedCandidateRevision}`,
        409
      );
    }

    const keepsSourceSnapshot = candidateKeepsSourceSnapshot(change.kind);
    // A one-scene or outline edit is not a re-adaptation of the chapter.
    // Installing its snapshot would mark every other scene as up to date.
    if (keepsSourceSnapshot && currentScript.freshness.sourceChanged) {
      throw new ScriptServiceError(
        'Source novel content or project context has changed. Outline and scene candidates keep the existing source snapshot and cannot be applied until the source is refreshed or the full script is regenerated.',
        409
      );
    }

    let candSnapshot: ScriptSourceSnapshot | null = null;
    if (change.source_snapshot_json) {
      try {
        candSnapshot = JSON.parse(change.source_snapshot_json);
      } catch {
        candSnapshot = null;
      }
    }

    if (candSnapshot) {
      const chapter = (await db.get(
        'SELECT content FROM chapter WHERE id = ?',
        currentScript.chapterId
      )) as { content?: string | null } | undefined;
      const currentContentHash = computeSourceContentHash(chapter?.content || '');
      const currentContext = await this.loadSourceContext(currentScript.projectId);
      if (
        currentContentHash !== candSnapshot.contentHash ||
        currentContext.contextHash !== candSnapshot.contextHash
      ) {
        throw new ScriptServiceError(
          'Source novel content or project context has changed since this candidate was created. Please regenerate or re-verify candidate.',
          409
        );
      }
    } else if (currentScript.freshness.sourceChanged) {
      throw new ScriptServiceError(
        'Source novel content or project context has changed since this candidate was created. Please regenerate or re-verify candidate.',
        409
      );
    }

    let newDocument: ScriptDocument;
    try {
      if (change.kind === 'script') {
        newDocument = ScriptDocumentSchema.parse(JSON.parse(change.after_json));
      } else if (change.kind === 'outline') {
        const outline = ScriptOutlineSchema.parse(JSON.parse(change.after_json));
        newDocument = ScriptDocumentSchema.parse({
          ...currentScript.document,
          outline,
        });
      } else if (change.kind === 'scene') {
        const scenePayload = ScriptSceneSchema.parse(JSON.parse(change.after_json));
        const targetSceneId = resolveSceneCandidateTargetId(change);
        if (!targetSceneId) {
          throw new ScriptServiceError(
            'Scene candidate is missing target_scene_id',
            400
          );
        }
        if (scenePayload.id !== targetSceneId) {
          throw new ScriptServiceError(
            `Scene candidate id "${scenePayload.id}" does not match target scene "${targetSceneId}"`,
            409
          );
        }
        const scenes = [...currentScript.document.scenes];
        const sIdx = scenes.findIndex((s) => s.id === targetSceneId);
        if (sIdx < 0) {
          throw new ScriptServiceError(
            `Target scene "${targetSceneId}" no longer exists`,
            409
          );
        }
        scenes[sIdx] = scenePayload;
        newDocument = ScriptDocumentSchema.parse({
          ...currentScript.document,
          scenes,
        });
      } else {
        newDocument = ScriptDocumentSchema.parse(JSON.parse(change.after_json));
      }
    } catch (err: any) {
      if (err instanceof ScriptServiceError) throw err;
      throw new ScriptServiceError(
        `Cannot apply candidate: invalid document after applying candidate: ${err.message}`,
        400
      );
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const row = (await db.get(
        'SELECT * FROM chapter_script WHERE id = ?',
        params.scriptId
      )) as ChapterScriptRow | undefined;

      if (!row) {
        throw new ScriptServiceError(`Script "${params.scriptId}" not found`, 404);
      }

      if (row.revision !== params.expectedRevision) {
        throw new ScriptServiceError(
          `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${row.revision}`,
          409
        );
      }

      ScriptDocumentSchema.parse(newDocument);
      const lockedChange = await db.get('SELECT state, candidate_revision FROM script_change WHERE id = ? AND script_id = ?', change.id, row.id);
      if (!lockedChange || lockedChange.state !== 'pending' || lockedChange.candidate_revision !== change.candidate_revision) {
        throw new ScriptServiceError('Revision conflict: candidate changed before applying', 409);
      }
      const newRevision = row.revision + 1;
      const docJson = JSON.stringify(newDocument);

      await db.run(
        `UPDATE chapter_script
         SET revision = ?, status = 'draft', document_json = ?,
             source_snapshot_json = ?, source_content_hash = ?, source_context_hash = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        newRevision,
        docJson,
        keepsSourceSnapshot
          ? row.source_snapshot_json
          : (change.source_snapshot_json || row.source_snapshot_json),
        keepsSourceSnapshot
          ? row.source_content_hash
          : (candSnapshot ? candSnapshot.contentHash : row.source_content_hash),
        keepsSourceSnapshot
          ? row.source_context_hash
          : (candSnapshot ? candSnapshot.contextHash : row.source_context_hash),
        row.id
      );

      await db.run(
        `UPDATE script_change
         SET state = 'applied', applied_revision = ?, before_json = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        newRevision,
        row.document_json,
        docJson,
        change.id
      );

      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }

    return this.getScriptById(params.scriptId);
  }

  /**
   * Explicitly refresh source snapshot against current chapter content and project context
   * without requiring production confirmation completeness checks.
   */
  static async refreshSourceSnapshot(params: {
    scriptId: number;
    expectedRevision: number;
    requestKey?: string;
  }): Promise<ScriptWithDetails> {
    if (params.requestKey) {
      const existingChange = (await db.get(
        `SELECT * FROM script_change
         WHERE script_id = ? AND request_key = ? AND state = 'applied'`,
        params.scriptId,
        params.requestKey
      )) as ScriptChangeRow | undefined;

      if (existingChange) {
        return this.getScriptById(params.scriptId);
      }
    }

    const currentScript = await this.getScriptById(params.scriptId);
    if (currentScript.revision !== params.expectedRevision) {
      throw new ScriptServiceError(
        `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${currentScript.revision}`,
        409
      );
    }

    const chapter = (await db.get(
      'SELECT title, content FROM chapter WHERE id = ?',
      currentScript.chapterId
    )) as { title: string; content?: string | null } | undefined;

    const newSnapshot = await this.createSourceSnapshot(
      currentScript.chapterId,
      chapter?.title || '',
      chapter?.content || '',
      currentScript.projectId
    );

    const changeId = crypto.randomUUID();
    const requestKey = params.requestKey || `refresh_source_${changeId}`;
    const snapshotJson = JSON.stringify(newSnapshot);

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const row = (await db.get(
        'SELECT * FROM chapter_script WHERE id = ?',
        params.scriptId
      )) as ChapterScriptRow | undefined;

      if (!row) {
        throw new ScriptServiceError(`Script "${params.scriptId}" not found`, 404);
      }

      if (row.revision !== params.expectedRevision) {
        throw new ScriptServiceError(
          `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${row.revision}`,
          409
        );
      }

      const newRevision = row.revision + 1;
      const docJson = row.document_json;

      await db.run(
        `UPDATE chapter_script
         SET revision = ?, source_snapshot_json = ?, source_content_hash = ?, source_context_hash = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        newRevision,
        snapshotJson,
        newSnapshot.contentHash,
        newSnapshot.contextHash,
        row.id
      );

      await db.run(
        `INSERT INTO script_change (
          id, script_id, kind, base_revision, candidate_revision,
          request_key, state, before_json, after_json, source_snapshot_json,
          applied_revision, result_json
        ) VALUES (?, ?, 'manual', ?, ?, ?, 'applied', ?, ?, ?, ?, ?)`,
        changeId,
        row.id,
        params.expectedRevision,
        newRevision,
        requestKey,
        docJson,
        docJson,
        snapshotJson,
        newRevision,
        docJson
      );
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }

    return this.getScriptById(params.scriptId);
  }

  /**
   * Discard a pending candidate.
   */
  static async discardCandidate(params: {
    scriptId: number;
    changeId: string;
  }): Promise<ScriptChangeRow> {
    const change = (await db.get(
      'SELECT * FROM script_change WHERE id = ? AND script_id = ?',
      params.changeId,
      params.scriptId
    )) as ScriptChangeRow | undefined;

    if (!change) {
      throw new ScriptServiceError(`Candidate "${params.changeId}" not found`, 404);
    }

    if (change.state === 'applied') {
      throw new ScriptServiceError('Cannot discard an already applied candidate', 409);
    }

    if (change.state === 'discarded') {
      return change;
    }

    await db.run(
      `UPDATE script_change
       SET state = 'discarded', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      params.changeId
    );

    return (await db.get(
      'SELECT * FROM script_change WHERE id = ?',
      params.changeId
    )) as ScriptChangeRow;
  }

  /**
   * Export script as deterministic Markdown.
   */
  static async exportScriptMarkdown(scriptId: number): Promise<string> {
    const script = await this.getScriptById(scriptId);

    const chapter = (await db.get(
      'SELECT title FROM chapter WHERE id = ?',
      script.chapterId
    )) as { title: string } | undefined;

    const chars = (await db.all(
      'SELECT id, name FROM character WHERE project_id = ?',
      script.projectId
    )) as Array<{ id: number; name: string }>;

    const charMap = new Map<number, string>();
    for (const c of chars) {
      charMap.set(c.id, c.name);
    }

    return serializeScriptToMarkdown(script.document, {
      status: script.status,
      sourceChanged: script.freshness.sourceChanged,
      chapterTitle: chapter?.title,
      characterNameMap: charMap,
    });
  }
}
