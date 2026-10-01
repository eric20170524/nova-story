import { z } from 'zod';
import { db } from '../../db/database';
import { LLMService } from '../llm';
import { parseProjectSettings } from '../project_settings';
import { formatPrompt, getPrompt } from './prompt_registry';
import { StoryPlanService } from '../story_plan_service';
import {
  GeneratedChapterFieldsSchema,
  PlanPatch,
  PlannedChapter,
  PlanningError,
  StoryBlueprintSchema,
  StoryPlanDocument,
  StoryPlanDocumentSchema,
  activePlanEntries,
  assertPlanningBudget,
  coerceChapterPayload,
  hashCanonical,
  newPlanEntryId,
  normalizeBlueprintInput,
  orderPlanEntries,
} from '../../schemas/story_plan';

const HISTORY_BUDGET = 4500;

const GeneratedChaptersSchema = z.object({
  chapters: z.array(GeneratedChapterFieldsSchema).min(1).max(5),
}).strict();

const RevisedChapterSchema = GeneratedChapterFieldsSchema.extend({
  id: z.string().min(1),
}).strict();

const RevisedChaptersSchema = z.object({
  chapters: z.array(RevisedChapterSchema).min(1).max(5),
}).strict();

type HistoryTurn = { role?: string; content?: string };

export type PlanGenerationRequest = {
  projectId: number;
  requestKey: string;
  expectedRevision: number;
  message: string;
  history?: HistoryTurn[];
  mode?: 'initial' | 'extend' | 'revise';
  targetPlanIds?: string[];
  batchSize?: number;
};

function historyText(history: HistoryTurn[] | undefined, message: string): string {
  const turns = [...(history || [])];
  const last = turns[turns.length - 1];
  if (last && (last.role || 'user') === 'user' && String(last.content || '').trim() === message.trim()) {
    turns.pop();
  }
  let text = turns
    .map((turn) => `${turn.role === 'assistant' ? '助手' : '用户'}: ${String(turn.content || '').trim()}`)
    .filter((line) => line.length > 2)
    .join('\n');
  if (text.length > HISTORY_BUDGET) text = text.slice(-HISTORY_BUDGET);
  return text;
}

function foldBlueprint(raw: unknown) {
  const normalized = normalizeBlueprintInput(raw);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
  const source = normalized as Record<string, any>;
  const characters = Array.isArray(source.characters)
    ? source.characters.slice(0, 20).map((row) => {
        const extra = [
          row?.coreDesire ? `核心欲望：${row.coreDesire}` : '',
          row?.fear ? `恐惧：${row.fear}` : '',
          row?.maskAndTruth ? `反差：${row.maskAndTruth}` : '',
          row?.logic ? `行为逻辑：${row.logic}` : '',
        ].filter(Boolean);
        return {
          name: String(row?.name || '').trim(),
          role: row?.role,
          description: [String(row?.description || '').trim(), ...extra].filter(Boolean).join('\n'),
          personality: String(row?.personality || ''),
          growthPath: String(row?.growthPath || ''),
        };
      })
    : [];
  const glossary = Array.isArray(source.glossary)
    ? source.glossary.slice(0, 30).map((item) => ({
        term: String(item?.term || '').trim(),
        definition: String(item?.definition || ''),
        category: String(item?.category || ''),
      }))
    : [];
  return {
    title: source.title,
    genre: String(source.genre || ''),
    style: String(source.style || ''),
    summary: source.summary,
    mainPlot: String(source.mainPlot || source.main_plot || ''),
    initialRelations: String(source.initialRelations || source.characterRelations || source.character_relations || ''),
    plannedRelations: String(source.plannedRelations || ''),
    characters,
    glossary,
  };
}

async function projectContext(projectId: number) {
  const project = await db.get('SELECT * FROM project WHERE id = ?', projectId);
  if (!project) throw new PlanningError('PROJECT_NOT_FOUND', 404, '项目不存在');
  const settings = parseProjectSettings(project.settings);
  const plan = await db.get('SELECT revision, document_json FROM story_plan WHERE project_id = ?', projectId);
  const document = plan
    ? StoryPlanDocumentSchema.parse(JSON.parse(String(plan.document_json)))
    : null;
  const chapters = (await db.all(
    'SELECT id, title, summary, content, status, plan_entry_id, "index" AS idx FROM chapter WHERE project_id = ? ORDER BY "index" ASC',
    projectId
  )) as any[];
  return { project, settings, document, revision: plan ? Number(plan.revision) : 1, chapters };
}

