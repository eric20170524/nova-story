import { db } from '../../db/database';
import { logger } from '../../core/logging';
import { LLMService } from '../llm';
import { parseProjectSettings, serializeProjectSettings } from '../project_settings';
import { generateAndReplaceNarrativeTimeline } from '../timeline_generation_service';
import {
  AgentActionSchema,
  normalizeAgentAction,
  type AgentAction,
} from '../../schemas/agent_os';
import { WritingService } from './writing_service';

export type ExecuteItemResult = {
  op: string;
  status: 'success' | 'error' | 'skipped';
  message?: string;
  data?: unknown;
};

export type ExecuteContext = {
  projectId: number;
  chapterId?: string | null;
  language?: string | null;
  apply: boolean;
};

/**
 * Detect full-chapter rewrite vs continue-writing for DRAFT_CONTENT.
 * User rewrites (小说化 / 全文重写 / 去掉画面动作指令) must REPLACE body, not append.
 */
export function isFullChapterRewriteIntent(instructions: string): boolean {
  const s = String(instructions || '');
  if (!s.trim()) return false;
  return /重写|全文|改写|整章|替换正文|不是剧本|非剧本|小说写法|小说体|去掉.*画面|不要.*画面|删除.*画面|动作指令|分镜格式|screenplay|rewrite|replace\s+(the\s+)?(whole|entire|full)|novel\s*prose|not\s+a\s+script/i.test(
    s
  );
}

async function assertChapterInProject(
  chapterId: string,
  projectId: number
): Promise<any> {
  const chapter = await db.get(
    'SELECT * FROM chapter WHERE id = ? AND project_id = ?',
    chapterId,
    projectId
  );
  if (!chapter) {
    throw new Error(`Chapter ${chapterId} not found in project ${projectId}`);
  }
  return chapter;
}

async function moveChapterInProject(
  chapterId: string,
  projectId: number,
  newIndex: number
): Promise<void> {
  const chapter = await assertChapterInProject(chapterId, projectId);
  if (chapter.index === newIndex) return;

  await db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    if (newIndex > chapter.index) {
      await db.run(
        'UPDATE chapter SET "index" = "index" - 1 WHERE project_id = ? AND id <> ? AND "index" > ? AND "index" <= ?',
        projectId,
        chapterId,
        chapter.index,
        newIndex
      );
    } else {
      await db.run(
        'UPDATE chapter SET "index" = "index" + 1 WHERE project_id = ? AND id <> ? AND "index" >= ? AND "index" < ?',
        projectId,
        chapterId,
        newIndex,
        chapter.index
      );
    }
    await db.run(
      'UPDATE chapter SET "index" = ? WHERE id = ?',
      newIndex,
      chapterId
    );
    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
}

async function deleteChapterCascade(chapterId: string, projectId: number): Promise<void> {
  await assertChapterInProject(chapterId, projectId);
  await db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    await db.run(
      `DELETE FROM coverage_shot
       WHERE coverage_group_id IN (
         SELECT coverage_group.id
         FROM coverage_group
         INNER JOIN scene ON scene.id = coverage_group.source_scene_id
         WHERE scene.chapter_id = ?
       )`,
      chapterId
    );
    await db.run(
      `DELETE FROM coverage_group
       WHERE source_scene_id IN (
         SELECT id FROM scene WHERE chapter_id = ?
       )`,
      chapterId
    );
    await db.run('DELETE FROM scene WHERE chapter_id = ?', chapterId);
    await db.run('DELETE FROM chapter WHERE id = ?', chapterId);
    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
}

export class AgentExecutor {
  static parseAction(raw: unknown): AgentAction {
    // Accept nested/aliased LLM shapes at execute time too (confirm card path)
    const normalized = normalizeAgentAction(raw) || raw;
    return AgentActionSchema.parse(normalized);
  }

  static async executeAll(
    rawActions: unknown[],
    ctx: ExecuteContext
  ): Promise<ExecuteItemResult[]> {
    const results: ExecuteItemResult[] = [];
    for (const raw of rawActions) {
      try {
        const action = AgentExecutor.parseAction(raw);
        const result = await AgentExecutor.executeOne(action, ctx);
        results.push(result);
      } catch (e: any) {
        logger.error(`Agent execute failed: ${e}`);
        const nestedOp =
          raw && typeof raw === 'object' && (raw as any).op && typeof (raw as any).op === 'object'
            ? (raw as any).op?.type || (raw as any).op?.op
            : (raw as any)?.op;
        results.push({
          op: nestedOp || 'unknown',
          status: 'error',
          message: e?.message || String(e),
        });
      }
    }
    return results;
  }

