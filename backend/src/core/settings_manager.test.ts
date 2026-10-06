import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SettingsManager } from './settings_manager';

const ENV_KEYS = ['NOVASTORY_CONFIG_DIR', 'LLM_API_KEY', 'LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL', 'GEMMA4_API_KEY'] as const;

function snapshotEnv() {
    return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved: Record<string, string | undefined>) {
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
}

test('retired local model alias novastory-qwen3:8b is rewritten to novastory-qwen3.5:9b', () => {
    const saved = snapshotEnv();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-settings-migrate-'));
    try {
        process.env.NOVASTORY_CONFIG_DIR = dir;
        delete process.env.LLM_MODEL;
        fs.writeFileSync(path.join(dir, 'system_settings.json'), JSON.stringify({
            llm_model: 'novastory-qwen3:8b',
            llm: { provider: 'ollama', model: 'novastory-qwen3:8b', base_url: 'http://127.0.0.1:11434/v1' },
        }));
        fs.writeFileSync(path.join(dir, '.env'), 'LLM_MODEL=novastory-qwen3:8b\n');
        const loaded = SettingsManager.loadSettings();
        assert.equal(loaded.llm.model, 'novastory-qwen3.5:9b');
        assert.equal(loaded.llm_model, 'novastory-qwen3.5:9b');
        const stored = JSON.parse(fs.readFileSync(path.join(dir, 'system_settings.json'), 'utf8'));
        assert.equal(stored.llm.model, 'novastory-qwen3.5:9b');
        assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /^LLM_MODEL=novastory-qwen3\.5:9b$/m);
    } finally {
        restoreEnv(saved);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('saving a non-Ollama provider removes a placeholder LLM_API_KEY', () => {
    const saved = snapshotEnv();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-settings-'));
    try {
        process.env.NOVASTORY_CONFIG_DIR = dir;
        delete process.env.GEMMA4_API_KEY;
        process.env.LLM_API_KEY = 'ollama';
        fs.writeFileSync(path.join(dir, '.env'), [
            'LLM_PROVIDER=ollama',
            'LLM_API_KEY=ollama',
            'LLM_BASE_URL=http://127.0.0.1:11434/v1',
            'LLM_MODEL=novastory-qwen3.5:9b',
            '',
        ].join('\n'));

        const loaded = SettingsManager.saveSettings({
            llm: {
                provider: 'openai',
                model: 'gemma-4-31b',
                base_url: 'https://comfy.chuangyi.chat/gemma4/v1',
                api_key: '',
            },
        });
        const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
        assert.doesNotMatch(env, /^LLM_API_KEY=/m);
        assert.match(env, /^LLM_PROVIDER=openai$/m);
        assert.equal(loaded.llm.provider, 'openai');
        assert.equal(loaded.llm.api_key, '');

        fs.writeFileSync(path.join(dir, '.env'), [
            'LLM_PROVIDER=openai',
            'LLM_API_KEY=real-gemma-key',
            'LLM_BASE_URL=https://comfy.chuangyi.chat/gemma4/v1',
            'LLM_MODEL=gemma-4-31b',
            '',
        ].join('\n'));
        process.env.LLM_API_KEY = 'real-gemma-key';
        process.env.LLM_PROVIDER = 'openai';
        process.env.LLM_MODEL = 'gemma-4-31b';
        process.env.LLM_BASE_URL = 'https://comfy.chuangyi.chat/gemma4/v1';
        const kept = SettingsManager.saveSettings({
            llm: {
                provider: 'openai',
                model: 'gemma-4-31b',
                base_url: 'https://comfy.chuangyi.chat/gemma4/v1',
                api_key: '',
            },
        });
        const keptEnv = fs.readFileSync(path.join(dir, '.env'), 'utf8');
        assert.match(keptEnv, /^LLM_API_KEY=real-gemma-key$/m);
        assert.equal(kept.llm.api_key, '');
        assert.equal(kept.llm.has_api_key, true);
    } finally {
        restoreEnv(saved);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
