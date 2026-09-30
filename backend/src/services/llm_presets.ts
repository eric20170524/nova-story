/** Lab Gemma 4 31B, served through the ComfyUI host's OpenAI-compatible path. */
export const GEMMA4_REMOTE_MODEL = 'gemma-4-31b';
export const GEMMA4_REMOTE_BASE_URL = 'https://comfy.chuangyi.chat/gemma4/v1';

const OLLAMA_PROVIDERS = new Set(['', 'ollama', 'local_llm']);

function isOllamaBase(baseUrl: string): boolean {
    return !baseUrl || baseUrl.includes(':11434');
}

export function isRemoteGemmaLlm(
    llm: { model?: string; base_url?: string } | null | undefined
): boolean {
    const model = String(llm?.model || '');
    const base = String(llm?.base_url || '');
    return model === GEMMA4_REMOTE_MODEL
        || base === GEMMA4_REMOTE_BASE_URL
        || base.includes('/gemma4');
}

/**
 * `LLM_MODEL=gemma-4-31b` is the remote lab model. A leftover Ollama
 * provider or base URL would send that name to the wrong server.
 */
export function applyKnownRemoteLlm(settings: Record<string, any>): Record<string, any> {
    const llm = { ...(settings.llm || {}) };
    if (!isRemoteGemmaLlm(llm)) {
        return settings;
    }

    const base = String(llm.base_url || '');
    const provider = String(llm.provider || '').toLowerCase();
    if (llm.model === GEMMA4_REMOTE_MODEL && (OLLAMA_PROVIDERS.has(provider) || isOllamaBase(base))) {
        llm.provider = 'openai';
        if (isOllamaBase(base)) {
            llm.base_url = GEMMA4_REMOTE_BASE_URL;
        }
    }

    const key = String(llm.api_key || '').trim();
    if (!key || key === 'ollama') {
        llm.api_key = '';
        const fromEnv = String(process.env.GEMMA4_API_KEY || process.env.LLM_API_KEY || '').trim();
        if (fromEnv && fromEnv !== 'ollama') {
            llm.api_key = fromEnv;
        }
    }

    settings.llm = llm;
    if (llm.model === GEMMA4_REMOTE_MODEL) {
        settings.llm_model = GEMMA4_REMOTE_MODEL;
    }
    return settings;
}

/** Verify uses the unsaved form. Blank keys must not revive a stored placeholder. */
export function mergeVerifyLlmConfig(
    storedLlm: Record<string, any> | undefined,
    bodyLlm: Record<string, any> | undefined
): Record<string, any> {
    const body = bodyLlm || {};
    const merged = applyKnownRemoteLlm({
        llm: {
            ...(storedLlm || {}),
            ...body,
            api_key:
                body.api_key && String(body.api_key).trim()
                    ? body.api_key
                    : storedLlm?.api_key,
        },
    });
    return merged.llm || {};
}
