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
      className={`rounded-xl border p-3 space-y-2 ${
        hasDelete
          ? 'border-red-500/40 bg-red-950/30'
          : 'border-indigo-500/30 bg-indigo-950/20'
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
        {hasDelete ? (
          <AlertTriangle size={14} className="text-red-400" />
        ) : (
          <Terminal size={14} className="text-indigo-400" />
        )}
        <span>
          {t('agent.action_plan', 'Proposed actions')} ({actions.length})
        </span>
      </div>
      <ul className="space-y-1.5">
        {actions.map((action, idx) => (
          <li
            key={idx}
            className="text-xs text-slate-300 font-mono bg-slate-900/60 rounded px-2 py-1.5 border border-slate-800"
          >
            <span className="text-indigo-400 mr-1">{action.op}</span>
            <span className="text-slate-400">— {describeAction(action, t)}</span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={executing}
          onClick={onConfirm}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
            hasDelete
              ? 'bg-red-600 hover:bg-red-500 text-white'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white'
          }`}
        >
          <Check size={14} />
          {executing
            ? t('agent.executing', 'Executing…')
            : hasDelete
              ? t('agent.confirm_delete', 'Confirm delete')
              : t('agent.confirm_execute', 'Execute all')}
        </button>
        <button
          type="button"
          disabled={executing}
          onClick={onDismiss}
          className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-700"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
