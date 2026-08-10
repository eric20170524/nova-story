import { z } from 'zod';
import { db } from '../../db/database';
import { logger } from '../../core/logging';
import { parseProjectSettings } from '../project_settings';
import { LLMService } from '../llm';
import {
  ChapterCharacterAnalysisSchema,
  type ChapterCharacterAnalysis,
} from '../../schemas/llm';
import {
  buildLayeredContext,
  type ChapterRow,
  type ProjectBible,
} from './layered_context';
import {
  buildNextChapterConstraint,
  formatPrompt,
  getPrompt,
  type PromptKey,
} from './prompt_registry';

/** Hard caps tuned for local ~8K context (character counts, not tokens). */
const BUDGET = {
  mainPlot: 400,
  description: 200,
  characterList: 12,
  characterDesc: 80,
  glossaryList: 20,
  glossaryDef: 60,
  existingContent: 1500,
  skillContent: 3500,
  chapterSummary: 300,
  metaContent: 6000,
  outlinesTotal: 4000,
};

/**
 * Split long chapter text into paragraph chunks for local 8K models.
 * Prefer paragraph boundaries; cover full document (no head+tail middle drop).
 * If maxChunks is exceeded, expand chunk size rather than drop sections.
 */
export function splitChapterIntoAnalysisChunks(
  content: string,
  opts: { maxChunkChars?: number; maxChunks?: number } = {}
): string[] {
  const maxChunkChars = opts.maxChunkChars ?? 3500;
  const maxChunks = Math.max(1, opts.maxChunks ?? 4);
  const text = String(content || '').trim();
  if (!text) return [];
  if (text.length <= maxChunkChars) return [text];

  // Grow chunk size so total length always fits in maxChunks without omissions
  const minNeeded = Math.ceil(text.length / maxChunks);
  const chunkSize = Math.max(maxChunkChars, minNeeded);

  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const units =
    paras.length > 1
      ? paras
      : text.match(new RegExp(`.{1,${Math.min(800, chunkSize)}}`, 'gs')) || [text];

  const chunks: string[] = [];
  let buf = '';
  for (const unit of units) {
    const candidate = buf ? `${buf}\n\n${unit}` : unit;
    if (candidate.length > chunkSize && buf) {
      chunks.push(buf);
      buf = unit;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);

  // Guarantee coverage: if still over maxChunks (oversized units), hard-slice text
  if (chunks.length > maxChunks) {
    const hard: string[] = [];
    const step = Math.ceil(text.length / maxChunks);
    for (let i = 0; i < maxChunks; i++) {
      const start = i * step;
      const end = i === maxChunks - 1 ? text.length : Math.min(text.length, start + step);
      if (start < text.length) hard.push(text.slice(start, end));
    }
    return hard;
  }
  return chunks;
}

/** Merge multi-chunk character analyses by name; de-dupe traits by trait text. */
export function mergeChapterCharacterAnalyses(
  parts: ChapterCharacterAnalysis[]
): ChapterCharacterAnalysis {
  type Char = ChapterCharacterAnalysis['characters'][number];
  const byName = new Map<string, Char>();

  for (const part of parts) {
    for (const c of part.characters || []) {
      const key = String(c.name || '').trim();
      if (!key) continue;
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, {
          name: key,
          roleInChapter: c.roleInChapter || '',
          traits: [...(c.traits || [])],
          motivation: c.motivation ?? null,
          relationships: [...(c.relationships || [])],
        });
        continue;
      }
      if (!existing.roleInChapter && c.roleInChapter) {
        existing.roleInChapter = c.roleInChapter;
      }
      if (!existing.motivation && c.motivation) {
        existing.motivation = c.motivation;
      }
      const traitKeys = new Set(
        (existing.traits || []).map((t) => `${t.trait}::${t.evidence}`.slice(0, 120))
      );
      for (const t of c.traits || []) {
        const k = `${t.trait}::${t.evidence}`.slice(0, 120);
        if (!traitKeys.has(k)) {
          existing.traits = existing.traits || [];
          existing.traits.push(t);
          traitKeys.add(k);
        }
      }
      const rel = new Set(existing.relationships || []);
      for (const r of c.relationships || []) rel.add(r);
      existing.relationships = [...rel];
    }
  }

  return { characters: [...byName.values()] };
}

