import React from 'react';
import { AlertTriangle, Check, X, Terminal } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

export type AgentAction = Record<string, any> & { op: string };

interface AgentActionCardProps {
  actions: AgentAction[];
  executing?: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}

const describeAction = (action: AgentAction, t: (k: string, f?: string) => string): string => {
  switch (action.op) {
    case 'DRAFT_CONTENT':
      return t('agent.op_draft', 'Generate / continue writing');
    case 'RENAME_CHAPTER':
      return `${t('agent.op_rename', 'Rename chapter')}: ${action.newTitle || ''}`;
    case 'UPDATE_CHAPTER_SUMMARY':
      return t('agent.op_summary', 'Update chapter summary');
    case 'DELETE_CHAPTER':
      return `${t('agent.op_delete', 'Delete chapter')}: ${action.chapterId}${
        action.reason ? ` — ${action.reason}` : ''
      }`;
    case 'MOVE_CHAPTER':
      return `${t('agent.op_move', 'Move chapter')} → #${action.positionIndex}`;
    case 'UPDATE_PROJECT_META':
      return t('agent.op_project_meta', 'Update project / story bible');
    case 'CINEMATIC_REWRITE':
      return `${t('agent.op_cinematic', 'Cinematic rewrite')} (${action.technique})`;
    case 'ADD_CONFLICT':
      return t('agent.op_conflict', 'Inject conflict');
    case 'REVERSE_PLOT':
      return t('agent.op_reversal', 'Plot reversal');
    case 'RUN_CONSISTENCY_CHECK':
      return t('agent.op_consistency', 'Consistency check');
    case 'APPLY_CHAPTER_IMPACT':
      return t('agent.op_impact', 'Apply chapter world impact');
    case 'GENERATE_TIMELINE':
      return t('agent.op_timeline', 'Generate storyboard timeline');
    case 'ANALYZE_CHAPTER':
      return t('agent.op_analyze', 'Analyze chapter');
    case 'ANALYZE_CHAPTER_CHARACTERS':
      return t('agent.op_analyze_chars', 'Analyze chapter characters');
    case 'GET_CHARACTER':
      return `${t('agent.op_get_char', 'Get character')}: ${action.name}`;
    case 'UPDATE_CHARACTER':
      return `${t('agent.op_update_char', 'Update character')}: ${action.name}`;
    case 'ANSWER_QUESTION':
      return t('agent.op_answer', 'Answer');
    case 'QUERY_DATABASE':
      return `${t('agent.op_query', 'Query')}: ${action.query}`;
    default:
      return action.op;
  }
};

export const AgentActionCard: React.FC<AgentActionCardProps> = ({
  actions,
  executing,
  onConfirm,
  onDismiss,
}) => {
  const { t } = useLanguage();
  const hasDelete = actions.some((a) => a.op === 'DELETE_CHAPTER');

  if (!actions.length) return null;

  return (
    <div
      className={`rounded-2xl border p-4 space-y-3 shadow-md transition-all ${
        hasDelete
          ? 'border-red-300 dark:border-red-500/40 bg-red-50/90 dark:bg-red-950/30'
          : 'border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/70 dark:bg-indigo-950/20'
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-200">
        {hasDelete ? (
          <AlertTriangle size={15} className="text-red-600 dark:text-red-400" />
        ) : (
          <Terminal size={15} className="text-indigo-600 dark:text-indigo-400" />
        )}
        <span>
          {t('agent.action_plan', '执行方案')} ({actions.length})
        </span>
      </div>
      <ul className="space-y-1.5">
        {actions.map((action, idx) => (
          <li
            key={idx}
            className="text-xs text-slate-800 dark:text-slate-300 font-mono bg-white dark:bg-slate-900/60 rounded-xl px-3 py-2 border border-slate-200 dark:border-slate-800 shadow-xs"
          >
            <span className="text-indigo-600 dark:text-indigo-400 font-semibold mr-1.5">{action.op}</span>
            <span className="text-slate-600 dark:text-slate-400">— {describeAction(action, t)}</span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={executing}
          onClick={onConfirm}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold transition-all shadow-sm disabled:opacity-50 ${
            hasDelete
              ? 'bg-red-600 hover:bg-red-500 text-white'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white'
          }`}
        >
          <Check size={14} />
          {executing
            ? t('agent.executing', '正在执行…')
            : hasDelete
              ? t('agent.confirm_delete', '确认删除')
              : t('agent.confirm_execute', '全部执行')}
        </button>
        <button
          type="button"
          disabled={executing}
          onClick={onDismiss}
          className="px-3.5 py-2 rounded-xl text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
};
