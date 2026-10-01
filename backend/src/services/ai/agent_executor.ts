import { randomUUID } from 'node:crypto';
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
import { StoryPlanService } from '../story_plan_service';
import { StoryPlanningService } from './story_planning_service';
import { CHAPTER_CONTENT_UNFINALIZE_SQL, PlanningError } from '../../schemas/story_plan';
import { ScriptService } from '../script_service';
import {
  ScriptGenerationService,
  ScriptGenerationError,
} from './script_generation_service';

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
  surface?: 'story' | 'script' | 'director' | 'characters' | 'settings' | null;
  scriptId?: number | null;
  scriptSceneId?: string | null;
  token?: string;
  provider?: any;
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

function parseSceneOrdinal(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    return value > 0 ? value : null;
  }
  const digit: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (token === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(token)) return 10 + (digit[token[1]!] || 0);
  if (/^[一二三四五六七八九]十$/.test(token)) return (digit[token[0]!] || 0) * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(token)) {
    return (digit[token[0]!] || 0) * 10 + (digit[token[2]!] || 0);
  }
  if (token.length === 1 && digit[token]) return digit[token];
  return null;
}

/**
 * Turn a route hint into a scene id that exists on the document.
 * Ordinals win over the editor selection. Unrelated text does not.
 */
export function resolveScriptSceneTarget(
  scenes: Array<{ id: string }>,
  hints: {
    actionSceneId?: string | null;
    instructions?: string | null;
    contextSceneId?: string | null;
  }
): string | null {
  const known = new Set(scenes.map((scene) => scene.id));
  const actionSceneId = (hints.actionSceneId || '').trim();
  if (actionSceneId && known.has(actionSceneId)) return actionSceneId;

  const text = `${actionSceneId} ${hints.instructions || ''}`;
  const ordinal = text.match(/第\s*([0-9一二三四五六七八九十]+)\s*场/);
  if (ordinal) {
    const index = parseSceneOrdinal(ordinal[1] || '');
    if (index && scenes[index - 1]) return scenes[index - 1]!.id;
    return null;
  }

  const asksForCurrent = /当前场|这一场|当前分场|选定分场/.test(text);
  const contextSceneId = (hints.contextSceneId || '').trim();
  if (asksForCurrent && contextSceneId && known.has(contextSceneId)) {
    return contextSceneId;
  }
  if (!actionSceneId && contextSceneId && known.has(contextSceneId)) {
    return contextSceneId;
  }
  return null;
}

async function currentPlanRevision(projectId: number): Promise<number> {
  try {
    const view = await StoryPlanService.getView(projectId);
    return view.revision;
  } catch (error) {
    if (error instanceof PlanningError && error.code === 'PLAN_NOT_FOUND') return 1;
    throw error;
  }
}

