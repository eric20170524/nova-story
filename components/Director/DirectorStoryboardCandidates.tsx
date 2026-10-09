import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Edit3, Eye, EyeOff, GitPullRequest, Save, Trash2, AlertTriangle } from 'lucide-react';
import { api } from '../../services/api';
import { useLanguage } from '../../LanguageContext';
import { useToast } from '../../ToastContext';
import { splitReviewFact, stabilizeReviewBeats, type ReviewFact } from '../../services/storyboardFactReview';

function StoryboardShotCards({ candidateId, shots }: { candidateId: string; shots: any[] }) {
  return (
    <div className="space-y-2">
      {shots.map((shot: any, index: number) => {
        let specIntent = '';
        try {
          if (shot.shot_spec) specIntent = JSON.parse(shot.shot_spec).shot_intent;
        } catch {
          specIntent = '';
        }
        return (
          <div
            key={`${candidateId}-${index}`}
            className="bg-white dark:bg-slate-900 p-2.5 rounded-md border border-slate-200 dark:border-slate-800 text-[11px] space-y-1 min-w-0"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 font-semibold text-amber-700 dark:text-amber-300">
              <span className="min-w-0 break-words">
                镜头 #{shot.index} · {shot.shot_type || 'Medium Shot'}
                {specIntent ? ` (${specIntent})` : ''}
              </span>
              <span className="text-slate-400 font-normal shrink-0">
                分场: {shot.script_scene_id} · {shot.duration}s
              </span>
            </div>
            <div className="text-slate-700 dark:text-slate-300 break-words">
              <span className="text-slate-400">画面:</span> {shot.location} · {shot.primary_action}
            </div>
            {shot.dialogue && (
              <div className="text-emerald-700 dark:text-emerald-400 break-words">
                <span className="text-slate-400">对白:</span> {shot.dialogue}
              </div>
            )}
            {shot.narration && (
              <div className="text-blue-700 dark:text-blue-400 break-words">
                <span className="text-slate-400">画外音:</span> {shot.narration}
              </div>
            )}
            {shot.audio_prompt && (
              <div className="text-amber-700 dark:text-amber-400 break-words">
                <span className="text-slate-400">音效:</span> {shot.audio_prompt}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

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
  const [tasks, setTasks] = useState<any[]>([]);
  const [resumingTaskId, setResumingTaskId] = useState<string | null>(null);
  const [reviewingTaskId, setReviewingTaskId] = useState<string | null>(null);
  const [reviewFacts, setReviewFacts] = useState<ReviewFact[]>([]);
  const notifiedCandidates = useRef(new Set<string>());
  useEffect(() => {
    let disposed = false;
    setTasks([]); setReviewingTaskId(null); setReviewFacts([]);
    const refresh = async () => {
      if (!script?.id) return;
      try {
        const response = await api.getStoryboardTasks(script.id);
        if (!disposed) {
          setTasks(response.tasks);
          for (const task of response.tasks) if (task.status === 'completed' && task.progress?.candidate_id && !notifiedCandidates.current.has(task.progress.candidate_id)) {
            notifiedCandidates.current.add(task.progress.candidate_id); onScriptChanged();
          }
        }
      }
      catch { /* A dropped connection must not clear durable progress. */ }
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [script?.id]);

  const resumeTask = async (task: any) => {
    if (!script || !task.progress?.request) return;
    setResumingTaskId(task.task_id);
    try { await api.createStoryboardCandidate(script.id, task.progress.request); onScriptChanged(); }
    catch (error: any) { showToast(error.message || '恢复分镜生成失败', 'error'); }
    finally { setResumingTaskId(null); }
  };
  const saveFactReview = async (task: any) => {
    if (!script) return;
    try {
      await api.reviewStoryboardFacts(script.id, task.task_id, { expected_input_hash: task.progress.input_hash, spans: reviewFacts });
      setReviewingTaskId(null);
      await resumeTask(task);
    } catch (error: any) { showToast(error.message || '事实核对未保存', 'error'); }
  };

  const candidates = (script?.pendingChanges || []).filter((change) => change.kind === 'storyboard');
  const confirmCandidate = candidates.find((candidate) => candidate.id === confirmCandidateId);
  const reviewTask = tasks.find((task) => task.task_id === reviewingTaskId) ?? null;
  useEffect(() => {
    if (!confirmCandidate && !reviewingTaskId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (reviewingTaskId) setReviewingTaskId(null);
      else setConfirmCandidateId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [confirmCandidate?.id, reviewingTaskId]);
  if (!script || (candidates.length === 0 && tasks.length === 0)) return null;

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

  const replacingExisting = (sceneIds?.length || 0) > 0;
  let confirmPayload: any = null;
  let confirmPayloadValid = false;
  if (confirmCandidate) {
    try {
      confirmPayload = JSON.parse(confirmCandidate.after_json);
      confirmPayloadValid = true;
    } catch {
      confirmPayload = null;
    }
  }
  const confirmShots = Array.isArray(confirmPayload?.shots) ? confirmPayload.shots : [];
  const confirmShotCount = !confirmPayloadValid
    ? (sceneIds?.length || 0)
    : replacingExisting
      ? (sceneIds?.length || 0)
      : confirmShots.length;

  return (
    <>
      <div
        data-testid="storyboard-candidate-panel"
        className="flex min-h-0 min-w-0 max-h-[min(52dvh,36rem)] flex-col overflow-hidden border-b border-amber-200 dark:border-amber-900/60 bg-amber-50/80 dark:bg-amber-950/30"
      >
        <div className="shrink-0 px-4 lg:px-6 py-3 border-b border-amber-200/80 dark:border-amber-900/50">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-amber-900 dark:text-amber-200">
              <GitPullRequest size={15} />
              <span>{t('director.storyboard_panel_title')} ({candidates.length})</span>
            </div>
            <span className="text-[11px] text-amber-700/80 dark:text-amber-300/80 min-w-0 break-words">
              {t('director.storyboard_panel_hint')}
            </span>
          </div>
        </div>
        <div
          data-testid="storyboard-candidate-scroll"
          className="min-h-0 flex-auto overflow-y-auto overflow-x-hidden overscroll-contain custom-scrollbar pb-3"
        >
      {tasks.filter(task => task.status !== 'completed').map(task => {
        const progress = task.progress || {};
        const stages: Record<string, string> = { queued: '排队中', facts: '核对事实来源', planning: '规划镜头', translating: '直译画面事实', auditing: '核验译文', needs_review: '事实需要核对', failed: '已保留进度' };
        return <div key={task.task_id} className="px-4 py-3 border-b border-amber-200 bg-amber-50 dark:bg-amber-950/30 text-xs space-y-2 min-w-0 break-words">
          <div>{stages[progress.phase] || progress.phase} {progress.scene_id ? `· 分场 ${progress.scene_id}` : ''} {progress.shot_index ? `· 第 ${progress.shot_index} 镜` : ''} · 已完成 {Object.keys(progress.shots || {}).length} 镜</div>
          {(task.error || progress.error) && <p className="text-amber-800 dark:text-amber-200">{task.error || progress.error}</p>}
          {(progress.facts || []).filter((fact: any) => ['mixed', 'uncertain'].includes(fact.kind) || fact.binding?.mentions.some((m: any) => !m.confirmed)).map((fact: any) => <p key={fact.id}>待核对：{fact.text}</p>)}
          {progress.facts?.length > 0 && ['failed', 'interrupted'].includes(task.status) && <button type="button" data-testid={`storyboard-fact-review-open-${task.task_id}`} className="px-3 py-1 rounded border border-amber-400" onClick={() => { setReviewingTaskId(task.task_id); setReviewFacts(stabilizeReviewBeats(progress.facts.map((fact: any) => ({ scene_id: fact.scene_id, block_id: fact.block_id, text: fact.text, kind: fact.kind, beat: fact.beat, states: fact.states || [], binding: fact.binding })))); }}>{t('director.fact_review_open')}</button>}
          {['failed', 'interrupted'].includes(task.status) && progress.request?.expected_revision === script.revision && <button type="button" className="px-3 py-1 rounded border border-amber-400" disabled={resumingTaskId === task.task_id} onClick={() => void resumeTask(task)}>从已通过结果继续</button>}
        </div>;
      })}

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
              className="bg-white dark:bg-slate-900 rounded-xl border border-amber-200/80 dark:border-amber-800/80 p-3 text-xs shadow-xs space-y-2 min-w-0 mx-4 lg:mx-6 mt-3"
            >
              <div className="sticky top-0 z-10 -mx-3 px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-full font-semibold text-[11px] bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300">
                    {t('script_editor.candidate_kind_storyboard')}
                  </span>
                  <span className="text-slate-500 font-mono text-[10px]">
                    ID: {candidate.id.slice(0, 8)}... (c_v{candidate.candidate_revision})
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
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
                    className="w-full h-56 max-h-[40vh] min-h-[8rem] overflow-y-auto font-mono text-[11px] p-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md focus:outline-hidden focus:ring-1 focus:ring-amber-500 text-slate-800 dark:text-slate-200 custom-scrollbar"
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
                    <div className="p-3 bg-slate-50 dark:bg-slate-950/60 rounded-lg border border-amber-200 dark:border-amber-900 space-y-2 min-w-0">
                      <span className="font-semibold text-xs text-amber-700 dark:text-amber-300 block">
                        分镜镜头清单 ({parsedPayload.shots.length} 镜)
                      </span>
                      <StoryboardShotCards candidateId={candidate.id} shots={parsedPayload.shots} />
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
        </div>
      </div>

      {confirmCandidate && typeof document !== 'undefined' && createPortal(
        <div
          data-testid="storyboard-adopt-confirm"
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[90] overflow-y-auto overscroll-contain bg-black/60 backdrop-blur-sm"
        >
          <div className="flex min-h-full items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full shadow-2xl">
              <div className="flex items-start gap-3 px-6 pt-6 pb-3 text-amber-500">
                <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200/60 dark:border-amber-800/50 shrink-0">
                  <AlertTriangle size={22} />
                </div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white min-w-0 break-words">
                  {replacingExisting
                    ? t('director.replace_confirm_title')
                    : t('director.adopt_confirm_title')}
                </h3>
              </div>
              <div
                data-testid="storyboard-adopt-confirm-body"
                className="max-h-[min(32rem,calc(100dvh-13rem))] overflow-y-auto overflow-x-hidden overscroll-contain custom-scrollbar px-6 pb-4 space-y-3"
              >
                <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed break-words">
                  {replacingExisting
                    ? t('director.replace_confirm_desc', { count: sceneIds?.length || 0 })
                    : t('director.adopt_confirm_desc', { count: confirmShotCount })}
                </p>
                {confirmShots.length > 0 && (
                  <div className="space-y-2 min-w-0">
                    <span className="font-semibold text-xs text-amber-700 dark:text-amber-300 block">
                      分镜镜头清单 ({confirmShots.length} 镜)
                    </span>
                    <StoryboardShotCards candidateId={confirmCandidate.id} shots={confirmShots} />
                  </div>
                )}
              </div>
              <div
                data-testid="storyboard-adopt-confirm-actions"
                className="flex flex-wrap items-center justify-end gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-800"
              >
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
        </div>,
        document.body
      )}

      {reviewTask && typeof document !== 'undefined' && createPortal(
        <div
          data-testid="storyboard-fact-review"
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[90] overflow-y-auto overscroll-contain bg-black/60 backdrop-blur-sm"
        >
          <div className="flex min-h-full items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full shadow-2xl">
              <div className="px-6 pt-6 pb-3">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white min-w-0 break-words">
                  {t('director.fact_review_title')}
                </h3>
              </div>
              <div
                data-testid="storyboard-fact-review-body"
                className="max-h-[min(32rem,calc(100dvh-13rem))] overflow-y-auto overflow-x-hidden overscroll-contain custom-scrollbar px-6 pb-4 space-y-3 text-xs"
              >
                <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed break-words">
                  {t('director.fact_review_help')}
                </p>
                {reviewFacts.map((fact, index) => <div key={index} className="flex flex-wrap gap-2 items-center">
                  <textarea aria-label={`事实原文 ${index + 1}`} className="border rounded p-1 grow min-w-0 max-h-28 overflow-y-auto bg-white dark:bg-slate-900" value={fact.text} onChange={event => setReviewFacts(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value, states: [], binding: undefined } : item))} />
                  {fact.binding?.mentions.map((mention, mentionIndex) => <label key={mentionIndex} className="w-full flex gap-2 items-center">
                    {mention.text || '省略的主语'} 对应人物{mention.confirmed ? '（已确认）' : '（待核对）'}
                    <select aria-label={`对应人物 ${index + 1}-${mentionIndex + 1}`} value={mention.confirmed ? mention.entity?.id || '' : ''} onChange={event => setReviewFacts(current => current.map((item, itemIndex) => itemIndex === index && item.binding ? { ...item, binding: { ...item.binding, mentions: item.binding.mentions.map((m, mi) => mi === mentionIndex ? { ...m, entity: m.candidates.find(e => e.id === event.target.value) || null, status: event.target.value ? 'resolved' : 'ambiguous', confirmed: Boolean(event.target.value), visibility: event.target.value ? 'visible' : 'uncertain' } : m) } } : item))}>
                      <option value="">未确定，请选择</option>{mention.candidates.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
                    </select>
                    {mention.confirmed && <select aria-label={`人物表现 ${index + 1}-${mentionIndex + 1}`} value={mention.visibility} onChange={event => setReviewFacts(current => current.map((item, itemIndex) => itemIndex === index && item.binding ? { ...item, binding: { ...item.binding, mentions: item.binding.mentions.map((m, mi) => mi === mentionIndex ? { ...m, visibility: event.target.value as 'visible' | 'mentioned' | 'uncertain' } : m) } } : item))}>
                      <option value="visible">本人可见</option><option value="mentioned">仅提及或画外</option><option value="uncertain">不确定</option>
                    </select>}
                  </label>)}
                  <button type="button" data-testid={`storyboard-fact-review-split-${index}`} onClick={() => setReviewFacts(current => splitReviewFact(current, index))}>{t('director.fact_review_split')}</button>
                  <select aria-label={`事实分类 ${index + 1}`} className="border rounded p-1 bg-white dark:bg-slate-900" value={fact.kind} onChange={event => setReviewFacts(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, kind: event.target.value, states: event.target.value === 'visual' ? item.states : [] } : item))}>
                    {Object.entries({ visual: '可见画面', audio: '声音', internal: '心理', figurative: '比喻', mixed: '混合待拆分', uncertain: '不确定' }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <label>{t('director.fact_review_beat')} <input data-testid={`storyboard-fact-review-beat-${index}`} aria-label={`${t('director.fact_review_beat')} ${index + 1}`} className="border rounded p-1 w-16 bg-white dark:bg-slate-900" type="number" min={0} value={fact.beat} onChange={event => setReviewFacts(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, beat: Number(event.target.value) } : item))} /></label>
                  {fact.kind === 'visual' && <div className="w-full space-y-1">
                    {(fact.states || []).map((state: any, stateIndex: number) => <div key={stateIndex} className="flex flex-wrap gap-1 items-center">
                      <input aria-label={`连续状态主体 ${index + 1}-${stateIndex + 1}`} placeholder="原文主体" className="border rounded p-1 bg-white dark:bg-slate-900" value={state.entity} onChange={event => setReviewFacts(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, states: item.states.map((entry: any, entryIndex: number) => entryIndex === stateIndex ? { ...entry, entity: event.target.value } : entry) } : item))} />
                      <select aria-label="连续状态类别" className="border rounded p-1 bg-white dark:bg-slate-900" value={state.attribute} onChange={event => setReviewFacts(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, states: item.states.map((entry: any, entryIndex: number) => entryIndex === stateIndex ? { ...entry, attribute: event.target.value } : entry) } : item))}>
                        {Object.entries({ presence: '在场', wardrobe: '衣着', holding: '持物', position: '位置', pending_action: '未完成动作' }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                      <input aria-label="连续状态原文" placeholder="原文状态" className="border rounded p-1 grow bg-white dark:bg-slate-900" value={state.value} onChange={event => setReviewFacts(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, states: item.states.map((entry: any, entryIndex: number) => entryIndex === stateIndex ? { ...entry, value: event.target.value } : entry) } : item))} />
                      <button type="button" onClick={() => setReviewFacts(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, states: item.states.filter((_: any, entryIndex: number) => entryIndex !== stateIndex) } : item))}>移除状态</button>
                    </div>)}
                    <button type="button" onClick={() => setReviewFacts(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, states: [...(item.states || []), { entity: '', attribute: 'presence', value: '' }] } : item))}>补充连续状态</button>
                  </div>}
                </div>)}
              </div>
              <div
                data-testid="storyboard-fact-review-actions"
                className="flex flex-wrap items-center justify-end gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-800"
              >
                <button
                  type="button"
                  data-testid="storyboard-fact-review-cancel"
                  onClick={() => setReviewingTaskId(null)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  data-testid="storyboard-fact-review-save"
                  onClick={() => void saveFactReview(reviewTask)}
                  className="px-4 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-xl"
                >
                  {t('director.fact_review_save')}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
