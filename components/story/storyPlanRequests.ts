export type PlanHistoryTurn = { role?: string; content?: string };

export type StoredGenerateRequest = {
  request_key: string;
  expected_revision: number;
  kind: 'blueprint' | 'chapters';
  mode?: 'initial' | 'extend' | 'revise';
  message: string;
  history?: PlanHistoryTurn[];
  target_plan_ids?: string[];
  batch_size?: number;
};

export type ReviewChapter = {
  id: string;
  title: string;
  summary: string;
  targetWordCount: number;
};

/** Chapters the author still needs to read before adopting a batch or revise candidate. */
export function chaptersAwaitingReview(candidate: {
  patches?: Array<{ id: string }>;
  before?: { chapters?: ReviewChapter[] } | null;
  after?: { chapters?: ReviewChapter[] } | null;
}): ReviewChapter[] {
  const after = candidate.after?.chapters || [];
  const patchIds = new Set(
    (candidate.patches || [])
      .map((patch) => (patch.id.startsWith('chapter:') ? patch.id.slice('chapter:'.length) : ''))
      .filter(Boolean)
  );
  if (patchIds.size) return after.filter((chapter) => patchIds.has(chapter.id));
  const beforeIds = new Set((candidate.before?.chapters || []).map((chapter) => chapter.id));
  if (beforeIds.size) return after.filter((chapter) => !beforeIds.has(chapter.id));
  return (candidate.patches || []).some((patch) => patch.id === 'chapters_batch') ? after : [];
}

export type StoredNextChapterRequest = {
  plan_entry_id: string;
  expected_revision: number;
  expected_last_chapter_id: string | null;
  request_key: string;
};

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class SavedRequestError extends Error {
  code: 'INVALID_SAVED_GENERATE_REQUEST' | 'INVALID_SAVED_NEXT_REQUEST' | 'STORAGE_UNAVAILABLE';

  constructor(code: SavedRequestError['code']) {
    super(code);
    this.name = 'SavedRequestError';
    this.code = code;
  }
}

export const generateStorageKey = (projectId: string) => `novastory_plan_generate_${projectId}`;

export const nextChapterStorageKey = (projectId: string, planEntryId: string) =>
  `novastory_next_chapter_${projectId}_${planEntryId}`;

/** Conflicts where the saved key is dead and one new key may be confirmed. */
export const FRESH_KEY_CONFLICTS = new Set([
  'PLAN_CONFLICT',
  'REQUEST_KEY_REUSED',
  'CHAPTER_TAIL_CHANGED',
  'PLAN_ORDER_CHANGED',
  'REQUEST_NOT_FINISHED',
]);

function readJson(raw: string, code: SavedRequestError['code']): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new SavedRequestError(code);
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

const IDEATION_HISTORY_BUDGET = 4500;

function parseHistory(value: unknown): PlanHistoryTurn[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new SavedRequestError('INVALID_SAVED_GENERATE_REQUEST');
  const turns: PlanHistoryTurn[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new SavedRequestError('INVALID_SAVED_GENERATE_REQUEST');
    }
    const row = item as Record<string, unknown>;
    if (row.role !== undefined && typeof row.role !== 'string') {
      throw new SavedRequestError('INVALID_SAVED_GENERATE_REQUEST');
    }
    if (row.content !== undefined && typeof row.content !== 'string') {
      throw new SavedRequestError('INVALID_SAVED_GENERATE_REQUEST');
    }
    const turn: PlanHistoryTurn = {};
    if (typeof row.role === 'string') turn.role = row.role;
    if (typeof row.content === 'string') turn.content = row.content;
    turns.push(turn);
  }
  return turns;
}

/** Ideation turns from the agent transcript, newest-last, within the planning history budget. */
export function readIdeationHistory(raw: string | null): PlanHistoryTurn[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const turns: Array<{ role: string; content: string }> = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (row.mode !== 'ideation') continue;
    if (typeof row.content !== 'string') continue;
    const content = row.content.trim();
    if (!content) continue;
    turns.push({
      role: row.role === 'agent' || row.role === 'assistant' ? 'assistant' : 'user',
      content,
    });
  }
  const recent = turns.slice(-12);
  const kept: Array<{ role: string; content: string }> = [];
  let used = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const turn = recent[index];
    if (!turn) continue;
    if (kept.length > 0 && used + turn.content.length > IDEATION_HISTORY_BUDGET) break;
    kept.push(turn);
    used += turn.content.length;
  }
  return kept.reverse();
}