  static async executeOne(
    action: AgentAction,
    ctx: ExecuteContext
  ): Promise<ExecuteItemResult> {
    const op = action.op;

    switch (action.op) {
      case 'ANSWER_QUESTION':
        return {
          op,
          status: 'success',
          message: action.answer,
          data: { answer: action.answer },
        };

      case 'QUERY_DATABASE': {
        const q = action.query.toLowerCase();
        const chars = await db.all(
          'SELECT name, role, description FROM character WHERE project_id = ?',
          ctx.projectId
        );
        const gloss = await db.all(
          'SELECT term, definition, category FROM glossary WHERE project_id = ?',
          ctx.projectId
        );
        const chapters = await db.all(
          'SELECT id, title, "index", summary, status FROM chapter WHERE project_id = ? ORDER BY "index"',
          ctx.projectId
        );
        const filtered = {
          characters: chars.filter(
            (c: any) =>
              !q ||
              String(c.name).toLowerCase().includes(q) ||
              String(c.description || '')
                .toLowerCase()
                .includes(q)
          ),
          glossary: gloss.filter(
            (g: any) =>
              !q ||
              String(g.term).toLowerCase().includes(q) ||
              String(g.definition || '')
                .toLowerCase()
                .includes(q)
          ),
          chapters: chapters.filter(
            (c: any) =>
              !q ||
              String(c.title).toLowerCase().includes(q) ||
              String(c.summary || '')
                .toLowerCase()
                .includes(q)
          ),
        };
        return {
          op,
          status: 'success',
          message: `Found ${filtered.characters.length} chars, ${filtered.glossary.length} terms, ${filtered.chapters.length} chapters`,
          data: filtered,
        };
      }

      case 'DRAFT_CONTENT': {
        const chapterId =
          action.targetChapterId || ctx.chapterId || undefined;
        if (!chapterId) {
          return { op, status: 'error', message: 'No chapter id for draft' };
        }
        await assertChapterInProject(chapterId, ctx.projectId);

        const replaceMode = isFullChapterRewriteIntent(action.instructions);
        const rewriteInstructions = replaceMode
          ? `${action.instructions}\n\n【强制格式】输出完整小说正文：禁止保留【场景】【画面】【动作指令】【视觉特效】等分镜/剧本标签；用连贯叙述与感官描写重写全章，不要只写续写片段。`
          : action.instructions;

        const draft = await WritingService.generateChapterDraft({
          projectId: ctx.projectId,
          chapterId,
          instructions: rewriteInstructions,
          targetWordCount: action.targetWordCount || (replaceMode ? 1200 : undefined),
          includeExisting: true,
          // Rewrite: treat existing body as source text to transform, not a tail to extend
          mode: replaceMode ? 'rewrite' : 'append',
          // Metadata only when applying; previews must not pollute DB
          generateMetadata: false,
        });

        // Final body that should appear in the editor / DB
        let finalContent = draft.content;
        let condensed = draft.condensed;

        if (ctx.apply) {
          if (replaceMode) {
            finalContent = draft.content;
            await db.run(
              'UPDATE chapter SET content = ? WHERE id = ?',
              finalContent,
              chapterId
            );
          } else {
            const chapter = await db.get(
              'SELECT content FROM chapter WHERE id = ?',
              chapterId
            );
            finalContent =
              (chapter?.content ? String(chapter.content) + '\n\n' : '') +
              draft.content;
            await db.run(
              'UPDATE chapter SET content = ? WHERE id = ?',
              finalContent,
              chapterId
            );
          }
          // Condensed must describe the full accepted chapter
          condensed =
            (await WritingService.regenerateCondensedFromChapter(
              ctx.projectId,
              chapterId
            )) || condensed;
        }

        return {
          op,
          status: 'success',
          message: ctx.apply
            ? replaceMode
              ? 'Chapter rewritten (replaced full body)'
              : 'Draft applied to chapter (appended)'
            : 'Draft generated (not applied)',
          data: {
            chapterId,
            // Always return the FULL chapter body for UI sync
            content: finalContent,
            fragment: replaceMode ? undefined : draft.content,
            mode: replaceMode ? 'rewrite' : 'append',
            condensed,
            nextPlot: draft.nextPlot,
            applied: ctx.apply,
          },
        };
      }

      case 'UPDATE_CHAPTER_SUMMARY': {
        await assertChapterInProject(action.chapterId, ctx.projectId);
        if (ctx.apply) {
          await db.run(
            'UPDATE chapter SET summary = ? WHERE id = ?',
            action.newSummary,
            action.chapterId
          );
        }
        return {
          op,
          status: 'success',
          message: `Summary updated for ${action.chapterId}`,
          data: { chapterId: action.chapterId, summary: action.newSummary },
        };
      }

      case 'RENAME_CHAPTER': {
        await assertChapterInProject(action.chapterId, ctx.projectId);
        if (ctx.apply) {
          await db.run(
            'UPDATE chapter SET title = ? WHERE id = ?',
            action.newTitle,
            action.chapterId
          );
        }
        return {
          op,
          status: 'success',
          message: `Renamed to ${action.newTitle}`,
          data: { chapterId: action.chapterId, title: action.newTitle },
        };
      }

      case 'DELETE_CHAPTER': {
        if (ctx.apply) {
          await deleteChapterCascade(action.chapterId, ctx.projectId);
        } else {
          await assertChapterInProject(action.chapterId, ctx.projectId);
        }
        return {
          op,
          status: 'success',
          message: ctx.apply
            ? `Deleted chapter ${action.chapterId}`
            : `Would delete ${action.chapterId}`,
          data: { chapterId: action.chapterId, reason: action.reason },
        };
      }

      case 'MOVE_CHAPTER': {
        if (ctx.apply) {
          await moveChapterInProject(
            action.chapterId,
            ctx.projectId,
            action.positionIndex
          );
        } else {
          await assertChapterInProject(action.chapterId, ctx.projectId);
        }
        return {
          op,
          status: 'success',
          message: `Moved chapter to index ${action.positionIndex}`,
          data: {
            chapterId: action.chapterId,
            positionIndex: action.positionIndex,
          },
        };
      }

      case 'UPDATE_PROJECT_META': {
        const project = await db.get(
          'SELECT * FROM project WHERE id = ?',
          ctx.projectId
        );
        if (!project) {
          return { op, status: 'error', message: 'Project not found' };
        }
        if (ctx.apply) {
          const settings = parseProjectSettings(project.settings);
          if (action.genre !== undefined) settings.genre = action.genre;
          if (action.style !== undefined) settings.style = action.style;
          if (action.main_plot !== undefined)
            settings.main_plot = action.main_plot;
          if (action.character_relations !== undefined) {
            settings.character_relations = action.character_relations;
          }
          const title = action.title ?? project.title;
          const description =
            action.description !== undefined
              ? action.description
              : project.description;
          await db.run(
            'UPDATE project SET title = ?, description = ?, settings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            title,
            description,
            serializeProjectSettings(settings),
            ctx.projectId
          );
        }
        return {
          op,
          status: 'success',
          message: 'Project meta updated',
          data: action,
        };
      }

      case 'CINEMATIC_REWRITE':
      case 'ADD_CONFLICT':
      case 'REVERSE_PLOT': {
        const chapterId =
          (action as any).targetChapterId || ctx.chapterId || undefined;
        if (!chapterId) {
          return { op, status: 'error', message: 'No chapter for skill' };
        }
        await assertChapterInProject(chapterId, ctx.projectId);
        let skillArg: any;
        if (action.op === 'CINEMATIC_REWRITE') {
          skillArg = {
            op: 'CINEMATIC_REWRITE' as const,
            technique: action.technique,
            instructions: action.instructions,
          };
        } else if (action.op === 'ADD_CONFLICT') {
          skillArg = {
            op: 'ADD_CONFLICT' as const,
            conflictType: action.conflictType,
            intensity: action.intensity || 'high',
            instructions: action.instructions,
          };
        } else {
          skillArg = {
            op: 'REVERSE_PLOT' as const,
            reversalType: action.reversalType,
            targetCharacter: action.targetCharacter,
            instructions: action.instructions,
          };
        }
        const rewritten = await WritingService.executeSkill({
          projectId: ctx.projectId,
          chapterId,
          skill: skillArg,
        });
        if (ctx.apply) {
          await db.run(
            'UPDATE chapter SET content = ? WHERE id = ?',
            rewritten,
            chapterId
          );
        }
        return {
          op,
          status: 'success',
          message: ctx.apply ? 'Skill rewrite applied' : 'Skill rewrite ready',
          data: { chapterId, content: rewritten, applied: ctx.apply },
        };
      }

      case 'RUN_CONSISTENCY_CHECK': {
        const issues = await WritingService.checkConsistency(ctx.projectId);
        return {
          op,
          status: 'success',
          message: `Found ${issues.length} issue(s)`,
          data: { issues },
        };
      }

      case 'APPLY_CHAPTER_IMPACT': {
        const chapterId = action.chapterId || ctx.chapterId;
        if (!chapterId) {
          return { op, status: 'error', message: 'No chapter for impact' };
        }
        await assertChapterInProject(chapterId, ctx.projectId);
        const impact = await WritingService.analyzeChapterImpact(
          ctx.projectId,
          chapterId,
          ctx.apply
        );
        const nChars = impact.newOrUpdatedCharacters?.length || 0;
        const nTerms = impact.newOrUpdatedGlossary?.length || 0;
        const notes: string[] = [];
        if (impact.personalityMerged) {
          notes.push('personality→description');
        }
        if (impact.visualTagsMerged) {
          notes.push('appearance→visual_tags');
        }
        const noteStr = notes.length ? `; ${notes.join(', ')}` : '';
        return {
          op,
          status: 'success',
          message: ctx.apply
            ? `World state updated from chapter (${nChars} character(s), ${nTerms} term(s)${noteStr})`
            : `Impact analyzed (not applied): ${nChars} character(s), ${nTerms} term(s)${noteStr}`,
          data: impact,
        };
      }

      case 'GENERATE_TIMELINE': {
        const chapterId = action.chapterId || ctx.chapterId;
        if (!chapterId) {
          return { op, status: 'error', message: 'No chapter for timeline' };
        }
        const chapter = await assertChapterInProject(chapterId, ctx.projectId);
        if (!chapter.content) {
          return { op, status: 'error', message: 'Chapter empty' };
        }
        if (!ctx.apply) {
          return {
            op,
            status: 'success',
            message: 'Would generate timeline',
            data: { chapterId },
          };
        }
        const result = await generateAndReplaceNarrativeTimeline({
          chapterId,
          projectId: ctx.projectId,
          content: String(chapter.content),
          mode: action.mode || 'narrative',
        });
        return {
          op,
          status: 'success',
          message: `Generated ${result.count} scenes`,
          data: {
            chapterId,
            count: result.count,
            storyboard_mode: result.storyboard_mode,
          },
        };
      }

      case 'ANALYZE_CHAPTER': {
        const chapterId = action.chapterId || ctx.chapterId;
        if (!chapterId) {
          return { op, status: 'error', message: 'No chapter' };
        }
        const chapter = await assertChapterInProject(chapterId, ctx.projectId);
        if (!chapter.content) {
          return { op, status: 'error', message: 'Chapter empty' };
        }
        const analysis = await LLMService.analyzeContent(chapter.content);
        return {
          op,
          status: 'success',
          message: 'Analysis complete',
          data: analysis,
        };
      }

      case 'ANALYZE_CHAPTER_CHARACTERS': {
        const chapterId = action.chapterId || ctx.chapterId;
        if (!chapterId) {
          return { op, status: 'error', message: 'No chapter for character analysis' };
        }
        await assertChapterInProject(chapterId, ctx.projectId);
        const analysis = await WritingService.analyzeChapterCharacters(
          ctx.projectId,
          chapterId
        );
        const n = analysis.characters?.length || 0;
        return {
          op,
          status: 'success',
          message:
            n > 0
              ? `Extracted ${n} character(s) with traits (read-only)`
              : 'No characters extracted (empty or model failed)',
          data: { chapterId, ...analysis, applied: false },
        };
      }

      case 'GET_CHARACTER': {
        const char = await db.get(
          'SELECT * FROM character WHERE name = ? AND project_id = ?',
          action.name,
          ctx.projectId
        );
        if (!char) {
          return { op, status: 'error', message: 'Character not found' };
        }
        return {
          op,
          status: 'success',
          message: `Character ${char.name}`,
          data: char,
        };
      }

      case 'UPDATE_CHARACTER': {
        const char = await db.get(
          'SELECT * FROM character WHERE name = ? AND project_id = ?',
          action.name,
          ctx.projectId
        );
        if (!char) {
          return { op, status: 'error', message: 'Character not found' };
        }
        if (ctx.apply) {
          const updates: string[] = [];
          const params: unknown[] = [];
          if (action.description) {
            updates.push('description = ?');
            params.push(action.description);
          }
          if (action.visual_tags) {
            updates.push('visual_tags = ?');
            params.push(JSON.stringify(action.visual_tags));
          }
          if (updates.length) {
            params.push(char.id);
            await db.run(
              `UPDATE character SET ${updates.join(', ')} WHERE id = ?`,
              ...params
            );
          }
        }
        return {
          op,
          status: 'success',
          message: `Updated character ${action.name}`,
          data: action,
        };
      }

      default:
        return {
          op: (action as any).op || 'unknown',
          status: 'error',
          message: 'Unknown op',
        };
    }
  }
}
