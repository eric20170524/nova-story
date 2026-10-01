import { AgentRequest, AgentResponse } from '../../schemas/agent';
import {
  needsConfirmation,
  type AgentOsDecision,
} from '../../schemas/agent_os';
import { logger } from '../../core/logging';
import { LLMService } from '../llm';
import { WritingService } from './writing_service';
import {
  decisionFromRoute,
  freeTextAnswerFallback,
  resolveAgentRoute,
} from './agent_route';
import { AgentExecutor } from './agent_executor';
import { StoryPlanningService } from './story_planning_service';
import { extractExplicitSummary, resolvePlanOrdinal } from '../../schemas/story_plan';
import { StoryPlanService } from '../story_plan_service';

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export function usesStoryIdeation(
  context: { conversation_mode?: string | null; surface?: string | null },
  preferredOp?: string | null
): boolean {
  return context.conversation_mode === 'ideation'
    && context.surface === 'story'
    && preferredOp !== 'PLAN_STORY'
    && preferredOp !== 'PLAN_CHAPTERS'
    && preferredOp !== 'CREATE_NEXT_CHAPTER';
}

export class AgentService {
  async processRequest(request: AgentRequest): Promise<AgentResponse> {
    try {
      const projectId = request.context.project_id;
      if (!projectId) {
        return this.projectlessChat(request);
      }

      const preferredOp =
        request.context.preferred_op
        || null;
      const ideation = usesStoryIdeation(request.context, preferredOp);
      if (ideation) {
        const reply = await StoryPlanningService.brainstorm(
          projectId,
          request.message,
          request.history as Array<{ role?: string; content?: string }>
        );
        return {
          thought: 'ideation',
          response: reply,
          actions: [{ op: 'ANSWER_QUESTION', answer: reply }],
          results: [],
          needs_confirmation: false,
        };
      }

      const decision = await this.decide(request, projectId);
      let actions: any[] = [];
      for (const action of decision.actions || []) {
        const planning = request.context.planning;
        if (action.op === 'PLAN_STORY') {
          actions.push({
            ...action,
            instructions: request.message,
            requestKey: planning?.requestKey || action.requestKey,
            history: request.history,
          });
          continue;
        }
        if (action.op === 'PLAN_CHAPTERS') {
          actions.push(await this.attachPlanChapterTargets(action, request, projectId));
          continue;
        }
        if (action.op === 'CREATE_NEXT_CHAPTER') {
          actions.push({
            ...action,
            instructions: request.message,
            requestKey: planning?.requestKey || action.requestKey,
          });
          continue;
        }
        if (action.op === 'UPDATE_CHAPTER_SUMMARY') {
          const explicit = extractExplicitSummary(request.message);
          actions.push(explicit ? { ...action, newSummary: explicit } : action);
          continue;
        }
        actions.push(action);
      }
      const confirm = needsConfirmation(actions);

      // Auto-run read-only actions so the user gets answers immediately
      let autoNotes: string[] = [];
      let autoResults: any[] = [];
      if (!confirm && actions.length > 0) {
        // ANSWER_QUESTION with placeholder: expand via free-text if answer is just the user message
        actions = await this.hydrateAnswerQuestions(actions, request);

        const surface =
          request.context.surface ||
          (request.context.route === 'script' ? 'script' : undefined);
        const results = await AgentExecutor.executeAll(actions, {
          projectId,
          chapterId: request.context.chapter_id,
          language: request.context.language,
          apply: true,
          surface: surface as any,
          scriptId: request.context.script_id,
          scriptSceneId: request.context.script_scene_id,
        });
        autoResults = results;
        autoNotes = results.map(
          (r) =>
            `[${r.op}] ${r.status}${r.message ? ': ' + r.message : ''}`
        );
      }

      // Build user-facing response
      let responseText = decision.response || '';
      if (!responseText) {
        const answer = actions.find((a: any) => a.op === 'ANSWER_QUESTION') as
          | { answer?: string }
          | undefined;
        responseText = answer?.answer || (actions.length
          ? `计划执行 ${actions.length} 步操作，请确认。`
          : '好的。');
      }
      if (autoNotes.length) {
        // Keep notes short for character analysis (card shows detail)
        const hasRichCard = autoResults.some(
          (r) =>
            r.op === 'ANALYZE_CHAPTER_CHARACTERS'
            || r.op === 'ANALYZE_CHAPTER'
            || r.op === 'RUN_CONSISTENCY_CHECK'
            || r.op === 'PLAN_STORY'
            || r.op === 'PLAN_CHAPTERS'
        );
        if (!hasRichCard) {
          responseText += '\n\n' + autoNotes.join('\n');
        }
      }

      const firstMutating = actions.find((a: any) => needsConfirmation([a]));

      return {
        thought: decision.thought,
        response: responseText,
        actions: actions as any[],
        results: autoResults,
        needs_confirmation: confirm && actions.length > 0,
        action: firstMutating
          ? {
              tool_name: (firstMutating as any).op,
              arguments: firstMutating as any,
              reason: decision.thought,
            }
          : null,
      };
    } catch (error) {
      logger.error(`Agent processing failed: ${error}`);
      return {
        thought: 'System Error',
        response:
          '处理请求时发生内部错误。请稍后重试，或检查本地 LLM 是否已启动。',
        actions: [],
        results: [],
        needs_confirmation: false,
      };
    }
  }

