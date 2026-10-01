import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Character editor values. Planning output must use this set. */
export const PLAN_CHARACTER_ROLES = ['protagonist', 'antagonist', 'supporting', 'extra'] as const;

export const ChapterPlanFieldsSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().max(3000),
  targetWordCount: z.number().int().min(200).max(10000),
});

export const GeneratedChapterFieldsSchema = ChapterPlanFieldsSchema.extend({
  summary: z.string().trim().min(1).max(3000),
}).strict();

export const PlannedChapterSchema = ChapterPlanFieldsSchema.extend({
  id: z.string().min(1),
  /** retired entries stay in the document so a deleted chapter is not created again. */
  disposition: z.enum(['active', 'retired']).default('active'),
}).strict();

export const StoryBlueprintSchema = z.object({
  title: z.string().trim().min(1).max(120),
  genre: z.string().max(200),
  style: z.string().max(500),
  summary: z.string().trim().min(1).max(3000),
  mainPlot: z.string().max(6000),
  initialRelations: z.string().max(3000),
  plannedRelations: z.string().max(3000),
  characters: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    role: z.enum(PLAN_CHARACTER_ROLES),
    description: z.string().max(1500),
    personality: z.string().max(1000),
    growthPath: z.string().max(1500),
  })).max(20),
  glossary: z.array(z.object({
    term: z.string().trim().min(1).max(200),
    definition: z.string().max(1500),
    category: z.string().max(100),
  })).max(30),
}).strict();

export const StoryPlanDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  blueprint: StoryBlueprintSchema.nullable(),
  /** Null until the author sets a 50–100k target. Ideation does not require it. */
  targetTotalWords: z.number().int().min(50000).max(100000).nullable(),
  endingPolicy: z.enum(['develop', 'conclude']).default('develop'),
  autoCreateNextChapter: z.boolean().default(false),
  chapters: z.array(PlannedChapterSchema),
}).strict();

export const PlanPatchSchema = z.object({
  id: z.string().min(1),
  entity: z.enum(['plan', 'project', 'character', 'glossary', 'initial_relations']),
  label: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
}).strict();

export type PlannedChapter = z.infer<typeof PlannedChapterSchema>;
export type StoryBlueprint = z.infer<typeof StoryBlueprintSchema>;
export type StoryPlanDocument = z.infer<typeof StoryPlanDocumentSchema>;
export type PlanPatch = z.infer<typeof PlanPatchSchema>;
export type PlanCharacterRole = (typeof PLAN_CHARACTER_ROLES)[number];

export class PlanningError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message?: string) {
    super(message || code);
    this.name = 'PlanningError';
    this.code = code;
    this.status = status;
  }
}

export const DETERMINISTIC_NEXT_CONFLICTS = new Set([
  'PLAN_CONFLICT',
  'CHAPTER_TAIL_CHANGED',
  'PLAN_ORDER_CHANGED',
  'PREVIOUS_CHAPTER_NOT_FINALIZED',
  'NO_PENDING_PLAN',
  'PLAN_INCOMPLETE',
  'PLAN_NOT_FOUND',
]);

export function emptyStoryPlan(): StoryPlanDocument {
  return StoryPlanDocumentSchema.parse({
    schemaVersion: 1,
    blueprint: null,
    targetTotalWords: null,
    endingPolicy: 'develop',
    autoCreateNextChapter: false,
    chapters: [],
  });
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hash the stored chapter body. Do not trim before hashing. */
export function hashChapterContent(content: string | null | undefined): string {
  return hashText(String(content ?? ''));
}

export function deterministicUuid(name: string): string {
  const hex = hashText(name).slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16] || '0', 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function hashCanonical(value: unknown): string {
  return hashText(JSON.stringify(sortJson(value)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortJson(source[key]);
    return sorted;
  }
  return value;
}

export function countStoryWords(text: string | null | undefined): number {
  const matches = String(text ?? '').normalize('NFC').match(/\p{L}|\p{N}/gu);
  return matches ? matches.length : 0;
}

export function mapPlanRole(raw: unknown): PlanCharacterRole {
  const text = String(raw ?? '').trim().toLowerCase();
  if (/反派|antagonist|villain/.test(text)) return 'antagonist';
  if (/主角|protagonist|\bmain\b|hero/.test(text)) return 'protagonist';
  if (/群众|路人|extra|minor|crowd/.test(text)) return 'extra';
  if (/配角|supporting/.test(text)) return 'supporting';
  if ((PLAN_CHARACTER_ROLES as readonly string[]).includes(text)) return text as PlanCharacterRole;
  return 'supporting';
}

export function normalizeBlueprintInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const source = raw as Record<string, unknown>;
  const characters = Array.isArray(source.characters)
    ? source.characters.map((row) => {
        if (!row || typeof row !== 'object') return row;
        return { ...(row as Record<string, unknown>), role: mapPlanRole((row as any).role) };
      })
    : source.characters;
  return { ...source, characters };
}

export function coerceChapterPayload(raw: unknown): unknown {
  if (Array.isArray(raw)) return { chapters: raw };
  return raw;
}

export type LinkedChapterRef = { plan_entry_id: string; index: number };

/** Linked entries follow chapter order. Future entries stay after them. Retired entries stay at the tail. */
export function orderPlanEntries(
  entries: PlannedChapter[],
  linked: LinkedChapterRef[]
): PlannedChapter[] {
  const indexById = new Map(linked.map((row) => [row.plan_entry_id, row.index]));
  const materialized: PlannedChapter[] = [];
  const future: PlannedChapter[] = [];
  const retired: PlannedChapter[] = [];
  for (const entry of entries) {
    if (entry.disposition === 'retired') {
      retired.push(entry);
      continue;
    }
    if (indexById.has(entry.id)) materialized.push(entry);
    else future.push(entry);
  }
  materialized.sort((a, b) => (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0));
  return [...materialized, ...future, ...retired];
}

/**
 * The next chapter is the first active, unlinked entry after the last linked entry.
 * A hole left by a deleted middle chapter is retired and is not selected.
 */
export function selectNextPlanEntry(
  entries: PlannedChapter[],
  linkedIds: Set<string>
): PlannedChapter | null {
  let lastLinked = -1;
  entries.forEach((entry, index) => {
    if (linkedIds.has(entry.id)) lastLinked = index;
  });
  for (let index = lastLinked + 1; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.disposition === 'retired') continue;
    if (linkedIds.has(entry.id)) continue;
    return entry;
  }
  return null;
}