/** Lines written into character.description for chapter personality. */
const PERSONALITY_LINE_RE = /^\s*(性格特征|本章动机|【本章性格】)[:：]?/;

export type ImpactCharacterTrait = {
  trait: string;
  evidence: string;
  confidence: number;
};

export type ImpactCharacterRow = {
  name: string;
  role?: string | null;
  description?: string | null;
  traits?: ImpactCharacterTrait[];
  motivation?: string | null;
  roleInChapter?: string | null;
  /** Flat visual appearance tags for image gen (hair/eyes/…). */
  visual_tags?: Record<string, string> | null;
};

export type ChapterImpactResult = {
  newOrUpdatedCharacters: ImpactCharacterRow[];
  newOrUpdatedGlossary: Array<{
    term: string;
    definition?: string | null;
    category?: string | null;
  }>;
  /** True when chapter character analysis contributed traits/motivation. */
  personalityMerged: boolean;
  /** True when any character received non-empty visual_tags from impact. */
  visualTagsMerged: boolean;
};

/** Keys stored as structured meta inside visual_tags JSON — never overwrite with appearance strings. */
const VISUAL_TAG_META_KEYS = new Set([
  'assets',
  'timeline_map',
  'variants',
  'base_model',
  'model_type',
  'avatar_url',
  'turnaround_url',
  'face_url',
  'lora_path',
  'lora_ready',
  'lora_name',
  'scene_modifiers',
]);

/** Normalize LLM visual_tags to a flat string map (skip nested meta / empty). */
export function normalizeVisualTags(
  raw: unknown
): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k || '').trim();
    if (!key || VISUAL_TAG_META_KEYS.has(key)) continue;
    if (v == null || typeof v === 'object') continue;
    const s = String(v).trim();
    if (s) out[key] = s;
  }
  return out;
}

/**
 * Merge flat appearance tags into character.visual_tags document shape used by
 * Character Manager + image gen (base_model.tags + top-level strings + variants).
 */
export function mergeVisualTagsDocument(
  existingRaw: unknown,
  incoming: Record<string, string>
): Record<string, unknown> {
  let existing: Record<string, any> = {};
  if (typeof existingRaw === 'string') {
    try {
      const parsed = JSON.parse(existingRaw);
      if (parsed && typeof parsed === 'object') existing = parsed;
    } catch {
      existing = {};
    }
  } else if (existingRaw && typeof existingRaw === 'object') {
    existing = { ...(existingRaw as Record<string, any>) };
  }

  if (!incoming || !Object.keys(incoming).length) {
    return existing;
  }

  const prevBaseTags =
    existing.base_model?.tags && typeof existing.base_model.tags === 'object'
      ? { ...existing.base_model.tags }
      : {};

  const flatFromTop: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing)) {
    if (VISUAL_TAG_META_KEYS.has(k)) continue;
    if (typeof v === 'string' && v.trim()) flatFromTop[k] = v.trim();
  }

  const mergedAppearance = {
    ...flatFromTop,
    ...prevBaseTags,
    ...incoming,
  };

  let variants = Array.isArray(existing.variants) ? [...existing.variants] : [];
  if (!variants.length) {
    variants = [{ id: 'v1_default', name: 'Default', tags: { ...mergedAppearance } }];
  } else {
    variants = variants.map((v: any, i: number) => {
      if (!v || typeof v !== 'object') return v;
      const isDefault =
        v.id === 'v1_default' || i === 0;
      if (!isDefault) return v;
      const prev =
        v.tags && typeof v.tags === 'object' && !Array.isArray(v.tags)
          ? v.tags
          : {};
      return { ...v, tags: { ...prev, ...incoming } };
    });
  }

  // Top-level string keys for simple editor UI; nested for generation pipeline
  const next: Record<string, any> = {
    ...existing,
    ...incoming,
    timeline_map: existing.timeline_map || {},
    variants,
    base_model: {
      ...(existing.base_model || {}),
      tags: {
        ...(existing.base_model?.tags || {}),
        ...incoming,
      },
    },
    assets: existing.assets || {},
    model_type: existing.model_type || 'pony',
  };
  return next;
}