export function parseGenerateRequest(raw: string | null): StoredGenerateRequest | null {
  if (!raw) return null;
  const parsed = readJson(raw, 'INVALID_SAVED_GENERATE_REQUEST');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SavedRequestError('INVALID_SAVED_GENERATE_REQUEST');
  }
  const row = parsed as Record<string, unknown>;
  const requestKey = row.request_key;
  const expectedRevision = row.expected_revision;
  const kind = row.kind;
  const mode = row.mode;
  const message = row.message;
  const targetPlanIds = row.target_plan_ids;
  const batchSize = row.batch_size;
  const history = parseHistory(row.history);
  const resolvedMode = mode === 'initial' || mode === 'extend' || mode === 'revise' ? mode : undefined;
  const resolvedTargets = Array.isArray(targetPlanIds)
    ? targetPlanIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : undefined;
  const resolvedBatch = typeof batchSize === 'number' && Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 5
    ? batchSize
    : undefined;
  if (typeof requestKey !== 'string' || requestKey.length < 1 || requestKey.length > 200) {
    throw new SavedRequestError('INVALID_SAVED_GENERATE_REQUEST');
  }
  if (!isPositiveInt(expectedRevision)) throw new SavedRequestError('INVALID_SAVED_GENERATE_REQUEST');
  if (kind !== 'blueprint' && kind !== 'chapters') throw new SavedRequestError('INVALID_SAVED_GENERATE_REQUEST');
  if (typeof message !== 'string') throw new SavedRequestError('INVALID_SAVED_GENERATE_REQUEST');
  if (mode !== undefined && !resolvedMode) throw new SavedRequestError('INVALID_SAVED_GENERATE_REQUEST');
  if (targetPlanIds !== undefined && (!Array.isArray(targetPlanIds) || !resolvedTargets || resolvedTargets.length !== targetPlanIds.length)) {
    throw new SavedRequestError('INVALID_SAVED_GENERATE_REQUEST');
  }
  if (batchSize !== undefined && resolvedBatch === undefined) {
    throw new SavedRequestError('INVALID_SAVED_GENERATE_REQUEST');
  }
  return {
    request_key: requestKey,
    expected_revision: expectedRevision,
    kind,
    mode: resolvedMode,
    message,
    history,
    target_plan_ids: resolvedTargets,
    batch_size: resolvedBatch,
  };
}

export function parseNextChapterRequest(raw: string | null): StoredNextChapterRequest | null {
  if (!raw) return null;
  const parsed = readJson(raw, 'INVALID_SAVED_NEXT_REQUEST');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SavedRequestError('INVALID_SAVED_NEXT_REQUEST');
  }
  const row = parsed as Record<string, unknown>;
  const planEntryId = row.plan_entry_id;
  const requestKey = row.request_key;
  const expectedRevision = row.expected_revision;
  const lastChapterId = row.expected_last_chapter_id;
  if (typeof planEntryId !== 'string' || planEntryId.length < 1) {
    throw new SavedRequestError('INVALID_SAVED_NEXT_REQUEST');
  }
  if (typeof requestKey !== 'string' || requestKey.length < 1 || requestKey.length > 200) {
    throw new SavedRequestError('INVALID_SAVED_NEXT_REQUEST');
  }
  if (!isPositiveInt(expectedRevision)) {
    throw new SavedRequestError('INVALID_SAVED_NEXT_REQUEST');
  }
  if (typeof lastChapterId !== 'string' && lastChapterId !== null) {
    throw new SavedRequestError('INVALID_SAVED_NEXT_REQUEST');
  }
  const expectedLastChapterId = typeof lastChapterId === 'string' ? lastChapterId : null;
  return {
    plan_entry_id: planEntryId,
    expected_revision: expectedRevision,
    expected_last_chapter_id: expectedLastChapterId,
    request_key: requestKey,
  };
}

function readItem(storage: KeyValueStore, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    throw new SavedRequestError('STORAGE_UNAVAILABLE');
  }
}

function writeItem(storage: KeyValueStore, key: string, value: string) {
  try {
    storage.setItem(key, value);
  } catch {
    throw new SavedRequestError('STORAGE_UNAVAILABLE');
  }
}

export function getOrCreateGenerateRequest(
  storage: KeyValueStore,
  projectId: string,
  create: () => Omit<StoredGenerateRequest, 'request_key'>
): StoredGenerateRequest {
  const key = generateStorageKey(projectId);
  const saved = parseGenerateRequest(readItem(storage, key));
  if (saved) return saved;
  const request: StoredGenerateRequest = { ...create(), request_key: crypto.randomUUID() };
  writeItem(storage, key, JSON.stringify(request));
  return request;
}

export function clearGenerateRequest(storage: KeyValueStore, projectId: string) {
  try {
    storage.removeItem(generateStorageKey(projectId));
  } catch {
    throw new SavedRequestError('STORAGE_UNAVAILABLE');
  }
}

export function getOrCreateNextRequest(
  storage: KeyValueStore,
  projectId: string,
  input: Omit<StoredNextChapterRequest, 'request_key'>
): StoredNextChapterRequest {
  const key = nextChapterStorageKey(projectId, input.plan_entry_id);
  const saved = parseNextChapterRequest(readItem(storage, key));
  if (saved) {
    if (saved.plan_entry_id !== input.plan_entry_id) {
      throw new SavedRequestError('INVALID_SAVED_NEXT_REQUEST');
    }
    return saved;
  }
  const request: StoredNextChapterRequest = { ...input, request_key: crypto.randomUUID() };
  writeItem(storage, key, JSON.stringify(request));
  return request;
}

export function clearNextRequest(storage: KeyValueStore, projectId: string, planEntryId: string) {
  try {
    storage.removeItem(nextChapterStorageKey(projectId, planEntryId));
  } catch {
    throw new SavedRequestError('STORAGE_UNAVAILABLE');
  }
}
