import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyGrokSourceDuration } from './grok_source_duration';

test('Grok clips near 5 seconds deliver, other watchable lengths require review, and nonsense lengths fail', () => {
  assert.equal(classifyGrokSourceDuration(5).action, 'deliver');
  assert.equal(classifyGrokSourceDuration(5.2).action, 'deliver');
  assert.equal(classifyGrokSourceDuration(6.2).action, 'review');
  assert.match(classifyGrokSourceDuration(6.2).reason || '', /manual review/);
  assert.equal(classifyGrokSourceDuration(0.2).action, 'reject');
  assert.equal(classifyGrokSourceDuration(Number.NaN).action, 'reject');
});
