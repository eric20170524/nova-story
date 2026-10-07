import { db } from '../db/database';
import { logger } from '../core/logging';
import {
  parseProjectSettings,
  type ProjectSettings,
} from './project_settings';
import type { ChapterContinuity, ChapterImpactEntry } from './ai/chapter_impact_settings';

export const STORY_BIBLE_HEADER = '--- 故事设定 ---';
export const PROMPT_CHAR_BUDGET = 6000;
export const MIGRATION_VERSION = 1;

export const SETTINGS_PATCH_KEYS = [
  'image_generation',
  'video_generation',
  'genre',
  'style',
  'story_tags',
  'pov',
  'tone',
  'plot_direction',
  'initial_relations',
  'planned_relations',
  'agent_prompts_override',
] as const;

const ROLE_LABEL: Record<string, string> = {
  protagonist: '主角',
  antagonist: '反派',
  supporting: '配角',
  extra: '群众',
};

const ROLE_RANK: Record<string, number> = {
  protagonist: 0,
  antagonist: 1,
  supporting: 2,
  extra: 3,
};

export type CastRow = { id: number; name: string; aliases: string[] };

export type ImpactStateRef = { line: string; character_id: number | null };
export type ImpactRelationRef = { line: string; a_id: number | null; b_id: number | null };

export type StoryChapter = {
  id: string;
  title: string;
  index: number;
  finalized_content_hash?: string | null;
};

export type BibleCharacter = {
  id: number;
  name: string;
  role: string;
  personality: string;
  appearance: string;
  growth: string;
  state: string;
};

export type BibleParts = {
  direction: string;
  initialRelations: string;
  plannedRelations: string;
  characters: BibleCharacter[];
  states: string[];
  relations: string[];
};

type SuggestionCharacter = {
  id: number;
  name: string;
  role: string;
  description: string;
  personality: string;
  growthPath: string;
  impactLike: boolean;
};

export type StoryBibleSnapshot = {
  characters: Array<{
    id: number;
    name: string;
    role: string | null;
    description: string | null;
    personality: string | null;
    growth_path: string | null;
  }>;
  main_plot: string;
  character_relations: string;
  initial_relations: string;
  suggestions: {
    plotDirection: string;
    plotResidue: string;
    initialRelations: string;
    relationsResidue: string;
    plannedRelations: string;
    characters: SuggestionCharacter[];
  };
};

const norm = (value: string) => value.trim().toLowerCase();

export function aliasesFromTags(raw: unknown): string[] {
  let tags = raw;
  if (typeof raw === 'string') {
    try { tags = JSON.parse(raw); } catch { return []; }
  }
  const aliases = tags && typeof tags === 'object' ? (tags as { aliases?: unknown }).aliases : undefined;
  if (!Array.isArray(aliases)) return [];
  return aliases.map((alias) => String(alias || '').trim()).filter(Boolean);
}

