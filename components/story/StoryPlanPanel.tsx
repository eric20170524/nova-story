import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../services/api';
import { useLanguage } from '../../LanguageContext';
import { useToast } from '../../ToastContext';
import { useProjectAgentOptional } from '../../contexts/ProjectAgentContext';
import type { Chapter } from '../../types';
import {
  FRESH_KEY_CONFLICTS,
  SavedRequestError,
  type StoredGenerateRequest,
  type StoredNextChapterRequest,
  chaptersAwaitingReview,
  clearGenerateRequest,
  clearNextRequest,
  generateStorageKey,
  getOrCreateGenerateRequest,
  getOrCreateNextRequest,
  parseGenerateRequest,
  readIdeationHistory,
} from './storyPlanRequests';

type PlanPatch = { id: string; label: string; before: string | null; after: string | null };
type PlanCandidate = {
  id: string;
  kind: string;
  state: string;
  candidate_revision: number;
  base_revision: number;
  patches: PlanPatch[];
  before?: { chapters?: Array<{ id: string; title: string; summary: string; targetWordCount: number }> } | null;
  after?: { chapters?: Array<{ id: string; title: string; summary: string; targetWordCount: number }> } | null;
  error_code?: string;
  request?: {
    project_id?: number;
    plan_entry_id?: string;
    expected_revision?: number;
    expected_last_chapter_id?: string | null;
    request_key?: string;
  } | null;
};
type PlanView = {
  project_id: number;
  revision: number;
  document: {
    blueprint: { title?: string; summary?: string; mainPlot?: string } | null;
    targetTotalWords: number | null;
    endingPolicy: 'develop' | 'conclude';
    autoCreateNextChapter: boolean;
    chapters: Array<{ id: string; title: string; summary: string; targetWordCount: number; disposition: 'active' | 'retired' }>;
  };
  entries: Array<{ id: string; title: string; summary: string; disposition: string; chapter_id: string | null; chapter_status: string | null }>;
  budget: { written: number; reserved: number; target: number | null };
  next_entry_id: string | null;
};

const resumeJobs = new Map<string, Promise<{ created: boolean }>>();

function resumePendingNextChapter(projectId: string): Promise<{ created: boolean }> {
  const existing = resumeJobs.get(projectId);
  if (existing) return existing;
  const job = (async () => {
    const rows = await api.listStoryPlanCandidates(Number(projectId));
    const pending = (rows || []).find((row) => row.kind === 'next_chapter' && row.state === 'pending' && row.request?.request_key);
    if (!pending) return { created: false };
    const result = await api.createNextPlannedChapter(Number(projectId), pending.request);
    return { created: !result?.reused };
  })().catch((error) => {
    resumeJobs.delete(projectId);
    throw error;
  });
  resumeJobs.set(projectId, job);
  return job;
}