async function assertChapterInProject(
  chapterId: string,
  projectId: number
): Promise<any> {
  const chapter = await db.get(
    'SELECT * FROM chapter WHERE id = ?',
    chapterId
  );
  if (!chapter) {
    throw new Error(`Chapter ${chapterId} not found in project ${projectId}`);
  }
  if (chapter.project_id !== projectId) {
    throw new Error(
      `Cross-project chapter reference rejected: Chapter ${chapterId} belongs to project ${chapter.project_id}, not ${projectId}`
    );
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
    await StoryPlanService.reorderFromChapters(projectId);
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
    await StoryPlanService.retireLinkedChapter(projectId, chapterId);
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
    const parsed: any = AgentActionSchema.parse(normalized);
    const rawSurface =
      raw && typeof raw === 'object' && typeof (raw as any).surface === 'string'
        ? (raw as any).surface
        : (normalized && typeof normalized === 'object' && typeof (normalized as any).surface === 'string'
          ? (normalized as any).surface
          : undefined);
    if (rawSurface && !parsed.surface) {
      parsed.surface = rawSurface;
    }
    return parsed;
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
        if (ctx.surface === 'script' || (action as any).surface === 'script') {
          return {
            op,
            status: 'error',
            message: '在剧本页面禁止直接调用小说正文重写或续写，请使用短剧剧本生成与分场改写服务',
          };
        }

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

        try {
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

          if (!draft.content || !draft.content.trim()) {
            return {
              op,
              status: 'error',
              message: '模型返回空内容，未修改章节正文',
              data: { chapterId },
            };
          }

          // Final body that should appear in the editor / DB
          let finalContent = draft.content;
          let condensed = draft.condensed;

          if (ctx.apply) {
            if (replaceMode) {
              finalContent = draft.content;
            } else {
              const chapter = await db.get(
                'SELECT content FROM chapter WHERE id = ?',
                chapterId
              );
              finalContent =
                (chapter?.content ? String(chapter.content) + '\n\n' : '') +
                draft.content;
            }

            const regeneratedCondensed =
              await WritingService.generateCondensedForContent(
                ctx.projectId,
                finalContent,
                chapterId
              );
            condensed = regeneratedCondensed;
            await db.run(
              `UPDATE chapter SET content = ?, condensed_content = ?, ${CHAPTER_CONTENT_UNFINALIZE_SQL} WHERE id = ?`,
              finalContent,
              condensed,
              chapterId
            );
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
        } catch (e: any) {
          logger.warn(`DRAFT_CONTENT failed: ${e?.message || e}`);
          return {
            op,
            status: 'error',
            message: e?.message || String(e),
            data: { chapterId },
          };
        }
      }

      case 'UPDATE_CHAPTER_SUMMARY': {
        const chapter = await assertChapterInProject(action.chapterId, ctx.projectId);
        if (ctx.apply) {
          await StoryPlanService.updateLinkedChapterFields(ctx.projectId, action.chapterId, {
            summary: action.newSummary,
          });
        }
        return {
          op,
          status: 'success',
          message: chapter.status === 'completed'
            ? '章纲已更新。正文未改，可能与已定稿内容不一致。'
            : `Summary updated for ${action.chapterId}`,
          data: { chapterId: action.chapterId, summary: action.newSummary },
        };
      }

      case 'RENAME_CHAPTER': {
        await assertChapterInProject(action.chapterId, ctx.projectId);
        if (ctx.apply) {
          await StoryPlanService.updateLinkedChapterFields(ctx.projectId, action.chapterId, {
            title: action.newTitle,
          });
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
        if (ctx.surface === 'script' || (action as any).surface === 'script') {
          return {
            op,
            status: 'error',
            message: '在剧本页面禁止直接调用小说正文技能覆盖章节，请使用剧本分场改写服务',
          };
        }

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
        try {
          const rewritten = await WritingService.executeSkill({
            projectId: ctx.projectId,
            chapterId,
            skill: skillArg,
          });
          if (!rewritten || !rewritten.trim()) {
            return {
              op,
              status: 'error',
              message: '技能执行返回空内容，未修改章节正文',
              data: { chapterId },
            };
          }
          if (ctx.apply) {
            const condensed = await WritingService.generateCondensedForContent(
              ctx.projectId,
              rewritten,
              chapterId
            );
            await db.run(
              `UPDATE chapter SET content = ?, condensed_content = ?, ${CHAPTER_CONTENT_UNFINALIZE_SQL} WHERE id = ?`,
              rewritten,
              condensed,
              chapterId
            );
          }
          return {
            op,
            status: 'success',
            message: ctx.apply ? 'Skill rewrite applied' : 'Skill rewrite ready',
            data: { chapterId, content: rewritten, applied: ctx.apply },
          };
        } catch (e: any) {
          logger.warn(`Skill rewrite failed: ${e?.message || e}`);
          return {
            op,
            status: 'error',
            message: e?.message || String(e),
            data: { chapterId },
          };
        }
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
        if (impact.mainPlotChanged) notes.push('timeline→main_plot');
        if (impact.characterRelationsChanged) notes.push('relationships→character_relations');
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

      case 'GENERATE_SCRIPT_OUTLINE': {
        const chapterId = action.chapterId || ctx.chapterId;
        if (!chapterId) {
          return { op, status: 'error', message: '请指定要生成改编提纲的章节' };
        }
        await assertChapterInProject(chapterId, ctx.projectId);
        try {
          const script = await ScriptService.createOrGetScript(chapterId);
          const requestKey = `agent_outline_${chapterId}_${Date.now()}`;
          const candidate = await ScriptGenerationService.generateOutlineCandidate({
            scriptId: script.id,
            expectedRevision: script.revision,
            requestKey,
            instructions: action.instructions,
            token: ctx.token,
            provider: ctx.provider,
          });
          return {
            op,
            status: 'success',
            message: '已生成短剧改编提纲候选，请在剧本编辑器中审核采纳',
            data: {
              chapterId,
              scriptId: script.id,
              candidateId: candidate.id,
              candidateRevision: candidate.candidate_revision,
              candidate,
            },
          };
        } catch (e: any) {
          logger.warn(`GENERATE_SCRIPT_OUTLINE failed: ${e?.message || e}`);
          return {
            op,
            status: 'error',
            message: e?.message || String(e),
            data: { chapterId },
          };
        }
      }

      case 'GENERATE_SCRIPT': {
        const chapterId = action.chapterId || ctx.chapterId;
        if (!chapterId) {
          return { op, status: 'error', message: '请指定要生成剧本的章节' };
        }
        await assertChapterInProject(chapterId, ctx.projectId);
        try {
          const script = await ScriptService.createOrGetScript(chapterId);
          const requestKey = `agent_script_${chapterId}_${Date.now()}`;
          const candidate = await ScriptGenerationService.generateFullScriptCandidate({
            scriptId: script.id,
            expectedRevision: script.revision,
            requestKey,
            instructions: action.instructions,
            token: ctx.token,
            provider: ctx.provider,
          });
          return {
            op,
            status: 'success',
            message: '已生成完整分场短剧剧本候选，请在剧本编辑器中审核采纳',
            data: {
              chapterId,
              scriptId: script.id,
              candidateId: candidate.id,
              candidateRevision: candidate.candidate_revision,
              candidate,
            },
          };
        } catch (e: any) {
          logger.warn(`GENERATE_SCRIPT failed: ${e?.message || e}`);
          return {
            op,
            status: 'error',
            message: e?.message || String(e),
            data: { chapterId },
          };
        }
      }

      case 'REWRITE_SCRIPT_SCENE': {
        const chapterId = action.chapterId || ctx.chapterId;
        if (!chapterId) {
          return { op, status: 'error', message: '请指定章节' };
        }
        await assertChapterInProject(chapterId, ctx.projectId);
        let targetSceneId: string | null = null;
        try {
          const script = await ScriptService.createOrGetScript(chapterId);
          targetSceneId = resolveScriptSceneTarget(script.document.scenes, {
            actionSceneId: action.scriptSceneId,
            instructions: action.instructions,
            contextSceneId: ctx.scriptSceneId,
          });
          if (!targetSceneId) {
            return {
              op,
              status: 'error',
              message: '请指定要改写的分场。在剧本页选定一场，或说明第几场。',
            };
          }
          const requestKey = `agent_rewrite_${chapterId}_${targetSceneId}_${Date.now()}`;
          const candidate = await ScriptGenerationService.generateSceneRewriteCandidate({
            scriptId: script.id,
            targetSceneId,
            expectedRevision: script.revision,
            requestKey,
            instructions: action.instructions,
            token: ctx.token,
            provider: ctx.provider,
          });
          return {
            op,
            status: 'success',
            message: `已生成第 ${script.document.scenes.findIndex((scene) => scene.id === targetSceneId) + 1} 场的改写候选，请在剧本编辑器中审核采纳`,
            data: {
              chapterId,
              scriptId: script.id,
              candidateId: candidate.id,
              targetSceneId,
              candidateRevision: candidate.candidate_revision,
              candidate,
            },
          };
        } catch (e: any) {
          logger.warn(`REWRITE_SCRIPT_SCENE failed: ${e?.message || e}`);
          return {
            op,
            status: 'error',
            message: e?.message || String(e),
            data: { chapterId, scriptSceneId: targetSceneId },
          };
        }
      }

      case 'PLAN_STORY':
      case 'PLAN_CHAPTERS': {
        try {
          const revision = await currentPlanRevision(ctx.projectId);
          const instructions = String(action.instructions || '');
          const requestKey = action.requestKey
            || `agent:${op}:${randomUUID()}`;
          const candidate = op === 'PLAN_STORY'
            ? await StoryPlanningService.generateBlueprint({
                projectId: ctx.projectId,
                requestKey,
                expectedRevision: revision,
                message: instructions,
                history: action.history,
              })
            : await StoryPlanningService.generateChapters({
                projectId: ctx.projectId,
                requestKey,
                expectedRevision: revision,
                message: instructions,
                history: action.history,
                mode: action.mode || 'extend',
                targetPlanIds: action.targetPlanIds,
                batchSize: action.batchSize,
              });
          if (candidate?.state !== 'pending') {
            const generating = candidate?.state === 'generating';
            const stale = candidate?.state === 'stale';
            return {
              op,
              status: 'error',
              message: generating
                ? '规划仍在生成，请稍后查看故事页'
                : stale
                  ? '规划候选已过期，请根据最新内容重新生成'
                  : '该规划请求已经结束，请重新生成',
              data: {
                code: candidate?.error_code || (generating ? 'GENERATION_IN_PROGRESS' : stale ? 'SOURCE_CHANGED' : 'REQUEST_NOT_FINISHED'),
                candidate_id: candidate?.id,
                candidate,
              },
            };
          }
          return {
            op,
            status: 'success',
            message: op === 'PLAN_STORY'
              ? '已生成开书设定候选，请在故事页审核后采纳'
              : '已生成章节规划候选，请在故事页审核后采纳',
            data: {
              candidate_id: candidate?.id,
              candidate,
            },
          };
        } catch (error: any) {
          return {
            op,
            status: 'error',
            message: error?.message || String(error),
            data: { code: error?.code },
          };
        }
      }

      case 'CREATE_NEXT_CHAPTER': {
        if (!ctx.apply) {
          return { op, status: 'success', message: '确认后将创建下一章', data: {} };
        }
        try {
          const view = await StoryPlanService.getView(ctx.projectId);
          const chapters = (await db.all(
            'SELECT id, "index" AS idx FROM chapter WHERE project_id = ? ORDER BY "index" ASC, id ASC',
            ctx.projectId
          )) as Array<{ id: string; idx: number }>;
          const last = chapters.at(-1);
          const entryId = action.planEntryId || view.next_entry_id;
          if (!entryId) {
            return { op, status: 'error', message: '没有可创建的下一条规划', data: { code: 'NO_PENDING_PLAN' } };
          }
          const result = await StoryPlanService.createNextChapter({
            project_id: ctx.projectId,
            plan_entry_id: entryId,
            expected_revision: action.expectedRevision || view.revision,
            expected_last_chapter_id: action.expectedLastChapterId ?? (last?.id || null),
            request_key: action.requestKey || `agent-next:${ctx.projectId}:${entryId}:${view.revision}:${last?.id || 'none'}`,
          });
          return {
            op,
            status: 'success',
            message: result.reused ? '下一章已经创建' : '已按规划创建下一章',
            data: { chapter: result.chapter, plan_revision: result.plan_revision, reused: result.reused },
          };
        } catch (error: any) {
          return {
            op,
            status: 'error',
            message: error?.message || String(error),
            data: { code: error?.code },
          };
        }
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