export function resolveCharacterId(token: string, cast: CastRow[]): number | null {
  const key = norm(token);
  if (!key) return null;
  const hits = new Set<number>();
  for (const row of cast) {
    if (norm(row.name) === key) hits.add(row.id);
    for (const alias of row.aliases) {
      if (norm(alias) === key) hits.add(row.id);
    }
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

export function nameFromStateLine(line: string): string {
  const match = line.match(/^([^：:]{1,40})[：:]/);
  return match ? match[1]!.trim() : '';
}

export function parseRelationLine(line: string): { a: string; b: string } | null {
  const match = line.match(/^(.{1,40}?)\s*(?:→|↔|->)\s*(.{1,40}?)[：:]/);
  if (!match) return null;
  return { a: match[1]!.trim(), b: match[2]!.trim() };
}

export function attachImpactRefs(
  entry: ChapterImpactEntry,
  continuity: ChapterContinuity,
  cast: CastRow[]
): ChapterImpactEntry {
  const state_refs: ImpactStateRef[] = continuity.characterStates.map((line) => ({
    line,
    character_id: resolveCharacterId(nameFromStateLine(line), cast),
  }));
  const relation_refs: ImpactRelationRef[] = continuity.characterRelations.map((line) => {
    const parsed = parseRelationLine(line);
    return {
      line,
      a_id: parsed ? resolveCharacterId(parsed.a, cast) : null,
      b_id: parsed ? resolveCharacterId(parsed.b, cast) : null,
    };
  });
  return { ...entry, state_refs, relation_refs };
}

export function entryIsValid(
  chapter: { finalized_content_hash?: string | null } | undefined,
  entry: ChapterImpactEntry | undefined
): boolean {
  if (!chapter || !entry) return false;
  if (entry.invalid) return false;
  return Boolean(chapter.finalized_content_hash);
}

export function dropChapterImpact(settings: ProjectSettings, chapterId: string): ProjectSettings {
  const entries = { ...(settings.chapter_impact_entries || {}) };
  delete entries[chapterId];
  return { ...settings, chapter_impact_entries: entries };
}

export function patchProjectSettings(
  current: ProjectSettings,
  incoming: Record<string, unknown>
): ProjectSettings {
  const next: Record<string, unknown> = { ...current };
  for (const key of SETTINGS_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) next[key] = incoming[key];
  }
  return next as ProjectSettings;
}

export function applyLegacyAuthorFields(
  settings: ProjectSettings,
  fields: { main_plot?: string; character_relations?: string }
): { settings: ProjectSettings; ignored: string[] } {
  const next = { ...settings };
  const ignored: string[] = [];
  const locked = Number((settings.story_bible_migration as { version?: number } | undefined)?.version) >= MIGRATION_VERSION;
  if (fields.main_plot !== undefined) {
    if (locked || Object.prototype.hasOwnProperty.call(settings, 'plot_direction')) ignored.push('main_plot');
    else next.plot_direction = fields.main_plot;
  }
  if (fields.character_relations !== undefined) {
    if (locked || Object.prototype.hasOwnProperty.call(settings, 'initial_relations')) ignored.push('character_relations');
    else next.initial_relations = fields.character_relations;
  }
  return { settings: next, ignored };
}

export function residueAfterExactBlocks(original: string, blocks: string[]): string {
  let manual = original;
  for (const block of blocks) {
    if (block) manual = manual.split(block).join('');
  }
  return manual.replace(/\n{3,}/g, '\n\n').trim();
}

const bulletLines = (section: string): string[] => section
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('- '))
  .map((line) => line.slice(2).trim())
  .filter(Boolean);

export function sectionLines(markdown: string, label: string): string[] {
  const match = markdown.match(new RegExp(`\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*\\n([\\s\\S]*?)(?=\\n\\*\\*|$)`));
  return match ? bulletLines(match[1] || '') : [];
}

function relationLines(markdown: string): string[] {
  return bulletLines(markdown);
}

function impactLike(description: string): boolean {
  return /依据[:：]/.test(description) || /性格特征[:：][^。\n]*\(\d{1,3}%\)/.test(description);
}

const legalRole = (role: string) =>
  role === 'protagonist' || role === 'antagonist' || role === 'supporting' || role === 'extra';

export function suggestRole(role: string | null | undefined, blueprintRole?: string): string {
  if (blueprintRole && legalRole(blueprintRole)) return blueprintRole;
  if (role === 'main') return 'protagonist';
  if (role === 'minor') return 'extra';
  if (role && legalRole(role)) return role;
  return 'supporting';
}

type BlueprintCharacter = {
  name: string;
  role: string;
  description: string;
  personality: string;
  growthPath: string;
};

export function buildMigrationSnapshot(input: {
  characters: Array<{
    id: number;
    name: string;
    role: string | null;
    description: string | null;
    personality: string | null;
    growth_path: string | null;
  }>;
  mainPlot: string;
  characterRelations: string;
  initialRelations: string;
  entries: Record<string, ChapterImpactEntry | undefined>;
  blueprint: {
    mainPlot?: string;
    initialRelations?: string;
    plannedRelations?: string;
    characters?: BlueprintCharacter[];
  } | null;
}): StoryBibleSnapshot {
  const blocks = Object.values(input.entries).flatMap((entry) => [
    entry?.main_plot || '',
    entry?.character_relations || '',
  ]);
  const byName = new Map((input.blueprint?.characters || []).map((row) => [norm(row.name), row]));
  return {
    characters: input.characters.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      description: row.description,
      personality: row.personality,
      growth_path: row.growth_path,
    })),
    main_plot: input.mainPlot,
    character_relations: input.characterRelations,
    initial_relations: input.initialRelations,
    suggestions: {
      plotDirection: String(input.blueprint?.mainPlot || ''),
      plotResidue: residueAfterExactBlocks(input.mainPlot, blocks),
      initialRelations: String(input.blueprint?.initialRelations || ''),
      relationsResidue: residueAfterExactBlocks(input.characterRelations, blocks),
      plannedRelations: String(input.blueprint?.plannedRelations || ''),
      characters: input.characters.flatMap((row) => {
        const suggestion = byName.get(norm(row.name));
        if (!suggestion && legalRole(String(row.role || ''))) return [];
        return [{
          id: row.id,
          name: row.name,
          role: suggestRole(row.role, suggestion?.role),
          description: suggestion?.description || '',
          personality: suggestion?.personality || '',
          growthPath: suggestion?.growthPath || '',
          impactLike: impactLike(String(row.description || '')),
        }];
      }),
    },
  };
}

