/**
 * Layered memory for novel drafting — flat chapter list (no volumes).
 * Tuned for local ~8K context models.
 */

export interface LayeredContext {
  recentFullText: string;
  recentCondensed: string;
  oldSummaries: string;
  worldBible: string;
  lastScene: string;
  nextChapterSummary: string | null;
  projectStructure: string;
}

export type ChapterRow = {
  id: string;
  title: string;
  index: number;
  content?: string | null;
  summary?: string | null;
  condensed_content?: string | null;
  status?: string | null;
};

export type ProjectBible = {
  title: string;
  description?: string | null;
  genre?: string;
  style?: string;
  main_plot?: string;
  character_relations?: string;
  story_tags?: string[];
  pov?: string;
  tone?: string;
};

const tail = (text: string, max: number) =>
  text.length > max ? '...' + text.slice(-max) : text;

const head = (text: string, max: number) =>
  text.length > max ? text.slice(0, max) + '...' : text;

const compactStoryTags = (tags: string[] | undefined): string => {
  if (!Array.isArray(tags)) return '';
  return head(
    tags
      .map((tag) => String(tag || '').trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(', '),
    160
  );
};

/**
 * Stable, compact creative constraints that should accompany chapter memory.
 * These values come from explicit project/import metadata, never AI inference.
 */
export function buildCreativeConstraints(bible: ProjectBible): string {
  const storyTags = compactStoryTags(bible.story_tags);
  return [
    storyTags ? `Story tags: ${storyTags}` : '',
    bible.pov ? `POV: ${head(bible.pov, 120)}` : '',
    bible.tone ? `Tone: ${head(bible.tone, 120)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildProjectStructure(chapters: ChapterRow[]): string {
  if (!chapters.length) return '(no chapters)';
  return chapters
    .map(
      (c) =>
        `- [${c.id}] #${c.index} ${c.title} (${c.status || 'draft'})${
          c.summary ? ` | ${head(c.summary, 80)}` : ''
        }`
    )
    .join('\n');
}

export function buildLayeredContext(options: {
  chapters: ChapterRow[];
  activeChapterId: string;
  bible: ProjectBible;
  characters: Array<{ name: string; role?: string | null; description?: string | null }>;
  glossary: Array<{ term: string; definition?: string | null; category?: string | null }>;
  /** L1 full-text chars per chapter */
  fullTextCap?: number;
  lastSceneCap?: number;
}): LayeredContext | null {
  const fullTextCap = options.fullTextCap ?? 800;
  const lastSceneCap = options.lastSceneCap ?? 400;
  const sorted = [...options.chapters].sort((a, b) => a.index - b.index);
  const currentIndex = sorted.findIndex((c) => c.id === options.activeChapterId);
  if (currentIndex === -1) return null;

  // L1: previous 1–2 chapters, truncated full text
  const startFull = Math.max(0, currentIndex - 2);
  const recentFullText = sorted
    .slice(startFull, currentIndex)
    .filter((c) => c.content)
    .map((c) => `[${c.title}]: ${tail(String(c.content), fullTextCap)}`)
    .join('\n\n');

  // L2: chapters further back (up to 6 more) condensed/summary
  const startCondensed = Math.max(0, currentIndex - 8);
  const recentCondensed =
    startFull > startCondensed
      ? sorted
          .slice(startCondensed, startFull)
          .map(
            (c) =>
              `[${c.title}]: ${head(
                String(c.condensed_content || c.summary || ''),
                200
              )}`
          )
          .join('\n')
      : '';

  // L3: older titles + short summary
  const oldSummaries =
    startCondensed > 0
      ? sorted
          .slice(0, startCondensed)
          .map((c) => `- ${c.title}: ${head(String(c.summary || ''), 100)}`)
          .join('\n')
      : '';

  const charList = options.characters
    .slice(0, 20)
    .map(
      (c) =>
        `${c.name}(${c.role || '?'})${c.description ? ': ' + head(c.description, 60) : ''}`
    )
    .join('; ');

  const glossList = options.glossary
    .slice(0, 30)
    .map((g) => `${g.term}: ${head(String(g.definition || ''), 40)}`)
    .join('; ');

  const b = options.bible;
  const creativeConstraints = buildCreativeConstraints(b);
  const worldBible = [
    `Title: ${b.title}`,
    b.genre ? `Genre: ${b.genre}` : '',
    b.style ? `Style: ${b.style}` : '',
    creativeConstraints,
    b.main_plot ? `Main plot: ${head(b.main_plot, 400)}` : '',
    b.description ? `Description: ${head(b.description, 200)}` : '',
    b.character_relations
      ? `Relations: ${head(b.character_relations, 200)}`
      : '',
    charList ? `Characters: ${charList}` : '',
    glossList ? `Glossary: ${glossList}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  let lastScene = '';
  if (currentIndex > 0) {
    const prev = sorted[currentIndex - 1];
    if (prev?.content) {
      lastScene = tail(String(prev.content), lastSceneCap);
    }
  }

  const next = sorted[currentIndex + 1];
  const nextChapterSummary = next?.summary?.trim() || null;

  return {
    recentFullText,
    recentCondensed,
    oldSummaries,
    worldBible,
    lastScene,
    nextChapterSummary,
    projectStructure: buildProjectStructure(sorted),
  };
}
