type Result = {
  status: string;
  op?: string;
  data?: {
    content?: unknown;
    applied?: unknown;
    chapterId?: unknown;
  };
};

const SKILL_CONTENT_OPS = new Set([
  'CINEMATIC_REWRITE',
  'ADD_CONFLICT',
  'REVERSE_PLOT',
  'DRAFT_CONTENT',
]);

/** Executor returns one result per action, in request order. */
export function summarizeAgentExecution<T>(actions: T[], results: Result[]) {
  const successful = results.filter((item) => item.status === 'success');
  const complete = results.length === actions.length;
  const failed = !complete || results.some((item) => item.status === 'error');
  return {
    successful,
    failed,
    titleKey: failed
      ? (successful.length ? 'agent.execute_partial' : 'agent.execute_fail')
      : (successful.length ? 'agent.execute_done' : 'agent.execute_skipped'),
    // Never rerun successful writes in a partially failed batch.
    retryActions: actions.filter((_, index) =>
      !results[index] || results[index].status === 'error'
    ),
  };
}

/** Drop confirm/retry cards when the page or the chapter they were created for changes. */
export function shouldRetainPendingAgentActions(input: {
  pendingChapterId: string | null;
  currentChapterId: string | null;
  pendingSurface: string | null;
  currentSurface: string | null;
}): boolean {
  if (input.pendingSurface && input.pendingSurface !== input.currentSurface) return false;
  return input.pendingChapterId === input.currentChapterId;
}

/**
 * Body already written to the database. Only the chapter currently open in the
 * editor may receive it; another chapter's draft stays untouched.
 */
export function selectAppliedSkillContent(
  results: Result[] | undefined,
  editorChapterId: string | null | undefined
): string | null {
  if (!results?.length || !editorChapterId) return null;
  for (const item of results) {
    if (item.status !== 'success' || !item.op || !SKILL_CONTENT_OPS.has(item.op)) continue;
    const data = item.data;
    const content = typeof data?.content === 'string' ? data.content : '';
    if (!content || !data?.applied) continue;
    if (data.chapterId !== editorChapterId) continue;
    return content;
  }
  return null;
}

/** Skip the story-editor force refresh when every successful write names another chapter. */
export function shouldRefreshAfterExecution(
  results: Result[] | undefined,
  editorChapterId: string | null | undefined
): boolean {
  const successes = (results || []).filter((item) => item.status === 'success');
  if (!successes.length) return false;
  return successes.some((item) => {
    const chapterId = item.data?.chapterId;
    if (typeof chapterId !== 'string' || !chapterId) return true;
    return chapterId === editorChapterId;
  });
}