export function backfillEntryRefs(
  entry: ChapterImpactEntry,
  cast: CastRow[]
): ChapterImpactEntry {
  if (entry.state_refs && entry.relation_refs) return entry;
  const state_refs = entry.state_refs || sectionLines(entry.main_plot || '', '角色状态').map((line) => ({
    line,
    character_id: resolveCharacterId(nameFromStateLine(line), cast),
  }));
  const relation_refs = entry.relation_refs || relationLines(entry.character_relations || '').map((line) => {
    const parsed = parseRelationLine(line);
    return {
      line,
      a_id: parsed ? resolveCharacterId(parsed.a, cast) : null,
      b_id: parsed ? resolveCharacterId(parsed.b, cast) : null,
    };
  });
  return { ...entry, state_refs, relation_refs };
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export type CurrentState = {
  characterId: number;
  line: string;
  chapterId: string;
  chapterTitle: string;
  staleName: boolean;
};

export type CurrentRelation = {
  aId: number;
  bId: number;
  line: string;
  chapterId: string;
  chapterTitle: string;
  history: Array<{ line: string; chapterId: string; chapterTitle: string }>;
};

export function collectCanonFacts(
  chapters: StoryChapter[],
  entries: Record<string, ChapterImpactEntry | undefined>,
  cast: CastRow[],
  beforeChapterId?: string | null
): { states: CurrentState[]; relations: CurrentRelation[]; unresolved: string[] } {
  const ordered = [...chapters].sort((a, b) => a.index - b.index);
  const cutoff = beforeChapterId ? ordered.find((chapter) => chapter.id === beforeChapterId) : undefined;
  const window = ordered.filter((chapter) => {
    if (cutoff && chapter.index >= cutoff.index) return false;
    return entryIsValid(chapter, entries[chapter.id]);
  });
  const castById = new Map(cast.map((row) => [row.id, row]));
  const states = new Map<number, CurrentState>();
  const history = new Map<string, CurrentRelation['history']>();
  const unresolved: string[] = [];
  for (const chapter of window) {
    const entry = entries[chapter.id];
    if (!entry) continue;
    const filled = backfillEntryRefs(entry, cast);
    for (const ref of filled.state_refs || []) {
      if (ref.character_id == null) {
        unresolved.push(ref.line);
        continue;
      }
      const person = castById.get(ref.character_id);
      const spoken = nameFromStateLine(ref.line);
      states.set(ref.character_id, {
        characterId: ref.character_id,
        line: ref.line,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        staleName: Boolean(person && spoken && norm(spoken) !== norm(person.name) && !person.aliases.some((alias) => norm(alias) === norm(spoken))),
      });
    }
    for (const ref of filled.relation_refs || []) {
      if (ref.a_id == null || ref.b_id == null) {
        unresolved.push(ref.line);
        continue;
      }
      const key = pairKey(ref.a_id, ref.b_id);
      const item = { line: ref.line, chapterId: chapter.id, chapterTitle: chapter.title };
      const list = history.get(key) || [];
      list.push(item);
      history.set(key, list);
    }
  }
  const relations: CurrentRelation[] = [...history.entries()].map(([key, items]) => {
    const [a, b] = key.split(':').map((part) => Number(part));
    const latest = items[items.length - 1]!;
    return { aId: a!, bId: b!, line: latest.line, chapterId: latest.chapterId, chapterTitle: latest.chapterTitle, history: items };
  });
  return { states: [...states.values()], relations, unresolved };
}

const clip = (value: string, max: number) => {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
};

export function selectBibleParts(input: {
  direction: string;
  initialRelations: string;
  plannedRelations: string;
  characters: BibleCharacter[];
  states: string[];
  relations: Array<{ line: string; primary: boolean; order: number }>;
}): BibleParts {
  const characters = [...input.characters]
    .sort((a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) || a.id - b.id)
    .slice(0, 8)
    .map((row) => ({
      ...row,
      personality: clip(row.personality, 60),
      appearance: clip(row.appearance, 60),
      growth: clip(row.growth, 40),
      state: clip(row.state, 40),
    }));
  const relations = [...input.relations]
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.order - b.order)
    .slice(0, 6)
    .map((row) => clip(row.line, 60));
  return {
    direction: clip(input.direction, 300),
    initialRelations: clip(input.initialRelations, 160),
    plannedRelations: clip(input.plannedRelations, 160),
    characters,
    states: input.states.slice(-6).map((line) => clip(line, 60)),
    relations,
  };
}

