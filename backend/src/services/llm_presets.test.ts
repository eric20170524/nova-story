import assert from 'node:assert/strict';
import test from 'node:test';
import { settings } from '../core/config';
import { resolveLlmApiKey } from './llm';
import {
    GEMMA4_REMOTE_BASE_URL,
    GEMMA4_REMOTE_MODEL,
    applyKnownRemoteLlm,
    mergeVerifyLlmConfig,
} from './llm_presets';

test('gemma-4-31b replaces a leftover Ollama endpoint', () => {
    const settings = applyKnownRemoteLlm({
        llm_model: 'novastory-qwen3.5:9b',
        llm: {
            provider: 'ollama',
            api_key: 'ollama',
            base_url: 'http://127.0.0.1:11434/v1',
            model: GEMMA4_REMOTE_MODEL,
        },
    });

    assert.equal(settings.llm.provider, 'openai');
    assert.equal(settings.llm.base_url, GEMMA4_REMOTE_BASE_URL);
    assert.equal(settings.llm.model, GEMMA4_REMOTE_MODEL);
    assert.equal(settings.llm_model, GEMMA4_REMOTE_MODEL);
});

test('gemma-4-31b keeps an explicit non-Ollama base URL', () => {
    const settings = applyKnownRemoteLlm({
        llm: {
            provider: 'openai',
            api_key: 'kept',
            base_url: 'http://127.0.0.1:8321/v1',
            model: GEMMA4_REMOTE_MODEL,
        },
    });

    assert.equal(settings.llm.base_url, 'http://127.0.0.1:8321/v1');
    assert.equal(settings.llm.api_key, 'kept');
});

test('other model names stay on their configured endpoint', () => {
    const settings = applyKnownRemoteLlm({
        llm: {
            provider: 'ollama',
            base_url: 'http://127.0.0.1:11434/v1',
            model: 'novastory-qwen3.5:9b',
        },
    });

    assert.equal(settings.llm.provider, 'ollama');
    assert.equal(settings.llm.base_url, 'http://127.0.0.1:11434/v1');
});

test('a Gemma endpoint drops a placeholder key during verify and does not borrow OPENAI_API_KEY', () => {
    const previousGemma = process.env.GEMMA4_API_KEY;
    const previousLlm = process.env.LLM_API_KEY;
    try {
        delete process.env.GEMMA4_API_KEY;
        process.env.LLM_API_KEY = 'ollama';
        const merged = mergeVerifyLlmConfig(
            {
                provider: 'ollama',
                model: 'novastory-qwen3.5:9b',
                base_url: 'http://127.0.0.1:11434/v1',
                api_key: 'ollama',
            },
            {
                provider: 'openai',
                model: GEMMA4_REMOTE_MODEL,
                base_url: GEMMA4_REMOTE_BASE_URL,
                api_key: '',
            }
        );
        assert.equal(merged.api_key, '');
        assert.equal(merged.provider, 'openai');
        assert.equal(merged.model, GEMMA4_REMOTE_MODEL);

        const kept = mergeVerifyLlmConfig(
            {
                provider: 'openai',
                model: GEMMA4_REMOTE_MODEL,
                base_url: GEMMA4_REMOTE_BASE_URL,
                api_key: 'real-gemma-key',
            },
            {
                provider: 'openai',
                model: GEMMA4_REMOTE_MODEL,
                base_url: GEMMA4_REMOTE_BASE_URL,
                api_key: '',
            }
        );
        assert.equal(kept.api_key, 'real-gemma-key');

        const gemmaConfig = {
            provider: 'openai',
            model: GEMMA4_REMOTE_MODEL,
            base_url: GEMMA4_REMOTE_BASE_URL,
        };
        assert.equal(resolveLlmApiKey({ ...gemmaConfig, api_key: '' }, 'openai'), '');
        assert.equal(resolveLlmApiKey({ ...gemmaConfig, api_key: 'ollama' }, 'openai'), '');
        assert.equal(resolveLlmApiKey({ ...gemmaConfig, api_key: 'real-gemma-key' }, 'openai'), 'real-gemma-key');
        assert.equal(
            resolveLlmApiKey({ provider: 'openai', model: 'gpt-4o', api_key: '' }, 'openai'),
            settings.OPENAI_API_KEY
        );
        if (settings.OPENAI_API_KEY) {
            assert.notEqual(resolveLlmApiKey({ ...gemmaConfig, api_key: '' }, 'openai'), settings.OPENAI_API_KEY);
        }
    } finally {
        if (previousGemma === undefined) delete process.env.GEMMA4_API_KEY;
        else process.env.GEMMA4_API_KEY = previousGemma;
        if (previousLlm === undefined) delete process.env.LLM_API_KEY;
        else process.env.LLM_API_KEY = previousLlm;
    }
});

test('Gemma clears Ollama placeholders and uses only a real configured key', () => {
    const previousGemma = process.env.GEMMA4_API_KEY;
    const previousLlm = process.env.LLM_API_KEY;
    try {
        delete process.env.GEMMA4_API_KEY;
        process.env.LLM_API_KEY = 'ollama';
        const settings = { llm: { model: GEMMA4_REMOTE_MODEL, provider: 'ollama', api_key: 'ollama' } };
        assert.equal(applyKnownRemoteLlm(structuredClone(settings)).llm.api_key, '');
        process.env.GEMMA4_API_KEY = 'test-remote-key';
        assert.equal(applyKnownRemoteLlm(structuredClone(settings)).llm.api_key, 'test-remote-key');
    } finally {
        if (previousGemma === undefined) delete process.env.GEMMA4_API_KEY;
        else process.env.GEMMA4_API_KEY = previousGemma;
        if (previousLlm === undefined) delete process.env.LLM_API_KEY;
        else process.env.LLM_API_KEY = previousLlm;
    }
});
