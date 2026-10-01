import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Send,
  Bot,
  Brain,
  Loader2,
  X,
  Sparkles,
  Copy,
  Check,
} from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { api } from '../../services/api';
import {
  executionAffectsEditorContent,
  selectAppliedSkillContent,
  shouldRefreshAfterExecution,
  shouldRetainPendingAgentActions,
  summarizeAgentExecution,
} from '../../services/agent_execution';
import { useLanguage } from '../../LanguageContext';
import { useProjectAgent, type AgentPromptRequest } from '../../contexts/ProjectAgentContext';
import { AgentActionCard, type AgentAction } from './AgentActionCard';
import {
  AgentExecutionResultCard,
  type ExecutionResultItem,
} from './AgentExecutionResultCard';

interface Message {
  role: 'user' | 'agent';
  content: string;
  thought?: string;
  actions?: AgentAction[];
  results?: ExecutionResultItem[];
  needs_confirmation?: boolean;
  error?: boolean;
  executed?: boolean;
  mode?: 'ideation' | 'command';
}

interface ProjectAgentPanelProps {
  projectId: string;
  /** When embedded in a side column, hide outer chrome */
  embedded?: boolean;
  chapterId?: string | null;
  onRefresh?: () => void;
}

const historyKey = (projectId: string) => `novastory_agent_history_${projectId}`;

/** When executor already wrote this chapter's body, push it into the open editor. */
function syncAppliedEditorContent(
  results: ExecutionResultItem[] | undefined,
  editorChapterId: string | null | undefined,
  applyContent: (content: string, opts?: { alreadyPersisted?: boolean }) => void
) {
  const content = selectAppliedSkillContent(results, editorChapterId);
  if (content) applyContent(content, { alreadyPersisted: true });
}

