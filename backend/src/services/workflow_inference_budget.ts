import { createHash } from 'node:crypto';
import type { AIProvider } from './ai/base';

export type WorkflowInferenceBudget = {
  version: 1;
  semantic_repairs: number;
  network_retries: number;
  translation_batch_size?: 1;
  batches: Array<{ stage: string; input_hash: string; items: number; reason: 'initial' | 'repair_split' }>;
  calls: Array<{ stage: string; task: string; prompt_hash: string; kind: 'initial' | 'semantic_repair' | 'network_retry'; attempt_state: 'reserved' | 'completed' | 'error' | 'interrupted_unknown'; elapsed_ms: number; response?: unknown; error?: string; model?: string; usage?: unknown; finish_reason?: string | null }>;
};
export const newWorkflowInferenceBudget = (): WorkflowInferenceBudget => ({ version: 1, semantic_repairs: 0, network_retries: 0, batches: [], calls: [] });
/** One storyboard fact pass makes many calls. A few EdgeOne 524s must not end it; the cap still stops a dead endpoint. */
export const NETWORK_RETRY_LIMIT = 6;
export const isInferenceTransportError = (error: any) => {
  const message = String(error?.message || '');
  return Boolean(error?.status === 429 || (typeof error?.status === 'number' && error.status >= 500) || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error?.code) || ['APIConnectionError','APIConnectionTimeoutError'].includes(error?.name) || ['APIConnectionError','APIConnectionTimeoutError'].includes(error?.constructor?.name) || message === 'terminated' || (/\b52[24]\b/.test(message) && /status code/.test(message)));
};
export class WorkflowTransportError extends Error {
  constructor(public cause: unknown) { super(cause instanceof Error ? cause.message : String(cause)); }
}

/** All children use this owner. Reserve before sending, including the one explicit transport retry. */
export function workflowBudgetProvider(delegate: AIProvider, budget: WorkflowInferenceBudget, persist: () => Promise<void>, stage: () => string, kind: () => 'initial' | 'semantic_repair'): AIProvider {
  return {
    generateText: delegate.generateText.bind(delegate),
    generateImage: delegate.generateImage.bind(delegate),
    async generateStructured(prompt, schema, system, options) {
      let callKind: WorkflowInferenceBudget['calls'][number]['kind'] = kind();
      while (true) {
        if (options?.signal?.aborted) throw options.signal.reason;
        let task = 'structured';
        try { task = JSON.parse(prompt).task || task; } catch { /* A non-JSON prompt remains valid. */ }
        const call: WorkflowInferenceBudget['calls'][number] = { stage: stage(), task, prompt_hash: createHash('sha256').update(prompt).digest('hex'), kind: callKind, attempt_state: 'reserved', elapsed_ms: 0 };
        const index = budget.calls.push(call) - 1;
        await persist();
        const started = Date.now();
        let traced = false;
        try {
          const output = await delegate.generateStructured(prompt, schema, system, { ...options, transportRetries: 0, onInference: record => {
            traced = true;
            budget.calls[index] = { ...call, ...record, attempt_state: record.error ? 'error' : 'completed' };
            options?.onInference?.(record);
          } });
          if (!traced) budget.calls[index] = { ...call, attempt_state: 'completed', elapsed_ms: Date.now() - started, response: output };
          await persist();
          return output;
        } catch (error: any) {
          if (!traced) budget.calls[index] = { ...call, attempt_state: 'error', elapsed_ms: Date.now() - started, error: error?.message || String(error) };
          await persist();
          if (options?.signal?.aborted) throw options.signal.reason;
          if (!isInferenceTransportError(error)) throw error;
          if (budget.network_retries >= NETWORK_RETRY_LIMIT) throw new WorkflowTransportError(error);
          budget.network_retries++;
          callKind = 'network_retry';
          await persist();
        }
      }
    },
  };
}