/** Remove previously merged personality lines so re-apply does not stack. */
export function stripPersonalitySections(text: string): string {
  if (!text) return '';
  return text
    .split('\n')
    .filter((line) => !PERSONALITY_LINE_RE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Format traits + motivation for character.description. */
export function formatPersonalityBlock(
  item:
    | {
        traits?: Array<{
          trait: string;
          evidence?: string;
          confidence?: number;
        }>;
        motivation?: string | null;
      }
    | null
    | undefined
): string {
  if (!item) return '';
  const parts: string[] = [];
  const traits = item.traits || [];
  if (traits.length) {
    const sorted = [...traits].sort(
      (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)
    );
    const lines = sorted.slice(0, 8).map((t) => {
      const conf =
        typeof t.confidence === 'number' && !Number.isNaN(t.confidence)
          ? `(${Math.round(Math.min(1, Math.max(0, t.confidence)) * 100)}%)`
          : '';
      const ev = String(t.evidence || '').trim();
      return `${t.trait}${conf}${ev ? ` — ${ev}` : ''}`;
    });
    parts.push(`性格特征：${lines.join('；')}`);
  }
  const mot = String(item.motivation || '').trim();
  if (mot) parts.push(`本章动机：${mot}`);
  return parts.join('\n');
}

/**
 * Merge bio + personality for character.description.
 * Prefer impact bio over existing bio; always re-apply a fresh personality block.
 */
export function mergeCharacterDescription(
  existing: string | null | undefined,
  impactBio: string | null | undefined,
  personalityBlock: string | null | undefined
): string {
  const bio =
    stripPersonalitySections(impactBio || '') ||
    stripPersonalitySections(existing || '');
  const personality = String(personalityBlock || '').trim();
  if (bio && personality) return `${bio}\n\n${personality}`;
  return bio || personality || '';
}

/** Map free-text chapter role to character.role enum-ish values. */
export function mapRoleInChapterToRole(
  roleInChapter?: string | null,
  fallback?: string | null
): string {
  const fb = String(fallback || '').trim().toLowerCase();
  if (fb === 'main' || fb === 'supporting' || fb === 'minor') return fb;
  const r = String(roleInChapter || fallback || '');
  if (/主[角色]?|protagonist|heroine?|\bmain\b/i.test(r)) return 'main';
  if (/观众|群众|群体|路人|次要|minor|extra|crowd/i.test(r)) return 'minor';
  if (fallback) return String(fallback);
  return 'supporting';
}

/**
 * Union impact delta characters with full-chapter personality analysis.
 * Ensures main cast with traits are not dropped when impact only returns "new" names.
 */
export function mergeImpactWithCharacterAnalysis(
  impact: {
    newOrUpdatedCharacters?: Array<{
      name: string;
      role?: string | null;
      description?: string | null;
      visual_tags?: unknown;
    }>;
    newOrUpdatedGlossary?: Array<{
      term: string;
      definition?: string | null;
      category?: string | null;
    }>;
  },
  analysis: ChapterCharacterAnalysis
): ChapterImpactResult {
  type Acc = {
    name: string;
    role?: string | null;
    impactBio?: string | null;
    traits: ImpactCharacterTrait[];
    motivation?: string | null;
    roleInChapter?: string | null;
    visual_tags: Record<string, string>;
  };
  const byName = new Map<string, Acc>();
  const keyOf = (n: string) => n.trim().toLowerCase();

  let visualTagsMerged = false;
  for (const ch of impact.newOrUpdatedCharacters || []) {
    const name = String(ch.name || '').trim();
    if (!name) continue;
    const visual_tags = normalizeVisualTags(ch.visual_tags);
    if (Object.keys(visual_tags).length) visualTagsMerged = true;
    byName.set(keyOf(name), {
      name,
      role: ch.role,
      impactBio: ch.description,
      traits: [],
      visual_tags,
    });
  }

  let personalityMerged = false;
  for (const a of analysis.characters || []) {
    const name = String(a.name || '').trim();
    if (!name) continue;
    const k = keyOf(name);
    const prev = byName.get(k);
    const traits: ImpactCharacterTrait[] = (a.traits || []).map((t) => ({
      trait: String(t.trait || '').trim(),
      evidence: String(t.evidence || '').trim(),
      confidence:
        typeof t.confidence === 'number' && !Number.isNaN(t.confidence)
          ? Math.min(1, Math.max(0, t.confidence))
          : 0.5,
    })).filter((t) => t.trait);

    if (traits.length || a.motivation) personalityMerged = true;

    byName.set(k, {
      name: prev?.name || name,
      role: mapRoleInChapterToRole(a.roleInChapter, prev?.role),
      impactBio: prev?.impactBio,
      traits,
      motivation: a.motivation ?? null,
      roleInChapter: a.roleInChapter || prev?.roleInChapter || null,
      visual_tags: prev?.visual_tags || {},
    });
  }

  const newOrUpdatedCharacters: ImpactCharacterRow[] = [...byName.values()].map(
    (c) => {
      const personality = formatPersonalityBlock(c);
      const description = mergeCharacterDescription(
        null,
        c.impactBio,
        personality
      );
      return {
        name: c.name,
        role: c.role || 'supporting',
        description: description || c.impactBio || '',
        traits: c.traits,
        motivation: c.motivation ?? null,
        roleInChapter: c.roleInChapter ?? null,
        visual_tags: Object.keys(c.visual_tags).length ? c.visual_tags : null,
      };
    }
  );

  return {
    newOrUpdatedCharacters,
    newOrUpdatedGlossary: impact.newOrUpdatedGlossary || [],
    personalityMerged,
    visualTagsMerged,
  };
}

const MetadataSchema = z.object({
  condensed: z.string(),
  nextPlot: z.string().optional().default(''),
});

/** Flat appearance tags; keep optional so local models can omit fields. */
const ImpactVisualTagsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.null()]))
  .optional()
  .nullable();

