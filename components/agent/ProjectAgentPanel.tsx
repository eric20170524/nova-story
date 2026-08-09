import React, { useEffect, useRef, useState } from 'react';
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

interface Message {
  role: 'user' | 'agent';
  content: string;
  thought?: string;
  actions?: AgentAction[];
  needs_confirmation?: boolean;
  error?: boolean;
  executed?: boolean;
}

interface ProjectAgentPanelProps {
  projectId: string;
  /** When embedded in a side column (e.g. director), hide outer chrome */
  embedded?: boolean;
  chapterId?: string | null;
  onRefresh?: () => void;
}

const historyKey = (projectId: string) => `novastory_agent_history_${projectId}`;

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

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const userMsg: Message = { role: 'user', content: input.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
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

      const agentMsg: Message = {
        role: 'agent',
        content: response.response || '',
        thought: response.thought,
        actions,
        needs_confirmation: Boolean(response.needs_confirmation),
      };
      setMessages((prev) => [...prev, agentMsg]);

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
  };

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
      const lines = (result.results || [])
        .map(
          (r: any) =>
            `• ${r.op}: ${r.status}${r.message ? ' — ' + r.message : ''}`
        )
        .join('\n');
      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: `${t('agent.execute_done', 'Execution finished')}:\n${lines}`,
          executed: true,
        },
      ]);
      setPendingActions(null);
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

  const suggestions = [
    'agent.suggestion_rename',
    'agent.suggestion_draft',
    'agent.suggestion_check',
  ];

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
            onClick={handleSend}
            disabled={loading || executing || !input.trim()}
            className="absolute right-2 top-2 p-1.5 text-slate-400 hover:text-white bg-slate-800 hover:bg-indigo-600 rounded-md transition-all disabled:opacity-50"
          >
            <Send size={16} />
          </button>
        </div>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
          {suggestions.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setInput(t(key))}
              className="text-[10px] whitespace-nowrap px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-full border border-slate-700"
            >
              {t(key)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  if (embedded) {
    return panelBody;
  }

  // Floating shell: FAB + drawer
  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/40 transition-transform hover:scale-105"
          title={t('agent.title_os')}
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
            className="fixed inset-0 bg-black/40 z-40 lg:bg-transparent lg:pointer-events-none"
            onClick={() => setOpen(false)}
          />
          <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md shadow-2xl border-l border-slate-800 flex flex-col">
            {panelBody}
          </div>
        </>
      )}
    </>
  );
};
