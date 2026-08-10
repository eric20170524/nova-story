import React, { useState } from 'react';
import {
  Users,
  BookOpen,
  ShieldAlert,
  AlertTriangle,
  Info,
  CheckCircle2,
  Sparkles,
  ChevronDown,
  ChevronUp,
  FileText,
  Copy,
  Check,
} from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

export interface ExecutionResultItem {
  op: string;
  status: string;
  message?: string;
  data?: any;
}

interface AgentExecutionResultCardProps {
  results: ExecutionResultItem[];
  onApplyContent?: (content: string) => void;
}

export const AgentExecutionResultCard: React.FC<AgentExecutionResultCardProps> = ({
  results,
  onApplyContent,
}) => {
  const { t } = useLanguage();

  if (!results || results.length === 0) return null;

  return (
    <div className="space-y-3 w-full animate-in fade-in duration-200">
      {results.map((item, idx) => (
        <SingleResultCard
          key={`${item.op}-${idx}`}
          item={item}
          onApplyContent={onApplyContent}
        />
      ))}
    </div>
  );
};

const getOpTitle = (op: string, t: (k: string, f?: string) => string): string => {
  switch (op) {
    case 'CINEMATIC_REWRITE':
      return t('agent.op_cinematic', '电影化改写');
    case 'ADD_CONFLICT':
      return t('agent.op_conflict', '注入冲突');
    case 'REVERSE_PLOT':
      return t('agent.op_reversal', '剧情反转');
    case 'RUN_CONSISTENCY_CHECK':
      return t('agent.op_consistency', '全书逻辑体检');
    case 'APPLY_CHAPTER_IMPACT':
      return t('agent.op_impact', '定稿世界观更新');
    case 'ANALYZE_CHAPTER':
      return t('agent.op_analyze', '分析章节');
    case 'DRAFT_CONTENT':
      return t('agent.op_draft', '正文生成/续写');
    default:
      return t(`agent.op_${op.toLowerCase()}`, op);
  }
};

