import { randomUUID } from 'node:crypto';
import { db, withImmediateTransaction } from '../db/database';
import { parseProjectSettings, serializeProjectSettings } from './project_settings';

import {
  CHAPTER_CONTENT_UNFINALIZE_SQL,
  DETERMINISTIC_NEXT_CONFLICTS,
  PlanPatch,
  PlannedChapter,
  PlanningError,
  StoryBlueprint,
  StoryPlanDocument,
  StoryPlanDocumentSchema,
  activePlanEntries,
  assertPlanningBudget,
  deterministicUuid,
  emptyStoryPlan,
  hashApplySelection,
  hashCanonical,
  hashChapterContent,
  hashNextChapterRequest,
  hashText,
  newPlanEntryId,
  orderPlanEntries,
  planningWordBudget,
  selectNextPlanEntry,
} from '../schemas/story_plan';

type ChangeRow = Record<string, any>;

const clampTarget = (value: unknown, fallback = 2000): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 200 || parsed > 10000) return fallback;
  return parsed;
};

const parseDocument = (raw: string): StoryPlanDocument =>
  StoryPlanDocumentSchema.parse(JSON.parse(raw));

function unfinalizedChapterMessage(chapter: { title?: string; status?: string; finalized_content_hash?: string | null }): string {
  const title = chapter.title || '上一章';
  if (chapter.status === 'completed' && !chapter.finalized_content_hash) {
    return `上一章（${title}）在正文哈希出现之前就已完成，需要定稿一次。`;
  }
  if (chapter.status === 'completed') {
    return `上一章（${title}）尚未定稿，正文已变化，需要重新定稿。`;
  }
  return `上一章（${title}）尚未定稿，请先完成「定稿：更新世界观」后再创建新章节`;
}

async function loadPlan(projectId: number): Promise<{ revision: number; document: StoryPlanDocument } | null> {
  const row = await db.get('SELECT revision, document_json FROM story_plan WHERE project_id = ?', projectId);
  if (!row) return null;
  return { revision: Number(row.revision), document: parseDocument(String(row.document_json)) };
}

async function savePlan(projectId: number, revision: number, document: StoryPlanDocument): Promise<number> {
  const updated = await db.run(
    `UPDATE story_plan
     SET document_json = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
     WHERE project_id = ? AND revision = ?`,
    JSON.stringify(document),
    projectId,
    revision
  );
  if (Number(updated?.changes) !== 1) {
    throw new PlanningError('PLAN_CONFLICT', 409, '规划已被其他操作更新');
  }
  await db.run(
    `UPDATE story_plan_change
     SET state = 'stale', error_code = 'SOURCE_CHANGED', updated_at = CURRENT_TIMESTAMP
     WHERE project_id = ? AND state = 'pending' AND kind != 'next_chapter'`,
    projectId
  );
  return revision + 1;
}

async function linkedRefs(projectId: number, exceptChapterId?: string) {
  const rows = await db.all(
    `SELECT id, plan_entry_id, "index" AS idx
     FROM chapter
     WHERE project_id = ? AND plan_entry_id IS NOT NULL`,
    projectId
  );
  return (rows as any[])
    .filter((row) => row.id !== exceptChapterId && row.plan_entry_id)
    .map((row) => ({ plan_entry_id: String(row.plan_entry_id), index: Number(row.idx) }));
}

export class StoryPlanService {
  static async markInterruptedGenerations(): Promise<void> {
    const table = await db.get(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'story_plan_change'"
    );
    if (!table) return;
    await db.run(
      `UPDATE story_plan_change
       SET state = 'failed', error_code = 'INTERRUPTED', updated_at = CURRENT_TIMESTAMP
       WHERE state = 'generating'`
    );
  }

  static async ensurePlan(projectId: number): Promise<{ revision: number; document: StoryPlanDocument }> {
    const existing = await loadPlan(projectId);
    if (existing) return existing;
    const document = emptyStoryPlan();
    try {
      await db.run(
        'INSERT INTO story_plan (project_id, revision, document_json) VALUES (?, 1, ?)',
        projectId,
        JSON.stringify(document)
      );
    } catch (error: any) {
      const again = await loadPlan(projectId);
      if (again) return again;
      throw error;
    }
    return { revision: 1, document };
  }

  /** Caller must already hold the write transaction. */
  static async bootstrapUnlocked(projectId: number): Promise<{ revision: number; document: StoryPlanDocument }> {
    const project = await db.get('SELECT id FROM project WHERE id = ?', projectId);
    if (!project) throw new PlanningError('PROJECT_NOT_FOUND', 404, '项目不存在');
    const chapters = (await db.all(
      'SELECT * FROM chapter WHERE project_id = ? ORDER BY "index" ASC, id ASC',
      projectId
    )) as any[];
    let plan = await loadPlan(projectId);
    if (!plan) {
      const document = emptyStoryPlan();
      await db.run(
        'INSERT INTO story_plan (project_id, revision, document_json) VALUES (?, 1, ?)',
        projectId,
        JSON.stringify(document)
      );
      plan = { revision: 1, document };
    }
    const known = new Set(plan.document.chapters.map((entry) => entry.id));
    let changed = false;
    for (const chapter of chapters) {
      if (chapter.plan_entry_id && known.has(String(chapter.plan_entry_id))) continue;
      const entry: PlannedChapter = {
        id: newPlanEntryId(),
        title: String(chapter.title || '未命名章节').trim().slice(0, 120) || '未命名章节',
        summary: String(chapter.summary || '').slice(0, 3000),
        targetWordCount: clampTarget(chapter.target_word_count),
        disposition: 'active',
      };
      plan.document.chapters.push(entry);
      known.add(entry.id);
      await db.run(
        'UPDATE chapter SET plan_entry_id = ?, target_word_count = COALESCE(target_word_count, ?) WHERE id = ? AND project_id = ?',
        entry.id,
        entry.targetWordCount,
        chapter.id,
        projectId
      );
      chapter.plan_entry_id = entry.id;
      changed = true;
    }
    const ordered = orderPlanEntries(
      plan.document.chapters,
      chapters
        .filter((chapter) => chapter.plan_entry_id)
        .map((chapter) => ({ plan_entry_id: String(chapter.plan_entry_id), index: Number(chapter.index) }))
    );
    if (JSON.stringify(ordered) !== JSON.stringify(plan.document.chapters)) {
      plan.document.chapters = ordered;
      changed = true;
    }
    if (!changed) return plan;
    const revision = await savePlan(projectId, plan.revision, plan.document);
    return { revision, document: plan.document };
  }