function pacingInstruction(mode: string, batchSize: number, endingPolicy: string): string {
  if (endingPolicy === 'conclude') {
    return '作者要求收束。新章节应推向结局，不要再无限展开支线。';
  }
  if (mode === 'initial' && batchSize >= 3) {
    return '这是开篇规划。前三章遵守黄金三章：危机或信息反差开篇、展示转机、第一个小高潮。不要提前写完全书结局。';
  }
  return '继续发展故事。不要假设已经接近结局，也不要强行收束全书。';
}

function linkedRefs(chapters: any[]) {
  return chapters
    .filter((chapter) => chapter.plan_entry_id)
    .map((chapter) => ({ plan_entry_id: String(chapter.plan_entry_id), index: Number(chapter.idx) }));
}

export class StoryPlanningService {
  static async brainstorm(projectId: number, message: string, history?: HistoryTurn[]): Promise<string> {
    const context = await projectContext(projectId);
    const prompt = formatPrompt(getPrompt('brainstorm_chat', context.settings.agent_prompts_override), {
      history: historyText(history, message),
      message,
    });
    const provider = LLMService.getProvider();
    const text = await provider.generateText(prompt);
    const reply = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!reply) throw new PlanningError('MODEL_EMPTY', 502, '构思对话没有返回内容');
    return reply;
  }

  static async generateBlueprint(request: PlanGenerationRequest) {
    const history = historyText(request.history, request.message);
    const requestHash = hashCanonical({
      kind: 'blueprint',
      message: request.message,
      history,
      expectedRevision: request.expectedRevision,
    });
    const row = await StoryPlanService.beginGeneration({
      projectId: request.projectId,
      kind: 'blueprint',
      requestKey: request.requestKey,
      requestHash,
      expectedRevision: request.expectedRevision,
      payload: { message: request.message, history },
    });
    if (!row?.created) {
      const listed = await StoryPlanService.listCandidates(request.projectId, request.requestKey);
      return listed[0] || row;
    }
    try {
      const context = await projectContext(request.projectId);
      const prompt = formatPrompt(getPrompt('structure_novel_gen', context.settings.agent_prompts_override), {
        conversationContext: `用户本轮：${request.message}\n\n历史：\n${history || '（无）'}`,
        instructions: request.message,
      });
      const raw = await LLMService.generateStructuredWithRetry(
        `${prompt}\n\n只返回设定 JSON。角色 role 只能是 protagonist、antagonist、supporting、extra。把核心欲望、恐惧、反差和行为逻辑写进 description，不要另起这些字段。`,
        z.any()
      );
      if (!raw || (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw as object).length === 0)) {
        throw new PlanningError('MODEL_EMPTY', 502, '开书设定没有返回内容');
      }
      const blueprint = StoryBlueprintSchema.parse(foldBlueprint(raw));
      const current = context.document || StoryPlanDocumentSchema.parse({
        schemaVersion: 1,
        blueprint: null,
        targetTotalWords: null,
        chapters: [],
      });
      const after = StoryPlanDocumentSchema.parse({ ...current, blueprint });
      const patches = StoryPlanService.buildBlueprintPatches({
        title: context.project.title,
        description: context.project.description,
        genre: typeof context.settings.genre === 'string' ? context.settings.genre : '',
        style: typeof context.settings.style === 'string' ? context.settings.style : '',
        initialRelations: typeof context.settings.initial_relations === 'string'
          ? context.settings.initial_relations
          : '',
      }, blueprint);
      return await StoryPlanService.finishGeneration({
        projectId: request.projectId,
        changeId: String(row.id),
        after,
        patches,
        targetPlanIds: [],
      });
    } catch (error) {
      await this.failRow(request.projectId, String(row.id), error);
      throw error;
    }
  }

  static async generateChapters(request: PlanGenerationRequest) {
    let mode = request.mode || 'extend';
    const batchSize = Math.min(5, Math.max(1, request.batchSize || 3));
    const targetPlanIds = [...new Set(request.targetPlanIds || [])];
    const history = historyText(request.history, request.message);
    const context = await projectContext(request.projectId);
    const document = context.document;
    if (mode === 'initial' && document && activePlanEntries(document.chapters).length > 0) {
      mode = 'extend';
    }
    if (mode === 'revise') {
      if (!document) throw new PlanningError('PLAN_NOT_FOUND', 404, '还没有章节规划');
      this.assertReviseTargets(document, context.chapters, targetPlanIds);
    }
    const requestHash = hashCanonical({
      kind: 'chapters',
      mode,
      message: request.message,
      history,
      targetPlanIds,
      batchSize,
      expectedRevision: request.expectedRevision,
    });
    const row = await StoryPlanService.beginGeneration({
      projectId: request.projectId,
      kind: 'chapters',
      requestKey: request.requestKey,
      requestHash,
      expectedRevision: request.expectedRevision,
      payload: { mode, message: request.message, history, targetPlanIds, batchSize },
    });
    if (!row?.created) {
      const listed = await StoryPlanService.listCandidates(request.projectId, request.requestKey);
      return listed[0] || row;
    }
    try {
      const fresh = await projectContext(request.projectId);
      const base = fresh.document;
      if (!base) throw new PlanningError('PLAN_NOT_FOUND', 500, '规划初始化失败');
      if (mode === 'initial' && activePlanEntries(base.chapters).length > 0) {
        throw new PlanningError('PLAN_ALREADY_EXISTS', 409, '已经有章节规划，请改为扩展');
      }
      if (mode === 'revise') this.assertReviseTargets(base, fresh.chapters, targetPlanIds);
      const afterChapters = mode === 'revise'
        ? await this.reviseEntries(fresh, request.message, history, targetPlanIds)
        : this.assignEntries(base, await this.generateEntryFields(fresh, request.message, history, mode, batchSize), fresh.chapters);
      const after = StoryPlanDocumentSchema.parse({ ...base, chapters: afterChapters });
      assertPlanningBudget(after, fresh.chapters);
      const patches: PlanPatch[] = StoryPlanService.buildChapterPatches(
        mode,
        base.chapters,
        after.chapters,
        targetPlanIds
      );
      return await StoryPlanService.finishGeneration({
        projectId: request.projectId,
        changeId: String(row.id),
        after,
        patches,
        targetPlanIds,
      });
    } catch (error) {
      await this.failRow(request.projectId, String(row.id), error);
      throw error;
    }
  }

  private static assertReviseTargets(document: StoryPlanDocument, chapters: any[], targetPlanIds: string[]) {
    if (!targetPlanIds.length) {
      throw new PlanningError('TARGET_SET_MISMATCH', 422, '请指定要修订的规划条目');
    }
    const known = new Set(document.chapters.map((entry) => entry.id));
    if (targetPlanIds.some((id) => !known.has(id))) {
      throw new PlanningError('TARGET_SET_MISMATCH', 422, '修订目标与当前规划不一致');
    }
    const finalized = new Set(
      chapters.filter((chapter) => chapter.status === 'completed' && chapter.plan_entry_id).map((chapter) => String(chapter.plan_entry_id))
    );
    if (targetPlanIds.some((id) => finalized.has(id))) {
      throw new PlanningError('TARGET_FINALIZED', 409, '已定稿章节的规划默认锁定');
    }
  }

  private static async generateEntryFields(
    context: Awaited<ReturnType<typeof projectContext>>,
    message: string,
    history: string,
    mode: 'initial' | 'extend',
    batchSize: number
  ): Promise<Array<z.infer<typeof GeneratedChapterFieldsSchema>>> {
    const document = context.document!;
    const future = activePlanEntries(document.chapters)
      .filter((entry) => !context.chapters.some((chapter) => chapter.plan_entry_id === entry.id))
      .map((entry) => `${entry.title}：${entry.summary}`)
      .join('\n');
    const last = context.chapters.at(-1);
    const lastChapterContext = last
      ? `${last.title}\n${String(last.summary || '').trim() || String(last.content || '').slice(-400)}`
      : '尚无已写章节';
    const promptKey = mode === 'initial' ? 'structure_volume_gen' : 'structure_extend';
    const prompt = formatPrompt(getPrompt(promptKey, context.settings.agent_prompts_override), {
      title: context.project.title,
      genre: String(context.settings.genre || document.blueprint?.genre || ''),
      summary: document.blueprint?.summary || context.project.description || '',
      mainPlot: document.blueprint?.mainPlot || '',
      contentForm: '短篇小说',
      lastChapterContext,
      chapterCount: batchSize,
      instructions: `${message}\n\n历史：\n${history || '（无）'}`,
      pacingInstruction: pacingInstruction(mode, batchSize, document.endingPolicy),
      existingFuturePlans: future || '（无）',
    });
    const raw = await LLMService.generateStructuredWithRetry(
      `${prompt}\n\n必须返回 {"chapters":[...]}，数量正好是 ${batchSize}。不要自行编号或指定插入位置。`,
      z.any()
    );
    if (!raw) throw new PlanningError('MODEL_EMPTY', 502, '章节规划没有返回内容');
    const parsed = GeneratedChaptersSchema.safeParse(coerceChapterPayload(raw));
    if (!parsed.success) throw new PlanningError('MODEL_INVALID_OUTPUT', 502, '章节规划格式无效');
    if (parsed.data.chapters.length !== batchSize) {
      throw new PlanningError('MODEL_INVALID_OUTPUT', 502, `需要 ${batchSize} 条章节规划`);
    }
    return parsed.data.chapters;
  }

  private static assignEntries(
    document: StoryPlanDocument,
    generated: Array<z.infer<typeof GeneratedChapterFieldsSchema>>,
    chapters: any[]
  ): PlannedChapter[] {
    const created: PlannedChapter[] = generated.map((entry) => ({
      id: newPlanEntryId(),
      title: entry.title,
      summary: entry.summary,
      targetWordCount: entry.targetWordCount,
      disposition: 'active',
    }));
    return orderPlanEntries([...document.chapters, ...created], linkedRefs(chapters));
  }

  private static async reviseEntries(
    context: Awaited<ReturnType<typeof projectContext>>,
    message: string,
    history: string,
    targetPlanIds: string[]
  ): Promise<PlannedChapter[]> {
    const document = context.document!;
    const targets = targetPlanIds.map((id) => document.chapters.find((entry) => entry.id === id)!);
    const prompt = formatPrompt(getPrompt('structure_revise', context.settings.agent_prompts_override), {
      title: context.project.title,
      instructions: `${message}\n\n历史：\n${history || '（无）'}`,
      targetPlans: JSON.stringify(targets.map((entry) => ({
        id: entry.id,
        title: entry.title,
        summary: entry.summary,
        targetWordCount: entry.targetWordCount,
      }))),
      targetIds: targetPlanIds.join(','),
    });
    const raw = await LLMService.generateStructuredWithRetry(prompt, z.any());
    if (!raw) throw new PlanningError('MODEL_EMPTY', 502, '规划修订没有返回内容');
    const parsed = RevisedChaptersSchema.safeParse(coerceChapterPayload(raw));
    if (!parsed.success) throw new PlanningError('MODEL_INVALID_OUTPUT', 502, '规划修订格式无效');
    const returned = parsed.data.chapters.map((entry) => entry.id);
    const unique = new Set(returned);
    const expected = new Set(targetPlanIds);
    if (unique.size !== expected.size || returned.length !== targetPlanIds.length || [...expected].some((id) => !unique.has(id))) {
      throw new PlanningError('TARGET_SET_MISMATCH', 422, '修订结果必须正好覆盖指定条目');
    }
    const byId = new Map(parsed.data.chapters.map((entry) => [entry.id, entry]));
    return document.chapters.map((entry) => {
      const revised = byId.get(entry.id);
      if (!revised) return entry;
      return {
        ...entry,
        title: revised.title,
        summary: revised.summary,
        targetWordCount: revised.targetWordCount,
      };
    });
  }

  private static async failRow(projectId: number, changeId: string, error: unknown) {
    const code = error instanceof PlanningError ? error.code : 'MODEL_INVALID_OUTPUT';
    const message = error instanceof Error ? error.message : String(error);
    await StoryPlanService.failGeneration(projectId, changeId, code, message);
  }
}
