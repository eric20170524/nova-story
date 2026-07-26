import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Brain, Terminal, Loader2, Sparkles, AlertCircle } from 'lucide-react';
import { api } from '../services/api';
import { useLanguage } from '../LanguageContext';

interface AgentAssistantProps {
  projectId?: string;
  chapterId?: string;
  onRefresh?: () => void;
}

interface Message {
  role: 'user' | 'agent';
  content: string;
  thought?: string;
  action?: {
    tool_name: string;
    arguments: any;
    reason?: string;
  };
  error?: boolean;
}

export const AgentAssistant: React.FC<AgentAssistantProps> = ({ projectId, chapterId, onRefresh }) => {
  const { t, language } = useLanguage();
  const [messages, setMessages] = useState<Message[]>([
    { role: 'agent', content: t('agent.welcome') }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const userMsg: Message = { role: 'user', content: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      // Build context
      const context = {
        project_id: projectId ? Number(projectId) : undefined,
        chapter_id: chapterId,
        language: language,
      };

      // Build history (last 10 messages)
      const history = messages.slice(-10).map(m => ({
        role: m.role,
        content: m.content
      }));

      const response = await api.chatWithAgent(userMsg.content, context, history);
      
      const agentMsg: Message = {
        role: 'agent',
        content: response.response,
        thought: response.thought,
        action: response.action
      };

      setMessages(prev => [...prev, agentMsg]);
      
      if (response.action && onRefresh) {
          // If a tool was executed that modifies state, refresh parent
          onRefresh();
      }

    } catch (e) {
      console.error(e);
      setMessages(prev => [...prev, { role: 'agent', content: t('agent.error_brain'), error: true }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-950 border-l border-slate-800">
      {/* Header */}
      <div className="p-4 border-b border-slate-800 bg-slate-900 flex items-center gap-2">
        <Bot className="text-indigo-400" size={20} />
        <h3 className="font-semibold text-slate-200">{t('agent.title')}</h3>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex flex-col gap-2 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            
            {/* Message Bubble */}
            <div className={`
              max-w-[90%] p-3 rounded-xl text-sm leading-relaxed
              ${msg.role === 'user' 
                ? 'bg-indigo-600 text-white rounded-br-none' 
                : 'bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700'}
              ${msg.error ? 'border-red-500 text-red-100 bg-red-900/20' : ''}
            `}>
              {msg.content.split('\n').map((line, i) => (
                  <p key={i} className={i > 0 ? 'mt-2' : ''}>{line}</p>
              ))}
            </div>

            {/* Thought Process (Agent Only) */}
            {msg.thought && (
              <div className="max-w-[90%] text-xs text-slate-500 flex items-start gap-2 bg-slate-900/50 p-2 rounded border border-slate-800/50">
                <Brain size={12} className="mt-0.5 flex-shrink-0" />
                <span className="italic">{msg.thought}</span>
              </div>
            )}

            {/* Action/Tool (Agent Only) */}
            {msg.action && (
              <div className="max-w-[90%] text-xs text-emerald-400 flex items-start gap-2 bg-emerald-900/10 p-2 rounded border border-emerald-900/30">
                <Terminal size={12} className="mt-0.5 flex-shrink-0" />
                <div className="font-mono">
                  <div className="font-bold">{t('agent.executed')} {msg.action.tool_name}</div>
                  <div className="text-emerald-400/70 truncate">{JSON.stringify(msg.action.arguments)}</div>
                </div>
              </div>
            )}
            
          </div>
        ))}
        {loading && (
           <div className="flex items-center gap-2 text-slate-500 text-xs p-2">
              <Loader2 size={12} className="animate-spin" />
              <span>{t('agent.thinking')}</span>
           </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 bg-slate-900 border-t border-slate-800">
        <div className="relative">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Analyze this chapter..."
            className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-4 pr-12 py-3 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
            disabled={loading}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="absolute right-2 top-2 p-1.5 text-slate-400 hover:text-white bg-slate-800 hover:bg-indigo-600 rounded-md transition-all disabled:opacity-50"
          >
            <Send size={16} />
          </button>
        </div>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
           {['agent.suggestion_analyze', 'agent.suggestion_storyboard', 'agent.suggestion_check'].map(key => (
               <button 
                 key={key}
                 onClick={() => { setInput(t(key)); }}
                 className="text-[10px] whitespace-nowrap px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-full transition-colors border border-slate-700"
               >
                 {t(key)}
               </button>
           ))}
        </div>
      </div>
    </div>
  );
};
