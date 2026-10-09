import { useEffect, useState } from 'react';
import { API_BASE_URL } from '../constants';
import { api } from './api';
import type { VideoTaskState } from '../types';

export type ProjectWorkKind =
  | 'storyboard'
  | 'script_outline'
  | 'script_full'
  | 'script_scene'
  | 'narration'
  | 'video'
  | 'video_batch';

export interface ProjectWorkJob {
  id: string;
  projectId: string;
  chapterId: string;
  chapterTitle: string;
  kind: ProjectWorkKind;
  detail?: string;
  sceneId?: number | string;
  task?: VideoTaskState;
  startedAt: number;
  /** Server candidate key, so a refreshed page can see when the result lands. */
  scriptId?: number;
  requestKey?: string;
  /** Narration text captured when the job started. */
  baseline?: string;
}

const jobs = new Map<string, ProjectWorkJob>();
const listeners = new Set<() => void>();
const stopFlags = new Set<string>();
const videoWatches = new Map<string, Promise<VideoTaskState>>();

const VIDEO_TERMINAL = new Set([
  'completed',
  'review_required',
  'rejected',
  'failed',
  'cancelled',
  'interrupted',
]);

const STORAGE_KEY = 'novastory.project_work.v1';
const RESUME_LIMIT_MS = 12 * 60 * 1000;

let pageUnloading = false;
let resumeStarted = false;

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    pageUnloading = true;
  });
}

/** True once this document is going away. Callers should not treat that as a failure. */
export function isProjectWorkUnloading(): boolean {
  return pageUnloading;
}

function persistJobs(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    const slim = [...jobs.values()].map((job) => {
      if (!job.task) return job;
      const task = job.task;
      return {
        ...job,
        task: {
          task_id: task.task_id,
          scene_id: task.scene_id,
          status: task.status,
          stage: task.stage,
          queue_position: task.queue_position,
          error: task.error,
        },
      };
    });
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch {
    /* private mode or a full quota should not stop generation */
  }
}

function emit(): void {
  listeners.forEach((listener) => listener());
  persistJobs();
}

function removeJob(job: ProjectWorkJob): void {
  if (pageUnloading) return;
  const current = jobs.get(job.id);
  if (current?.startedAt !== job.startedAt) return;
  jobs.delete(job.id);
  emit();
}

function publishNotice(
  messageKey: string,
  tone: 'success' | 'error' | 'info',
  params?: Record<string, string | number>
): void {
  if (typeof window === 'undefined' || pageUnloading) return;
  window.dispatchEvent(
    new CustomEvent('novastory-project-work-notice', {
      detail: { messageKey, tone, params },
    })
  );
}

export function projectWorkId(kind: string, chapterId: string, sceneId?: number | string): string {
  return sceneId == null ? `${kind}:${chapterId}` : `${kind}:${chapterId}:${sceneId}`;
}

/** Outline, full script, and scene rewrite share one lock per chapter. */
export function scriptWorkId(chapterId: string): string {
  return `script:${chapterId}`;
}

export function claimProjectWork(job: ProjectWorkJob): boolean {
  if (jobs.has(job.id)) return false;
  jobs.set(job.id, job);
  emit();
  return true;
}

export function rememberVideoTask(id: string, startedAt: number, task: VideoTaskState): void {
  const current = jobs.get(id);
  if (!current || current.startedAt !== startedAt) return;
  jobs.set(id, { ...current, task });
  emit();
}

export function releaseProjectWork(id: string, startedAt: number): void {
  if (pageUnloading) return;
  const current = jobs.get(id);
  if (current?.startedAt !== startedAt) return;
  jobs.delete(id);
  emit();
}

export function listProjectWorkJobs(projectId?: string): ProjectWorkJob[] {
  const all = [...jobs.values()];
  return projectId ? all.filter((job) => job.projectId === projectId) : all;
}

