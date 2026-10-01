import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ApiError } from './api_error';
import { unsupportedMockResponse } from './mock_fallback';

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