  static async bootstrap(projectId: number) {
    const result = await withImmediateTransaction(() => this.bootstrapUnlocked(projectId));
    return this.view(projectId, result.revision, result.document);
  }

  static async getView(projectId: number) {
    const project = await db.get('SELECT id FROM project WHERE id = ?', projectId);
    if (!project) throw new PlanningError('PROJECT_NOT_FOUND', 404, '项目不存在');
    const plan = await loadPlan(projectId);
    if (!plan) throw new PlanningError('PLAN_NOT_FOUND', 404, '还没有章节规划');
    return this.view(projectId, plan.revision, plan.document);
  }

  static async view(projectId: number, revision: number, document: StoryPlanDocument) {
    const chapters = (await db.all(
      'SELECT id, title, "index" AS idx, status, summary, content, plan_entry_id, target_word_count, finalized_content_hash FROM chapter WHERE project_id = ? ORDER BY "index" ASC, id ASC',
      projectId
    )) as any[];
    const byEntry = new Map(chapters.filter((row) => row.plan_entry_id).map((row) => [String(row.plan_entry_id), row]));
    const linkedIds = new Set(byEntry.keys());
    const next = selectNextPlanEntry(document.chapters, linkedIds);
    const budget = planningWordBudget(chapters, document.chapters);
    return {
      project_id: projectId,
      revision,
      document,
      entries: document.chapters.map((entry) => {
        const chapter = byEntry.get(entry.id);
        return {
          ...entry,
          chapter_id: chapter?.id ?? null,
          chapter_status: chapter?.status ?? null,
          chapter_index: chapter ? Number(chapter.idx) : null,
        };
      }),
      budget: {
        written: budget.written,
        reserved: budget.reserved,
        target: document.targetTotalWords,
      },
      next_entry_id: next?.id ?? null,
      auto_create_next_chapter: document.autoCreateNextChapter,
    };
  }

  static async updateDocument(
    projectId: number,
    expectedRevision: number,
    incoming: unknown
  ) {
    return withImmediateTransaction(async () => {
      const plan = await loadPlan(projectId);
      if (!plan) throw new PlanningError('PLAN_NOT_FOUND', 404, '还没有章节规划');
      if (plan.revision !== expectedRevision) {
        throw new PlanningError('PLAN_CONFLICT', 409, '规划已被其他操作更新');
      }
      const document = StoryPlanDocumentSchema.parse(incoming);
      const chapters = (await db.all(
        'SELECT id, status, plan_entry_id, "index" AS idx FROM chapter WHERE project_id = ?',
        projectId
      )) as any[];
      const linked = new Map(chapters.filter((row) => row.plan_entry_id).map((row) => [String(row.plan_entry_id), row]));
      const nextIds = new Set(document.chapters.map((entry) => entry.id));
      for (const [entryId, chapter] of linked) {
        if (!nextIds.has(entryId)) {
          throw new PlanningError('PLAN_ENTRY_REFERENCED', 409, '不能删除已经写过的规划条目');
        }
        const previous = plan.document.chapters.find((entry) => entry.id === entryId);
        const updated = document.chapters.find((entry) => entry.id === entryId);
        if (chapter.status === 'completed' && previous && updated) {
          if (
            previous.title !== updated.title
            || previous.summary !== updated.summary
            || previous.targetWordCount !== updated.targetWordCount
          ) {
            throw new PlanningError('TARGET_FINALIZED', 409, '已定稿章节的规划默认锁定');
          }
        }
      }
      document.chapters = orderPlanEntries(
        document.chapters,
        chapters
          .filter((row) => row.plan_entry_id)
          .map((row) => ({ plan_entry_id: String(row.plan_entry_id), index: Number(row.idx) }))
      );
      for (const entry of document.chapters) {
        const chapter = linked.get(entry.id);
        if (!chapter || chapter.status === 'completed') continue;
        await db.run(
          'UPDATE chapter SET title = ?, summary = ?, target_word_count = ? WHERE id = ? AND project_id = ?',
          entry.title,
          entry.summary,
          entry.targetWordCount,
          chapter.id,
          projectId
        );
      }
      assertPlanningBudget(document, await this.budgetChapters(projectId));
      const revision = await savePlan(projectId, plan.revision, document);
      return this.view(projectId, revision, document);
    });
  }

  static async createManualChapter(input: {
    projectId: number;
    id?: string;
    title: string;
    content?: string | null;
  }) {
    return withImmediateTransaction(async () => {
      const project = await db.get('SELECT id FROM project WHERE id = ?', input.projectId);
      if (!project) throw new PlanningError('PROJECT_NOT_FOUND', 404, 'Project not found');
      await this.assertAppendAllowed(input.projectId);
      await this.bootstrapUnlocked(input.projectId);
      const chapterId = input.id?.trim() || randomUUID();
      const existing = await db.get('SELECT id FROM chapter WHERE id = ?', chapterId);
      if (existing) throw new PlanningError('CHAPTER_ID_CONFLICT', 409, '章节 ID 已存在');
      const actual = (await db.all(
        'SELECT "index" AS idx FROM chapter WHERE project_id = ?',
        input.projectId
      )) as Array<{ idx: number }>;
      const index = actual.length ? Math.max(...actual.map((row) => Number(row.idx))) + 1 : 1;
      const title = input.title.trim().slice(0, 120);
      const entry: PlannedChapter = {
        id: newPlanEntryId(),
        title,
        summary: '',
        targetWordCount: 2000,
        disposition: 'active',
      };
      await db.run(
        `INSERT INTO chapter
          (id, project_id, "index", title, summary, content, status, plan_entry_id, target_word_count)
         VALUES (?, ?, ?, ?, '', ?, 'draft', ?, ?)`,
        chapterId,
        input.projectId,
        index,
        title,
        input.content ?? '',
        entry.id,
        entry.targetWordCount
      );
      const plan = await loadPlan(input.projectId);
      if (!plan) throw new PlanningError('PLAN_NOT_FOUND', 500, '规划初始化失败');
      plan.document.chapters.push(entry);
      plan.document.chapters = orderPlanEntries(plan.document.chapters, await linkedRefs(input.projectId));
      await savePlan(input.projectId, plan.revision, plan.document);
      return db.get('SELECT * FROM chapter WHERE id = ? AND project_id = ?', chapterId, input.projectId);
    });
  }

