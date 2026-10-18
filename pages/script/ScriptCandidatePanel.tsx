import React from 'react';
import { Check, Edit3, Eye, EyeOff, GitPullRequest, Save, Trash2 } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import type { ScriptChangeRow } from '../../backend/src/schemas/script';

interface ScriptCandidatePanelProps {
  pendingReview: ScriptChangeRow[];
  expandedCandidateId: string | null;
  setExpandedCandidateId: React.Dispatch<React.SetStateAction<string | null>>;
  editingCandidateId: string | null;
  setEditingCandidateId: React.Dispatch<React.SetStateAction<string | null>>;
  editingCandidateJson: string;
  setEditingCandidateJson: React.Dispatch<React.SetStateAction<string>>;
  applyingChangeId: string | null;
  discardingChangeId: string | null;
  isSavingCandidate: boolean;
  onStartEdit: (candidate: ScriptChangeRow, parsedPayload: any) => void;
  onDiscard: (candidate: ScriptChangeRow) => void;
  onApply: (candidate: ScriptChangeRow) => void;
  onSaveEdit: (candidate: ScriptChangeRow) => void;
}

export const ScriptCandidatePanel: React.FC<ScriptCandidatePanelProps> = ({
  pendingReview,
  expandedCandidateId,
  setExpandedCandidateId,
  editingCandidateId,
  setEditingCandidateId,
  editingCandidateJson,
  setEditingCandidateJson,
  applyingChangeId,
  discardingChangeId,
  isSavingCandidate,
  onStartEdit,
  onDiscard,
  onApply,
  onSaveEdit,
}) => {
  const { t } = useLanguage();
  if (pendingReview.length === 0) return null;

  return (
    <div className="bg-indigo-50/80 dark:bg-indigo-950/40 border-b border-indigo-200 dark:border-indigo-900/60 p-3 sm:px-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-bold text-indigo-900 dark:text-indigo-200">
          <GitPullRequest size={15} className="text-indigo-600 dark:text-indigo-400" />
          <span>{t('script_editor.pending_candidate_title')} ({pendingReview.length})</span>
        </div>
        <span className="text-[11px] text-indigo-600/80 dark:text-indigo-400/80">审核并确认后合并入正式剧本</span>
      </div>

      {pendingReview.map((cand) => {
        let parsedPayload: any = null;
        try {
          parsedPayload = JSON.parse(cand.after_json);
        } catch {
          parsedPayload = null;
        }

        const isExpanded = expandedCandidateId === cand.id;
        const isApplying = applyingChangeId === cand.id;
        const isDiscarding = discardingChangeId === cand.id;

        const kindLabel =
          cand.kind === 'outline'
            ? t('script_editor.candidate_kind_outline')
            : cand.kind === 'script'
            ? t('script_editor.candidate_kind_script')
            : cand.kind === 'scene'
            ? t('script_editor.candidate_kind_scene')
            : cand.kind;

        return (
          <div
            key={cand.id}
            className="bg-white dark:bg-slate-900 rounded-xl border border-indigo-200/80 dark:border-indigo-800/80 p-3 text-xs shadow-xs space-y-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded-full font-semibold text-[11px] bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300">
                  {kindLabel}
                </span>
                <span className="text-slate-500 font-mono text-[10px]">
                  ID: {cand.id.slice(0, 8)}... (c_v{cand.candidate_revision})
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setExpandedCandidateId(isExpanded ? null : cand.id)}
                  className="px-2 py-1 rounded-md text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1 transition-colors"
                >
                  {isExpanded ? <EyeOff size={13} /> : <Eye size={13} />}
                  <span>{isExpanded ? t('script_editor.hide_candidate_details') : t('script_editor.view_candidate_details')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (editingCandidateId === cand.id) {
                      setEditingCandidateId(null);
                    } else {
                      onStartEdit(cand, parsedPayload);
                    }
                  }}
                  disabled={isDiscarding || isApplying}
                  className={`px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 transition-colors ${
                    editingCandidateId === cand.id
                      ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-300 dark:border-indigo-800'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <Edit3 size={13} />
                  <span>{editingCandidateId === cand.id ? '取消编辑' : '编辑'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => onDiscard(cand)}
                  disabled={isDiscarding || isApplying}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 border border-red-200 dark:border-red-900/60 flex items-center gap-1 transition-colors disabled:opacity-50"
                >
                  <Trash2 size={13} />
                  <span>{isDiscarding ? t('script_editor.discarding_candidate') : t('script_editor.discard_candidate')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => onApply(cand)}
                  disabled={isApplying || isDiscarding}
                  className="px-3 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 shadow-xs transition-colors disabled:opacity-50 bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <Check size={13} />
                  <span>
                    {isApplying
                      ? t('script_editor.applying_candidate')
                      : t('script_editor.apply_candidate')}
                  </span>
                </button>
              </div>
            </div>

            {editingCandidateId === cand.id ? (
              <div className="p-3 bg-slate-50 dark:bg-slate-950/60 rounded-lg border border-indigo-300 dark:border-indigo-800 mt-2 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                    编辑候选内容 (JSON 结构)
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    目标候选版本: v{cand.candidate_revision}
                  </span>
                </div>
                <textarea
                  value={editingCandidateJson}
                  onChange={(e) => setEditingCandidateJson(e.target.value)}
                  className="w-full h-56 font-mono text-[11px] p-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md focus:outline-hidden focus:ring-1 focus:ring-indigo-500 custom-scrollbar text-slate-800 dark:text-slate-200"
                  placeholder="请输入合法的 JSON 格式候选内容..."
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingCandidateId(null)}
                    className="px-2.5 py-1 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-md transition-colors"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => onSaveEdit(cand)}
                    disabled={isSavingCandidate}
                    className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-md flex items-center gap-1 shadow-xs transition-colors disabled:opacity-50"
                  >
                    <Save size={13} />
                    <span>{isSavingCandidate ? '保存中...' : '保存候选修改'}</span>
                  </button>
                </div>
              </div>
            ) : (
              <>
                {cand.kind === 'outline' && parsedPayload && (
                  <div className="text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 p-2 rounded-lg border border-slate-200/60 dark:border-slate-800/60">
                    <p className="font-semibold text-slate-800 dark:text-slate-200">
                      一句话梗概：<span className="font-normal">{parsedPayload.logline || '无'}</span>
                    </p>
                    <div className="flex flex-wrap gap-4 mt-1 text-[11px] text-slate-500">
                      <span>保留事件：{parsedPayload.mustKeepEvents?.length || 0} 个</span>
                      <span>戏剧节拍：{parsedPayload.beats?.length || 0} 场</span>
                      <span>结尾钩子：{parsedPayload.endingHook || '无'}</span>
                    </div>
                  </div>
                )}

                {cand.kind === 'script' && parsedPayload && (
                  <div className="text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 p-2 rounded-lg border border-slate-200/60 dark:border-slate-800/60 flex flex-wrap gap-4 text-[11px]">
                    <span>标题：<strong className="text-slate-900 dark:text-white">{parsedPayload.title}</strong></span>
                    <span>分场数：{parsedPayload.scenes?.length || 0} 场</span>
                    <span>地点：{parsedPayload.locations?.length || 0} 个</span>
                    <span>预估时长：{parsedPayload.targetDurationSec || 120} 秒</span>
                  </div>
                )}

                {cand.kind === 'scene' && parsedPayload && (
                  <div className="text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 p-2 rounded-lg border border-slate-200/60 dark:border-slate-800/60 flex flex-wrap gap-4 text-[11px]">
                    <span>改写目标场：<strong className="text-slate-900 dark:text-white">{parsedPayload.id}</strong></span>
                    <span>场景：{parsedPayload.interiorExterior === 'exterior' ? '外景' : '内景'} · {parsedPayload.timeOfDay}</span>
                    <span>动作/对白块数：{parsedPayload.blocks?.length || 0}</span>
                    <span>预计时长：{parsedPayload.estimatedDurationSec || 30} 秒</span>
                  </div>
                )}

                {isExpanded && (
                  <pre className="p-2.5 rounded-lg bg-slate-100 dark:bg-slate-950 font-mono text-[11px] text-slate-700 dark:text-slate-300 overflow-x-auto max-h-60 custom-scrollbar border border-slate-200 dark:border-slate-800">
                    {JSON.stringify(parsedPayload, null, 2)}
                  </pre>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};
