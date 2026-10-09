import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ApiError } from './api_error';
import { unsupportedMockResponse } from './mock_fallback';
import { api } from './api';
import { listProjectWorkJobs, resumePersistedProjectWork, releaseProjectWork } from './project_work_tracker';

test('mock story-plan requests reject instead of staying pending', async () => {
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('private getMockResponse'));
  const beforeTimer = method.slice(0, method.indexOf('setTimeout'));
  assert.match(beforeTimer, /unsupportedMockResponse/);

  const outcome = await Promise.race([
    unsupportedMockResponse('/projects/1/story-plan/candidates')!.then(
      () => 'resolved',
      (error: unknown) => error
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
  ]);
  assert.equal(outcome instanceof ApiError, true);
  assert.equal((outcome as ApiError).code, 'MOCK_UNSUPPORTED');
  assert.equal((outcome as ApiError).status, 501);
  assert.equal(unsupportedMockResponse('/projects/1'), null);
});

test('storyboard polling ignores a previous attempt failure and accepts a fast current completion', async t => {
  t.mock.method(api as any, 'request', async () => ({ task_id: 'resumed', attempt: 2 }));
  let polls = 0;
  t.mock.method(api, 'getStoryboardTask', async () => ++polls === 1
    ? { status: 'failed', error: 'old failure', progress: { attempt: 1 } }
    : { status: 'completed', progress: { attempt: 2, candidate_id: 'new-candidate' } });
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { queueMicrotask(callback); return 0; }) as any);
  assert.deepEqual(await api.createStoryboardCandidate(1, { expected_revision: 1, request_key: 'resume' }), { candidate: { id: 'new-candidate' } });
  assert.equal(polls, 2);
});

test('storyboard polling surfaces a current failure even without observing queued or processing', async t => {
  t.mock.method(api as any, 'request', async () => ({ task_id: 'resumed', attempt: 2 }));
  let polls = 0;
  t.mock.method(api, 'getStoryboardTask', async () => { polls++; return { status: 'failed', error: 'current failure', progress: { attempt: 2 } }; });
  await assert.rejects(() => api.createStoryboardCandidate(1, { expected_revision: 1, request_key: 'resume' }), /current failure/);
  assert.equal(polls, 1);
});

test('refresh recovery ignores failures older than the new job, but stops on a current failure', async t => {
  const startedAt = Date.now();
  const jobs = [1, 2].map(scriptId => ({ id: `storyboard:resume-${scriptId}`, kind: 'storyboard', projectId: '1', chapterId: `resume-${scriptId}`, chapterTitle: '恢复', scriptId, requestKey: `resume-${scriptId}`, startedAt }));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => JSON.stringify(jobs), setItem: () => {} } });
  t.after(() => {
    for (const job of jobs) releaseProjectWork(job.id, startedAt);
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else delete (globalThis as any).sessionStorage;
  });
  t.mock.method(api, 'getStoryboardTasks', async scriptId => ({ tasks: [{ status: 'failed', updated_at: new Date(startedAt + (scriptId === 1 ? -1000 : 1)).toISOString(), progress: { request: { request_key: `resume-${scriptId}` } } }] }));
  const chapters: string[] = [];
  t.mock.method(api, 'getChapterScript', async chapterId => {
    chapters.push(chapterId);
    assert.ok(listProjectWorkJobs().some(job => job.chapterId === chapterId));
    return { exists: true, script: { pendingChanges: [{ request_key: chapterId }] } };
  });
  resumePersistedProjectWork();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(chapters, ['resume-1']);
  assert.equal(listProjectWorkJobs().length, 0);
});