export function subscribeProjectWork(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProjectWorkJobs(projectId?: string): ProjectWorkJob[] {
  const [snapshot, setSnapshot] = useState(() => listProjectWorkJobs(projectId));
  useEffect(() => {
    setSnapshot(listProjectWorkJobs(projectId));
    return subscribeProjectWork(() => {
      setSnapshot(listProjectWorkJobs(projectId));
    });
  }, [projectId]);
  return snapshot;
}

export function requestStopProjectWork(id: string): void {
  stopFlags.add(id);
  emit();
}

export function isProjectWorkStopRequested(id: string): boolean {
  return stopFlags.has(id);
}

export function clearProjectWorkStop(id: string): void {
  stopFlags.delete(id);
}

/** Keeps `run` alive after the page that started it unmounts. */
export function startProjectWork(job: ProjectWorkJob, run: () => Promise<void>): boolean {
  if (jobs.has(job.id)) return false;
  jobs.set(job.id, job);
  emit();
  void run()
    .catch(() => {})
    .finally(() => {
      if (pageUnloading) return;
      clearProjectWorkStop(job.id);
      const current = jobs.get(job.id);
      if (current?.startedAt === job.startedAt) {
        jobs.delete(job.id);
        emit();
      }
    });
  return true;
}

function noteVideo(jobId: string, taskId: string, sceneId: number, patch: Partial<VideoTaskState>): VideoTaskState {
  const current = jobs.get(jobId);
  const next: VideoTaskState = {
    status: 'processing',
    ...current?.task,
    ...patch,
    task_id: taskId,
    scene_id: sceneId,
  };
  if (current) {
    jobs.set(jobId, { ...current, task: next });
    emit();
  }
  return next;
}

/** Follow a server video task after the director page unmounts. One watch per task id. */
export function watchVideoTask(
  job: ProjectWorkJob,
  taskId: string,
  streamUrl: string,
  onFinished?: (state: VideoTaskState) => void
): Promise<VideoTaskState> {
  const existing = videoWatches.get(taskId);
  if (existing) return existing;

  const sceneId = Number(job.sceneId) || 0;
  if (!jobs.has(job.id)) {
    jobs.set(job.id, {
      ...job,
      task: { task_id: taskId, scene_id: sceneId, status: 'processing' },
    });
    emit();
  } else {
    noteVideo(job.id, taskId, sceneId, { status: 'processing' });
  }

  const promise = new Promise<VideoTaskState>((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const source = new EventSource(streamUrl);

    const finish = (state: VideoTaskState) => {
      if (settled) return;
      if (pageUnloading) {
        settled = true;
        if (poll) clearInterval(poll);
        source.close();
        videoWatches.delete(taskId);
        return;
      }
      settled = true;
      if (poll) clearInterval(poll);
      source.close();
      const current = jobs.get(job.id);
      if (current?.startedAt === job.startedAt) {
        jobs.delete(job.id);
        emit();
      }
      videoWatches.delete(taskId);
      try {
        onFinished?.(state);
      } finally {
        resolve(state);
      }
    };

    const note = (patch: Partial<VideoTaskState> & { status?: VideoTaskState['status'] }) => {
      if (settled) return;
      const state = noteVideo(job.id, taskId, sceneId, patch);
      if (VIDEO_TERMINAL.has(state.status)) finish(state);
    };

    const startPoll = () => {
      if (poll || settled) return;
      poll = setInterval(() => {
        void api.getVideoTask(taskId).then((state) => {
          if (state) note(state);
        }).catch(() => {});
      }, 2000);
    };

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'snapshot' && data.task) {
          note(data.task);
          return;
        }
        if (data.stage || data.status || data.phase) {
          note({
            status: data.status || 'processing',
            stage: data.stage || data.phase,
            output_url: data.output_url,
            qa_report: data.qa_report,
            error: data.error,
            queue_position: data.queue_position,
          });
        }
      } catch {
        /* ignore a malformed progress frame */
      }
    };
    source.onerror = () => {
      source.close();
      startPoll();
    };
  });

  videoWatches.set(taskId, promise);
  return promise;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobStillCurrent(job: ProjectWorkJob): boolean {
  return jobs.get(job.id)?.startedAt === job.startedAt;
}

async function resumeScriptLike(job: ProjectWorkJob): Promise<void> {
  const deadline = Math.max(job.startedAt + RESUME_LIMIT_MS, Date.now() + 4000);
  const readyKey = job.kind === 'storyboard'
    ? 'director.storyboard_candidate_ready'
    : job.kind === 'script_outline'
      ? 'script_editor.outline_ready'
      : job.kind === 'script_full'
        ? 'script_editor.script_ready'
        : 'script_editor.scene_ready';
  const eventName = job.kind === 'storyboard'
    ? 'novastory-storyboard-candidate-finished'
    : 'novastory-script-candidate-finished';
  while (jobStillCurrent(job)) {
    try {
      if (job.kind === 'storyboard' && job.scriptId && job.requestKey) {
        const result = await api.getStoryboardTasks(job.scriptId);
        const task = result.tasks.find(item => item.progress?.request?.request_key === job.requestKey);
        const updatedAt = task?.updated_at ? Date.parse(task.updated_at.endsWith('Z') ? task.updated_at : `${task.updated_at.replace(' ', 'T')}Z`) : NaN;
        if (task && ['failed', 'interrupted', 'cancelled'].includes(task.status) && (!Number.isFinite(updatedAt) || updatedAt >= job.startedAt)) {
          removeJob(job);
          publishNotice('director.storyboard_candidate_failed', 'error');
          return;
        }
      }
      const res = await api.getChapterScript(job.chapterId);
      const changes = (res.script?.pendingChanges || []) as Array<{ request_key?: string }>;
      if (job.requestKey && changes.some((change) => change.request_key === job.requestKey)) {
        removeJob(job);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(eventName, {
            detail: { projectId: job.projectId, chapterId: job.chapterId },
          }));
        }
        publishNotice(readyKey, 'success', job.detail ? { scene: job.detail } : undefined);
        return;
      }
    } catch {
      /* the next poll retries a dropped connection */
    }
    if (Date.now() >= deadline) break;
    await sleep(3000);
  }
  if (!jobStillCurrent(job)) return;
  removeJob(job);
  publishNotice('director.work_resume_timeout', 'info');
}