export const StoryPlanPanel: React.FC<{
  projectId: string;
  chapters: Chapter[];
  dirty: boolean;
  onSave: () => Promise<boolean>;
  onChaptersChanged: () => void;
}> = ({ projectId, chapters, dirty, onSave, onChaptersChanged }) => {
  const { t } = useLanguage();
  const { showToast } = useToast();
  const agent = useProjectAgentOptional();
  const [view, setView] = useState<PlanView | null>(null);
  const [candidate, setCandidate] = useState<PlanCandidate | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviseIds, setReviseIds] = useState<string[]>([]);
  const chaptersChangedRef = useRef(onChaptersChanged);
  const candidateRef = useRef<PlanCandidate | null>(null);
  const planEpoch = useRef(0);
  const reloadSerial = useRef(0);
  chaptersChangedRef.current = onChaptersChanged;
  candidateRef.current = candidate;

  const stillCurrent = (epoch: number, serial: number, requestedId: string) =>
    epoch === planEpoch.current && serial === reloadSerial.current && requestedId === projectId;

  const reload = useCallback(async () => {
    const epoch = planEpoch.current;
    const serial = ++reloadSerial.current;
    const requestedId = projectId;
    try {
      const next = await api.getStoryPlan(Number(requestedId));
      const rows = await api.listStoryPlanCandidates(Number(requestedId));
      if (!stillCurrent(epoch, serial, requestedId)) return;
      if (String(next?.project_id) !== String(requestedId)) return;
      setView(next);
      const visible = (rows || []).find((row) => row.kind !== 'next_chapter' && (row.state === 'pending' || row.state === 'stale'));
      setCandidate(visible || null);
      setSelected((prev) => {
        if (!visible) return [];
        const patchIds = new Set((visible.patches || []).map((patch: PlanPatch) => patch.id));
        if (candidateRef.current?.id === visible.id) return prev.filter((id) => patchIds.has(id));
        return (visible.patches || []).map((patch: PlanPatch) => patch.id);
      });
    } catch (error) {
      if (!stillCurrent(epoch, serial, requestedId)) return;
      if (error instanceof ApiError && error.status === 404) setView(null);
    }
  }, [projectId]);

  useEffect(() => {
    planEpoch.current += 1;
    setView(null);
    setCandidate(null);
    void reload();
  }, [projectId, reload]);

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.projectId && String(detail.projectId) !== String(projectId)) return;
      void reload();
    };
    window.addEventListener('novastory-agent-data-changed', onChange);
    window.addEventListener('novastory-story-plan-changed', onChange);
    return () => {
      window.removeEventListener('novastory-agent-data-changed', onChange);
      window.removeEventListener('novastory-story-plan-changed', onChange);
    };
  }, [projectId, reload]);

  useEffect(() => {
    let active = true;
    resumePendingNextChapter(projectId)
      .then(async (result) => {
        if (!active || !result.created) return;
        showToast(t('story.plan_next_ready', '下一章已创建'), 'success');
        chaptersChangedRef.current();
        await reload();
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error && error.message
          ? error.message
          : t('story.plan_next_failed', '自动创建下一章失败');
        showToast(message, 'error');
      });
    return () => {
      active = false;
    };
  }, [projectId, reload, showToast, t]);

  useEffect(() => {
    let active = true;
    const resumeGenerate = async () => {
      let saved: StoredGenerateRequest | null;
      try {
        saved = parseGenerateRequest(localStorage.getItem(generateStorageKey(projectId)));
      } catch (error) {
        if (active && error instanceof SavedRequestError) {
          showToast(t('story.plan_saved_invalid', '已保存的规划请求无法读取'), 'warning');
        }
        return;
      }
      if (!saved) return;
      try {
        const rows = await api.listStoryPlanCandidates(Number(projectId), saved.request_key);
        if (!active) return;
        const row = (rows || [])[0] as PlanCandidate | undefined;
        if (!row || row.state === 'generating') {
          showToast(t('story.plan_network_kept', '网络结果未知，已保留原来的请求，可再次点击重试'), 'warning');
          return;
        }
        clearGenerateRequest(localStorage, projectId);
        if (row.state === 'pending' || row.state === 'stale') {
          setCandidate(row);
          setSelected((row.patches || []).map((patch) => patch.id));
          return;
        }
        if (row.state === 'failed') {
          showToast(t('story.plan_failed', '规划失败'), 'error');
        }
      } catch (error) {
        if (active && !(error instanceof ApiError)) {
          showToast(t('story.plan_network_kept', '网络结果未知，已保留原来的请求，可再次点击重试'), 'warning');
        }
      }
    };
    void resumeGenerate();
    return () => {
      active = false;
    };
  }, [projectId, showToast, t]);

  const loadPlan = async (refresh: boolean): Promise<PlanView | null> => {
    if (!refresh && view && String(view.project_id) === String(projectId)) return view;
    const epoch = planEpoch.current;
    const serial = ++reloadSerial.current;
    const requestedId = projectId;
    const accept = (next: PlanView | null) => {
      if (!next || !stillCurrent(epoch, serial, requestedId)) return null;
      if (String(next.project_id) !== String(requestedId)) return null;
      setView(next);
      return next;
    };
    try {
      const current = await api.getStoryPlan(Number(requestedId)) as PlanView;
      return accept(current);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      const created = await api.bootstrapStoryPlan(Number(requestedId)) as PlanView;
      return accept(created);
    }
  };

  const showGenerateResult = (result: PlanCandidate | null) => {
    if (!result || result.state === 'generating') {
      showToast(t('story.plan_still_generating', '规划仍在生成。已保留原来的请求，可再次点击核对'), 'warning');
      return;
    }
    if (result.state !== 'pending' && result.state !== 'stale') {
      clearGenerateRequest(localStorage, projectId);
      if (result.state === 'failed') showToast(t('story.plan_failed', '规划失败'), 'error');
      return;
    }
    clearGenerateRequest(localStorage, projectId);
    setCandidate(result);
    setSelected((result.patches || []).map((patch) => patch.id));
    showToast(
      result.state === 'stale'
        ? t('story.plan_stale', '来源已变化，请重新生成')
        : t('story.plan_candidate_ready', '规划候选已生成，请选择后采纳'),
      result.state === 'stale' ? 'warning' : 'success'
    );
  };

  const generate = async (kind: 'blueprint' | 'chapters', mode?: 'initial' | 'extend' | 'revise') => {
    if (busy) return;
    setBusy(true);
    const draft = async () => {
      const current = await loadPlan(true);
      if (!current) return null;
      const active = current.document.chapters.filter((entry) => entry.disposition !== 'retired');
      const resolvedMode = mode === 'initial' && active.length > 0 ? 'extend' : mode;
      const history = kind === 'blueprint'
        ? readIdeationHistory(sessionStorage.getItem(`novastory_agent_history_${projectId}`))
        : [];
      return {
        expected_revision: current.revision,
        kind,
        mode: kind === 'chapters' ? (resolvedMode || 'extend') : undefined,
        message: kind === 'blueprint'
          ? t('story.plan_blueprint_prompt', '请根据目前的构思整理开书设定')
          : resolvedMode === 'revise'
            ? t('story.plan_revise_prompt', '请修订选中的章节规划')
            : t('story.plan_chapters_prompt', '请规划后续章节'),
        history: history.length ? history : undefined,
        target_plan_ids: resolvedMode === 'revise' ? reviseIds : undefined,
        batch_size: kind === 'chapters'
          ? (resolvedMode === 'revise' ? Math.min(5, Math.max(1, reviseIds.length || 1)) : 3)
          : undefined,
      };
    };
    const loadRequest = async (): Promise<StoredGenerateRequest | null> => {
      try {
        const existing = parseGenerateRequest(localStorage.getItem(generateStorageKey(projectId)));
        if (existing) {
          if (existing.kind !== kind) {
            showToast(t('story.plan_replay_saved', '有一条规划请求尚未确认结果，将先按原来的请求核对'), 'warning');
          }
          return existing;
        }
        const created = await draft();
        if (!created) return null;
        return getOrCreateGenerateRequest(localStorage, projectId, () => created);
      } catch (error) {
        if (!(error instanceof SavedRequestError)) throw error;
        if (error.code === 'INVALID_SAVED_GENERATE_REQUEST') {
          const reset = window.confirm(t('story.plan_saved_invalid_confirm', '已保存的规划请求无法读取。清除并重新发起？'));
          if (!reset) return null;
          clearGenerateRequest(localStorage, projectId);
          const created = await draft();
          if (!created) return null;
          return getOrCreateGenerateRequest(localStorage, projectId, () => created);
        }
        showToast(t('story.plan_storage_unavailable', '浏览器无法保存请求，已取消本次生成'), 'error');
        return null;
      }
    };
    try {
      const request = await loadRequest();
      if (!request) return;
      try {
        showGenerateResult(await api.generateStoryPlan(Number(projectId), request));
      } catch (error) {
        if (!(error instanceof ApiError)) {
          showToast(t('story.plan_network_kept', '网络结果未知，已保留原来的请求，可再次点击重试'), 'warning');
          return;
        }
        if (!FRESH_KEY_CONFLICTS.has(error.code || '')) {
          clearGenerateRequest(localStorage, projectId);
          showToast(error.message, 'error');
          return;
        }
        clearGenerateRequest(localStorage, projectId);
        const retry = window.confirm(`${error.message}\n${t('story.plan_retry_conflict', '确认后将使用新的请求再试一次。')}`);
        if (!retry) {
          showToast(error.message, 'error');
          return;
        }
        const created = await draft();
        if (!created) return;
        const fresh = getOrCreateGenerateRequest(localStorage, projectId, () => created);
        try {
          showGenerateResult(await api.generateStoryPlan(Number(projectId), fresh));
        } catch (retryError) {
          if (!(retryError instanceof ApiError)) {
            showToast(t('story.plan_network_kept', '网络结果未知，已保留原来的请求，可再次点击重试'), 'warning');
          } else {
            clearGenerateRequest(localStorage, projectId);
            showToast(retryError.message, 'error');
          }
        }
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('story.plan_failed', '规划失败'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const applyCandidate = async () => {
    if (!view || !candidate || busy || String(view.project_id) !== String(projectId)) return;
    if (!selected.length) {
      showToast(t('story.plan_empty_selection', '请至少选择一项再采纳'), 'warning');
      return;
    }
    setBusy(true);
    try {
      if (dirty) {
        const proceed = window.confirm(t('story.plan_dirty_confirm', '当前章节有未保存修改。保存并继续？'));
        if (!proceed || !(await onSave())) return;
        await reload();
        showToast(t('story.plan_saved_before_apply', '已保存章节修改，请核对最新规划后再采纳'), 'warning');
        return;
      }
      const current = await loadPlan(true);
      if (!current || current.revision !== view.revision) {
        showToast(t('story.plan_saved_before_apply', '已保存章节修改，请核对最新规划后再采纳'), 'warning');
        return;
      }
      await api.applyStoryPlanCandidate(Number(projectId), candidate.id, {
        expected_revision: current.revision,
        expected_candidate_revision: candidate.candidate_revision,
        selected_patch_ids: selected,
      });
      setCandidate(null);
      await reload();
      onChaptersChanged();
      showToast(t('story.plan_applied', '已采纳所选规划'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('story.plan_failed', '规划失败'), 'error');
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const createNext = async () => {
    if (!view?.next_entry_id || busy || String(view.project_id) !== String(projectId)) return;
    let current: PlanView | null = view;
    if (dirty) {
      const proceed = window.confirm(t('story.plan_dirty_confirm', '当前章节有未保存修改。保存并继续？'));
      if (!proceed) return;
      const saved = await onSave();
      if (!saved) return;
    }
    setBusy(true);
    try {
      current = await loadPlan(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('story.plan_failed', '规划失败'), 'error');
      setBusy(false);
      return;
    }
    if (!current?.next_entry_id) {
      setBusy(false);
      return;
    }
    const entryId = current.next_entry_id;
    const last = [...chapters].sort((a, b) => a.index - b.index).at(-1);
    const input = {
      plan_entry_id: entryId,
      expected_revision: current.revision,
      expected_last_chapter_id: last?.id || null,
    };
    let request: StoredNextChapterRequest;
    try {
      request = getOrCreateNextRequest(localStorage, projectId, input);
    } catch (error) {
      if (error instanceof SavedRequestError && error.code === 'INVALID_SAVED_NEXT_REQUEST') {
        const reset = window.confirm(t('story.plan_saved_invalid_confirm', '已保存的规划请求无法读取。清除并重新发起？'));
        if (!reset) {
          setBusy(false);
          return;
        }
        clearNextRequest(localStorage, projectId, entryId);
        request = getOrCreateNextRequest(localStorage, projectId, input);
      } else {
        showToast(t('story.plan_storage_unavailable', '浏览器无法保存请求，已取消本次生成'), 'error');
        setBusy(false);
        return;
      }
    }
    const finishNext = async (payload: StoredNextChapterRequest) => {
      await api.createNextPlannedChapter(Number(projectId), payload);
      clearNextRequest(localStorage, projectId, entryId);
      onChaptersChanged();
      await reload();
      showToast(t('story.plan_next_ready', '下一章已创建'), 'success');
    };
    try {
      await finishNext(request);
    } catch (error) {
      if (error instanceof ApiError && FRESH_KEY_CONFLICTS.has(error.code || '')) {
        clearNextRequest(localStorage, projectId, entryId);
        const retry = window.confirm(`${error.message}\n${t('story.plan_retry_conflict', '确认后将使用新的请求再试一次。')}`);
        if (retry) {
          let freshInput = input;
          try {
            const epoch = planEpoch.current;
            const [latestPlan, latestChapters] = await Promise.all([
              api.getStoryPlan(Number(projectId)),
              api.getChapters(Number(projectId)),
            ]);
            if (epoch === planEpoch.current && String(latestPlan?.project_id) === String(projectId)) {
              setView(latestPlan);
            }
            const latestLast = [...(latestChapters || [])].sort((a, b) => a.index - b.index).at(-1);
            freshInput = {
              plan_entry_id: entryId,
              expected_revision: latestPlan.revision,
              expected_last_chapter_id: latestLast?.id || null,
            };
          } catch {
            freshInput = input;
          }
          const fresh = getOrCreateNextRequest(localStorage, projectId, freshInput);
          try {
            await finishNext(fresh);
          } catch (retryError) {
            if (!(retryError instanceof ApiError)) {
              showToast(t('story.plan_network_kept', '网络结果未知，已保留原来的请求，可再次点击重试'), 'warning');
            } else {
              showToast(retryError.message, 'error');
            }
          }
        } else {
          showToast(error.message, 'error');
        }
      } else if (!(error instanceof ApiError)) {
        showToast(t('story.plan_network_kept', '网络结果未知，已保留原来的请求，可再次点击重试'), 'warning');
      } else {
        showToast(error.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleAuto = async () => {
    if (!view || busy || String(view.project_id) !== String(projectId)) return;
    setBusy(true);
    try {
      const current = await loadPlan(true);
      if (!current || String(current.project_id) !== String(projectId)) return;
      const document = {
        ...current.document,
        autoCreateNextChapter: !current.document.autoCreateNextChapter,
      };
      const epoch = planEpoch.current;
      const next = await api.updateStoryPlan(Number(projectId), current.revision, document);
      if (epoch !== planEpoch.current || String(next?.project_id) !== String(projectId)) return;
      setView(next);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('story.plan_failed', '规划失败'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const activeEntries = view?.entries.filter((entry) => entry.disposition !== 'retired') || [];
  const futureEntries = activeEntries.filter((entry) => !entry.chapter_id);
  const reviewChapters = candidate && String(view?.project_id) === String(projectId)
    ? chaptersAwaitingReview(candidate)
    : [];

  return (
    <section className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-[#0c1322]/80 px-3 py-3 space-y-2" data-plan-id={view ? String(view.project_id) : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">{t('story.plan_title', '后续规划')}</h3>
        {view?.budget && (
          <span className="text-[11px] text-slate-500">
            {t('story.plan_budget', '已写')} {view.budget.written} / {t('story.plan_reserved', '预留')} {view.budget.reserved}
            {view.budget.target ? ` / ${view.budget.target}` : ''}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="story-ideation-start" className="text-[11px] px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800" onClick={() => agent?.sendPrompt({ text: t('story.ideation_hello', '我想构思一本新小说'), conversationMode: 'ideation', dispatchId: crypto.randomUUID() })}>
          {t('story.ideation_start', '构思开书')}
        </button>
        <button type="button" data-testid="story-blueprint-generate" disabled={busy} className="text-[11px] px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 disabled:opacity-50" onClick={() => generate('blueprint')}>
          {t('story.plan_blueprint', '整理设定')}
        </button>
        <button type="button" data-testid="story-plan-generate" disabled={busy} className="text-[11px] px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 disabled:opacity-50" onClick={() => generate('chapters', activeEntries.length ? 'extend' : 'initial')}>
          {t('story.plan_generate', '规划章节')}
        </button>
        <button type="button" data-testid="story-plan-extend" disabled={busy || !view} className="text-[11px] px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 disabled:opacity-50" onClick={() => generate('chapters', 'extend')}>
          {t('story.plan_extend', '扩展规划')}
        </button>
        <button type="button" data-testid="story-plan-revise" disabled={busy || reviseIds.length === 0} className="text-[11px] px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 disabled:opacity-50" onClick={() => generate('chapters', 'revise')}>
          {t('story.plan_revise', '修订所选')}
        </button>
        <button type="button" data-testid="story-next-chapter" disabled={busy || !view?.next_entry_id} className="text-[11px] px-2.5 py-1 rounded-lg bg-emerald-600 text-white disabled:opacity-50" onClick={createNext}>
          {t('story.plan_next', '创建下一章')}
        </button>
        <button type="button" data-testid="story-auto-next" aria-pressed={Boolean(view?.document.autoCreateNextChapter)} disabled={!view || busy} className="text-[11px] px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-50" onClick={toggleAuto}>
          {view?.document.autoCreateNextChapter ? t('story.plan_auto_on', '定稿后自动建章：开') : t('story.plan_auto_off', '定稿后自动建章：关')}
        </button>
      </div>
      {futureEntries.length > 0 && (
        <ul className="space-y-1 max-h-36 overflow-auto">
          {futureEntries.map((entry) => (
            <li key={entry.id} className="text-[11px] text-slate-600 dark:text-slate-300 flex gap-2">
              <input type="checkbox" checked={reviseIds.includes(entry.id)} onChange={() => setReviseIds((ids) => ids.includes(entry.id) ? ids.filter((id) => id !== entry.id) : [...ids, entry.id])} />
              <span className="font-medium">{entry.title}</span>
              <span className="truncate text-slate-400">{entry.summary}</span>
            </li>
          ))}
        </ul>
      )}
      {candidate && (
        <div className="rounded-xl border border-indigo-200 dark:border-indigo-900 p-2 space-y-1" data-candidate-id={candidate.id}>
          <div className="text-[11px] font-medium text-indigo-700 dark:text-indigo-300">
            {candidate.state === 'stale' ? t('story.plan_stale', '来源已变化，请重新生成') : t('story.plan_diff', '待采纳差异')}
          </div>
          {(candidate.patches || []).map((patch) => (
            <label key={patch.id} className="flex gap-2 text-[11px] text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={selected.includes(patch.id)}
                onChange={() => setSelected((ids) => ids.includes(patch.id) ? ids.filter((id) => id !== patch.id) : [...ids, patch.id])}
              />
              <span>
                <span className="font-medium">{patch.label}</span>
                {patch.before ? <span className="block line-through text-slate-400">{patch.before}</span> : null}
                {patch.after ? <span className="block">{patch.after}</span> : null}
              </span>
            </label>
          ))}
          {reviewChapters.map((chapter) => (
            <div key={chapter.id} data-testid="story-plan-chapter-preview" className="pl-5 text-[11px] text-slate-600 dark:text-slate-300">
              <span className="font-medium">{chapter.title}</span>
              <span className="text-slate-400"> · {chapter.targetWordCount}{t('story.plan_words', '字')}</span>
              {chapter.summary ? <span className="block whitespace-pre-wrap">{chapter.summary}</span> : null}
            </div>
          ))}
          <button type="button" data-testid="story-plan-candidate-apply" disabled={busy || candidate.state !== 'pending'} className="text-[11px] px-2.5 py-1 rounded-lg bg-indigo-600 text-white disabled:opacity-50" onClick={applyCandidate}>
            {t('story.plan_apply', '采纳所选')}
          </button>
        </div>
      )}
    </section>
  );
};
