import { z } from 'zod';
import { db } from '../../db/database';
import { logger } from '../../core/logging';
import { parseProjectSettings } from '../project_settings';
import { LLMService } from '../llm';
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

const MetadataSchema = z.object({
  condensed: z.string(),
  nextPlot: z.string().optional().default(''),
});

const ImpactSchema = z.object({
  newOrUpdatedCharacters: z
    .array(
      z.object({
        name: z.string(),
        role: z.string().optional().nullable(),
        description: z.string().optional().nullable(),
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
      existing = source ? source.slice(-BUDGET.existingContent) : '';
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
      existingContent: existing || '(空 — 请从章纲开写)',
      nextChapterConstraint: nextConstraint,
      instructions: options.instructions,
      targetWordCount: options.targetWordCount || 800,
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

  static async analyzeChapterImpact(
    projectId: number,
    chapterId: string,
    apply: boolean = true
  ): Promise<z.infer<typeof ImpactSchema>> {
    const bundle = await loadWritingBundle(projectId, chapterId);
    const chapter = bundle.chapters.find((c) => c.id === chapterId);
    if (!chapter) throw new Error('Chapter not found');

    const prompt = formatPrompt(getPrompt('analysis_impact', bundle.overrides), {
      characters: budgetedCharacters(bundle.characters),
      glossary: budgetedGlossary(bundle.glossary),
      chapterTitle: chapter.title,
      content: head(String(chapter.content || ''), 5000),
    });

    const data =
      (await LLMService.generateStructuredWithRetry(prompt, ImpactSchema)) || {
        newOrUpdatedCharacters: [],
        newOrUpdatedGlossary: [],
      };

    if (apply) {
      for (const ch of data.newOrUpdatedCharacters) {
        const existing = await db.get(
          'SELECT id FROM character WHERE project_id = ? AND name = ?',
          projectId,
          ch.name
        );
        if (existing) {
          await db.run(
            'UPDATE character SET role = COALESCE(?, role), description = COALESCE(?, description) WHERE id = ?',
            ch.role ?? null,
            ch.description ?? null,
            existing.id
          );
        } else {
          await db.run(
            'INSERT INTO character (project_id, name, role, description, visual_tags) VALUES (?, ?, ?, ?, ?)',
            projectId,
            ch.name,
            ch.role || 'supporting',
            ch.description || '',
            '{}'
          );
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