  static async createNextChapter(request: {
    project_id: number;
    plan_entry_id: string;
    expected_revision: number;
    expected_last_chapter_id: string | null;
    request_key: string;
  }) {
    const requestHash = hashNextChapterRequest(request);
    try {
      return await withImmediateTransaction(() => this.createNextUnlocked(request, requestHash));
    } catch (error) {
      if (error instanceof PlanningError && DETERMINISTIC_NEXT_CONFLICTS.has(error.code)) {
        await this.failPendingReceipt(request.project_id, request.request_key, requestHash, error.code);
      }
      throw error;
    }
  }

  private static async failPendingReceipt(
    projectId: number,
    requestKey: string,
    requestHash: string,
    code: string
  ) {
    await withImmediateTransaction(async () => {
      await db.run(
        `UPDATE story_plan_change
         SET state = 'failed', error_code = ?, updated_at = CURRENT_TIMESTAMP
         WHERE project_id = ? AND request_key = ? AND request_hash = ? AND state = 'pending'`,
        code,
        projectId,
        requestKey,
        requestHash
      );
    });
  }

  private static async createNextUnlocked(
    request: {
      project_id: number;
      plan_entry_id: string;
      expected_revision: number;
      expected_last_chapter_id: string | null;
      request_key: string;
    },
    requestHash: string
  ) {
    const project = await db.get('SELECT id FROM project WHERE id = ?', request.project_id);
    if (!project) throw new PlanningError('PROJECT_NOT_FOUND', 404, '项目不存在');
    const receipt = await db.get(
      'SELECT * FROM story_plan_change WHERE project_id = ? AND request_key = ?',
      request.project_id,
      request.request_key
    ) as ChangeRow | undefined;
    if (receipt) {
      if (receipt.request_hash !== requestHash) {
        throw new PlanningError('REQUEST_KEY_REUSED', 409, '同一请求键对应了不同的创建参数');
      }
      if (receipt.state === 'applied') return JSON.parse(String(receipt.result_json));
      if (receipt.kind !== 'next_chapter' || receipt.state !== 'pending') {
        throw new PlanningError('REQUEST_NOT_FINISHED', 409, '该创建请求已经结束，请使用新的请求键');
      }
    }
    const plan = await loadPlan(request.project_id);
    if (!plan) throw new PlanningError('PLAN_NOT_FOUND', 404, '还没有章节规划');
    const bound = await db.get(
      'SELECT * FROM chapter WHERE project_id = ? AND plan_entry_id = ?',
      request.project_id,
      request.plan_entry_id
    );
    let chapter = bound;
    let nextRevision = plan.revision;
    if (!bound) {
      if (plan.revision !== request.expected_revision) {
        throw new PlanningError('PLAN_CONFLICT', 409, '规划已被其他操作更新');
      }
      const actual = (await db.all(
        'SELECT * FROM chapter WHERE project_id = ? ORDER BY "index" ASC, id ASC',
        request.project_id
      )) as any[];
      const last = actual.at(-1);
      if ((last?.id ?? null) !== request.expected_last_chapter_id) {
        throw new PlanningError('CHAPTER_TAIL_CHANGED', 409, '章节顺序已经变化');
      }
      if (last && !this.isEffectivelyFinalized(last)) {
        throw new PlanningError(
          'PREVIOUS_CHAPTER_NOT_FINALIZED',
          409,
          `上一章（${last.title}）尚未定稿，请先完成「定稿：更新世界观」后再创建新章节`
        );
      }
      const linked = new Set(actual.map((row) => row.plan_entry_id).filter(Boolean));
      const next = selectNextPlanEntry(plan.document.chapters, linked);
      if (!next) throw new PlanningError('NO_PENDING_PLAN', 409, '后续规划已用完');
      if (next.id !== request.plan_entry_id) {
        throw new PlanningError('PLAN_ORDER_CHANGED', 409, '下一章规划已经变化');
      }
      if (!next.summary.trim()) throw new PlanningError('PLAN_INCOMPLETE', 422, '下一条规划还没有章纲');
      const chapterId = randomUUID();
      const index = actual.length ? Math.max(...actual.map((row) => Number(row.index))) + 1 : 1;
      await db.run(
        `INSERT INTO chapter
          (id, project_id, "index", title, summary, target_word_count, plan_entry_id, content, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', 'draft')`,
        chapterId,
        request.project_id,
        index,
        next.title,
        next.summary,
        next.targetWordCount,
        next.id
      );
      nextRevision = await savePlan(request.project_id, plan.revision, plan.document);
      chapter = await db.get(
        'SELECT * FROM chapter WHERE id = ? AND project_id = ?',
        chapterId,
        request.project_id
      );
    }
    if (!chapter) throw new PlanningError('CHAPTER_NOT_FOUND', 500, '章节创建失败');
    const result = { chapter, plan_revision: nextRevision, reused: Boolean(bound) };
    if (receipt) {
      await db.run(
        `UPDATE story_plan_change
         SET state = 'applied', result_json = ?, applied_revision = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ?`,
        JSON.stringify(result),
        nextRevision,
        receipt.id,
        request.project_id
      );
    } else {
      await db.run(
        `INSERT INTO story_plan_change
          (id, project_id, kind, state, request_key, request_hash, request_payload_json,
           base_revision, result_json, applied_revision)
         VALUES (?, ?, 'next_chapter', 'applied', ?, ?, ?, ?, ?, ?)`,
        randomUUID(),
        request.project_id,
        request.request_key,
        requestHash,
        JSON.stringify(request),
        request.expected_revision,
        JSON.stringify(result),
        nextRevision
      );
    }
    return result;
  }