  /**
   * A revise request such as “改写第一章规划” has no ids yet.
   * Keep an explicit target list, and otherwise map the ordinal onto the live plan.
   */
  private async attachPlanChapterTargets(action: any, request: AgentRequest, projectId: number) {
    const planning = request.context.planning;
    const mode = planning?.mode && planning.mode !== 'blueprint' ? planning.mode : action.mode;
    const explicit = planning?.targetPlanIds?.length
      ? planning.targetPlanIds
      : (Array.isArray(action.targetPlanIds) && action.targetPlanIds.length ? action.targetPlanIds : undefined);
    let targetPlanIds = explicit;
    if (mode === 'revise' && !targetPlanIds?.length) {
      targetPlanIds = await this.resolveReviseTarget(projectId, request.message);
    }
    return {
      ...action,
      instructions: request.message,
      mode,
      targetPlanIds,
      batchSize: planning?.batchSize || action.batchSize,
      requestKey: planning?.requestKey || action.requestKey,
      history: request.history,
    };
  }

  private async resolveReviseTarget(projectId: number, message: string): Promise<string[] | undefined> {
    try {
      const view = await StoryPlanService.getView(projectId);
      const id = resolvePlanOrdinal(view.document.chapters, message);
      return id ? [id] : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * When route maps to ANSWER_QUESTION with focus==userMessage, generate a real reply.
   */
  private async hydrateAnswerQuestions(
    actions: any[],
    request: AgentRequest
  ): Promise<any[]> {
    const out = [];
    for (const a of actions) {
      if (a.op !== 'ANSWER_QUESTION') {
        out.push(a);
        continue;
      }
      const ans = String(a.answer || '').trim();
      const msg = String(request.message || '').trim();
      if (ans && ans !== msg && ans.length > msg.length + 20) {
        out.push(a);
        continue;
      }
      try {
        const provider = LLMService.getProvider();
        const text = await provider.generateText(
          msg,
          '你是 NovaStory 写作助手。用简体中文简洁回答用户关于剧本/章节/角色的问题。不要假装已修改数据库。'
        );
        out.push({ op: 'ANSWER_QUESTION', answer: stripThink(text) || ans || msg });
      } catch {
        out.push(a);
      }
    }
    return out;
  }

  private async projectlessChat(request: AgentRequest): Promise<AgentResponse> {
    const provider = LLMService.getProvider();
    const lang =
      request.context.language === 'en' ? 'English' : 'Simplified Chinese';
    const text = await provider.generateText(
      request.message,
      `You are NovaStory assistant. Reply in ${lang}. No tools available without a project context.`
    );
    return {
      thought: 'No project context',
      response: stripThink(text),
      actions: [],
      results: [],
      needs_confirmation: false,
    };
  }

  /**
   * P0: preferred_op / keyword shortcut / strict mini Route Schema / free-text fallback.
   * No loose actions[] planner.
   */
  private async decide(
    request: AgentRequest,
    projectId: number
  ): Promise<AgentOsDecision> {
    const preferredOp =
      (request.context as any)?.preferred_op
      || (request.context as any)?.preferredOp
      || null;

    let chapterTitle: string | null = null;
    let overrides: Partial<Record<string, string>> | null = null;
    try {
      const bundle = await WritingService.loadBundleForAgent(
        projectId,
        request.context.chapter_id
      );
      const active =
        bundle.chapters.find((c) => c.id === bundle.activeId) ||
        bundle.chapters[0];
      chapterTitle = active?.title || null;
      overrides =
        (bundle.settings?.agent_prompts_override as Partial<
          Record<string, string>
        > | null) || null;
    } catch {
      /* ignore */
    }

    const history = (request.history || [])
      .slice(-4)
      .map((m: any) => {
        const role = m.role === 'user' ? 'U' : 'A';
        return `${role}:${String(m.content || '').slice(0, 120)}`;
      })
      .join('\n');

    const resolved = await resolveAgentRoute({
      userMessage: request.message,
      chapterId: request.context.chapter_id,
      chapterTitle,
      routeHint: request.context.route || request.context.surface || null,
      preferredOp,
      historyTail: history,
      overrides: overrides as any,
    });

    if (resolved) {
      logger.info(
        `Agent route OK source=${resolved.source} intent=${resolved.route.intent}`
      );
      return decisionFromRoute(resolved.route, {
        chapterId: request.context.chapter_id,
        userMessage: request.message,
      });
    }

    logger.warn('Agent route failed — free-text fallback');
    return freeTextAnswerFallback(
      request.message,
      `project=${projectId} chapter=${request.context.chapter_id || 'none'} page=${request.context.route || '?'}`
    );
  }
}
