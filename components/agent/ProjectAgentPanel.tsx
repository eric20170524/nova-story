import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Send,
  Bot,
  Brain,
  Loader2,
  X,
  Sparkles,
} from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { api } from '../../services/api';
import { useLanguage } from '../../LanguageContext';
import { useProjectAgent } from '../../contexts/ProjectAgentContext';
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
}

interface ProjectAgentPanelProps {
  projectId: string;
  /** When embedded in a side column, hide outer chrome */
  embedded?: boolean;
  chapterId?: string | null;
  onRefresh?: () => void;
}

const historyKey = (projectId: string) => `novastory_agent_history_${projectId}`;

const SKILL_CONTENT_OPS = new Set([
  'CINEMATIC_REWRITE',
  'ADD_CONFLICT',
  'REVERSE_PLOT',
  'DRAFT_CONTENT',
]);

/** When executor already wrote content to DB (applied=true), push it into the story editor. */
function syncAppliedEditorContent(
  results: ExecutionResultItem[] | undefined,
  applyContent: (content: string, opts?: { alreadyPersisted?: boolean }) => void
) {
  if (!results?.length) return;
  for (const item of results) {
    if (item.status === 'error') continue;
    const data = item.data;
    const content = typeof data?.content === 'string' ? data.content : '';
    if (!content) continue;
    const applied = Boolean(data?.applied);
    const isSkill = SKILL_CONTENT_OPS.has(item.op);
    if (applied && isSkill) {
      applyContent(content, { alreadyPersisted: true });
      return; // one chapter body at a time
    }
  }
}

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
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [pendingActions, setPendingActions] = useState<AgentAction[] | null>(
    null
  );
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
    if (p.includes('/story')) return 'story';
    return 'project';
  })();

  const handleSend = useCallback(
    async (textToSend?: string) => {
      const text = (textToSend !== undefined ? textToSend : input).trim();
      if (!text || loading || executing) return;

      const userMsg: Message = { role: 'user', content: text };
      setMessages((prev) => [...prev, userMsg]);
      if (textToSend === undefined) setInput('');
      setLoading(true);
      setPendingActions(null);

      try {
        const history = messages.slice(-10).map((m) => ({
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
          },
          history
        );

        const actions: AgentAction[] = Array.isArray(response.actions)
          ? response.actions
          : response.action?.arguments
            ? [{ op: response.action.tool_name, ...response.action.arguments }]
            : [];

        const results =
          response.results && response.results.length > 0
            ? (response.results as ExecutionResultItem[])
            : undefined;

        const agentMsg: Message = {
          role: 'agent',
          content: response.response || '',
          thought: response.thought,
          actions,
          results,
          needs_confirmation: Boolean(response.needs_confirmation),
        };
        setMessages((prev) => [...prev, agentMsg]);

        // Auto-executed skills with apply:true must update the open editor
        syncAppliedEditorContent(results, applyContent);

        if (response.needs_confirmation && actions.length > 0) {
          setPendingActions(actions);
        } else if (actions.length > 0 && !response.needs_confirmation) {
          notifyDataChanged();
          onRefresh?.();
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
      language,
      routeHint,
      notifyDataChanged,
      onRefresh,
      applyContent,
      t,
    ]
  );

  // Handle external pendingPrompt safely without discarding while loading/executing
  useEffect(() => {
    if (pendingPrompt && pendingPrompt.trim()) {
      if (loading || executing) {
        return;
      }
      const prompt = pendingPrompt.trim();
      clearPendingPrompt();
      handleSend(prompt);
    }
  }, [pendingPrompt, loading, executing, clearPendingPrompt, handleSend]);

  const handleExecute = async () => {
    if (!pendingActions?.length) return;
    setExecuting(true);
    try {
      const result = await api.executeAgentActions({
        project_id: Number(projectId),
        chapter_id: chapterId || undefined,
        language,
        actions: pendingActions,
        apply: true,
      });

      const results = (result.results || []) as ExecutionResultItem[];
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
          content: `${t('agent.execute_done', 'Execution finished')}:\n${lines}`,
          results,
          executed: true,
        },
      ]);
      setPendingActions(null);

      // Confirm→execute writes skill body to DB; keep editor in sync to avoid save overwrite
      syncAppliedEditorContent(results, applyContent);

      notifyDataChanged();
      onRefresh?.();
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

  const getRouteSuggestions = () => {
    switch (routeHint) {
      case 'story':
        return [
          {
            label: t('agent.chip_extract_chars', '提取本章角色'),
            prompt: t(
              'agent.prompt_extract_chars',
              '请提取并分析当前章节出现的所有角色与性格特征'
            ),
          },
          {
            label: t('agent.chip_analyze_plot', '剧情深度分析'),
            prompt: t(
              'agent.prompt_analyze_plot',
              '请分析当前章节的剧情推进要点与新实体'
            ),
          },
          {
            label: t('agent.chip_cinematic', '电影化改写'),
            prompt: t(
              'agent.prompt_cinematic',
              '请对当前章节进行电影化视听与感官改写，增强沉浸感'
            ),
          },
          {
            label: t('agent.chip_add_conflict', '增加冲突'),
            prompt: t(
              'agent.prompt_add_conflict',
              '请为当前章节注入戏剧冲突与突发危机'
            ),
          },
          {
            label: t('agent.chip_reverse_plot', '情节反转'),
            prompt: t(
              'agent.prompt_reverse_plot',
              '请为当前章节结尾设计一个意料之外的情节反转'
            ),
          },
          {
            label: t('agent.chip_consistency', '全书逻辑体检'),
            prompt: t(
              'agent.prompt_consistency',
              '请对全书所有章节进行逻辑一致性与设定漏洞体检'
            ),
          },
          {
            label: t('agent.chip_impact', '定稿：更新世界观'),
            prompt: t(
              'agent.prompt_impact',
              '本章已定稿，请提取新增角色与世界观术语并更新到设定库'
            ),
          },
        ];
      case 'director':
        return [
          {
            label: t('agent.chip_gen_timeline', '生成本章分镜'),
            prompt: t(
              'agent.prompt_gen_timeline',
              '请基于当前章节内容生成完整的分镜时间轴场景'
            ),
          },
          {
            label: t('agent.chip_analyze_shots', '优化镜头提示词'),
            prompt: t(
              'agent.prompt_analyze_shots',
              '请分析当前分镜的镜头景别、光影与画面构图提示词'
            ),
          },
        ];
      case 'characters':
        return [
          {
            label: t('agent.chip_extract_unlisted', '提取未收录角色'),
            prompt: t(
              'agent.prompt_extract_unlisted',
              '请扫描当前所有章节，找出尚未收录到角色列表的人物'
            ),
          },
          {
            label: t('agent.chip_check_relations', '梳理人物关系网'),
            prompt: t(
              'agent.prompt_check_relations',
              '请梳理项目中各角色之间的阵营与人际关系'
            ),
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
    <div className="flex flex-col h-full bg-slate-950">
      {!embedded && (
        <div className="p-4 border-b border-slate-800 bg-slate-900 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="text-indigo-400" size={20} />
            <div>
              <h3 className="font-semibold text-slate-200 text-sm">
                {t('agent.title_os')}
              </h3>
              <p className="text-[10px] text-slate-500">
                {routeHint}
                {chapterId ? ` · ch ${String(chapterId).slice(0, 8)}…` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800"
          >
            <X size={18} />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex flex-col gap-1.5 ${
              msg.role === 'user' ? 'items-end' : 'items-start'
            }`}
          >
            <div
              className={`max-w-[92%] p-3 rounded-xl text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-indigo-600 text-white rounded-br-none'
                  : 'bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700'
              } ${msg.error ? 'border-red-500 text-red-100 bg-red-900/20' : ''}`}
            >
              {msg.content}
            </div>
            {msg.thought && (
              <div className="max-w-[92%] text-xs text-slate-500 flex items-start gap-2 bg-slate-900/50 p-2 rounded border border-slate-800/50">
                <Brain size={12} className="mt-0.5 flex-shrink-0" />
                <span className="italic">{msg.thought}</span>
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
            onDismiss={() => setPendingActions(null)}
          />
        )}

        {loading && (
          <div className="flex items-center gap-2 text-slate-500 text-xs p-2">
            <Loader2 size={12} className="animate-spin" />
            <span>{t('agent.thinking')}</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 bg-slate-900 border-t border-slate-800">
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
            className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-4 pr-12 py-3 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
            disabled={loading || executing}
          />
          <button
            type="button"
            onClick={() => handleSend()}
            disabled={loading || executing || !input.trim()}
            className="absolute right-2 top-2 p-1.5 text-slate-400 hover:text-white bg-slate-800 hover:bg-indigo-600 rounded-md transition-all disabled:opacity-50"
          >
            <Send size={16} />
          </button>
        </div>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
          {suggestions.map((item, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleSend(item.prompt)}
              className="text-[10px] whitespace-nowrap px-2.5 py-1 bg-slate-800 hover:bg-indigo-900/40 hover:text-indigo-200 text-slate-400 rounded-full border border-slate-700 transition-colors"
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
          className={`fixed ${fabOffsetClass} flex items-center gap-2 px-4 py-3 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/40 transition-transform hover:scale-105`}
          title={t('agent.open_panel', '打开 Agent OS')}
        >
          <Sparkles size={18} />
          <span className="text-sm font-medium hidden sm:inline">
            {t('agent.fab_label', 'Agent OS')}
          </span>
        </button>
      )}
      {open && (
        <>
          <div
            className="fixed inset-0 bg-black/40 z-[70] lg:bg-black/20"
            onClick={() => setOpen(false)}
          />
          <div className="fixed inset-y-0 right-0 z-[80] w-full max-w-md shadow-2xl border-l border-slate-800 flex flex-col bg-slate-950">
            {panelBody}
          </div>
        </>
      )}
    </>
  );
};