export function activePlanEntries(entries: PlannedChapter[]): PlannedChapter[] {
  return entries.filter((entry) => entry.disposition !== 'retired');
}

export type BudgetChapter = {
  content?: string | null;
  status?: string | null;
  plan_entry_id?: string | null;
  target_word_count?: number | null;
};

export function planningWordBudget(
  chapters: BudgetChapter[],
  entries: PlannedChapter[]
): { written: number; reserved: number } {
  const linked = new Set<string>();
  let written = 0;
  let reserved = 0;
  for (const chapter of chapters) {
    const actual = countStoryWords(chapter.content);
    written += actual;
    if (chapter.status === 'completed') reserved += actual;
    else reserved += Math.max(actual, Number(chapter.target_word_count) || 0);
    if (chapter.plan_entry_id) linked.add(chapter.plan_entry_id);
  }
  for (const entry of entries) {
    if (entry.disposition === 'retired') continue;
    if (linked.has(entry.id)) continue;
    reserved += entry.targetWordCount;
  }
  return { written, reserved };
}

export function assertPlanningBudget(document: StoryPlanDocument, chapters: BudgetChapter[]): void {
  if (document.targetTotalWords == null) return;
  const budget = planningWordBudget(chapters, document.chapters);
  if (budget.reserved > document.targetTotalWords) {
    throw new PlanningError(
      'PLAN_BUDGET_EXCEEDED',
      422,
      `规划预留 ${budget.reserved} 字，超过目标 ${document.targetTotalWords} 字`
    );
  }
}

const CN_DIGIT: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

export function parseOrdinalToken(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    return value > 0 ? value : null;
  }
  if (token === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(token)) return 10 + (CN_DIGIT[token[1]!] || 0);
  if (/^[一二三四五六七八九]十$/.test(token)) return (CN_DIGIT[token[0]!] || 0) * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(token)) {
    return (CN_DIGIT[token[0]!] || 0) * 10 + (CN_DIGIT[token[2]!] || 0);
  }
  if (token.length === 1 && CN_DIGIT[token]) return CN_DIGIT[token];
  return null;
}

/** Ordinal is the position among active plan entries, not chapter.index. */
export function resolvePlanOrdinal(entries: PlannedChapter[], message: string): string | null {
  const match = String(message || '').match(/第\s*([0-9一二三四五六七八九十]+)\s*章/);
  if (!match) return null;
  const ordinal = parseOrdinalToken(match[1] || '');
  if (!ordinal) return null;
  const visible = activePlanEntries(entries);
  return visible[ordinal - 1]?.id ?? null;
}

export function extractExplicitSummary(message: string): string | null {
  const match = String(message || '').match(
    /(?:章纲|摘要|梗概)(?:改为|改成|写成|设置为)\s*[:：]?\s*[「“"']?([\s\S]+?)[」”"']?\s*$/
  );
  const text = match?.[1]?.trim();
  if (!text || /^(修改|修订|优化|扩写)/.test(text)) return null;
  return text.slice(0, 3000);
}

export function newPlanEntryId(): string {
  return `plan_${randomUUID()}`;
}

export function hashApplySelection(
  changeId: string,
  expectedRevision: number,
  expectedCandidateRevision: number,
  patchIds: string[]
): string {
  const ids = [...new Set(patchIds)].sort();
  return hashText(JSON.stringify([changeId, expectedRevision, expectedCandidateRevision, ids]));
}

export function hashNextChapterRequest(request: {
  project_id: number;
  plan_entry_id: string;
  expected_revision: number;
  expected_last_chapter_id: string | null;
}): string {
  return hashText(JSON.stringify([
    'next_chapter',
    request.project_id,
    request.plan_entry_id,
    request.expected_revision,
    request.expected_last_chapter_id,
  ]));
}

export const CHAPTER_CONTENT_UNFINALIZE_SQL =
  'status = CASE WHEN status = \'completed\' THEN \'draft\' ELSE status END, finalized_content_hash = NULL';

export function upcomingPlanSummary(
  document: StoryPlanDocument,
  chapters: Array<{ id: string; plan_entry_id?: string | null }>,
  activeChapterId: string | null
): string | null {
  if (!activeChapterId) return null;
  const linked = new Map<string, string>();
  for (const chapter of chapters) {
    if (chapter.plan_entry_id) linked.set(chapter.plan_entry_id, chapter.id);
  }
  const activeEntryIndex = document.chapters.findIndex((entry) => linked.get(entry.id) === activeChapterId);
  if (activeEntryIndex === -1) {
    const next = selectNextPlanEntry(
      document.chapters,
      new Set(chapters.map((chapter) => chapter.plan_entry_id).filter((id): id is string => Boolean(id)))
    );
    return next?.summary?.trim() || null;
  }
  for (let index = activeEntryIndex + 1; index < document.chapters.length; index += 1) {
    const entry = document.chapters[index]!;
    if (entry.disposition === 'retired') continue;
    if (linked.has(entry.id)) return null;
    return entry.summary.trim() || null;
  }
  return null;
}
