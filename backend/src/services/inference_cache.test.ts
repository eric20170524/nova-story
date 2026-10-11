import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { InferenceCache } from './inference_cache';
import { BACKEND_DIRECTORY } from '../core/paths';

const cacheTestDirectory = () => {
  // Windows AppContainer can deny atomic rename in its redirected OS temp folder.
  // Exercise the same workspace-backed storage used by production instead.
  const root = path.resolve(BACKEND_DIRECTORY, '../local/validation');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'inference-cache-test-'));
};

test('verified inference survives restart, separates rules and variants, and ignores corrupt entries', async () => {
  const directory = cacheTestDirectory();
  try {
    let calls = 0;
    const work = async () => ({ prompt: `result ${++calls}` });
    const cache = new InferenceCache<{ prompt: string }>('test', directory);
    const first = await cache.run({ a: 1, b: 2 }, 'rules-v1', work);
    const restarted = new InferenceCache<{ prompt: string }>('test', directory);
    assert.deepEqual(await restarted.run({ b: 2, a: 1 }, 'rules-v1', work), first);
    assert.equal(calls, 1);
    await restarted.run({ a: 1, b: 2 }, 'rules-v2', work);
    await restarted.run({ a: 1, b: 2 }, 'rules-v1', work, { variant: 'alternative' });
    await restarted.run({ a: 1, b: 2 }, 'rules-v1', work, { variant: 'alternative' });
    assert.equal(calls, 3);
    await restarted.run({ a: 1, b: 2 }, 'rules-v1', work, { forceRegenerate: true });
    assert.equal(calls, 4);
    const files = fs.readdirSync(path.join(directory, 'test'));
    assert.equal(files.length, 3);
    for (const file of files) {
      const filename = path.join(directory, 'test', file);
      const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
      assert.equal(record.verification.passed, true);
      record.result.prompt = 'unverified tampering';
      fs.writeFileSync(filename, JSON.stringify(record));
    }
    const corrupt = new InferenceCache<{ prompt: string }>('test', directory);
    assert.equal((await corrupt.run({ a: 1, b: 2 }, 'rules-v1', work)).prompt, 'result 5');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('concurrent identical requests share validation, failures are retryable, results cannot mutate the cache', async () => {
  const cache = new InferenceCache<{ values: number[] }>('concurrency-test');
  let calls = 0;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const work = async () => { calls++; await gate; return { values: [calls] }; };
  const a = cache.run({ source: 'one' }, 'v1', work);
  const b = cache.run({ source: 'one' }, 'v1', work);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  finish();
  const [one, two] = await Promise.all([a, b]);
  one.values.push(9);
  assert.deepEqual(two.values, [1]);
  assert.deepEqual((await cache.run({ source: 'one' }, 'v1', work)).values, [1]);
  const fail = async () => { calls++; throw new Error('validation failed'); };
  await assert.rejects(() => cache.run({ source: 'bad' }, 'v1', fail), /validation failed/);
  await assert.rejects(() => cache.run({ source: 'bad' }, 'v1', fail), /validation failed/);
  assert.equal(calls, 3);
});

test('different inputs persist independently and a mutating caller cannot change the saved fingerprint', async () => {
  const directory = cacheTestDirectory();
  try {
    const cache = new InferenceCache<string>('inputs', directory);
    const source = { text: 'original' };
    await Promise.all([
      cache.run(source, 'v1', async () => { source.text = 'changed'; return 'one'; }),
      cache.run({ text: 'other' }, 'v1', async () => 'two'),
    ]);
    const restarted = new InferenceCache<string>('inputs', directory);
    const fail = async () => { throw new Error('must reuse disk'); };
    assert.equal(await restarted.run({ text: 'original' }, 'v1', fail), 'one');
    assert.equal(await restarted.run({ text: 'other' }, 'v1', fail), 'two');
    assert.equal(fs.readdirSync(path.join(directory, 'inputs')).length, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