/** One-click copy for Agent OS bubbles / input. */
const QuickCopyButton: React.FC<{
  text: string;
  className?: string;
  label?: string;
  onCopied?: () => void;
}> = ({ text, className = '', label, onCopied }) => {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const value = (text || '').trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopied?.();
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* fallback for older browsers / insecure context */
      try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopied(true);
        onCopied?.();
        window.setTimeout(() => setCopied(false), 1600);
      } catch {
        /* ignore */
      }
    }
  };

  if (!(text || '').trim()) return null;

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-slate-700/80 border border-transparent hover:border-slate-300 dark:hover:border-slate-600 transition-colors ${className}`}
      title={label || t('agent.copy', '复制')}
      aria-label={label || t('agent.copy', '复制')}
    >
      {copied ? (
        <Check size={13} className="text-emerald-500 dark:text-emerald-400" />
      ) : (
        <Copy size={13} />
      )}
    </button>
  );
};

export const ProjectAgentPanel: React.FC<ProjectAgentPanelProps> = ({
  projectId,
  embedded = false,
  chapterId: chapterIdProp,
  onRefresh,
}) => {
  const { t, language } = useLanguage();
  const location = useLocation();
  const {
    open,
    setOpen,
    notifyDataChanged,
    activeChapterId,
    setActiveChapterId,
    activeScriptId,
    activeScriptSceneId,
    pendingPrompt,
    clearPendingPrompt,
    applyContent,
  } = useProjectAgent();

  const chapterId = chapterIdProp ?? activeChapterId;

  const [messages, setMessages] = useState<Message[]>(() => {
    try {
      const raw = sessionStorage.getItem(historyKey(projectId));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch {
      /* ignore */
    }
    return [{ role: 'agent', content: t('agent.welcome_os') }];
  });
  const [input, setInput] = useState('');
  const [conversationMode, setConversationMode] = useState<'ideation' | 'command'>('command');
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [pendingActions, setPendingActions] = useState<AgentAction[] | null>(
    null
  );
  const [pendingChapterId, setPendingChapterId] = useState<string | null>(null);
  const chapterIdRef = useRef(chapterId);
  chapterIdRef.current = chapterId;
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingActions]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        historyKey(projectId),
        JSON.stringify(messages.slice(-40))
      );
    } catch {
      /* ignore */
    }
  }, [messages, projectId]);

  useEffect(() => {
    if (chapterIdProp) setActiveChapterId(chapterIdProp);
  }, [chapterIdProp, setActiveChapterId]);

  const routeHint = (() => {
    const p = location.pathname;
    if (p.includes('/director')) return 'director';
    if (p.includes('/characters')) return 'characters';
    if (p.includes('/settings')) return 'settings';
    if (p.includes('/script')) return 'script';
    if (p.includes('/story')) return 'story';
    return 'project';
  })();

  const currentSurface =
    routeHint === 'script' ||
    routeHint === 'story' ||
    routeHint === 'director' ||
    routeHint === 'characters' ||
    routeHint === 'settings'
      ? routeHint
      : undefined;

  const [pendingSurface, setPendingSurface] = useState<string | null>(null);

  useEffect(() => {
    if (currentSurface !== 'story') setConversationMode('command');
  }, [currentSurface]);

  const clearPendingAgentActions = () => {
    setPendingActions(null);
    setPendingSurface(null);
    setPendingChapterId(null);
  };

  // Drop confirm/retry cards when the page or chapter they belong to changes.
  useEffect(() => {
    if (!pendingActions) return;
    if (!shouldRetainPendingAgentActions({
      pendingChapterId,
      currentChapterId: chapterId ?? null,
      pendingSurface,
      currentSurface: currentSurface ?? null,
    })) {
      clearPendingAgentActions();
    }
  }, [chapterId, currentSurface, pendingActions, pendingChapterId, pendingSurface]);

  const handleSend = useCallback(
    async (textToSend?: string, preferredOp?: string | null, promptRequest?: AgentPromptRequest) => {
      const text = (textToSend !== undefined ? textToSend : input).trim();
      if (!text || loading || executing) return;
      const requestedMode = promptRequest?.conversationMode || conversationMode;
      const mode = currentSurface === 'story' ? requestedMode : 'command';

      const userMsg: Message = { role: 'user', content: text, mode };
      setMessages((prev) => [...prev, userMsg]);
      if (textToSend === undefined) setInput('');
      setLoading(true);
      setPendingActions(null);
      setPendingSurface(null);
      setPendingChapterId(null);

      try {
        const history = messages
          .filter((m) => (mode === 'ideation' ? m.mode === 'ideation' : m.mode !== 'ideation'))
          .slice(-10)
          .map((m) => ({
            role: m.role,
            content: m.content,
          }));
        const response = await api.chatWithAgent(
          userMsg.content,
          {
            project_id: Number(projectId),
            chapter_id: chapterId || undefined,
            language,
            route: routeHint,
            surface: currentSurface,
            conversation_mode: mode,
            planning: promptRequest?.planning,
            ...(routeHint === 'script'
              ? {
                  script_id: activeScriptId ?? undefined,
                  script_scene_id: activeScriptSceneId ?? undefined,
                }
              : {}),
          } as any,
          history,
          preferredOp
        );

        const actions: AgentAction[] = Array.isArray(response.actions)
          ? response.actions
          : response.action?.arguments
            ? [{ op: response.action.tool_name, ...response.action.arguments }]
            : [];

        // Tag actions with originating surface
        const taggedActions: AgentAction[] = actions.map((a) => ({
          ...a,
          surface: (a as any).surface || currentSurface,
        }));

        const results =
          response.results && response.results.length > 0
            ? (response.results as ExecutionResultItem[])
            : undefined;

        const agentMsg: Message = {
          role: 'agent',
          mode,
          content: response.response || '',
          thought: response.thought,
          actions: taggedActions,
          results,
          needs_confirmation: Boolean(response.needs_confirmation),
          error: results?.some((item) => item.status === 'error'),
        };
        setMessages((prev) => [...prev, agentMsg]);

        // Auto-executed skills with apply:true must update the open editor
        const contentResults = results?.filter((item) =>
          !['PLAN_STORY', 'PLAN_CHAPTERS', 'CREATE_NEXT_CHAPTER', 'ANSWER_QUESTION'].includes(item.op)
        );
        syncAppliedEditorContent(contentResults, chapterIdRef.current, applyContent);

        if (response.needs_confirmation && taggedActions.length > 0) {
          setPendingActions(taggedActions);
          setPendingSurface(currentSurface || null);
          setPendingChapterId(chapterId ?? null);
        } else if (taggedActions.length > 0 && !response.needs_confirmation) {
          const successfulResults = (results || []).filter((item) => item.status === 'success');
          const changedChapterId = successfulResults.find(
            (item) => item.data && typeof item.data.chapterId === 'string'
          )?.data?.chapterId;
          if (shouldRefreshAfterExecution(successfulResults, chapterIdRef.current)) {
            notifyDataChanged({
              chapterId: changedChapterId || chapterIdRef.current,
              affectsContent: executionAffectsEditorContent(successfulResults),
            });
            onRefresh?.();
          }
        }
      } catch (e) {
        console.error(e);
        setMessages((prev) => [
          ...prev,
          { role: 'agent', content: t('agent.error_brain'), error: true },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [
      input,
      loading,
      executing,
      messages,
      projectId,
      chapterId,
      activeScriptId,
      activeScriptSceneId,
      language,
      routeHint,
      notifyDataChanged,
      onRefresh,
      applyContent,
      t,
      conversationMode,
      currentSurface,
    ]
  );

  // Handle external pendingPrompt safely without discarding while loading/executing
  useEffect(() => {
    const text = typeof pendingPrompt === 'string' ? pendingPrompt : pendingPrompt?.text;
    if (text?.trim()) {
      if (loading || executing) {
        return;
      }
      const extra = typeof pendingPrompt === 'string' ? undefined : pendingPrompt;
      if (extra?.conversationMode && currentSurface === 'story') setConversationMode(extra.conversationMode);
      clearPendingPrompt();
      handleSend(text.trim(), extra?.preferredOp, extra);
    }
  }, [pendingPrompt, loading, executing, clearPendingPrompt, handleSend]);

  const handleExecute = async () => {
    if (!pendingActions?.length) return;
    const boundChapterId = pendingChapterId ?? chapterId ?? null;
    setExecuting(true);
    try {
      const result = await api.executeAgentActions({
        project_id: Number(projectId),
        chapter_id: boundChapterId || undefined,
        language,
        actions: pendingActions,
        apply: true,
        surface: currentSurface,
        ...(routeHint === 'script'
          ? {
              script_id: activeScriptId ?? undefined,
              script_scene_id: activeScriptSceneId ?? undefined,
            }
          : {}),
      });

      const results = (result.results || []) as ExecutionResultItem[];
      const outcome = summarizeAgentExecution(pendingActions, results);
      const lines = results
        .map(
          (r) =>
            `• ${r.op}: ${r.status}${r.message ? ' — ' + r.message : ''}`
        )
        .join('\n');

      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: `${t(outcome.titleKey)}:\n${lines}`,
          results,
          executed: true,
          error: outcome.failed,
        },
      ]);
      if (outcome.retryActions.length) {
        setPendingActions(outcome.retryActions);
        setPendingChapterId(boundChapterId);
      } else {
        clearPendingAgentActions();
      }

      // Confirm→execute writes skill body to DB; keep the matching editor in sync
      syncAppliedEditorContent(results, chapterIdRef.current, applyContent);

      const changedChapterId = results.find(
        (item) => item.status === 'success' && item.data && typeof item.data.chapterId === 'string'
      )?.data?.chapterId;
      if (shouldRefreshAfterExecution(results, chapterIdRef.current)) {
        notifyDataChanged({
          chapterId: changedChapterId || chapterIdRef.current,
          affectsContent: executionAffectsEditorContent(results),
        });
        onRefresh?.();
      }
    } catch (e) {
      console.error(e);
      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: t('agent.execute_fail', 'Failed to execute actions'),
          error: true,
        },
      ]);
    } finally {
      setExecuting(false);
    }
  };

  const getRouteSuggestions = (): Array<{
    label: string;
    prompt: string;
    preferredOp?: string;
  }> => {
    switch (routeHint) {
      case 'script':
        return [
          {
            label: t('agent.chip_script_outline', '生成改编提纲'),
            prompt: t(
              'agent.prompt_script_outline',
              '为当前章节生成短剧改编提纲（关键事件与结尾钩子）'
            ),
            preferredOp: 'GENERATE_SCRIPT_OUTLINE',
          },
          {
            label: t('agent.chip_script_generate', '生成分场剧本'),
            prompt: t(
              'agent.prompt_script_generate',
              '基于已采纳提纲生成完整分场短剧剧本'
            ),
            preferredOp: 'GENERATE_SCRIPT',
          },
          {
            label: t('agent.chip_script_rewrite_scene', '改写当前分场'),
            prompt: t(
              'agent.prompt_script_rewrite_scene',
              '改写当前选定分场的动作与对白，不影响其他分场'
            ),
            preferredOp: 'REWRITE_SCRIPT_SCENE',
          },
        ];
      case 'story':
        return [
          {
            label: t('agent.chip_extract_chars', '提取本章角色'),
            prompt: t(
              'agent.prompt_extract_chars',
              '提取本章出场角色与性格特征（只读分析，不写入角色库）'
            ),
            preferredOp: 'ANALYZE_CHAPTER_CHARACTERS',
          },
          {
            label: t('agent.chip_analyze_plot', '剧情深度分析'),
            prompt: t(
              'agent.prompt_analyze_plot',
              '分析当前章节的剧情推进要点与新实体'
            ),
            preferredOp: 'ANALYZE_CHAPTER',
          },
          {
            label: t('agent.chip_cinematic', '电影化改写'),
            prompt: t(
              'agent.prompt_cinematic',
              '对当前章节进行电影化感官重写，改为小说叙述体'
            ),
            preferredOp: 'CINEMATIC_REWRITE',
          },
          {
            label: t('agent.chip_add_conflict', '增加冲突'),
            prompt: t(
              'agent.prompt_add_conflict',
              '为当前章节注入戏剧冲突与突发危机'
            ),
            preferredOp: 'ADD_CONFLICT',
          },
          {
            label: t('agent.chip_reverse_plot', '情节反转'),
            prompt: t(
              'agent.prompt_reverse_plot',
              '为当前章节结尾设计一个意料之外的情节反转'
            ),
            preferredOp: 'REVERSE_PLOT',
          },
          {
            label: t('agent.chip_consistency', '全书逻辑体检'),
            prompt: t(
              'agent.prompt_consistency',
              '对全书所有章节进行逻辑一致性与设定漏洞体检'
            ),
            preferredOp: 'RUN_CONSISTENCY_CHECK',
          },
          {
            label: t('agent.chip_impact', '定稿：更新世界观'),
            prompt: t(
              'agent.prompt_impact',
              '本章已定稿，请提取角色（含性格特征）、世界观术语并更新到角色库与设定库，同时更新主线剧情时间线（角色状态、事件、伏笔）与人物关系'
            ),
            preferredOp: 'APPLY_CHAPTER_IMPACT',
          },
        ];
      case 'director':
        return [
          {
            label: t('agent.chip_gen_timeline', '生成本章分镜'),
            prompt: t(
              'agent.prompt_gen_timeline',
              '基于当前章节内容生成完整的分镜时间轴场景'
            ),
            preferredOp: 'GENERATE_TIMELINE',
          },
          {
            label: t('agent.chip_analyze_shots', '优化镜头提示词'),
            prompt: t(
              'agent.prompt_analyze_shots',
              '分析当前分镜的镜头景别、光影与画面构图提示词'
            ),
            preferredOp: 'ANSWER_QUESTION',
          },
        ];
      case 'characters':
        return [
          {
            label: t('agent.chip_extract_unlisted', '提取未收录角色'),
            prompt: t(
              'agent.prompt_extract_unlisted',
              '从当前章正文提取角色与性格（只读预览）；定稿会将性格写入角色库'
            ),
            preferredOp: 'ANALYZE_CHAPTER_CHARACTERS',
          },
          {
            label: t('agent.chip_check_relations', '梳理人物关系网'),
            prompt: t(
              'agent.prompt_check_relations',
              '请梳理项目中各角色之间的阵营与人际关系'
            ),
            preferredOp: 'ANSWER_QUESTION',
          },
        ];
      default:
        return [
          {
            label: t('agent.suggestion_rename', '重命名本章'),
            prompt: t(
              'agent.prompt_rename',
              '请根据内容为当前章节起一个更吸引人的标题'
            ),
          },
          {
            label: t('agent.suggestion_draft', '沉浸续写'),
            prompt: t(
              'agent.prompt_draft',
              '请顺着当前剧情继续向下推进写作'
            ),
          },
          {
            label: t('agent.suggestion_check', '一致性检查'),
            prompt: t(
              'agent.prompt_check',
              '请检查当前章节与世界观设定是否一致'
            ),
          },
        ];
    }
  };

  const suggestions = getRouteSuggestions();

  const panelBody = (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950 transition-colors">
      {!embedded && (
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900 flex items-center justify-between transition-colors">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200/60 dark:border-indigo-800/40 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shadow-sm">
              <Bot size={18} />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm">
                {t('agent.title_os')}
              </h3>
              <p className="text-[10px] text-slate-500 dark:text-slate-400">
                {routeHint}
                {chapterId ? ` · ch ${String(chapterId).slice(0, 8)}…` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X size={18} />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-slate-50/30 dark:bg-slate-950/40">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex flex-col gap-1.5 ${
              msg.role === 'user' ? 'items-end' : 'items-start'
            }`}
          >
            <div
              className={`group/msg relative max-w-[92%] p-3.5 pr-9 rounded-2xl text-xs sm:text-sm leading-relaxed whitespace-pre-wrap shadow-sm transition-all ${
                msg.role === 'user'
                  ? 'bg-indigo-600 text-white rounded-br-none shadow-indigo-600/10'
                  : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-bl-none border border-slate-200/80 dark:border-slate-700'
              } ${msg.error ? 'border-red-300 dark:border-red-500 text-red-900 dark:text-red-100 bg-red-50 dark:bg-red-900/20' : ''}`}
            >
              {msg.content}
              <div
                className={`absolute top-2 right-2 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity ${
                  msg.role === 'user' ? 'text-indigo-100' : ''
                }`}
              >
                <QuickCopyButton
                  text={msg.content}
                  className={
                    msg.role === 'user'
                      ? 'hover:bg-indigo-500/80 text-indigo-100 hover:text-white'
                      : ''
                  }
                />
              </div>
            </div>
            {msg.thought && (
              <div className="group/thought max-w-[92%] text-xs text-slate-500 dark:text-slate-400 flex items-start gap-2 bg-slate-100/80 dark:bg-slate-900/50 p-2.5 pr-8 rounded-xl border border-slate-200 dark:border-slate-800/50 relative">
                <Brain size={13} className="mt-0.5 flex-shrink-0 text-indigo-500 dark:text-indigo-400" />
                <span className="italic flex-1 min-w-0">{msg.thought}</span>
                <div className="absolute top-1.5 right-1.5 opacity-0 group-hover/thought:opacity-100 transition-opacity">
                  <QuickCopyButton
                    text={msg.thought}
                    label={t('agent.copy_thought', '复制思考')}
                  />
                </div>
              </div>
            )}
            {msg.results && msg.results.length > 0 && (
              <div className="w-full max-w-[96%] mt-1">
                <AgentExecutionResultCard
                  results={msg.results}
                  onApplyContent={(newContent) => {
                    applyContent(newContent);
                  }}
                />
              </div>
            )}
          </div>
        ))}

        {pendingActions && (
          <AgentActionCard
            actions={pendingActions}
            executing={executing}
            onConfirm={handleExecute}
            onDismiss={clearPendingAgentActions}
          />
        )}

        {executing && (
          <div className="flex items-center gap-3 p-3.5 rounded-2xl bg-indigo-50/90 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800/60 text-indigo-700 dark:text-indigo-300 text-xs sm:text-sm shadow-sm animate-pulse">
            <div className="relative flex items-center justify-center">
              <Loader2 size={16} className="animate-spin text-indigo-600 dark:text-indigo-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-slate-800 dark:text-slate-200">
                {t('agent.executing_title', '正在执行指令方案…')}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                {t('agent.executing_desc', '正在同步世界观设定、改写正文并写入项目数据库')}
              </div>
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl bg-slate-100/90 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 text-xs shadow-xs">
            <Loader2 size={14} className="animate-spin text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
            <span className="font-medium">{t('agent.thinking', 'Agent OS 正在深度思考与规划…')}</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 transition-colors">
        {currentSurface === 'story' && (
          <button
            type="button"
            data-testid="agent-mode-ideation"
            aria-pressed={conversationMode === 'ideation'}
            onClick={() => setConversationMode((mode) => mode === 'ideation' ? 'command' : 'ideation')}
            className={`mb-2 text-[11px] px-3 py-1 rounded-full border font-medium ${
              conversationMode === 'ideation'
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
            }`}
          >
            {conversationMode === 'ideation'
              ? t('story.ideation_mode_on', '构思模式')
              : t('story.command_mode', '创作指令')}
          </button>
        )}
        <div className="relative">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder={t(
              'agent.placeholder',
              'e.g. Rename this chapter / continue writing…'
            )}
            className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl pl-4 pr-20 py-3 text-xs sm:text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 transition-all shadow-sm"
            disabled={loading || executing}
          />
          <div className="absolute right-2 top-2 flex items-center gap-1">
            <QuickCopyButton
              text={input}
              label={t('agent.copy_input', '复制输入')}
              className="bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 shadow-sm"
            />
            <button
              type="button"
              onClick={() => handleSend()}
              disabled={loading || executing || !input.trim()}
              className="p-1.5 text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-all shadow-sm disabled:opacity-40"
              title={t('agent.send', '发送')}
            >
              <Send size={15} />
            </button>
          </div>
        </div>
        <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
          {suggestions.map((item, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleSend(item.prompt, item.preferredOp)}
              className="text-[11px] whitespace-nowrap px-3 py-1 bg-slate-100 hover:bg-indigo-50 hover:text-indigo-700 dark:bg-slate-800 dark:hover:bg-indigo-900/40 dark:hover:text-indigo-200 text-slate-600 dark:text-slate-400 rounded-full border border-slate-200 dark:border-slate-700 transition-colors font-medium shadow-xs"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  if (embedded) {
    return panelBody;
  }

  // Offset FAB on director so it sits left of the static production panel (lg:w-80)
  const fabOffsetClass = routeHint === 'director'
    ? 'bottom-6 right-6 lg:right-[22rem] z-[60]'
    : 'bottom-6 right-6 z-[60]';

  // Floating shell: FAB + drawer (z above director panels)
  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`fixed ${fabOffsetClass} flex items-center gap-2 px-4 py-3 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white shadow-xl shadow-indigo-600/30 transition-transform hover:scale-105`}
          title={t('agent.open_panel', '打开 Agent OS')}
        >
          <Sparkles size={18} />
          <span className="text-sm font-semibold hidden sm:inline">
            {t('agent.fab_label', 'Agent OS')}
          </span>
        </button>
      )}
      {open && (
        <>
          <div
            className="fixed inset-0 bg-slate-900/30 dark:bg-black/40 z-[70] backdrop-blur-xs"
            onClick={() => setOpen(false)}
          />
          <div className="fixed inset-y-0 right-0 z-[80] w-full max-w-md shadow-2xl border-l border-slate-200 dark:border-slate-800 flex flex-col bg-white dark:bg-slate-950 animate-in slide-in-from-right duration-200">
            {panelBody}
          </div>
        </>
      )}
    </>
  );
};