const ImpactSchema = z.object({
  newOrUpdatedCharacters: z
    .array(
      z.object({
        name: z.string(),
        role: z.string().optional().nullable(),
        description: z.string().optional().nullable(),
        visual_tags: ImpactVisualTagsSchema,
      })
    )
    .default([]),
  newOrUpdatedGlossary: z
    .array(
      z.object({
        term: z.string(),
        definition: z.string().optional().nullable(),
        category: z.string().optional().nullable(),
      })
    )
    .default([]),
});

const ConsistencySchema = z.object({
  issues: z
    .array(
      z.object({
        severity: z.string(),
        location: z.string(),
        description: z.string(),
      })
    )
    .default([]),
});

const head = (text: string, max: number) =>
  text.length > max ? text.slice(0, max) + '…' : text;

async function loadWritingBundle(projectId: number, chapterId?: string | null) {
  const project = await db.get('SELECT * FROM project WHERE id = ?', projectId);
  if (!project) throw new Error('Project not found');

  const settings = parseProjectSettings(project.settings);
  const overrides = (settings.agent_prompts_override || null) as
    | Partial<Record<PromptKey, string>>
    | null;

  const chapters = (await db.all(
    'SELECT * FROM chapter WHERE project_id = ? ORDER BY "index" ASC',
    projectId
  )) as ChapterRow[];

  const characters = await db.all(
    'SELECT id, name, role, description FROM character WHERE project_id = ? ORDER BY id ASC',
    projectId
  );

  const glossary = await db.all(
    'SELECT id, term, definition, category FROM glossary WHERE project_id = ? ORDER BY id ASC',
    projectId
  );

  const bible: ProjectBible = {
    title: project.title,
    description: project.description,
    genre: typeof settings.genre === 'string' ? settings.genre : undefined,
    style: typeof settings.style === 'string' ? settings.style : undefined,
    main_plot:
      typeof settings.main_plot === 'string' ? settings.main_plot : undefined,
    character_relations:
      typeof settings.character_relations === 'string'
        ? settings.character_relations
        : undefined,
  };

  const activeId = chapterId || chapters[0]?.id || null;

  const layered =
    activeId != null
      ? buildLayeredContext({
          chapters,
          activeChapterId: activeId,
          bible,
          characters,
          glossary,
        })
      : null;

  return {
    project,
    settings,
    overrides,
    chapters,
    characters,
    glossary,
    bible,
    activeId,
    layered,
  };
}

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function budgetedCharacters(characters: any[]): string {
  return JSON.stringify(
    characters.slice(0, BUDGET.characterList).map((c) => ({
      name: c.name,
      role: c.role,
      description: head(String(c.description || ''), BUDGET.characterDesc),
    }))
  );
}

