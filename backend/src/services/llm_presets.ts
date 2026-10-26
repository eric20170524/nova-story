/** Lab Gemma 4 31B and Qwen3.8-27B, served through the ComfyUI host's OpenAI-compatible path. */
export const GEMMA4_REMOTE_MODEL = 'gemma-4-31b';
export const GEMMA4_REMOTE_BASE_URL = 'https://comfy.chuangyi.chat/gemma4/v1';
export const QWEN38_REMOTE_MODEL = 'Qwen3.8-27B';
export const QWEN38_REMOTE_BASE_URL = 'https://comfy.chuangyi.chat/qwen38/v1';
export const LOCAL_LLM_DEFAULT_MODEL = 'novastory-qwen3.5:9b';
export const LOCAL_LLM_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
export type LLMMode = 'local' | 'remote' | 'qwen' | 'gemma4';

const OLLAMA_PROVIDERS = new Set(['', 'ollama', 'local_llm']);

function isOllamaBase(baseUrl: string): boolean {
    return !baseUrl || baseUrl.includes(':11434');
}

export function isRemoteGemmaLlm(
    llm: { model?: string; base_url?: string } | null | undefined
): boolean {
    const model = String(llm?.model || '').toLowerCase();
    const base = String(llm?.base_url || '').toLowerCase();
    return model === GEMMA4_REMOTE_MODEL.toLowerCase()
        || model.includes('gemma-4-31b')
        || base === GEMMA4_REMOTE_BASE_URL.toLowerCase()
        || base.includes('/gemma4');
}

export function isRemoteQwenLlm(
    llm: { model?: string; base_url?: string } | null | undefined
): boolean {
    const model = String(llm?.model || '').toLowerCase();
    const base = String(llm?.base_url || '').toLowerCase();
    return model === QWEN38_REMOTE_MODEL.toLowerCase()
        || model === 'qwen3.8-27b'
        || model.includes('qwen3.8-27b')
        || base === QWEN38_REMOTE_BASE_URL.toLowerCase()
        || base.includes('/qwen38');
}

export function isRemotePresetLlm(
    llm: { model?: string; base_url?: string } | null | undefined
): boolean {
    return isRemoteGemmaLlm(llm) || isRemoteQwenLlm(llm);
}

/**
 * Apply explicit parameter/env mode control ('local' | 'remote' | 'qwen') so local LLM
 * and remote presets operate as parallel selectable working modes.
 */
export function applyLlmModeOverride(
    settings: Record<string, any>,
    rawMode?: string | null
): Record<string, any> {
    const normalized = String(rawMode || '').trim().toLowerCase();
    if (!normalized) return settings;
    const llm = { ...(settings.llm || {}) };
    if (normalized === 'local') {
        const isCurrentlyLocal = OLLAMA_PROVIDERS.has(String(llm.provider || '').toLowerCase()) && !isRemotePresetLlm(llm);
        llm.provider = 'ollama';
        llm.api_key = 'ollama';
        llm.base_url = isCurrentlyLocal && llm.base_url ? llm.base_url : LOCAL_LLM_DEFAULT_BASE_URL;
        llm.model = isCurrentlyLocal && llm.model ? llm.model : LOCAL_LLM_DEFAULT_MODEL;
        settings.llm = llm;
        settings.llm_model = llm.model;
        return settings;
    }
    if (normalized === 'remote' || normalized === 'gemma4' || normalized === 'gemma') {
        llm.provider = 'openai';
        llm.model = GEMMA4_REMOTE_MODEL;
        llm.base_url = GEMMA4_REMOTE_BASE_URL;
        settings.llm = llm;
        settings.llm_model = GEMMA4_REMOTE_MODEL;
        return applyKnownRemoteLlm(settings);
    }
    if (normalized === 'qwen' || normalized === 'qwen38' || normalized === 'qwen3.8' || normalized === 'qwen3.8-27b') {
        llm.provider = 'openai';
        llm.model = QWEN38_REMOTE_MODEL;
        llm.base_url = QWEN38_REMOTE_BASE_URL;
        settings.llm = llm;
        settings.llm_model = QWEN38_REMOTE_MODEL;
        return applyKnownRemoteLlm(settings);
    }
    return settings;
}

/**
 * Known remote lab models. A leftover Ollama
 * provider or base URL would send that name to the wrong server.
 */
export function applyKnownRemoteLlm(settings: Record<string, any>): Record<string, any> {
    const llm = { ...(settings.llm || {}) };
    if (!isRemotePresetLlm(llm)) {
        return settings;
    }

    const base = String(llm.base_url || '');
    const provider = String(llm.provider || '').toLowerCase();
    const isGemma = isRemoteGemmaLlm(llm);
    const isQwen = isRemoteQwenLlm(llm);

    if (isGemma && (OLLAMA_PROVIDERS.has(provider) || isOllamaBase(base))) {
        llm.provider = 'openai';
        if (isOllamaBase(base)) {
            llm.base_url = GEMMA4_REMOTE_BASE_URL;
        }
    } else if (isQwen && (OLLAMA_PROVIDERS.has(provider) || isOllamaBase(base))) {
        llm.provider = 'openai';
        if (isOllamaBase(base)) {
            llm.base_url = QWEN38_REMOTE_BASE_URL;
        }
    }

    const key = String(llm.api_key || '').trim();
    if (!key || key === 'ollama') {
        llm.api_key = '';
        const envKey = isQwen
            ? (process.env.QWEN38_API_KEY || process.env.QWEN_REMOTE_API_KEY || process.env.LLM_API_KEY)
            : (process.env.GEMMA4_API_KEY || process.env.GEMMA_REMOTE_API_KEY || process.env.LLM_API_KEY);
        const fromEnv = String(envKey || '').trim();
        if (fromEnv && fromEnv !== 'ollama') {
            llm.api_key = fromEnv;
        }
    }

    settings.llm = llm;
    if (isGemma && (String(llm.model || '').toLowerCase() === GEMMA4_REMOTE_MODEL.toLowerCase() || !llm.model)) {
        settings.llm_model = GEMMA4_REMOTE_MODEL;
    } else if (isQwen && (String(llm.model || '').toLowerCase() === QWEN38_REMOTE_MODEL.toLowerCase() || !llm.model)) {
        settings.llm_model = QWEN38_REMOTE_MODEL;
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
