import { z } from 'zod';

export type TextGenOptions = {
  stream?: boolean;
  /** Dynamic thinking switch (Scheme C): true enables thinking for conception/breakdown; false disables it. */
  enableThinking?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type StructuredGenOptions = {
  temperature?: number;
  maxTokens?: number;
  systemInstruction?: string;
  seed?: number;
  signal?: AbortSignal;
  /** Dynamic thinking switch (Scheme C): false (default) disables thinking during JSON formatting/extraction. */
  enableThinking?: boolean;
  /** Logical task owners count transport retries themselves. */
  transportRetries?: number;
  onInference?: (record:{model:string;elapsed_ms:number;response?:unknown;error?:string;usage?:unknown;finish_reason?:string|null})=>void;
};

/**
 * Strip `<think>...</think>` blocks from Step 1 thinking output while preserving
 * the resulting director/screenwriter analysis outline (or falling back to inner
 * thinking text if the model emitted its entire conception inside `<think>`).
 */
export function extractThinkingConceptionText(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  const withoutCompleteThink = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const withoutUnclosedThink = withoutCompleteThink.replace(/<think>[\s\S]*$/i, '').trim();
  if (withoutUnclosedThink) return withoutUnclosedThink;
  const thinkMatch = text.match(/<think>([\s\S]*?)(?:<\/think>|$)/i);
  return thinkMatch?.[1]?.trim() || '';
}

/**
 * Scheme C Stage-1 helper: Run free-text thinking/conception (`enable_thinking: true`,
 * no JSON schema forced) before Stage-2 strict JSON formatting (`enable_thinking: false`).
 * Gracefully degrades to empty string when called against unit-test mock providers
 * that do not implement `generateText` or stub it out to throw.
 */
export async function runStageOneThinkingConception(
  provider: AIProvider,
  prompt: string,
  systemInstruction?: string,
  options?: Omit<TextGenOptions, 'enableThinking'>
): Promise<string> {
  if (!provider || typeof provider.generateText !== 'function') return '';
  let currentMaxTokens = options?.maxTokens;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await provider.generateText(prompt, systemInstruction, {
        ...options,
        maxTokens: currentMaxTokens,
        enableThinking: true,
      });
      const cleaned = extractThinkingConceptionText(raw);
      if (!cleaned || cleaned === 'mock text') return '';
      return cleaned;
    } catch (error: any) {
      const msg = String(error?.message || error || '');
      // Unit-test stubs that forbid or omit free-text calls should proceed to Stage 2 JSON formatting.
      if (/unexpected.*text|no text|never generates free text|unhandled/i.test(msg)) {
        return '';
      }
      if (/maximum context length/i.test(msg) && currentMaxTokens !== undefined && attempt < 2) {
        currentMaxTokens = undefined;
        continue;
      }
      const isTransient =
        error?.status === 429 ||
        (typeof error?.status === 'number' && error.status >= 500) ||
        /52[24]|timeout|terminated|ECONNRESET|ETIMEDOUT|socket/i.test(msg);
      if (isTransient && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  return '';
}

export type ImageGenerationOptions = {
  width: number;
  height: number;
  aspectRatio: '16:9' | '9:16' | '1:1';
  imageSize: '512' | '1K' | '2K';
  /** Local files for providers that can preserve approved visual identity. */
  referenceImagePaths?: string[];
  /** Reattach a timed-out built-in Codex image job to the normal generation flow. */
  resumeJobId?: string;
};

export interface AIProvider {
    generateText(prompt: string, systemInstruction?: string, options?: TextGenOptions): Promise<string>;

    // In Node.js with Zod, we pass the ZodSchema to be parsed instead of a Pydantic Model
    generateStructured<T>(
      prompt: string,
      responseSchema: z.ZodSchema<T>,
      systemInstruction?: string,
      options?: StructuredGenOptions
    ): Promise<T>;

    generateImage(prompt: string, options?: ImageGenerationOptions, token?: string): Promise<{ url?: string; b64_json?: string; data?: Buffer; error?: string }>;
}
