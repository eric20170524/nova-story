/**
 * Strict intent router for Agent OS (8B-friendly).
 * Maps user message → AgentRoute → deterministic actions.
 */
import {
  AgentRouteSchema,
  routeToActions,
  tryIntentShortcut,
  type AgentOsDecision,
  type AgentRoute,
} from '../../schemas/agent_os';
import { logger } from '../../core/logging';
import { LLMService } from '../llm';
import { formatPrompt, getPrompt, type PromptKey } from './prompt_registry';

const ROUTE_SYSTEM = `You are a routing kernel for NovaStory. Output ONLY JSON matching the schema.
Pick exactly one intent. Do not invent nested objects. Do not answer the user question in this step.
chapterScope=current means use the active chapter; none means project-wide or N/A.
focus = short parameter text (rename title, character name, rewrite focus) — keep under 200 chars.`;

export type RouteDecideInput = {
  userMessage: string;
  chapterId?: string | null;
  chapterTitle?: string | null;
  routeHint?: string | null;
  /** UI chip preferred op — highest priority */
  preferredOp?: string | null;
  historyTail?: string;
  overrides?: Partial<Record<PromptKey, string>> | null;
};

export type RouteDecideResult = {
  decision: AgentOsDecision;
  source: 'shortcut' | 'preferred_op' | 'llm_route' | 'free_text_fallback';
  route?: AgentRoute;
};

/** Build slim route prompt — no full bible, no chapter tree dump. */
export function buildRoutePrompt(input: RouteDecideInput): string {
  const template = getPrompt('agent_route', input.overrides);
  return formatPrompt(template, {
    routeHint: input.routeHint || 'unknown',
    chapterTitle: input.chapterTitle || 'None',
    chapterId: input.chapterId || 'None',
    history: input.historyTail || '(empty)',
    userMessage: input.userMessage,
  });
}

/**
 * Resolve route: preferred_op / keyword shortcut / strict LLM schema / null.
 */
export async function resolveAgentRoute(
  input: RouteDecideInput
): Promise<{ route: AgentRoute; source: RouteDecideResult['source'] } | null> {
  const shortcut = tryIntentShortcut(input.userMessage, input.preferredOp);
  if (shortcut) {
    const parsed = AgentRouteSchema.safeParse(shortcut);
    if (parsed.success) {
      return {
        route: parsed.data,
        source: input.preferredOp ? 'preferred_op' : 'shortcut',
      };
    }
  }

  try {
    const prompt = buildRoutePrompt(input);
    const raw = await LLMService.generateStructuredWithRetry(
      prompt,
      AgentRouteSchema,
      undefined,
      {
        maxRetries: 2,
        temperature: 0,
        maxTokens: 160,
        systemInstruction: ROUTE_SYSTEM,
      }
    );
    if (!raw) return null;
    const parsed = AgentRouteSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(`Route schema parse failed: ${parsed.error}`);
      return null;
    }
    return { route: parsed.data, source: 'llm_route' };
  } catch (e: any) {
    logger.warn(`Route LLM failed: ${e?.message || e}`);
    return null;
  }
}

export function decisionFromRoute(
  route: AgentRoute,
  ctx: { chapterId?: string | null; userMessage: string },
  responseText?: string
): AgentOsDecision {
  const actions = routeToActions(route, ctx);
  return {
    thought: `route:${route.intent}`,
    response:
      responseText
      || defaultResponseForIntent(route.intent, ctx.userMessage),
    actions: actions as any,
  };
}

function defaultResponseForIntent(intent: string, userMessage: string): string {
  const map: Record<string, string> = {
    ANALYZE_CHAPTER_CHARACTERS: '正在从本章正文提取角色与性格特征（只读预览，不写入角色库）。',
    ANALYZE_CHAPTER: '正在分析本章剧情推进与新实体。',
    APPLY_CHAPTER_IMPACT: '将提取本章人物、性格、视觉特征与术语；确认后写入角色库与世界观。',
    CINEMATIC_REWRITE: '将对当前章进行电影感/小说体重写；确认后写入正文。',
    DRAFT_CONTENT: '将按指令续写或重写正文；确认后写入章节。',
    ADD_CONFLICT: '将为本章注入戏剧冲突；确认后写入。',
    REVERSE_PLOT: '将设计情节反转；确认后写入。',
    RUN_CONSISTENCY_CHECK: '正在进行全书逻辑一致性体检。',
    GENERATE_TIMELINE: '将基于本章生成分镜时间线；确认后写入。',
    ANSWER_QUESTION: '正在回答你的问题。',
    QUERY_DATABASE: '正在查询项目数据。',
    RENAME_CHAPTER: '将重命名章节；请确认。',
    DELETE_CHAPTER: '将删除章节；请确认。',
  };
  return map[intent] || `已理解：${userMessage.slice(0, 80)}`;
}

/** Free-text fallback when routing fails entirely. */
export async function freeTextAnswerFallback(
  userMessage: string,
  contextNote: string
): Promise<AgentOsDecision> {
  try {
    const provider = LLMService.getProvider();
    const text = await provider.generateText(
      userMessage,
      `你是 NovaStory 写作助手。路由规划失败时，用简体中文直接回答用户。\n上下文：${contextNote}\n不要假装已修改数据库；若需要改章节/角色，请提示用户换更明确的指令。`
    );
    const answer = (text || '').trim() || '暂时无法规划操作，请换更短、更明确的指令重试。';
    return {
      thought: 'free_text_fallback',
      response: answer,
      actions: [{ op: 'ANSWER_QUESTION', answer }],
    };
  } catch {
    return {
      thought: 'free_text_fallback_error',
      response:
        '本地模型未能生成有效操作计划。请换更短指令，或检查 Ollama。',
      actions: [
        {
          op: 'ANSWER_QUESTION',
          answer:
            '系统解析失败。可试：「提取本章角色性格」「定稿更新世界观」「全文重写为小说体」。',
        },
      ],
    };
  }
}