  /** Insert the auto-create receipt inside the finalize transaction. Does not begin a transaction. */
  static async registerAutoNextInOpenTransaction(projectId: number, chapterId: string): Promise<void> {
    const plan = await loadPlan(projectId);
    if (!plan?.document.autoCreateNextChapter) return;
    const chapter = await db.get(
      'SELECT * FROM chapter WHERE id = ? AND project_id = ?',
      chapterId,
      projectId
    );
    if (!chapter || !this.isEffectivelyFinalized(chapter)) return;
    const actual = (await db.all(
      'SELECT id, "index" AS idx FROM chapter WHERE project_id = ? ORDER BY "index" ASC, id ASC',
      projectId
    )) as any[];
    if (actual.at(-1)?.id !== chapterId) return;
    const linked = new Set(
      (await db.all(
        'SELECT plan_entry_id FROM chapter WHERE project_id = ? AND plan_entry_id IS NOT NULL',
        projectId
      ) as any[]).map((row) => String(row.plan_entry_id))
    );
    const next = selectNextPlanEntry(plan.document.chapters, linked);
    if (!next || !next.summary.trim()) return;
    const contentHash = hashChapterContent(chapter.content);
    const requestKey = deterministicUuid(`${projectId}|${chapterId}|${contentHash}`);
    const existing = await db.get(
      'SELECT id, kind, state FROM story_plan_change WHERE project_id = ? AND request_key = ?',
      projectId,
      requestKey
    );
    if (existing?.state === 'applied' || existing?.state === 'pending') return;
    if (existing && existing.kind !== 'next_chapter') {
      throw new PlanningError('REQUEST_KEY_REUSED', 409, '自动下一章请求键已被其他请求使用');
    }
    const payload = {
      project_id: projectId,
      plan_entry_id: next.id,
      expected_revision: plan.revision,
      expected_last_chapter_id: chapterId,
      request_key: requestKey,
    };
    if (existing) {
      // Retain the content-keyed receipt, but retry using the current plan and tail.
      await db.run(
        `UPDATE story_plan_change
         SET state = 'pending', request_hash = ?, request_payload_json = ?, base_revision = ?,
             error_code = NULL, result_json = NULL, applied_revision = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ?`,
        hashNextChapterRequest(payload), JSON.stringify(payload), plan.revision, existing.id, projectId
      );
      return;
    }
    await db.run(
      `INSERT INTO story_plan_change
        (id, project_id, kind, state, request_key, request_hash, request_payload_json, base_revision)
       VALUES (?, ?, 'next_chapter', 'pending', ?, ?, ?, ?)`,
      randomUUID(),
      projectId,
      requestKey,
      hashNextChapterRequest(payload),
      JSON.stringify(payload),
      plan.revision
    );
  }

  static async consumePendingAutoNext(projectId: number, chapterId: string) {
    const chapter = await db.get(
      'SELECT content, finalized_content_hash, status FROM chapter WHERE id = ? AND project_id = ?',
      chapterId,
      projectId
    );
    if (!chapter) return null;
    const requestKey = deterministicUuid(
      `${projectId}|${chapterId}|${hashChapterContent(chapter.content)}`
    );
    const receipt = await db.get(
      'SELECT * FROM story_plan_change WHERE project_id = ? AND request_key = ?',
      projectId,
      requestKey
    ) as ChangeRow | undefined;
    if (!receipt || receipt.state === 'applied') return null;
    if (receipt.state !== 'pending' || !receipt.request_payload_json) {
      return {
        status: 'failed' as const,
        code: receipt.error_code || 'REQUEST_NOT_FINISHED',
        message: '自动创建下一章的请求已失效，请再次定稿或手动创建下一章',
      };
    }
    const payload = JSON.parse(String(receipt.request_payload_json));
    try {
      const result = await this.createNextChapter(payload);
      return { status: 'created' as const, result };
    } catch (error: any) {
      return {
        status: 'failed' as const,
        code: error?.code || 'NEXT_CHAPTER_FAILED',
        message: error?.message || String(error),
      };
    }
  }

  static async retireLinkedChapter(projectId: number, chapterId: string): Promise<void> {
    const chapter = await db.get(
      'SELECT plan_entry_id FROM chapter WHERE id = ? AND project_id = ?',
      chapterId,
      projectId
    );
    if (!chapter?.plan_entry_id) return;
    const plan = await loadPlan(projectId);
    if (!plan) return;
    plan.document.chapters = plan.document.chapters.map((entry) => (
      entry.id === chapter.plan_entry_id ? { ...entry, disposition: 'retired' as const } : entry
    ));
    plan.document.chapters = orderPlanEntries(plan.document.chapters, await linkedRefs(projectId, chapterId));
    await savePlan(projectId, plan.revision, plan.document);
  }

  static async reorderFromChapters(projectId: number): Promise<void> {
    const plan = await loadPlan(projectId);
    if (!plan) return;
    const ordered = orderPlanEntries(plan.document.chapters, await linkedRefs(projectId));
    if (JSON.stringify(ordered) === JSON.stringify(plan.document.chapters)) return;
    plan.document.chapters = ordered;
    await savePlan(projectId, plan.revision, plan.document);
  }

  static async syncLinkedOutline(projectId: number, chapterId: string): Promise<void> {
    await withImmediateTransaction(() => this.syncLinkedOutlineUnlocked(projectId, chapterId));
  }

  static async syncLinkedOutlineUnlocked(projectId: number, chapterId: string): Promise<void> {
    const chapter = await db.get(
      'SELECT * FROM chapter WHERE id = ? AND project_id = ?',
      chapterId,
      projectId
    );
    if (!chapter?.plan_entry_id) return;
    const plan = await loadPlan(projectId);
    if (!plan) return;
    const entry = plan.document.chapters.find((item) => item.id === chapter.plan_entry_id);
    if (!entry || entry.disposition === 'retired') return;
    const title = String(chapter.title || '').trim().slice(0, 120) || entry.title;
    const summary = String(chapter.summary || '').slice(0, 3000);
    const target = clampTarget(chapter.target_word_count, entry.targetWordCount);
    if (entry.title === title && entry.summary === summary && entry.targetWordCount === target) return;
    entry.title = title;
    entry.summary = summary;
    entry.targetWordCount = target;
    await savePlan(projectId, plan.revision, plan.document);
  }

  static async updateLinkedChapterFields(
    projectId: number,
    chapterId: string,
    fields: { title?: string; summary?: string }
  ) {
    return withImmediateTransaction(async () => {
      const chapter = await db.get(
        'SELECT id FROM chapter WHERE id = ? AND project_id = ?',
        chapterId,
        projectId
      );
      if (!chapter) throw new PlanningError('CHAPTER_NOT_FOUND', 404, '章节不存在');
      if (fields.title !== undefined) {
        await db.run('UPDATE chapter SET title = ? WHERE id = ? AND project_id = ?', fields.title, chapterId, projectId);
      }
      if (fields.summary !== undefined) {
        await db.run('UPDATE chapter SET summary = ? WHERE id = ? AND project_id = ?', fields.summary, chapterId, projectId);
      }
      await this.syncLinkedOutlineUnlocked(projectId, chapterId);
      return db.get('SELECT * FROM chapter WHERE id = ? AND project_id = ?', chapterId, projectId);
    });
  }

