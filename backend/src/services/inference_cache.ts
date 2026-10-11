import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDirectory } from '../core/paths';
import { SettingsManager } from '../core/settings_manager';
import { hashCanonical } from '../schemas/story_plan';

export const isNodeTest = () => process.execArgv.includes('--test')
  || process.argv.some(arg => /\.test\.[cm]?[jt]sx?$/.test(arg));

export const textModelFingerprint = () => hashCanonical(SettingsManager.loadSettings().llm || {});

export type InferenceReuseOptions = {
  /** A stable token for an explicitly requested alternative. Retries reuse that alternative. */
  variant?: string;
  forceRegenerate?: boolean;
};

type CacheRecord<T> = {
  schema_version: 1;
  input_fingerprint: string;
  rule_version: string;
  result: T;
  result_hash: string;
  verification: { passed: true; rule_version: string };
  verified_at: string;
};

/** Cache only the successful result of a step, including its validation. Never cache a failure. */
export class InferenceCache<T> {
  private memory = new Map<string, CacheRecord<T>>();
  private pending = new Map<string, Promise<T>>();

  constructor(private namespace: string, private directory?: string) {
    if (!/^[a-z0-9-]+$/.test(namespace)) throw new Error('Invalid inference cache namespace');
  }

  private filename(key: string): string | null {
    // Tests must not read or populate real production caches.
    if (!this.directory && isNodeTest()) return null;
    return path.join(this.directory || path.join(getDataDirectory(), 'inference-cache'), this.namespace, `${key}.json`);
  }

  private key(input: unknown, rules: string, variant?: string): string {
    return hashCanonical({ input, rules, variant: variant || '' });
  }

  private copy(value: T): T { return JSON.parse(JSON.stringify(value)); }

  private read(key: string, rules: string): CacheRecord<T> | null {
    let record = this.memory.get(key);
    if (!record) {
      const filename = this.filename(key);
      if (!filename) return null;
      try { record = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; }
    }
    try {
      if (!record || record.schema_version !== 1 || record.input_fingerprint !== key || record.rule_version !== rules
          || record.verification?.passed !== true || record.verification.rule_version !== rules
          || record.result === undefined || record.result_hash !== hashCanonical(record.result)) return null;
    } catch { return null; }
    this.remember(key, record);
    return record;
  }

  private remember(key: string, record: CacheRecord<T>): void {
    this.memory.delete(key);
    this.memory.set(key, record);
    if (this.memory.size > 512) this.memory.delete(this.memory.keys().next().value!);
  }

  rememberVerified(input: unknown, rules: string, result: T, options: InferenceReuseOptions = {}): void {
    const key = this.key(input, rules, options.variant);
    const record: CacheRecord<T> = {
      schema_version: 1, input_fingerprint: key, rule_version: rules,
      result: this.copy(result), result_hash: hashCanonical(result),
      verification: { passed: true, rule_version: rules }, verified_at: new Date().toISOString(),
    };
    this.remember(key, record);
    const filename = this.filename(key);
    if (!filename) return;
    // Keep temporary basenames short on Windows, including long user data paths.
    const temp = path.join(path.dirname(filename), `.${randomUUID()}.tmp`);
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(record));
      fs.renameSync(temp, filename);
    } catch {
      // Cache I/O must not fail production work. Each fingerprint has its own file,
      // so concurrent writes for different inputs never overwrite each other's entries.
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { /* Best-effort temporary-file cleanup. */ }
    }
  }

  async run(
    input: unknown,
    rules: string,
    work: () => Promise<T>,
    options: InferenceReuseOptions = {},
    executionScope?: (run: () => Promise<T>) => Promise<T>,
  ): Promise<T> {
    const snapshot = JSON.parse(JSON.stringify(input));
    const key = this.key(snapshot, rules, options.variant);
    if (!options.forceRegenerate) {
      const cached = this.read(key, rules);
      if (cached) return this.copy(cached.result);
    }
    // Enter the resource scope before registering OR awaiting shared work. A task
    // holding that resource must never await a worker queued behind its own lease.
    // Recheck the cache inside the scope: another owner may have filled it meanwhile.
    if (executionScope) return executionScope(() => this.run(snapshot, rules, work, options));
    if (!options.forceRegenerate) {
      const pending = this.pending.get(key);
      if (pending) return this.copy(await pending);
    }
    // Register before invoking work, including work that completes synchronously.
    const task = Promise.resolve().then(async () => {
      const result = await work();
      this.rememberVerified(snapshot, rules, result, options);
      return result;
    });
    if (!options.forceRegenerate) this.pending.set(key, task);
    try { return this.copy(await task); }
    finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }

  clearMemory(): void { this.memory.clear(); }
}
