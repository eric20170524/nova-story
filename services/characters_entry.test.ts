import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LAST_PROJECT_STORAGE_KEY,
  readLastProjectId,
  rememberLastProjectId,
  resolveCharactersEntry,
} from './characters_entry';

test('resolveCharactersEntry redirects only when the stored project is in the list', () => {
  assert.deepEqual(resolveCharactersEntry([], null), { type: 'empty' });
  assert.deepEqual(resolveCharactersEntry([], 3), { type: 'empty' });
  assert.deepEqual(
    resolveCharactersEntry([{ id: 2 }, { id: 9 }], 9),
    { type: 'redirect', projectId: 9 }
  );
  assert.deepEqual(resolveCharactersEntry([{ id: 2 }, { id: 9 }], 1), { type: 'pick' });
  assert.deepEqual(resolveCharactersEntry([{ id: 2 }], null), { type: 'pick' });
});

test('readLastProjectId and rememberLastProjectId round-trip a positive integer', () => {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
  });
  try {
    assert.equal(readLastProjectId(), null);
    rememberLastProjectId(7);
    assert.equal(store.get(LAST_PROJECT_STORAGE_KEY), '7');
    assert.equal(readLastProjectId(), 7);
    rememberLastProjectId(0);
    rememberLastProjectId(-4);
    rememberLastProjectId(1.5);
    assert.equal(readLastProjectId(), 7);
    store.set(LAST_PROJECT_STORAGE_KEY, 'nope');
    assert.equal(readLastProjectId(), null);
    store.set(LAST_PROJECT_STORAGE_KEY, '-3');
    assert.equal(readLastProjectId(), null);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: original,
    });
  }
});
