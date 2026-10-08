import React, { useState } from 'react';
import { Check, Edit3, Eye, EyeOff, GitPullRequest, Save, Trash2, AlertTriangle } from 'lucide-react';
import { api } from '../../services/api';
import { useLanguage } from '../../LanguageContext';
import { useToast } from '../../ToastContext';

export interface DirectorScreenplay {
  id: number;
  revision: number;
  status: string;
  freshness?: { sourceChanged?: boolean };
  pendingChanges?: Array<{
    id: string;
    kind: string;
    candidate_revision: number;
    after_json: string;
  }>;
}

interface DirectorStoryboardCandidatesProps {
  script: DirectorScreenplay | null;
  sceneIds: number[] | null;
  timelineReady: boolean;
  onApplied: () => void;
  onScriptChanged: () => void;
}

export const DirectorStoryboardCandidates: React.FC<DirectorStoryboardCandidatesProps> = ({
  script,
  sceneIds,
  timelineReady,
  onApplied,
  onScriptChanged,
}) => {
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [expandedCandidateId, setExpandedCandidateId] = useState<string | null>(null);
  const [editingCandidateId, setEditingCandidateId] = useState<string | null>(null);
  const [editingCandidateJson, setEditingCandidateJson] = useState('');
  const [applyingChangeId, setApplyingChangeId] = useState<string | null>(null);
  const [discardingChangeId, setDiscardingChangeId] = useState<string | null>(null);
  const [savingCandidateId, setSavingCandidateId] = useState<string | null>(null);
  const [confirmCandidateId, setConfirmCandidateId] = useState<string | null>(null);

  const candidates = (script?.pendingChanges || []).filter((change) => change.kind === 'storyboard');
  if (!script || candidates.length === 0) return null;

  const submitCandidate = async (candidate: (typeof candidates)[number], replaceExisting: boolean) => {
    if (replaceExisting && (!sceneIds || sceneIds.length === 0)) {
      showToast(t('director.scene_ids_unavailable'), 'warning');
      return;
    }
    setApplyingChangeId(candidate.id);
    setConfirmCandidateId(null);
    try {
      await api.applyStoryboardCandidate(script.id, candidate.id, {
        expected_revision: script.revision,
        expected_candidate_revision: candidate.candidate_revision,
        ...(replaceExisting
          ? { replace_existing: true, expected_scene_ids: sceneIds || [] }
          : {}),
      });
      showToast(t('script_editor.candidate_submitted_success'), 'success');
      onApplied();
    } catch (err: any) {
      showToast(err.message || t('director.storyboard_candidate_failed'), 'error');
      onScriptChanged();
    } finally {
      setApplyingChangeId(null);
    }
  };

  const requestSubmit = (candidate: (typeof candidates)[number]) => {
    if (!timelineReady) {
      showToast(t('director.scene_ids_unavailable'), 'warning');
      return;
    }
    setConfirmCandidateId(candidate.id);
  };

  const discardCandidate = async (candidate: (typeof candidates)[number]) => {
    setDiscardingChangeId(candidate.id);
    try {
      await api.discardScriptCandidate(script.id, candidate.id);
      showToast(t('script_editor.candidate_discarded_success'), 'info');
      if (editingCandidateId === candidate.id) setEditingCandidateId(null);
      if (confirmCandidateId === candidate.id) setConfirmCandidateId(null);
      onScriptChanged();
    } catch (err: any) {
      showToast(err.message || '丢弃候选失败', 'error');
    } finally {
      setDiscardingChangeId(null);
    }
  };

  const saveCandidateEdit = async (candidate: (typeof candidates)[number]) => {
    try {
      JSON.parse(editingCandidateJson);
    } catch (err: any) {
      showToast('候选内容必须为合法 JSON: ' + err.message, 'error');
      return;
    }
    setSavingCandidateId(candidate.id);
    try {
      await api.updateScriptCandidate(script.id, candidate.id, {
        expected_revision: script.revision,
        expected_candidate_revision: candidate.candidate_revision,
        after_json: editingCandidateJson,
      });
      showToast(`候选修改已保存`, 'success');
      setEditingCandidateId(null);
      onScriptChanged();
    } catch (err: any) {
      showToast(err.message || '保存候选修改失败', 'error');
    } finally {
      setSavingCandidateId(null);
    }
  };

  const confirmCandidate = candidates.find((candidate) => candidate.id === confirmCandidateId);
  const replacingExisting = (sceneIds?.length || 0) > 0;
  const confirmShotCount = (() => {
    if (!confirmCandidate) return sceneIds?.length || 0;
    try {
      const payload = JSON.parse(confirmCandidate.after_json);
      const shots = Array.isArray(payload?.shots) ? payload.shots.length : 0;
      return replacingExisting ? (sceneIds?.length || 0) : shots;
    } catch {
      return sceneIds?.length || 0;
    }
  })();

  return (
    <>
      <div className="border-b border-amber-200 dark:border-amber-900/60 bg-amber-50/80 dark:bg-amber-950/30 px-4 lg:px-6 py-3 space-y-2 max-h-[40vh] overflow-y-auto custom-scrollbar">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-bold text-amber-900 dark:text-amber-200">
            <GitPullRequest size={15} />
            <span>{t('director.storyboard_panel_title')} ({candidates.length})</span>
          </div>
          <span className="text-[11px] text-amber-700/80 dark:text-amber-300/80">
            {t('director.storyboard_panel_hint')}
          </span>
        </div>

        {candidates.map((candidate) => {
          let parsedPayload: any = null;
          try {
            parsedPayload = JSON.parse(candidate.after_json);
          } catch {
            parsedPayload = null;
          }
          const isExpanded = expandedCandidateId === candidate.id;
          const isApplying = applyingChangeId === candidate.id;
          const isDiscarding = discardingChangeId === candidate.id;
          const isSaving = savingCandidateId === candidate.id;
          const busy = isApplying || isDiscarding || isSaving;

          return (
            <div
              key={candidate.id}
              className="bg-white dark:bg-slate-900 rounded-xl border border-amber-200/80 dark:border-amber-800/80 p-3 text-xs shadow-xs space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-full font-semibold text-[11px] bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300">
                    {t('script_editor.candidate_kind_storyboard')}
                  </span>
                  <span className="text-slate-500 font-mono text-[10px]">
                    ID: {candidate.id.slice(0, 8)}... (c_v{candidate.candidate_revision})
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid={`storyboard-adopt-${candidate.id}`}
                    disabled={busy || !timelineReady}
                    onClick={() => requestSubmit(candidate)}
                    className="px-3 py-1 rounded-md text-[11px] font-medium bg-amber-600 hover:bg-amber-700 text-white flex items-center gap-1 disabled:opacity-50"
                  >
                    <Check size={13} />
                    <span>
                      {isApplying
                        ? t('script_editor.applying_candidate')
                        : t('script_editor.apply_candidate')}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpandedCandidateId(isExpanded ? null : candidate.id)}
                    className="px-2 py-1 rounded-md text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1"
                  >
                    {isExpanded ? <EyeOff size={13} /> : <Eye size={13} />}
                    <span>
                      {isExpanded
                        ? t('script_editor.hide_candidate_details')
                        : t('script_editor.view_candidate_details')}
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (editingCandidateId === candidate.id) {
                        setEditingCandidateId(null);
                      } else {
                        setEditingCandidateId(candidate.id);
                        setEditingCandidateJson(candidate.after_json || JSON.stringify(parsedPayload, null, 2));
                        setExpandedCandidateId(candidate.id);
                      }
                    }}
                    className="px-2 py-1 rounded-md text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1 disabled:opacity-50"
                  >
                    <Edit3 size={13} />
                    <span>{editingCandidateId === candidate.id ? '取消编辑' : '编辑'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => discardCandidate(candidate)}
                    className="px-2.5 py-1 rounded-md text-[11px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 border border-red-200 dark:border-red-900/60 flex items-center gap-1 disabled:opacity-50"
                  >
                    <Trash2 size={13} />
                    <span>
                      {isDiscarding
                        ? t('script_editor.discarding_candidate')
                        : t('script_editor.discard_candidate')}
                    </span>
                  </button>
                </div>
              </div>

              {editingCandidateId === candidate.id ? (
                <div className="p-3 bg-slate-50 dark:bg-slate-950/60 rounded-lg border border-amber-300 dark:border-amber-800 space-y-2">
                  <textarea
                    value={editingCandidateJson}
                    onChange={(event) => setEditingCandidateJson(event.target.value)}
                    className="w-full h-56 font-mono text-[11px] p-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md focus:outline-hidden focus:ring-1 focus:ring-amber-500 text-slate-800 dark:text-slate-200"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingCandidateId(null)}
                      className="px-2.5 py-1 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-md"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={isSaving}
                      onClick={() => saveCandidateEdit(candidate)}
                      className="px-3 py-1 text-xs bg-amber-600 hover:bg-amber-700 text-white font-medium rounded-md flex items-center gap-1 disabled:opacity-50"
                    >
                      <Save size={13} />
                      <span>{isSaving ? '保存中...' : '保存候选修改'}</span>
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {parsedPayload && (
                    <div className="text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 p-2.5 rounded-lg border border-slate-200/60 dark:border-slate-800/60 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-semibold text-slate-800 dark:text-slate-200">
                          导演分镜契约：
                          <span className="font-normal">
                            {' '}
                            {parsedPayload.shots?.length || 0} 镜（总时长约 {parsedPayload.totalDuration || 0} 秒）
                          </span>
                        </p>
                        <span className="text-[11px] text-amber-700 dark:text-amber-300 font-medium">
                          剧本预估时长: {parsedPayload.estimatedScriptDuration || 0} 秒
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-4 text-[11px] text-slate-500">
                        <span>
                          已覆盖分场：{parsedPayload.coverageReport?.coveredSceneIds?.length || 0} / {parsedPayload.coverageReport?.totalScenes || 0} 场
                        </span>
                        <span>
                          已覆盖有声内容块：{parsedPayload.coverageReport?.coveredBlockIds?.length || 0} / {parsedPayload.coverageReport?.totalAudibleBlocks || 0} 条
                        </span>
                        <span>
                          核心保留事件：{parsedPayload.coverageReport?.coveredMustKeepEventIds?.length || 0} / {parsedPayload.coverageReport?.totalMustKeepEvents || 0} 项
                        </span>
                      </div>
                    </div>
                  )}
                  {isExpanded && parsedPayload?.shots && (
                    <div className="p-3 bg-slate-50 dark:bg-slate-950/60 rounded-lg border border-amber-200 dark:border-amber-900 space-y-2">
                      <span className="font-semibold text-xs text-amber-700 dark:text-amber-300 block">
                        分镜镜头清单 ({parsedPayload.shots.length} 镜)
                      </span>
                      <div className="space-y-2 max-h-80 overflow-y-auto pr-1 custom-scrollbar">
                        {parsedPayload.shots.map((shot: any, index: number) => {
                          let specIntent = '';
                          try {
                            if (shot.shot_spec) specIntent = JSON.parse(shot.shot_spec).shot_intent;
                          } catch {
                            specIntent = '';
                          }
                          return (
                            <div
                              key={`${candidate.id}-${index}`}
                              className="bg-white dark:bg-slate-900 p-2.5 rounded-md border border-slate-200 dark:border-slate-800 text-[11px] space-y-1"
                            >
                              <div className="flex items-center justify-between font-semibold text-amber-700 dark:text-amber-300">
                                <span>
                                  镜头 #{shot.index} · {shot.shot_type || 'Medium Shot'}
                                  {specIntent ? ` (${specIntent})` : ''}
                                </span>
                                <span className="text-slate-400 font-normal">
                                  分场: {shot.script_scene_id} · {shot.duration}s
                                </span>
                              </div>
                              <div className="text-slate-700 dark:text-slate-300">
                                <span className="text-slate-400">画面:</span> {shot.location} · {shot.primary_action}
                              </div>
                              {shot.dialogue && (
                                <div className="text-emerald-700 dark:text-emerald-400">
                                  <span className="text-slate-400">对白:</span> {shot.dialogue}
                                </div>
                              )}
                              {shot.narration && (
                                <div className="text-blue-700 dark:text-blue-400">
                                  <span className="text-slate-400">画外音:</span> {shot.narration}
                                </div>
                              )}
                              {shot.audio_prompt && (
                                <div className="text-amber-700 dark:text-amber-400">
                                  <span className="text-slate-400">音效:</span> {shot.audio_prompt}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {confirmCandidate && (
        <div
          data-testid="storyboard-adopt-confirm"
          className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-amber-500">
              <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200/60 dark:border-amber-800/50">
                <AlertTriangle size={22} />
              </div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                {replacingExisting
                  ? t('director.replace_confirm_title')
                  : t('director.adopt_confirm_title')}
              </h3>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              {replacingExisting
                ? t('director.replace_confirm_desc', { count: sceneIds?.length || 0 })
                : t('director.adopt_confirm_desc', { count: confirmShotCount })}
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                data-testid="storyboard-adopt-cancel"
                onClick={() => setConfirmCandidateId(null)}
                className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="button"
                data-testid="storyboard-adopt-confirm-submit"
                onClick={() => {
                  if (replacingExisting && (!sceneIds || sceneIds.length === 0)) {
                    showToast(t('director.scene_ids_unavailable'), 'warning');
                    return;
                  }
                  void submitCandidate(confirmCandidate, replacingExisting);
                }}
                className="px-4 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-xl"
              >
                {replacingExisting ? t('director.confirm_replace') : t('director.confirm_adopt')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
