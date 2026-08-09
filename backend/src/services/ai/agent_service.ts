import { z } from 'zod';
import { AgentRequest, AgentResponse } from '../../schemas/agent';
import {
  AgentActionSchema,
  AgentOsDecisionSchema,
  needsConfirmation,
  type AgentOsDecision,
} from '../../schemas/agent_os';
import { logger } from '../../core/logging';
import { LLMService } from '../llm';
import { WritingService } from './writing_service';
import { buildProjectStructure } from './layered_context';
import { formatPrompt, getPrompt, type PromptKey } from './prompt_registry';
import { AgentExecutor } from './agent_executor';

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** Normalize legacy single-action shapes into Agent OS multi-action. */
function coerceDecision(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  if (Array.isArray(raw.actions)) return raw;
  // Legacy: { thought, response, action: { tool_name, arguments } }
  if (raw.action && raw.action.tool_name) {
    const mapped = mapLegacyTool(raw.action);
    return {
      thought: raw.thought || '',
      response: raw.response || '',
      actions: mapped ? [mapped] : [],
    };
  }
  // Single action object with op
  if (raw.action && raw.action.op) {
    return {
      thought: raw.thought || '',
      response: raw.response || '',
      actions: [raw.action],
    };
  }
  if (raw.op) {
    return {
      thought: raw.thought || '',
      response: raw.response || raw.answer || '',
      actions: [raw],
    };
  }
  if (typeof raw.response === 'string' && !raw.actions) {
    return {
      thought: raw.thought || '',
      response: raw.response,
      actions: raw.response
        ? [{ op: 'ANSWER_QUESTION', answer: raw.response }]
        : [],
    };
  }
  return raw;
}

function mapLegacyTool(action: {
  tool_name: string;
  arguments?: Record<string, any>;
}): Record<string, any> | null {
  const args = action.arguments || {};
  switch (action.tool_name) {
    case 'analyze_chapter':
      return { op: 'ANALYZE_CHAPTER', chapterId: args.chapter_id };
    case 'generate_timeline':
      return { op: 'GENERATE_TIMELINE', chapterId: args.chapter_id };
    case 'get_character_info':
      return { op: 'GET_CHARACTER', name: args.name };
    case 'update_character_info':
      return {
        op: 'UPDATE_CHARACTER',
        name: args.name,
        description: args.description,
        visual_tags: args.visual_tags,
      };
    default:
      return null;
  }
}

export class AgentService {
  async processRequest(request: AgentRequest): Promise<AgentResponse> {
    try {
      const projectId = request.context.project_id;
      if (!projectId) {
        // Fallback: pure chat without project
        return this.projectlessChat(request);
      }

      const decision = await this.decide(request, projectId);
      const actions = decision.actions || [];
      const confirm = needsConfirmation(actions);

      // Auto-run read-only actions so the user gets answers immediately
      let autoNotes: string[] = [];
      if (!confirm && actions.length > 0) {
        const results = await AgentExecutor.executeAll(actions, {
          projectId,
          chapterId: request.context.chapter_id,
          language: request.context.language,
          apply: true,
        });
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
        responseText += '\n\n' + autoNotes.join('\n');
      }

      // Legacy single action for old clients
      const firstMutating = actions.find((a: any) =>
        needsConfirmation([a])
      );

      return {
        thought: decision.thought,
        response: responseText,
        actions: actions as any[],
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
        needs_confirmation: false,
      };
    }
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
      needs_confirmation: false,
    };
  }

  private async decide(
    request: AgentRequest,
    projectId: number
  ): Promise<AgentOsDecision> {
    const bundle = await WritingService.loadBundleForAgent(
      projectId,
      request.context.chapter_id
    );
    const overrides = (bundle.settings.agent_prompts_override || null) as
      | Partial<Record<PromptKey, string>>
      | null;

    const active =
      bundle.chapters.find((c) => c.id === bundle.activeId) ||
      bundle.chapters[0];

    const history = (request.history || [])
      .slice(-8)
      .map((m: any) => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const content = String(m.content || '').slice(0, 300);
        return `${role}: ${content}`;
      })
      .join('\n');

    const characterList = bundle.characters
      .slice(0, 15)
      .map((c: any) => c.name)
      .join(', ');

    const basePrompt = formatPrompt(getPrompt('agent_core', overrides), {
      title: bundle.bible.title,
      activeChapterTitle: active?.title || 'None',
      activeChapterId: active?.id || 'None',
      activeChapterSummary: active?.summary || 'None',
      routeHint: request.context.route || 'unknown',
      history: history || '(empty)',
      projectStructure: buildProjectStructure(bundle.chapters),
      genre: bundle.bible.genre || '',
      style: bundle.bible.style || '',
      mainPlot: (bundle.bible.main_plot || '').slice(0, 400),
      characterList,
      userMessage: request.message,
    });

    // Loose object schema for provider JSON Schema path (temp 0.1 / Ollama structured).
    // Full discriminated-union validation happens after with AgentOsDecisionSchema.
    const LooseDecisionSchema = z.object({
      thought: z.string(),
      response: z.string().optional().default(''),
      actions: z.array(z.record(z.string(), z.any())).default([]),
    });

    const MAX_RETRIES = 2;
    let prompt = basePrompt;
    let lastError = '';
    let lastRaw = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const structured = await LLMService.generateStructuredWithRetry(
          prompt,
          LooseDecisionSchema
        );
        if (!structured) {
          throw new Error('Structured decision empty');
        }
        lastRaw = JSON.stringify(structured).slice(0, 1000);
        const rawData = coerceDecision(structured);
        const parsed = AgentOsDecisionSchema.safeParse(rawData);
        if (parsed.success) {
          return parsed.data;
        }
        const filtered = (rawData.actions || []).filter(
          (a: any) => AgentActionSchema.safeParse(a).success
        );
        const second = AgentOsDecisionSchema.safeParse({
          thought: rawData.thought || structured.thought,
          response: rawData.response || structured.response || '',
          actions: filtered,
        });
        if (second.success) {
          return second.data;
        }
        lastError = parsed.error.toString();
        logger.warn(
          `Agent schema validation failed attempt ${attempt + 1}: ${lastError}`
        );
        if (attempt < MAX_RETRIES) {
          const repair = formatPrompt(getPrompt('agent_repair', overrides), {
            errorMessage: lastError,
            invalidOutput: lastRaw,
          });
          prompt = basePrompt + '\n\n' + repair;
        }
      } catch (e: any) {
        lastError = e?.message || String(e);
        logger.warn(`Agent decide attempt ${attempt + 1} error: ${lastError}`);
        if (attempt >= MAX_RETRIES) break;
        const repair = formatPrompt(getPrompt('agent_repair', overrides), {
          errorMessage: lastError,
          invalidOutput: lastRaw || lastError,
        });
        prompt = basePrompt + '\n\n' + repair;
      }
    }

    return {
      thought: 'Failed to parse structured plan after retries',
      response:
        '抱歉，本地模型未能生成有效的操作计划。请换一种说法重试，或检查 Ollama 是否正常。',
      actions: [
        {
          op: 'ANSWER_QUESTION',
          answer:
            '系统解析失败。你可以尝试更短、更明确的指令，例如：“把当前章重命名为决战前夕”。',
        },
      ],
    };
  }
}