async function resumeNarration(job: ProjectWorkJob): Promise<void> {
  const deadline = Math.max(job.startedAt + RESUME_LIMIT_MS, Date.now() + 4000);
  while (jobStillCurrent(job)) {
    try {
      const res = await api.getTimeline(job.chapterId);
      const timeline = (res?.timeline || []) as Array<{ id?: number | string; narration?: string }>;
      const fingerprint = timeline.map((scene) => `${scene.id}:${scene.narration || ''}`).join('\n');
      if (job.baseline != null && fingerprint !== job.baseline) {
        removeJob(job);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('novastory-narration-finished', {
            detail: { projectId: job.projectId, chapterId: job.chapterId },
          }));
        }
        publishNotice('director.narration_generated', 'success', { count: timeline.length });
        return;
      }
    } catch {
      /* retry */
    }
    if (Date.now() >= deadline) break;
    await sleep(3000);
  }
  if (!jobStillCurrent(job)) return;
  removeJob(job);
  publishNotice('director.work_resume_timeout', 'info');
}

function chapterHasLiveVideo(job: ProjectWorkJob): boolean {
  return [...jobs.values()].some((item) =>
    item.kind === 'video'
    && item.projectId === job.projectId
    && item.chapterId === job.chapterId
    && Boolean(item.task?.task_id)
    && !VIDEO_TERMINAL.has(item.task?.status || '')
  );
}

function resumeBatch(job: ProjectWorkJob): void {
  publishNotice('director.video_batch_refresh_stopped', 'info');
  if (!chapterHasLiveVideo(job)) {
    removeJob(job);
    return;
  }
  const unsubscribe = subscribeProjectWork(() => {
    if (chapterHasLiveVideo(job)) return;
    unsubscribe();
    removeJob(job);
  });
}

function resumeVideo(job: ProjectWorkJob): void {
  const taskId = job.task?.task_id || '';
  if (!taskId || VIDEO_TERMINAL.has(job.task?.status || '')) {
    removeJob(job);
    return;
  }
  void watchVideoTask(
    job,
    taskId,
    `${API_BASE_URL}/videos/tasks/${taskId}/stream`,
    (state) => {
      const failed = state.status === 'failed' || state.status === 'rejected' || state.status === 'interrupted';
      const messageKey = failed
        ? 'director.video_failed'
        : state.status === 'review_required'
          ? 'director.video_review_required'
          : state.status === 'completed'
            ? 'director.video_completed'
            : state.status === 'cancelled'
              ? 'director.video_cancelled'
              : 'director.video_failed';
      const tone = state.status === 'completed'
        ? 'success'
        : state.status === 'cancelled' || state.status === 'review_required'
          ? 'info'
          : 'error';
      publishNotice(messageKey, tone);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('novastory-video-task-finished', {
          detail: {
            projectId: job.projectId,
            chapterId: job.chapterId,
            sceneId: job.sceneId,
            status: state.status,
            error: state.error,
            taskId: state.task_id,
          },
        }));
      }
    }
  );
}

/** Restore jobs written before a full page refresh and keep watching them. */
export function resumePersistedProjectWork(): void {
  if (resumeStarted || typeof sessionStorage === 'undefined') return;
  resumeStarted = true;
  let saved: ProjectWorkJob[] = [];
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]') as ProjectWorkJob[];
    saved = Array.isArray(raw) ? raw : [];
  } catch {
    saved = [];
  }
  for (const job of saved) {
    if (!job?.id || !job.kind || jobs.has(job.id)) continue;
    jobs.set(job.id, job);
  }
  emit();
  for (const job of [...jobs.values()]) {
    if (job.kind === 'video') resumeVideo(job);
    else if (job.kind === 'video_batch') resumeBatch(job);
    else if (job.kind === 'narration') void resumeNarration(job);
    else void resumeScriptLike(job);
  }
}
