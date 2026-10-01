import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chaptersAwaitingReview,
  FRESH_KEY_CONFLICTS,
  SavedRequestError,
  clearGenerateRequest,
  getOrCreateGenerateRequest,
  getOrCreateNextRequest,
  parseGenerateRequest,
  readIdeationHistory,
} from './storyPlanRequests';

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

test('an unknown generate request keeps the first key and revision', () => {
  const storage = memoryStore();
  const first = getOrCreateGenerateRequest(storage, '9', () => ({
    expected_revision: 2,
    kind: 'chapters',
    mode: 'extend',
    message: '请规划后续章节',
    batch_size: 3,
  }));
  const replay = getOrCreateGenerateRequest(storage, '9', () => {
    throw new Error('must not mint a new payload');
  });
  assert.equal(replay.request_key, first.request_key);
  assert.equal(replay.expected_revision, 2);
  assert.equal(replay.message, '请规划后续章节');
  clearGenerateRequest(storage, '9');
  const next = getOrCreateGenerateRequest(storage, '9', () => ({
    expected_revision: 4,
    kind: 'blueprint',
    message: '整理设定',
  }));
  assert.notEqual(next.request_key, first.request_key);
  assert.equal(next.expected_revision, 4);
});

test('a damaged generate payload is not replaced silently', () => {
  const storage = memoryStore();
  storage.setItem('novastory_plan_generate_9', '{');
  assert.throws(
    () => parseGenerateRequest(storage.getItem('novastory_plan_generate_9')),
    (error: unknown) => error instanceof SavedRequestError && error.code === 'INVALID_SAVED_GENERATE_REQUEST'
  );
  assert.throws(
    () => getOrCreateGenerateRequest(storage, '9', () => ({
      expected_revision: 1,
      kind: 'blueprint',
      message: 'new',
    })),
    (error: unknown) => error instanceof SavedRequestError && error.code === 'INVALID_SAVED_GENERATE_REQUEST'
  );
  assert.equal(storage.getItem('novastory_plan_generate_9'), '{');
});

test('the next-chapter request ignores a newer revision until the saved key is cleared', () => {
  const storage = memoryStore();
  const first = getOrCreateNextRequest(storage, '9', {
    plan_entry_id: 'plan_1',
    expected_revision: 3,
    expected_last_chapter_id: 'ch-1',
  });
  const replay = getOrCreateNextRequest(storage, '9', {
    plan_entry_id: 'plan_1',
    expected_revision: 8,
    expected_last_chapter_id: 'ch-2',
  });
  assert.equal(replay.request_key, first.request_key);
  assert.equal(replay.expected_revision, 3);
  assert.equal(replay.expected_last_chapter_id, 'ch-1');
  assert.equal(FRESH_KEY_CONFLICTS.has('PLAN_CONFLICT'), true);
  assert.equal(FRESH_KEY_CONFLICTS.has('PREVIOUS_CHAPTER_NOT_FINALIZED'), false);
});

test('ideation history is kept on the saved generate payload and command chat is left out', () => {
  const storage = memoryStore();
  const history = readIdeationHistory(JSON.stringify([
    { role: 'agent', content: '欢迎', mode: 'command' },
    { role: 'user', content: '主角是画师', mode: 'ideation' },
    { role: 'agent', content: '题材可以是民国', mode: 'ideation' },
    { role: 'user', content: '  ', mode: 'ideation' },
  ]));
  assert.deepEqual(history, [
    { role: 'user', content: '主角是画师' },
    { role: 'assistant', content: '题材可以是民国' },
  ]);
  const saved = getOrCreateGenerateRequest(storage, '9', () => ({
    expected_revision: 2,
    kind: 'blueprint',
    message: '请根据目前的构思整理开书设定',
    history,
  }));
  const replay = parseGenerateRequest(storage.getItem('novastory_plan_generate_9'));
  assert.deepEqual(replay?.history, history);
  assert.equal(replay?.request_key, saved.request_key);
  assert.throws(
    () => parseGenerateRequest(JSON.stringify({
      request_key: 'k',
      expected_revision: 1,
      kind: 'blueprint',
      message: '整理设定',
      history: 'not-an-array',
    })),
    (error: unknown) => error instanceof SavedRequestError && error.code === 'INVALID_SAVED_GENERATE_REQUEST'
  );
});

test('chapter review shows outlines hidden by a title-only batch patch', () => {
  const existing = { id: 'plan_old', title: '旧章', summary: '已有', targetWordCount: 2000 };
  const added = { id: 'plan_new', title: '新章', summary: '雨夜相遇', targetWordCount: 8000 };
  assert.deepEqual(chaptersAwaitingReview({
    patches: [{ id: 'chapters_batch' }],
    before: { chapters: [existing] },
    after: { chapters: [existing, added] },
  }), [added]);
  assert.deepEqual(chaptersAwaitingReview({
    patches: [{ id: 'chapter:plan_old' }],
    before: { chapters: [existing] },
    after: { chapters: [{ ...existing, summary: '改后的章纲', targetWordCount: 3000 }] },
  }), [{ ...existing, summary: '改后的章纲', targetWordCount: 3000 }]);
  assert.deepEqual(chaptersAwaitingReview({
    patches: [{ id: 'project.title' }],
    after: { chapters: [existing] },
  }), []);
});