const SingleResultCard: React.FC<{
  item: ExecutionResultItem;
  onApplyContent?: (content: string) => void;
}> = ({ item, onApplyContent }) => {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // 1. APPLY_CHAPTER_IMPACT
  if (item.op === 'APPLY_CHAPTER_IMPACT') {
    const impact = item.data || {};
    const characters: any[] = impact.newOrUpdatedCharacters || [];
    const glossary: any[] = impact.newOrUpdatedGlossary || [];
    const hasData = characters.length > 0 || glossary.length > 0;

    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 overflow-hidden text-xs">
        <div
          onClick={() => setExpanded(!expanded)}
          className="p-3 bg-emerald-950/40 border-b border-emerald-500/20 flex items-center justify-between cursor-pointer hover:bg-emerald-950/60 transition-colors"
        >
          <div className="flex items-center gap-2 text-emerald-300 font-semibold">
            <Sparkles size={15} />
            <span>{t('agent.impact_result_title', '世界观演化报告 (World Impact)')}</span>
            <span className="text-[10px] bg-emerald-900/60 text-emerald-300 px-2 py-0.5 rounded-full border border-emerald-700/50">
              {characters.length} {t('agent.chars_count', '角色')} · {glossary.length} {t('agent.terms_count', '术语')}
            </span>
          </div>
          {expanded ? <ChevronUp size={14} className="text-emerald-400" /> : <ChevronDown size={14} className="text-emerald-400" />}
        </div>

        {expanded && (
          <div className="p-3 space-y-3">
            {!hasData && (
              <p className="text-slate-400 italic text-center py-2">
                {t('agent.no_impact_changes', '本章未检测到新增或变更的角色与世界观设定')}
              </p>
            )}

            {characters.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-300 uppercase tracking-wider">
                  <Users size={13} className="text-indigo-400" />
                  <span>{t('agent.impact_characters', '角色演化 (Characters)')}</span>
                </div>
                <div className="grid gap-2">
                  {characters.map((char, i) => (
                    <div
                      key={i}
                      className="bg-slate-900/80 border border-slate-800 rounded-lg p-2.5 space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-indigo-300 text-xs">
                          {char.name}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 uppercase">
                          {char.role || 'supporting'}
                        </span>
                      </div>
                      {char.description && (
                        <p className="text-slate-400 text-[11px] leading-relaxed">
                          {char.description}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {glossary.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-300 uppercase tracking-wider">
                  <BookOpen size={13} className="text-amber-400" />
                  <span>{t('agent.impact_glossary', '世界观术语演化 (Glossary)')}</span>
                </div>
                <div className="grid gap-2">
                  {glossary.map((g, i) => (
                    <div
                      key={i}
                      className="bg-slate-900/80 border border-slate-800 rounded-lg p-2.5 space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-amber-300 text-xs">
                          {g.term}
                        </span>
                        {g.category && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-300 border border-amber-800/40">
                            {g.category}
                          </span>
                        )}
                      </div>
                      {g.definition && (
                        <p className="text-slate-400 text-[11px] leading-relaxed">
                          {g.definition}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // 2. RUN_CONSISTENCY_CHECK
  if (item.op === 'RUN_CONSISTENCY_CHECK') {
    const issues: any[] = item.data?.issues || [];

    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 overflow-hidden text-xs">
        <div
          onClick={() => setExpanded(!expanded)}
          className="p-3 bg-amber-950/40 border-b border-amber-500/20 flex items-center justify-between cursor-pointer hover:bg-amber-950/60 transition-colors"
        >
          <div className="flex items-center gap-2 text-amber-300 font-semibold">
            <ShieldAlert size={15} />
            <span>{t('agent.consistency_result_title', '全书逻辑体检报告 (Consistency Audit)')}</span>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full border ${
                issues.length === 0
                  ? 'bg-emerald-900/60 text-emerald-300 border-emerald-700/50'
                  : 'bg-amber-900/60 text-amber-300 border-amber-700/50'
              }`}
            >
              {issues.length} {t('agent.issues_count', '项问题')}
            </span>
          </div>
          {expanded ? <ChevronUp size={14} className="text-amber-400" /> : <ChevronDown size={14} className="text-amber-400" />}
        </div>

        {expanded && (
          <div className="p-3 space-y-2.5">
            {issues.length === 0 ? (
              <div className="flex items-center gap-2 text-emerald-400 p-2 rounded bg-emerald-950/30 border border-emerald-800/40">
                <CheckCircle2 size={16} />
                <span>{t('agent.no_issues_found', '全书逻辑严谨，未发现明显设定冲突或断层。')}</span>
              </div>
            ) : (
              issues.map((issue, i) => {
                const sev = String(issue.severity || 'LOW').toUpperCase();
                const isHigh = sev === 'HIGH';
                const isMed = sev === 'MEDIUM';

                return (
                  <div
                    key={i}
                    className={`p-3 rounded-lg border leading-relaxed space-y-1.5 ${
                      isHigh
                        ? 'bg-rose-950/30 border-rose-800/60 text-rose-200'
                        : isMed
                          ? 'bg-amber-950/30 border-amber-800/60 text-amber-200'
                          : 'bg-slate-900/70 border-slate-800 text-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        {isHigh ? (
                          <AlertTriangle size={13} className="text-rose-400 flex-shrink-0" />
                        ) : isMed ? (
                          <Info size={13} className="text-amber-400 flex-shrink-0" />
                        ) : (
                          <Info size={13} className="text-slate-400 flex-shrink-0" />
                        )}
                        <span className="font-semibold text-xs">
                          {issue.type || t('agent.issue_general', '逻辑问题')}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {(issue.chapterIndex !== undefined ||
                          issue.location) && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-300 border border-slate-700 max-w-[140px] truncate">
                            {issue.chapterIndex !== undefined
                              ? `#${issue.chapterIndex}`
                              : String(issue.location)}
                          </span>
                        )}
                        <span
                          className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                            isHigh
                              ? 'bg-rose-900/60 text-rose-300 border border-rose-700/50'
                              : isMed
                                ? 'bg-amber-900/60 text-amber-300 border border-amber-700/50'
                                : 'bg-slate-800 text-slate-400 border border-slate-700'
                          }`}
                        >
                          {sev}
                        </span>
                      </div>
                    </div>
                    <p className="text-slate-300 text-xs pl-4 border-l-2 border-slate-700/50">
                      {issue.description}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    );
  }

  // 3. Writing Skills (CINEMATIC_REWRITE, ADD_CONFLICT, REVERSE_PLOT)
  if (
    item.op === 'CINEMATIC_REWRITE' ||
    item.op === 'ADD_CONFLICT' ||
    item.op === 'REVERSE_PLOT'
  ) {
    const content = item.data?.content || '';
    const applied = Boolean(item.data?.applied);

    return (
      <div className="rounded-xl border border-indigo-500/30 bg-indigo-950/20 overflow-hidden text-xs">
        <div className="p-3 bg-indigo-950/40 border-b border-indigo-500/20 flex items-center justify-between">
          <div className="flex items-center gap-2 text-indigo-300 font-semibold">
            <FileText size={15} />
            <span>{getOpTitle(item.op, t)}</span>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full border ${
                applied
                  ? 'bg-emerald-900/60 text-emerald-300 border-emerald-700/50'
                  : 'bg-indigo-900/60 text-indigo-300 border-indigo-700/50'
              }`}
            >
              {applied ? t('agent.applied', '已直接写入') : t('agent.ready_to_apply', '改写完成')}
            </span>
          </div>
          {content && (
            <button
              onClick={() => handleCopy(content)}
              className="p-1 text-slate-400 hover:text-white rounded bg-slate-800/80 border border-slate-700"
              title={t('agent.copy', '复制正文')}
            >
              {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            </button>
          )}
        </div>

        {content && (
          <div className="p-3 space-y-3">
            <div className="max-h-48 overflow-y-auto p-2.5 rounded bg-slate-900/90 border border-slate-800 text-slate-300 text-xs font-serif leading-relaxed custom-scrollbar whitespace-pre-wrap">
              {content}
            </div>
            {!applied && onApplyContent && (
              <button
                type="button"
                onClick={() => onApplyContent(content)}
                className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium text-xs flex items-center justify-center gap-1.5 transition-colors"
              >
                <Check size={14} />
                {t('agent.apply_to_editor', '应用至编辑器当前章节')}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // 4. ANALYZE_CHAPTER
  if (item.op === 'ANALYZE_CHAPTER') {
    const analysis = item.data || {};
    const entities: string[] = analysis.new_entities || [];
    const updates: string[] = analysis.updates || [];

    return (
      <div className="rounded-xl border border-sky-500/30 bg-sky-950/20 overflow-hidden text-xs">
        <div className="p-3 bg-sky-950/40 border-b border-sky-500/20 flex items-center gap-2 text-sky-300 font-semibold">
          <Sparkles size={15} />
          <span>{t('agent.analysis_result_title', '剧情与实体深度分析')}</span>
        </div>
        <div className="p-3 space-y-3">
          {entities.length > 0 && (
            <div>
              <span className="text-[11px] font-bold text-slate-400 block mb-1.5 uppercase">
                {t('story.new_entities', '新实体 / 人物')}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {entities.map((e, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-200 text-xs"
                  >
                    {e}
                  </span>
                ))}
              </div>
            </div>
          )}

          {updates.length > 0 && (
            <div>
              <span className="text-[11px] font-bold text-slate-400 block mb-1.5 uppercase">
                {t('story.plot_progression', '剧情推进要点')}
              </span>
              <ul className="space-y-1 text-slate-300">
                {updates.map((u, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-sky-400">•</span>
                    <span>{u}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Default fallback for other operations
  return (
    <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-xs flex items-start gap-2">
      <CheckCircle2 size={15} className="text-indigo-400 mt-0.5 flex-shrink-0" />
      <div>
        <span className="font-semibold text-slate-200">{item.op}</span>
        <span className="text-slate-400 ml-1">— {item.message || item.status}</span>
      </div>
    </div>
  );
};