export function renderStoryBible(parts: BibleParts): string {
  const lines = [STORY_BIBLE_HEADER];
  if (parts.direction) lines.push(`作者走向：${parts.direction}`);
  if (parts.initialRelations) lines.push(`开篇关系：${parts.initialRelations}`);
  if (parts.plannedRelations) lines.push(`关系走向：${parts.plannedRelations}`);
  if (parts.states.length) {
    lines.push('本章之前的定稿状态：');
    for (const line of parts.states) lines.push(`- ${line}`);
  }
  if (parts.relations.length) {
    lines.push('本章之前的关系：');
    for (const line of parts.relations) lines.push(`- ${line}`);
  }
  if (parts.characters.length) {
    lines.push('人物：');
    for (const row of parts.characters) {
      const bits = [`${row.name}（${ROLE_LABEL[row.role] || row.role || '配角'}）`];
      if (row.personality) bits.push(`性格：${row.personality}`);
      if (row.appearance) bits.push(`外貌与设定：${row.appearance}`);
      if (row.growth) bits.push(`成长：${row.growth}`);
      if (row.state) bits.push(`此前状态：${row.state}`);
      lines.push(bits.join('；'));
    }
  }
  return lines.join('\n');
}

export type PromptFitState = {
  template: string;
  variables: Record<string, string>;
  bible: BibleParts;
  oldSummaries: string;
  recentCondensed: string;
  supplemental: string;
  glossary: string;
  recentFullText: string;
  lastScene: string;
  existingContent: string;
  existingFloor: number;
};

const joinMemory = (state: PromptFitState) => [
  state.variables.creativeConstraints ? `[创作约束]\n${state.variables.creativeConstraints}` : '',
  state.supplemental ? `[补充资料]\n${state.supplemental}` : '',
  state.oldSummaries ? `[较早梗概]\n${state.oldSummaries}` : '',
  state.recentCondensed ? `[近期浓缩]\n${state.recentCondensed}` : '',
  state.recentFullText ? `[紧邻前文]\n${state.recentFullText}` : '',
].filter(Boolean).join('\n\n');

export function renderBudgetedPrompt(
  state: PromptFitState,
  format: (template: string, variables: Record<string, string>) => string
): string {
  const bibleText = renderStoryBible(state.bible);
  const formatted = format(state.template, {
    ...state.variables,
    storyBible: bibleText,
    memoryPrompt: joinMemory(state),
    glossary: state.glossary,
    existingContent: state.existingContent,
    mainPlot: '',
    characters: '',
  });
  if (formatted.includes(STORY_BIBLE_HEADER)) return formatted;
  const marker = '--- 当前创作目标 ---';
  if (formatted.includes(marker)) return formatted.replace(marker, `${bibleText}\n\n${marker}`);
  return `${formatted}\n\n${bibleText}`;
}

const shrinkText = (value: string, keep: number) => (value.length <= keep ? value : value.slice(value.length - keep));

