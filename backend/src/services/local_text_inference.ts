import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { SettingsManager } from '../core/settings_manager';
import { GpuLeaseService, type GpuLease } from './gpu_lease_service';
import { isRemoteGemmaLlm, isRemotePresetLlm } from './llm_presets';
import { isNodeTest } from './inference_cache';

const ownedTextLease = new AsyncLocalStorage<GpuLease>();
let ensureOverride: (() => Promise<void>) | null = null;
export function setLocalTextModelEnsureForTests(fn: (() => Promise<void>) | null): void { ensureOverride = fn; }

/** Hold exclusive GPU ownership through composition AND verification, not just model startup. */
export async function withLocalTextInference<T>(work: () => Promise<T>, options: { configuredProvider?: boolean } = {}): Promise<T> {
  const llm = SettingsManager.loadSettings().llm || {};
  if (options.configuredProvider && !['ollama', 'local_llm', 'custom'].includes(String(llm.provider || 'ollama').toLowerCase())) return work();
  if (options.configuredProvider && String(llm.provider || '').toLowerCase() === 'custom' && llm.base_url) {
    try { if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(llm.base_url).hostname)) return work(); } catch { return work(); }
  }
  if (!ensureOverride && (isNodeTest() || isRemotePresetLlm(llm) || isRemoteGemmaLlm(llm) || String(llm.provider || '').toLowerCase() === 'gemini')) return work();
  if (ownedTextLease.getStore()) return work();
  const owner = `text_${randomUUID()}`;
  const lease = await GpuLeaseService.acquireLease(owner, 'text', 30 * 60 * 1000);
  const heartbeat = setInterval(() => GpuLeaseService.heartbeat(lease.lease_id, owner), 20_000);
  try {
    if (ensureOverride) await ensureOverride();
    else {
      const { VramService } = await import('./vram_service');
      const status = await VramService.getStatus();
      if (!status.ollama.online) {
        const switched = await VramService.switchTo('llamacpp');
        if (!switched.ok || !switched.status?.ollama.online) {
          throw new Error(switched.message_zh || switched.message || '本地文本模型未能启动。');
        }
      }
    }
    return await ownedTextLease.run(lease, work);
  } finally {
    clearInterval(heartbeat);
    GpuLeaseService.releaseLease(lease.lease_id, owner);
  }
}
