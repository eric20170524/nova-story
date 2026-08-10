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

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export class AgentService {
  async processRequest(request: AgentRequest): Promise<AgentResponse> {
    try {
      const projectId = request.context.project_id;
      if (!projectId) {
        return this.projectlessChat(request);
      }

      const decision = await this.decide(request, projectId);
      let actions = decision.actions || [];
      const confirm = needsConfirmation(actions);

      // Auto-run read-only actions so the user gets answers immediately
      let autoNotes: string[] = [];
      let autoResults: any[] = [];
      if (!confirm && actions.length > 0) {
        // ANSWER_QUESTION with placeholder: expand via free-text if answer is just the user message
        actions = await this.hydrateAnswerQuestions(actions, request);

        const results = await AgentExecutor.executeAll(actions, {
          projectId,
          chapterId: request.context.chapter_id,
          language: request.context.language,
          apply: true,
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
      routeHint: request.context.route,
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