export function fitPromptToBudget(
  initial: PromptFitState,
  format: (template: string, variables: Record<string, string>) => string
): { prompt: string; warned: boolean } {
  const state: PromptFitState = {
    ...initial,
    variables: { ...initial.variables },
    bible: {
      ...initial.bible,
      characters: initial.bible.characters.map((row) => ({ ...row })),
      states: [...initial.bible.states],
      relations: [...initial.bible.relations],
    },
  };
  const steps: Array<() => boolean> = [
    () => state.oldSummaries ? (state.oldSummaries = '', true) : false,
    () => state.recentCondensed ? (state.recentCondensed = '', true) : false,
    () => {
      if (!state.supplemental) return false;
      state.supplemental = state.supplemental.length <= 400 ? '' : state.supplemental.slice(0, state.supplemental.length - 400);
      return true;
    },
    () => {
      if (!state.glossary) return false;
      state.glossary = state.glossary.length <= 200 ? '' : state.glossary.slice(0, state.glossary.length - 200);
      return true;
    },
    () => dropField(state, 'growth'),
    () => dropField(state, 'personality'),
    () => dropField(state, 'appearance'),
    () => state.bible.plannedRelations ? (state.bible.plannedRelations = '', true) : false,
    () => state.bible.initialRelations ? (state.bible.initialRelations = '', true) : false,
    () => {
      const floor = shrinkText(state.lastScene, 400);
      if (state.recentFullText === floor) return false;
      state.recentFullText = floor;
      return true;
    },
    () => {
      if (state.existingContent.length <= Math.max(state.existingFloor, 800)) return false;
      state.existingContent = shrinkText(state.existingContent, Math.max(state.existingFloor, 800));
      return true;
    },
    () => dropTrailing(state.bible.characters, (row) => row.role !== 'protagonist'),
    () => dropTrailing(state.bible.relations, () => true),
    () => dropTrailing(state.bible.states, () => true),
    () => {
      if (state.existingContent.length <= 200) return false;
      state.existingContent = shrinkText(state.existingContent, Math.max(200, state.existingContent.length - 200));
      return true;
    },
  ];
  let prompt = renderBudgetedPrompt(state, format);
  let step = 0;
  let warned = false;
  while (prompt.length > PROMPT_CHAR_BUDGET && step < steps.length) {
    const changed = steps[step]!();
    if (!changed) {
      step += 1;
      continue;
    }
    const next = renderBudgetedPrompt(state, format);
    if (next.length >= prompt.length) step += 1;
    prompt = next;
  }
  if (prompt.length > PROMPT_CHAR_BUDGET) {
    warned = true;
    logger.warn(`Chapter prompt remains ${prompt.length} characters after budget cuts`);
    prompt = prompt.slice(0, PROMPT_CHAR_BUDGET);
  }
  return { prompt, warned };
}

function dropField(state: PromptFitState, field: 'growth' | 'personality' | 'appearance'): boolean {
  if (!state.bible.characters.some((row) => row[field])) return false;
  for (const row of state.bible.characters) row[field] = '';
  return true;
}

function dropTrailing<T>(items: T[], canDrop: (item: T) => boolean): boolean {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (!canDrop(items[index]!)) continue;
    items.splice(index, 1);
    return true;
  }
  return false;
}

async function readBlueprint(projectId: number): Promise<StoryBibleSnapshot['suggestions'] | null> {
  const row = await db.get('SELECT document_json FROM story_plan WHERE project_id = ?', projectId);
  if (!row?.document_json) return null;
  try {
    const document = JSON.parse(String(row.document_json));
    return document?.blueprint || null;
  } catch {
    return null;
  }
}

async function loadCast(projectId: number): Promise<Array<CastRow & {
  role: string;
  description: string;
  personality: string;
  growth_path: string;
}>> {
  const rows = await db.all(
    'SELECT id, name, role, description, personality, growth_path, visual_tags FROM character WHERE project_id = ? ORDER BY id ASC',
    projectId
  );
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    name: String(row.name || ''),
    role: String(row.role || ''),
    description: String(row.description || ''),
    personality: String(row.personality || ''),
    growth_path: String(row.growth_path || ''),
    aliases: aliasesFromTags(row.visual_tags),
  }));
}

async function loadChapters(projectId: number): Promise<StoryChapter[]> {
  const rows = await db.all(
    'SELECT id, title, "index" AS idx, finalized_content_hash FROM chapter WHERE project_id = ? ORDER BY "index" ASC',
    projectId
  );
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    title: String(row.title || ''),
    index: Number(row.idx),
    finalized_content_hash: row.finalized_content_hash == null ? null : String(row.finalized_content_hash),
  }));
}