  static async beginGeneration(input: {
    projectId: number;
    kind: 'blueprint' | 'chapters';
    requestKey: string;
    requestHash: string;
    expectedRevision: number;
    payload: unknown;
  }) {
    return withImmediateTransaction(async () => {
      const project = await db.get('SELECT id FROM project WHERE id = ?', input.projectId);
      if (!project) throw new PlanningError('PROJECT_NOT_FOUND', 404, '项目不存在');
      await this.ensurePlan(input.projectId);
      const plan = await loadPlan(input.projectId);
      if (!plan) throw new PlanningError('PLAN_NOT_FOUND', 500, '规划初始化失败');
      const existing = await db.get(
        'SELECT * FROM story_plan_change WHERE project_id = ? AND request_key = ?',
        input.projectId,
        input.requestKey
      ) as ChangeRow | undefined;
      if (existing) {
        if (existing.request_hash !== input.requestHash) {
          throw new PlanningError('REQUEST_KEY_REUSED', 409, '同一请求键对应了不同的生成参数');
        }
        if (existing.state === 'failed' || existing.state === 'rejected') {
          throw new PlanningError(existing.error_code || 'REQUEST_NOT_FINISHED', 409,
            '该规划请求已失败或被拒绝，请使用新的请求键重新生成');
        }
        return { ...existing, created: false };
      }
      if (plan.revision !== input.expectedRevision) {
        throw new PlanningError('PLAN_CONFLICT', 409, '规划已被其他操作更新');
      }
      const id = randomUUID();
      const snapshot = await this.captureSource(input.projectId, plan.revision, []);
      await db.run(
        `INSERT INTO story_plan_change
          (id, project_id, kind, state, request_key, request_hash, request_payload_json,
           base_revision, source_snapshot_json)
         VALUES (?, ?, ?, 'generating', ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.kind,
        input.requestKey,
        input.requestHash,
        JSON.stringify(input.payload),
        plan.revision,
        JSON.stringify(snapshot)
      );
      const row = await db.get('SELECT * FROM story_plan_change WHERE id = ?', id);
      return { ...row, created: true };
    });
  }

  static async finishGeneration(input: {
    projectId: number;
    changeId: string;
    after: StoryPlanDocument;
    patches: PlanPatch[];
    targetPlanIds: string[];
  }) {
    return withImmediateTransaction(async () => {
      const change = await this.requireChange(input.projectId, input.changeId);
      if (change.state === 'pending' || change.state === 'stale' || change.state === 'failed') return change;
      if (change.state !== 'generating') {
        throw new PlanningError('REQUEST_NOT_FINISHED', 409, '该生成请求已经结束');
      }
      const plan = await loadPlan(input.projectId);
      if (!plan) throw new PlanningError('PLAN_NOT_FOUND', 404, '还没有章节规划');
      const snapshot = await this.captureSource(input.projectId, plan.revision, input.targetPlanIds);
      const previous = change.source_snapshot_json ? JSON.parse(String(change.source_snapshot_json)) : null;
      const sourceChanged = !previous
        || previous.planRevision !== plan.revision
        || hashCanonical(previous.fingerprint) !== hashCanonical(snapshot.fingerprint);
      const state = sourceChanged ? 'stale' : 'pending';
      await db.run(
        `UPDATE story_plan_change
         SET state = ?, before_json = ?, after_json = ?, patches_json = ?, source_snapshot_json = ?,
             error_code = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ?`,
        state,
        JSON.stringify(plan.document),
        JSON.stringify(input.after),
        JSON.stringify(input.patches),
        JSON.stringify(snapshot),
        sourceChanged ? 'SOURCE_CHANGED' : null,
        input.changeId,
        input.projectId
      );
      return this.presentChange(await this.requireChange(input.projectId, input.changeId));
    });
  }

  static async failGeneration(projectId: number, changeId: string, code: string, message: string) {
    await db.run(
      `UPDATE story_plan_change
       SET state = 'failed', error_code = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND project_id = ? AND state = 'generating'`,
      code,
      JSON.stringify({ message }),
      changeId,
      projectId
    );
    const row = await db.get(
      'SELECT * FROM story_plan_change WHERE id = ? AND project_id = ?',
      changeId,
      projectId
    );
    return row ? this.presentChange(row) : null;
  }

  static async listCandidates(projectId: number, requestKey?: string) {
    const rows = requestKey
      ? await db.all(
          'SELECT * FROM story_plan_change WHERE project_id = ? AND request_key = ? ORDER BY created_at DESC',
          projectId,
          requestKey
        )
      : await db.all(
          `SELECT * FROM story_plan_change
           WHERE project_id = ? AND state IN ('generating', 'pending', 'failed', 'stale')
           ORDER BY created_at DESC LIMIT 20`,
          projectId
        );
    return (rows as any[]).map((row) => this.presentChange(row));
  }

  static async editCandidate(
    projectId: number,
    changeId: string,
    expectedCandidateRevision: number,
    after: unknown
  ) {
    return withImmediateTransaction(async () => {
      const change = await this.requireChange(projectId, changeId);
      if (change.state !== 'pending') {
        throw new PlanningError('REQUEST_NOT_FINISHED', 409, '只有待采纳候选可以编辑');
      }
      if (Number(change.candidate_revision) !== expectedCandidateRevision) {
        throw new PlanningError('CANDIDATE_CONFLICT', 409, '候选已被其他操作更新');
      }
      const document = StoryPlanDocumentSchema.parse(after);
      if (this.locksExistingPlanEntries(change)) {
        const plan = await loadPlan(projectId);
        const baseline = plan ? plan.document.chapters : this.chaptersFromBefore(change);
        this.assertExistingEntriesIntact(baseline, document.chapters);
      }
      const patches = this.refreshPatchText(this.parsePatches(change.patches_json), document);
      const updated = await db.run(
        `UPDATE story_plan_change
         SET after_json = ?, patches_json = ?, candidate_revision = candidate_revision + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ? AND state = 'pending' AND candidate_revision = ?`,
        JSON.stringify(document),
        JSON.stringify(patches),
        changeId,
        projectId,
        expectedCandidateRevision
      );
      if (Number(updated?.changes) !== 1) {
        throw new PlanningError('CANDIDATE_CONFLICT', 409, '候选已被其他操作更新');
      }
      return this.presentChange(await this.requireChange(projectId, changeId));
    });
  }

  static async rejectCandidate(projectId: number, changeId: string) {
    const updated = await db.run(
      `UPDATE story_plan_change
       SET state = 'rejected', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND project_id = ? AND state IN ('pending', 'stale', 'failed')`,
      changeId,
      projectId
    );
    if (Number(updated?.changes) !== 1) {
      throw new PlanningError('REQUEST_NOT_FINISHED', 409, '该候选不能拒绝');
    }
    return this.presentChange(await this.requireChange(projectId, changeId));
  }

  static async applyCandidate(
    projectId: number,
    changeId: string,
    request: {
      expected_revision: number;
      expected_candidate_revision: number;
      selected_patch_ids: string[];
    }
  ) {
    return withImmediateTransaction(async () => {
      const change = await this.requireChange(projectId, changeId);
      const applyHash = hashApplySelection(
        changeId,
        request.expected_revision,
        request.expected_candidate_revision,
        request.selected_patch_ids
      );
      if (change.state === 'applied') {
        if (change.apply_payload_hash !== applyHash) {
          throw new PlanningError('APPLY_SELECTION_CHANGED', 409, '已采纳的选择不能改成另一组字段');
        }
        return JSON.parse(String(change.result_json));
      }
      if (change.state !== 'pending') {
        throw new PlanningError('REQUEST_NOT_FINISHED', 409, '该候选不能采纳');
      }
      const selected = [...new Set(request.selected_patch_ids)];
      if (!selected.length) throw new PlanningError('EMPTY_SELECTION', 422, '请至少选择一项再采纳');
      const plan = await loadPlan(projectId);
      if (!plan) throw new PlanningError('PLAN_NOT_FOUND', 404, '还没有章节规划');
      if (plan.revision !== request.expected_revision || Number(change.base_revision) !== plan.revision) {
        throw new PlanningError('PLAN_CONFLICT', 409, '规划已被其他操作更新');
      }
      if (Number(change.candidate_revision) !== request.expected_candidate_revision) {
        throw new PlanningError('CANDIDATE_CONFLICT', 409, '候选已被编辑，请查看最新差异');
      }
      await this.assertSourceUnchanged(projectId, change.source_snapshot_json);
      const after = StoryPlanDocumentSchema.parse(JSON.parse(String(change.after_json)));
      const patches = this.parsePatches(change.patches_json);
      const known = new Set(patches.map((patch) => patch.id));
      if (selected.some((id) => !known.has(id))) {
        throw new PlanningError('UNKNOWN_PATCH', 422, '选择了候选中不存在的差异');
      }
      const payload = change.request_payload_json ? JSON.parse(String(change.request_payload_json)) : {};
      const document = await this.applySelected(projectId, plan.document, after, patches, selected, payload);
      assertPlanningBudget(document, await this.budgetChapters(projectId));
      const revision = await savePlan(projectId, plan.revision, document);
      const result = {
        plan_revision: revision,
        candidate_id: changeId,
        affected_entities: this.affectedEntities(patches, selected),
        view: await this.view(projectId, revision, document),
      };
      await db.run(
        `UPDATE story_plan_change
         SET state = 'applied', apply_payload_hash = ?, result_json = ?, applied_revision = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ?`,
        applyHash,
        JSON.stringify(result),
        revision,
        changeId,
        projectId
      );
      return result;
    });
  }

  static async captureSource(projectId: number, planRevision: number, targetPlanIds: string[]) {
    const chapters = (await db.all(
      'SELECT id, content, summary, status FROM chapter WHERE project_id = ? ORDER BY "index" ASC, id ASC',
      projectId
    )) as any[];
    const project = await db.get('SELECT title, description, settings FROM project WHERE id = ?', projectId);
    const characters = (await db.all(
      'SELECT id, name, role, description FROM character WHERE project_id = ? ORDER BY id ASC',
      projectId
    )) as any[];
    const glossary = (await db.all(
      'SELECT id, term, definition FROM glossary WHERE project_id = ? ORDER BY id ASC',
      projectId
    )) as any[];
    const fingerprint = {
      chapters: chapters.map((chapter) => ({
        id: chapter.id,
        contentHash: hashChapterContent(chapter.content),
        summary: chapter.summary || '',
        status: chapter.status || 'draft',
      })),
      projectTitle: String(project?.title || ''),
      projectDescription: String(project?.description || ''),
      settingsHash: hashCanonical(parseProjectSettings(project?.settings)),
      characters: characters.map((character) => ({
        id: character.id,
        name: character.name,
        role: character.role || '',
        descriptionHash: hashText(String(character.description || '')),
      })),
      glossary: glossary.map((item) => ({
        id: item.id,
        term: item.term,
        definitionHash: hashText(String(item.definition || '')),
      })),
    };
    return { planRevision, targetPlanIds, fingerprint };
  }

  private static payloadOf(change: ChangeRow): Record<string, any> {
    if (!change.request_payload_json) return {};
    try {
      const parsed = JSON.parse(String(change.request_payload_json));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Initial and extend batches may add entries. They may not rewrite or drop ones already in the plan. */
  private static locksExistingPlanEntries(change: ChangeRow): boolean {
    const payload = this.payloadOf(change);
    if (payload.mode === 'revise') return false;
    if (payload.mode === 'initial' || payload.mode === 'extend') return true;
    return this.parsePatches(change.patches_json).some((patch) => patch.id === 'chapters_batch');
  }

  private static chaptersFromBefore(change: ChangeRow): PlannedChapter[] {
    if (!change.before_json) return [];
    try {
      return StoryPlanDocumentSchema.parse(JSON.parse(String(change.before_json))).chapters;
    } catch {
      return [];
    }
  }

  private static planEntryIdentity(entry: PlannedChapter): string {
    return JSON.stringify({
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      targetWordCount: entry.targetWordCount,
      disposition: entry.disposition,
    });
  }

  private static assertExistingEntriesIntact(existing: PlannedChapter[], proposed: PlannedChapter[]) {
    const byId = new Map(proposed.map((entry) => [entry.id, entry]));
    for (const entry of existing) {
      const next = byId.get(entry.id);
      if (!next || this.planEntryIdentity(next) !== this.planEntryIdentity(entry)) {
        throw new PlanningError('PLAN_ENTRY_REFERENCED', 409, '已有规划条目不能在这批候选里修改或删除');
      }
    }
  }

  /** Copy an adopted outline onto the linked draft. Leave the body, and leave a finalized chapter alone. */
  private static async syncLinkedDraftFromPlan(projectId: number, entry: PlannedChapter) {
    const chapter = await db.get(
      'SELECT id, status FROM chapter WHERE project_id = ? AND plan_entry_id = ?',
      projectId,
      entry.id
    );
    if (!chapter) return;
    if (chapter.status === 'completed') {
      throw new PlanningError('TARGET_FINALIZED', 409, '已定稿章节的规划默认锁定');
    }
    await db.run(
      `UPDATE chapter
       SET title = ?, summary = ?, target_word_count = ?
       WHERE id = ? AND project_id = ?`,
      entry.title,
      entry.summary,
      entry.targetWordCount,
      chapter.id,
      projectId
    );
  }

  private static async assertSourceUnchanged(projectId: number, snapshotJson: string | null) {
    if (!snapshotJson) throw new PlanningError('SOURCE_CHANGED', 409, '候选缺少来源快照');
    const saved = JSON.parse(snapshotJson);
    const plan = await loadPlan(projectId);
    const current = await this.captureSource(projectId, plan?.revision ?? 0, saved.targetPlanIds || []);
    if (saved.planRevision !== current.planRevision || hashCanonical(saved.fingerprint) !== hashCanonical(current.fingerprint)) {
      throw new PlanningError('SOURCE_CHANGED', 409, '正文、设定或规划已变化，请基于新来源重新生成');
    }
  }

  private static async applySelected(
    projectId: number,
    current: StoryPlanDocument,
    after: StoryPlanDocument,
    patches: PlanPatch[],
    selected: string[],
    payload: any
  ): Promise<StoryPlanDocument> {
    const chosen = new Set(selected);
    const mode = payload?.mode as string | undefined;
    if (payload?.kind === 'chapters' || patches.some((patch) => patch.id === 'chapters_batch' || patch.id.startsWith('chapter:'))) {
      if (mode === 'revise') {
        const document: StoryPlanDocument = {
          ...current,
          chapters: current.chapters.map((entry) => ({ ...entry })),
        };
        for (const patch of patches) {
          if (!chosen.has(patch.id) || !patch.id.startsWith('chapter:')) continue;
          const entryId = patch.id.slice('chapter:'.length);
          const replacement = after.chapters.find((entry) => entry.id === entryId);
          const index = document.chapters.findIndex((entry) => entry.id === entryId);
          if (!replacement || index < 0) {
            throw new PlanningError('TARGET_SET_MISMATCH', 422, '修订目标不在当前规划中');
          }
          document.chapters[index] = { ...document.chapters[index]!, ...replacement, id: entryId };
          await this.syncLinkedDraftFromPlan(projectId, document.chapters[index]!);
        }
        return document;
      }
      if (!chosen.has('chapters_batch')) {
        throw new PlanningError('EMPTY_SELECTION', 422, '请采纳这批章节规划');
      }
      this.assertExistingEntriesIntact(current.chapters, after.chapters);
      const existingIds = new Set(current.chapters.map((entry) => entry.id));
      const seen = new Set<string>();
      const created = after.chapters.filter((entry) => {
        if (existingIds.has(entry.id) || seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      });
      return {
        ...current,
        chapters: orderPlanEntries(
          [...current.chapters.map((entry) => ({ ...entry })), ...created],
          await linkedRefs(projectId)
        ),
        endingPolicy: after.endingPolicy,
      };
    }
    const document: StoryPlanDocument = { ...current, chapters: current.chapters.map((entry) => ({ ...entry })) };
    if (chosen.has('blueprint') && after.blueprint) document.blueprint = after.blueprint;
    await this.applyProjectPatches(projectId, after.blueprint, patches, chosen);
    return document;
  }

  private static async applyProjectPatches(
    projectId: number,
    blueprint: StoryBlueprint | null,
    patches: PlanPatch[],
    chosen: Set<string>
  ) {
    if (!blueprint) return;
    const project = await db.get('SELECT title, description, settings FROM project WHERE id = ?', projectId);
    if (!project) throw new PlanningError('PROJECT_NOT_FOUND', 404, '项目不存在');
    const settings = parseProjectSettings(project.settings);
    let title = project.title as string;
    let description = project.description as string | null;
    const take = (id: string) => patches.some((patch) => patch.id === id && chosen.has(id));
    if (take('project.title')) title = blueprint.title;
    if (take('project.description')) description = blueprint.summary;
    if (take('project.genre')) settings.genre = blueprint.genre;
    if (take('project.style')) settings.style = blueprint.style;
    if (take('initial_relations')) {
      settings.initial_relations = blueprint.initialRelations;
    }
    if (take('blueprint')) {
      settings.plot_direction = blueprint.mainPlot;
      settings.planned_relations = blueprint.plannedRelations;
    }
    await db.run(
      'UPDATE project SET title = ?, description = ?, settings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      title,
      description,
      serializeProjectSettings(settings),
      projectId
    );
    for (const character of blueprint.characters) {
      const patchId = `character:${encodeURIComponent(character.name)}`;
      if (!chosen.has(patchId)) continue;
      const existing = await db.get(
        'SELECT id, description FROM character WHERE project_id = ? AND name = ? ORDER BY id ASC',
        projectId,
        character.name
      );
      if (existing) {
        await db.run(
          'UPDATE character SET role = ?, description = ?, personality = ?, growth_path = ? WHERE id = ?',
          character.role,
          character.description,
          character.personality,
          character.growthPath,
          existing.id
        );
      } else {
        await db.run(
          'INSERT INTO character (project_id, name, role, description, visual_tags, personality, growth_path) VALUES (?, ?, ?, ?, ?, ?, ?)',
          projectId,
          character.name,
          character.role,
          character.description,
          '{}',
          character.personality,
          character.growthPath
        );
      }
    }
    for (const item of blueprint.glossary) {
      const patchId = `glossary:${encodeURIComponent(item.term)}`;
      if (!chosen.has(patchId)) continue;
      const existing = await db.get(
        'SELECT id FROM glossary WHERE project_id = ? AND term = ? ORDER BY id ASC',
        projectId,
        item.term
      );
      if (existing) {
        await db.run(
          'UPDATE glossary SET definition = ?, category = ? WHERE id = ?',
          item.definition,
          item.category,
          existing.id
        );
      } else {
        await db.run(
          'INSERT INTO glossary (project_id, term, definition, category) VALUES (?, ?, ?, ?)',
          projectId,
          item.term,
          item.definition,
          item.category
        );
      }
    }
  }

  static buildBlueprintPatches(current: {
    title?: string | null;
    description?: string | null;
    genre?: string | null;
    style?: string | null;
    initialRelations?: string | null;
  }, blueprint: StoryBlueprint): PlanPatch[] {
    const patches: PlanPatch[] = [
      {
        id: 'blueprint',
        entity: 'plan',
        label: '故事发展方向',
        before: null,
        after: blueprint.mainPlot || blueprint.summary,
      },
      { id: 'project.title', entity: 'project', label: '书名', before: current.title || null, after: blueprint.title },
      { id: 'project.description', entity: 'project', label: '故事简介', before: current.description || null, after: blueprint.summary },
      { id: 'project.genre', entity: 'project', label: '类型', before: current.genre || null, after: blueprint.genre },
      { id: 'project.style', entity: 'project', label: '文风', before: current.style || null, after: blueprint.style },
      {
        id: 'initial_relations',
        entity: 'initial_relations',
        label: '已确认的初始关系',
        before: current.initialRelations || null,
        after: blueprint.initialRelations,
      },
    ];
    for (const character of blueprint.characters) {
      patches.push({
        id: `character:${encodeURIComponent(character.name)}`,
        entity: 'character',
        label: character.name,
        before: null,
        after: [character.role, character.description, character.personality].filter(Boolean).join('\n'),
      });
    }
    for (const item of blueprint.glossary) {
      patches.push({
        id: `glossary:${encodeURIComponent(item.term)}`,
        entity: 'glossary',
        label: item.term,
        before: null,
        after: item.definition,
      });
    }
    return patches;
  }

  static buildChapterPatches(
    mode: 'initial' | 'revise' | 'extend',
    before: PlannedChapter[],
    after: PlannedChapter[],
    targetIds: string[]
  ): PlanPatch[] {
    if (mode === 'revise') {
      return targetIds.map((id) => {
        const previous = before.find((entry) => entry.id === id);
        const next = after.find((entry) => entry.id === id);
        return {
          id: `chapter:${id}`,
          entity: 'plan' as const,
          label: next?.title || previous?.title || id,
          before: previous?.summary || null,
          after: next?.summary || null,
        };
      });
    }
    const added = after.filter((entry) => !before.some((item) => item.id === entry.id));
    return [{
      id: 'chapters_batch',
      entity: 'plan',
      label: mode === 'initial' ? '首批章节规划' : '追加章节规划',
      before: null,
      after: added.map((entry) => entry.title).join('、'),
    }];
  }

  private static refreshPatchText(patches: PlanPatch[], document: StoryPlanDocument): PlanPatch[] {
    return patches.map((patch) => {
      if (patch.id === 'blueprint') {
        return { ...patch, after: document.blueprint?.mainPlot || document.blueprint?.summary || patch.after };
      }
      if (patch.id === 'project.title') return { ...patch, after: document.blueprint?.title || patch.after };
      if (patch.id === 'project.description') return { ...patch, after: document.blueprint?.summary || patch.after };
      if (patch.id.startsWith('chapter:')) {
        const entry = document.chapters.find((item) => item.id === patch.id.slice('chapter:'.length));
        return entry ? { ...patch, after: entry.summary, label: entry.title } : patch;
      }
      return patch;
    });
  }

  private static affectedEntities(patches: PlanPatch[], selected: string[]) {
    const chosen = new Set(selected);
    const entities = new Set<string>();
    for (const patch of patches) {
      if (!chosen.has(patch.id)) continue;
      if (patch.entity === 'plan') entities.add('plan');
      if (patch.entity === 'project' || patch.entity === 'initial_relations') entities.add('project');
      if (patch.entity === 'character') entities.add('characters');
      if (patch.entity === 'glossary') entities.add('glossary');
    }
    if (patches.some((patch) => chosen.has(patch.id) && patch.id === 'chapters_batch')) entities.add('chapters');
    return [...entities];
  }

  private static parsePatches(raw: string | null): PlanPatch[] {
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }

  private static presentChange(row: ChangeRow) {
    const parseJson = (value: string | null) => {
      if (!value) return null;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    };
    return {
      id: row.id,
      project_id: row.project_id,
      kind: row.kind,
      state: row.state,
      request_key: row.request_key,
      base_revision: row.base_revision,
      candidate_revision: row.candidate_revision,
      before: parseJson(row.before_json),
      after: parseJson(row.after_json),
      patches: parseJson(row.patches_json) || [],
      error_code: row.error_code || undefined,
      result: parseJson(row.result_json),
      request: parseJson(row.request_payload_json),
    };
  }

  private static async requireChange(projectId: number, changeId: string): Promise<ChangeRow> {
    const row = await db.get(
      'SELECT * FROM story_plan_change WHERE id = ? AND project_id = ?',
      changeId,
      projectId
    );
    if (!row) throw new PlanningError('CANDIDATE_NOT_FOUND', 404, '找不到该候选');
    return row;
  }

  private static async budgetChapters(projectId: number) {
    return db.all(
      'SELECT content, status, plan_entry_id, target_word_count FROM chapter WHERE project_id = ?',
      projectId
    ) as Promise<any[]>;
  }

  private static isEffectivelyFinalized(chapter: any): boolean {
    return chapter.status === 'completed'
      && chapter.finalized_content_hash === hashChapterContent(chapter.content);
  }

  private static async assertAppendAllowed(projectId: number) {
    const actual = (await db.all(
      'SELECT * FROM chapter WHERE project_id = ? ORDER BY "index" ASC, id ASC',
      projectId
    )) as any[];
    const last = actual.at(-1);
    if (!last) return;
    if (!this.isEffectivelyFinalized(last)) {
      throw new PlanningError(
        'PREVIOUS_CHAPTER_NOT_FINALIZED',
        409,
        unfinalizedChapterMessage(last)
      );
    }
  }

  static autoRequestKey(projectId: number, chapterId: string, content: string | null | undefined) {
    return deterministicUuid(`${projectId}|${chapterId}|${hashChapterContent(content)}`);
  }
}

export { CHAPTER_CONTENT_UNFINALIZE_SQL };