function budgetedGlossary(glossary: any[]): string {
  return JSON.stringify(
    glossary.slice(0, BUDGET.glossaryList).map((g) => ({
      term: g.term,
      category: g.category,
      definition: head(String(g.definition || ''), BUDGET.glossaryDef),
    }))
  );
}

export class WritingService {
  static async generateChapterDraft(options: {
    projectId: number;
    chapterId: string;
    instructions: string;
    targetWordCount?: number;
    /** Append mode: include existing chapter content in prompt */
    includeExisting?: boolean;
    /**
     * Prefer live editor buffer over DB content (unsaved draft).
     * When set, used as "已有正文" for continuity.
     */
    existingContentOverride?: string | null;
    /**
     * rewrite = transform full chapter into new body (novel prose).
     * append = continue after existing (default).
     */
    mode?: 'rewrite' | 'append';
    /**
     * When true, compute condensed/nextPlot via structured LLM.
     * Caller must not persist condensed unless content is applied/accepted.
     */
    generateMetadata?: boolean;
  }): Promise<{
    content: string;
    condensed?: string;
    nextPlot?: string;
  }> {
    const bundle = await loadWritingBundle(options.projectId, options.chapterId);
    const chapter = bundle.chapters.find((c) => c.id === options.chapterId);
    if (!chapter) throw new Error('Chapter not found');

    const rewriteMode = options.mode === 'rewrite';
    const layered = bundle.layered;
    const nextConstraint = buildNextChapterConstraint(
      layered?.nextChapterSummary,
      bundle.overrides
    );

    const memoryPrompt = [
      layered?.oldSummaries ? `[较早梗概]\n${layered.oldSummaries}` : '',
      layered?.recentCondensed ? `[近期浓缩]\n${layered.recentCondensed}` : '',
      layered?.recentFullText ? `[紧邻前文]\n${layered.recentFullText}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    let existing = '';
    if (options.includeExisting !== false) {
      const source =
        options.existingContentOverride != null
          ? String(options.existingContentOverride)
          : String(chapter.content || '');
      // Rewrite needs more of the source body; append only needs the tail
      const budget = rewriteMode
        ? Math.max(BUDGET.existingContent, 6000)
        : BUDGET.existingContent;
      existing = source
        ? rewriteMode
          ? source.slice(0, budget)
          : source.slice(-budget)
        : '';
    }

    // Prefer layered worldBible (already capped) over raw full dumps
    const worldBible =
      layered?.worldBible ||
      [
        `Title: ${bundle.bible.title}`,
        bundle.bible.genre ? `Genre: ${bundle.bible.genre}` : '',
        bundle.bible.style ? `Style: ${bundle.bible.style}` : '',
        bundle.bible.main_plot
          ? `Main plot: ${head(bundle.bible.main_plot, BUDGET.mainPlot)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

    const existingLabel = rewriteMode
      ? '原文（请全文改写为小说叙述，删除分镜标签，输出完整替换稿）'
      : '已有正文(可续写)';
    const existingBlock = existing
      ? existing
      : rewriteMode
        ? '(原文为空 — 请按章纲撰写完整小说正文)'
        : '(空 — 请从章纲开写)';

    const prompt = formatPrompt(getPrompt('writing_chapter_gen', bundle.overrides), {
      title: bundle.bible.title,
      genre: bundle.bible.genre || '',
      style: bundle.bible.style || '',
      mainPlot: head(
        bundle.bible.main_plot || bundle.bible.description || '',
        BUDGET.mainPlot
      ),
      characters: budgetedCharacters(bundle.characters),
      glossary: budgetedGlossary(bundle.glossary),
      lastScene: layered?.lastScene || '无',
      memoryPrompt: memoryPrompt || worldBible || '无',
      chapterTitle: chapter.title,
      chapterSummary: head(String(chapter.summary || ''), BUDGET.chapterSummary),
      existingContentLabel: existingLabel,
      existingContent: existingBlock,
      nextChapterConstraint: nextConstraint,
      instructions: options.instructions,
      targetWordCount: options.targetWordCount || (rewriteMode ? 1200 : 800),
      writingModeNote: rewriteMode
        ? '【模式=全文重写】只输出完整新正文，不要“续写”、不要保留【画面】【动作指令】等标签。'
        : '【模式=续写】在已有正文之后自然接写。',
    });

    const provider = LLMService.getProvider();
    const raw = await provider.generateText(prompt);
    const content = stripThink(raw);

    let condensed: string | undefined;
    let nextPlot: string | undefined;
    if (options.generateMetadata !== false) {
      try {
        // Prefer full accepted chapter when metadata is for applied content;
        // for previews this describes only the new fragment (caller must not persist).
        const metaSource = head(content, BUDGET.metaContent);
        const metaPrompt = formatPrompt(
          getPrompt('writing_metadata_gen', bundle.overrides),
          { content: metaSource }
        );
        const meta = await LLMService.generateStructuredWithRetry(
          metaPrompt,
          MetadataSchema
        );
        if (meta) {
          condensed = meta.condensed;
          nextPlot = meta.nextPlot;
        }
      } catch (e) {
        logger.warn(`Metadata generation failed: ${e}`);
      }
    }

    return { content, condensed, nextPlot };
  }

  /** Legacy-compatible draft without project context */
  static async generateSimpleDraft(
    instructions: string,
    contextText: string
  ): Promise<string> {
    return LLMService.generateDraft(instructions, contextText);
  }

  static async applyMetadata(
    chapterId: string,
    condensed?: string,
    alsoSummary?: boolean
  ): Promise<void> {
    if (!condensed) return;
    if (alsoSummary) {
      await db.run(
        'UPDATE chapter SET condensed_content = ?, summary = COALESCE(NULLIF(summary, ""), ?) WHERE id = ?',
        condensed,
        condensed,
        chapterId
      );
    } else {
      await db.run(
        'UPDATE chapter SET condensed_content = ? WHERE id = ?',
        condensed,
        chapterId
      );
    }
  }

  /**
   * After content is accepted into the chapter, recompute condensed from full text.
   */
  static async regenerateCondensedFromChapter(
    projectId: number,
    chapterId: string
  ): Promise<string | undefined> {
    const chapter = await db.get(
      'SELECT content FROM chapter WHERE id = ? AND project_id = ?',
      chapterId,
      projectId
    );
    if (!chapter?.content) return undefined;
    const bundle = await loadWritingBundle(projectId, chapterId);
    const metaPrompt = formatPrompt(
      getPrompt('writing_metadata_gen', bundle.overrides),
      { content: head(String(chapter.content), BUDGET.metaContent) }
    );
    const meta = await LLMService.generateStructuredWithRetry(
      metaPrompt,
      MetadataSchema
    );
    if (meta?.condensed) {
      await WritingService.applyMetadata(chapterId, meta.condensed);
      return meta.condensed;
    }
    return undefined;
  }

  /**
   * Extract world delta (characters + glossary + visual tags) and chapter personality,
   * then optionally persist into character / glossary tables.
   * Personality → character.description; appearance → character.visual_tags.
   */
  static async analyzeChapterImpact(
    projectId: number,
    chapterId: string,
    apply: boolean = true
  ): Promise<ChapterImpactResult> {
    const bundle = await loadWritingBundle(projectId, chapterId);
    const chapter = bundle.chapters.find((c) => c.id === chapterId);
    if (!chapter) throw new Error('Chapter not found');

    const prompt = formatPrompt(getPrompt('analysis_impact', bundle.overrides), {
      characters: budgetedCharacters(bundle.characters),
      glossary: budgetedGlossary(bundle.glossary),
      chapterTitle: chapter.title,
      content: head(String(chapter.content || ''), 5000),
    });

    const [impactRaw, analysis] = await Promise.all([
      LLMService.generateStructuredWithRetry(prompt, ImpactSchema).then(
        (d) =>
          d || {
            newOrUpdatedCharacters: [] as z.infer<
              typeof ImpactSchema
            >['newOrUpdatedCharacters'],
            newOrUpdatedGlossary: [] as z.infer<
              typeof ImpactSchema
            >['newOrUpdatedGlossary'],
          }
      ),
      WritingService.analyzeChapterCharacters(projectId, chapterId).catch(
        (err) => {
          logger.warn(
            { err, projectId, chapterId },
            'analyzeChapterCharacters failed during chapter impact; continuing with impact delta only'
          );
          return { characters: [] } as ChapterCharacterAnalysis;
        }
      ),
    ]);

    const data = mergeImpactWithCharacterAnalysis(impactRaw, analysis);

    if (apply) {
      for (const ch of data.newOrUpdatedCharacters) {
        const existing = await db.get(
          `SELECT id, role, description, visual_tags FROM character
           WHERE project_id = ? AND TRIM(name) = TRIM(?) COLLATE NOCASE
           LIMIT 1`,
          projectId,
          ch.name
        );
        const personality = formatPersonalityBlock(ch);
        const impactBio = stripPersonalitySections(ch.description || '');
        const finalDesc = mergeCharacterDescription(
          existing?.description,
          impactBio,
          personality
        );
        const role =
          ch.role ||
          existing?.role ||
          mapRoleInChapterToRole(ch.roleInChapter) ||
          'supporting';
        const incomingVisual = normalizeVisualTags(ch.visual_tags);
        const mergedVisualDoc = mergeVisualTagsDocument(
          existing?.visual_tags,
          incomingVisual
        );
        const visualJson = JSON.stringify(mergedVisualDoc || {});

        if (existing) {
          await db.run(
            'UPDATE character SET role = ?, description = ?, visual_tags = ? WHERE id = ?',
            role,
            finalDesc || existing.description || '',
            visualJson,
            existing.id
          );
          ch.description = finalDesc || existing.description || '';
          ch.role = role;
          ch.visual_tags = Object.keys(incomingVisual).length
            ? incomingVisual
            : ch.visual_tags;
        } else {
          await db.run(
            'INSERT INTO character (project_id, name, role, description, visual_tags) VALUES (?, ?, ?, ?, ?)',
            projectId,
            ch.name,
            role,
            finalDesc || '',
            visualJson
          );
          ch.description = finalDesc || '';
          ch.role = role;
        }
      }
      for (const g of data.newOrUpdatedGlossary) {
        const existing = await db.get(
          'SELECT id FROM glossary WHERE project_id = ? AND term = ?',
          projectId,
          g.term
        );
        if (existing) {
          await db.run(
            'UPDATE glossary SET definition = COALESCE(?, definition), category = COALESCE(?, category) WHERE id = ?',
            g.definition ?? null,
            g.category ?? null,
            existing.id
          );
        } else {
          await db.run(
            'INSERT INTO glossary (project_id, term, definition, category) VALUES (?, ?, ?, ?)',
            projectId,
            g.term,
            g.definition ?? null,
            g.category ?? null
          );
        }
      }
    }

    return data;
  }

  /**
   * Read-only: characters + personality traits with evidence from chapter body.
   * Does not write to character DB by itself — APPLY_CHAPTER_IMPACT merges these
   * traits into character.description when finalizing a chapter.
   * Long chapters: paragraph chunks, then merge by character name.
   */
  static async analyzeChapterCharacters(
    projectId: number,
    chapterId: string
  ): Promise<ChapterCharacterAnalysis> {
    const bundle = await loadWritingBundle(projectId, chapterId);
    const chapter = bundle.chapters.find((c) => c.id === chapterId);
    if (!chapter) throw new Error('Chapter not found');
    const content = String(chapter.content || '').trim();
    if (!content) {
      return { characters: [] };
    }

    const chunks = splitChapterIntoAnalysisChunks(content, {
      maxChunkChars: 3500,
      maxChunks: 4,
    });

    const partials: ChapterCharacterAnalysis[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk?.trim()) continue;
      const label =
        chunks.length > 1
          ? `${chapter.title}（分段 ${i + 1}/${chunks.length}）`
          : chapter.title;
      const prompt = formatPrompt(
        getPrompt('analysis_chapter_characters', bundle.overrides),
        {
          chapterTitle: label,
          content: chunk,
        }
      );
      const data = await LLMService.generateStructuredWithRetry(
        prompt,
        ChapterCharacterAnalysisSchema,
        undefined,
        { temperature: 0.15, maxTokens: 1800, maxRetries: 2 }
      );
      if (data) {
        try {
          partials.push(ChapterCharacterAnalysisSchema.parse(data));
        } catch {
          /* skip bad partial */
        }
      }
    }

    if (!partials.length) {
      return { characters: [] };
    }
    return mergeChapterCharacterAnalyses(partials);
  }

  static async checkConsistency(
    projectId: number
  ): Promise<z.infer<typeof ConsistencySchema>['issues']> {
    const bundle = await loadWritingBundle(projectId, null);
    let outlines = bundle.chapters
      .map(
        (c) =>
          `#${c.index} ${c.title}: ${head(
            String(c.summary || c.condensed_content || '(no summary)'),
            120
          )}`
      )
      .join('\n');
    outlines = head(outlines, BUDGET.outlinesTotal);

    const prompt = formatPrompt(
      getPrompt('consistency_check', bundle.overrides),
      {
        title: bundle.bible.title,
        mainPlot: head(
          bundle.bible.main_plot || bundle.bible.description || '',
          BUDGET.mainPlot
        ),
        characters: budgetedCharacters(bundle.characters),
        outlines,
      }
    );

    const data = await LLMService.generateStructuredWithRetry(
      prompt,
      ConsistencySchema
    );
    return data?.issues || [];
  }

  static async executeSkill(options: {
    projectId: number;
    chapterId: string;
    skill:
      | { op: 'CINEMATIC_REWRITE'; technique: string; instructions: string }
      | {
          op: 'ADD_CONFLICT';
          conflictType: string;
          intensity: string;
          instructions?: string;
        }
      | {
          op: 'REVERSE_PLOT';
          reversalType: string;
          targetCharacter?: string;
          instructions?: string;
        };
  }): Promise<string> {
    const bundle = await loadWritingBundle(options.projectId, options.chapterId);
    const chapter = bundle.chapters.find((c) => c.id === options.chapterId);
    if (!chapter) throw new Error('Chapter not found');

    const contextSummary = head(
      `Title: ${bundle.bible.title}\nGenre: ${bundle.bible.genre || ''}\nChapter: ${chapter.title}\nSummary: ${chapter.summary || ''}`,
      500
    );
    const content = head(
      String(chapter.content || '(No content, write from summary)'),
      BUDGET.skillContent
    );

    let prompt = '';
    const skill = options.skill;

    if (skill.op === 'CINEMATIC_REWRITE') {
      const techniqueInstr: Record<string, string> = {
        montage: '蒙太奇：快节奏转场，跳过流水账，聚焦变化与对比。',
        close_up: '特写：微表情、生理反应、关键物件细节。',
        sensory: '感官沉浸：视听嗅触与温度氛围。',
      };
      prompt = formatPrompt(getPrompt('skill_cinematic', bundle.overrides), {
        technique: skill.technique,
        techniqueInstructions: techniqueInstr[skill.technique] || skill.technique,
        instructions: skill.instructions,
        context: contextSummary,
        content,
      });
    } else if (skill.op === 'ADD_CONFLICT') {
      const typeInstr: Record<string, string> = {
        variable_intrusion: '变量侵入：第三方/意外事件打破平衡。',
        extreme_pressure: '极限施压：时间/生存/两难逼迫立刻行动。',
      };
      prompt = formatPrompt(getPrompt('skill_conflict', bundle.overrides), {
        type: skill.conflictType,
        typeInstructions: typeInstr[skill.conflictType] || skill.conflictType,
        intensity: skill.intensity,
        context: contextSummary,
        content,
      });
    } else {
      const typeInstr: Record<string, string> = {
        motive_switch: '动机偷梁换柱：行为相同，隐藏动机相反。',
        character_peel: '人设剥洋葱：揭示与标签矛盾的隐藏层。',
      };
      prompt = formatPrompt(getPrompt('skill_reversal', bundle.overrides), {
        type: skill.reversalType,
        typeInstructions: typeInstr[skill.reversalType] || skill.reversalType,
        target: skill.targetCharacter || '主角或关键配角',
        context: contextSummary,
        content,
      });
    }

    const provider = LLMService.getProvider();
    return stripThink(await provider.generateText(prompt));
  }

  static async loadBundleForAgent(projectId: number, chapterId?: string | null) {
    return loadWritingBundle(projectId, chapterId);
  }
}