export async function migrateStoryBible(projectId: number): Promise<ProjectSettings> {
  await db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const project = await db.get('SELECT settings FROM project WHERE id = ?', projectId);
    if (!project) {
      await db.exec('ROLLBACK');
      throw new Error('Project not found');
    }
    const settings = parseProjectSettings(project.settings);
    const migration = settings.story_bible_migration as { version?: number } | undefined;
    if (Number(migration?.version) >= MIGRATION_VERSION) {
      await db.exec('COMMIT');
      return settings;
    }
    const cast = await loadCast(projectId);
    const chapters = await loadChapters(projectId);
    const entries = { ...(settings.chapter_impact_entries || {}) };
    for (const chapter of chapters) {
      const entry = entries[chapter.id];
      if (entry) entries[chapter.id] = backfillEntryRefs(entry, cast);
    }
    const blueprint = await readBlueprint(projectId) as {
      mainPlot?: string;
      initialRelations?: string;
      plannedRelations?: string;
      characters?: BlueprintCharacter[];
    } | null;
    const snapshot = buildMigrationSnapshot({
      characters: cast,
      mainPlot: String(settings.main_plot || ''),
      characterRelations: String(settings.character_relations || ''),
      initialRelations: String(settings.initial_relations || ''),
      entries,
      blueprint,
    });
    const next: ProjectSettings = {
      ...settings,
      chapter_impact_entries: entries,
      story_bible_snapshot: snapshot,
      story_bible_migration: { version: MIGRATION_VERSION, status: 'complete' },
    };
    await db.run(
      'UPDATE project SET settings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      JSON.stringify(next),
      projectId
    );
    await db.exec('COMMIT');
    logger.info(`Story bible migration complete for project ${projectId}; characters ${cast.map((row) => row.name).join(',')}`);
    return next;
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

export async function loadBibleParts(projectId: number, beforeChapterId?: string | null): Promise<BibleParts> {
  const settings = parseProjectSettings((await db.get('SELECT settings FROM project WHERE id = ?', projectId))?.settings);
  const cast = await loadCast(projectId);
  const chapters = await loadChapters(projectId);
  const facts = collectCanonFacts(chapters, settings.chapter_impact_entries || {}, cast, beforeChapterId);
  const stateById = new Map(facts.states.map((row) => [row.characterId, row.line]));
  const protagonistIds = new Set(cast.filter((row) => row.role === 'protagonist').map((row) => row.id));
  const chapterOrder = new Map(chapters.map((chapter) => [chapter.id, chapter.index]));
  return selectBibleParts({
    direction: String(settings.plot_direction || ''),
    initialRelations: String(settings.initial_relations || ''),
    plannedRelations: String(settings.planned_relations || ''),
    states: facts.states.map((row) => row.line),
    relations: facts.relations.map((row) => ({
      line: row.line,
      primary: protagonistIds.has(row.aId) || protagonistIds.has(row.bId),
      order: chapterOrder.get(row.chapterId) ?? 0,
    })),
    characters: cast.map((row) => ({
      id: row.id,
      name: row.name,
      role: legalRole(row.role) ? row.role : 'supporting',
      personality: row.personality,
      appearance: row.description,
      growth: row.growth_path,
      state: stateById.get(row.id) || '',
    })),
  });
}

export function parseCanonChapter(entry: ChapterImpactEntry | undefined): {
  states: string[];
  events: string[];
  foreshadowing: string[];
  relations: string[];
} {
  if (!entry) return { states: [], events: [], foreshadowing: [], relations: [] };
  return {
    states: entry.state_refs?.map((ref) => ref.line) || sectionLines(entry.main_plot || '', '角色状态'),
    events: sectionLines(entry.main_plot || '', '事件（叙事顺序）'),
    foreshadowing: sectionLines(entry.main_plot || '', '伏笔（埋设 / 推进 / 回收）'),
    relations: entry.relation_refs?.map((ref) => ref.line) || relationLines(entry.character_relations || ''),
  };
}

export async function buildStoryBibleView(projectId: number) {
  const settings = await migrateStoryBible(projectId);
  const cast = await loadCast(projectId);
  const chapters = await loadChapters(projectId);
  const entries = settings.chapter_impact_entries || {};
  const facts = collectCanonFacts(chapters, entries, cast);
  const snapshot = settings.story_bible_snapshot as StoryBibleSnapshot | undefined;
  return {
    migrationVersion: MIGRATION_VERSION,
    suggestions: snapshot?.suggestions || null,
    currentStates: facts.states,
    currentRelations: facts.relations,
    unresolved: facts.unresolved,
    canon: [...chapters].sort((a, b) => a.index - b.index).map((chapter) => {
      const entry = entries[chapter.id];
      const valid = entryIsValid(chapter, entry);
      return {
        chapterId: chapter.id,
        index: chapter.index,
        title: chapter.title,
        valid,
        ...parseCanonChapter(valid || entry ? entry : undefined),
      };
    }),
  };
}
