import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getConfigDirectory } from './paths';
import { applyKnownRemoteLlm } from '../services/llm_presets';
export { validateTtsBaseUrl, type TtsUrlValidationResult } from '../services/tts_service';

const SETTINGS_FILE = 'system_settings.json';
const ENV_FILE = '.env';
const RETIRED_LOCAL_LLM_MODEL = 'novastory-qwen3:8b';
const CURRENT_LOCAL_LLM_MODEL = 'novastory-qwen3.5:9b';

function migrateRetiredLocalLlmModel(settings: Record<string, any>): boolean {
    const current = String(settings.llm?.model || '');
    const topLevel = String(settings.llm_model || '');
    if (current !== RETIRED_LOCAL_LLM_MODEL && topLevel !== RETIRED_LOCAL_LLM_MODEL) return false;
    settings.llm = { ...(settings.llm || {}), model: CURRENT_LOCAL_LLM_MODEL };
    if (!topLevel || topLevel === RETIRED_LOCAL_LLM_MODEL) settings.llm_model = CURRENT_LOCAL_LLM_MODEL;
    if (process.env.LLM_MODEL === RETIRED_LOCAL_LLM_MODEL) process.env.LLM_MODEL = CURRENT_LOCAL_LLM_MODEL;
    return true;
}

function persistRetiredLocalLlmModel(): void {
    const filePath = SettingsManager.getFilePath();
    if (fs.existsSync(filePath)) {
        try {
            const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            let changed = false;
            if (stored?.llm?.model === RETIRED_LOCAL_LLM_MODEL) {
                stored.llm.model = CURRENT_LOCAL_LLM_MODEL;
                changed = true;
            }
            if (stored?.llm_model === RETIRED_LOCAL_LLM_MODEL) {
                stored.llm_model = CURRENT_LOCAL_LLM_MODEL;
                changed = true;
            }
            if (changed) fs.writeFileSync(filePath, JSON.stringify(stored, null, 4));
        } catch { /* Leave an unreadable settings file untouched. */ }
    }
    const envPath = SettingsManager.getEnvPath();
    if (!fs.existsSync(envPath)) return;
    const envContent = fs.readFileSync(envPath, 'utf-8');
    if (!new RegExp(`^LLM_MODEL=${RETIRED_LOCAL_LLM_MODEL}$`, 'm').test(envContent)) return;
    fs.writeFileSync(envPath, envContent.replace(
        new RegExp(`^LLM_MODEL=${RETIRED_LOCAL_LLM_MODEL}$`, 'm'),
        `LLM_MODEL=${CURRENT_LOCAL_LLM_MODEL}`
    ));
}

const DEFAULT_SETTINGS = {
    llm_model: 'novastory-qwen3.5:9b',
    image_model: 'gemini-2.5-flash-image',
    comfyui: {
        mode: 'local', // 'local' | 'remote'
        base_url: 'http://127.0.0.1:8188',
        local_base_url: 'http://127.0.0.1:8188',
        remote_base_url: process.env.COMFYUI_REMOTE_URL || '',
        remote_username: process.env.COMFYUI_REMOTE_USERNAME || '',
        remote_password: process.env.COMFYUI_REMOTE_PASSWORD || '',
        enabled: false,
        selected_workflow_file: null,
        install_path: 'D:\\ComfyUI',
        // Style/detail LoRAs (auto-discovered if missing; see image_generation_policy.ts)
        // FLUX.1-dev GGUF retired (2026-08); flux_* keys ignored if present in old settings files.
        pony_lora: 'Pony_DetailV2.0.safetensors',
        pony_lora_strength: 0.65,
        redcraft_krea2_lora: null,
        redcraft_krea2_lora_strength: 0.8,
        default_workflow: 'pony_xl_12gb.json',
        /**
         * Tier B dual-reference (Pony/SDXL):
         * character = IP-Adapter, composition = ControlNet.
         * Auto-probed; missing nodes/models silent-fallback to Tier A.
         */
        tier_b: {
            enabled: true,
            character_weight: 0.75,
            composition_strength: 0.55,
            ipadapter_model: null,
            clip_vision_model: null,
            controlnet_model: null
        }
    },
    advanced: {
        nsfw_enabled: false,
        // Retired. Look LoRAs are chosen by the visual style preset, not this switch.
        pony_nsfw_lora: null,
        redcraft_krea2_nsfw_lora: null,
        nsfw_lora_strength: 0.55
    },
    // Local-first default (llama.cpp OpenAI-compatible). Cloud providers still work via settings/.env.
    llm: {
        provider: 'ollama',
        api_key: 'ollama',
        base_url: 'http://127.0.0.1:11434/v1',
        model: 'novastory-qwen3.5:9b'
    },
    tts: {
        base_url: 'http://127.0.0.1:8765',
        enabled: true
    }
};

export class SettingsManager {
    static getFilePath() {
        return path.join(getConfigDirectory(), SETTINGS_FILE);
    }

    static getEnvPath() {
        return path.join(getConfigDirectory(), ENV_FILE);
    }

    static loadSettings() {
        const filePath = SettingsManager.getFilePath();
        const envPath = SettingsManager.getEnvPath();
        const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); // deep clone

        // 1. Load from file first
        if (fs.existsSync(filePath)) {
            try {
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const fileSettings = JSON.parse(fileContent);
                // Deep merge
                for (const [key, value] of Object.entries(fileSettings)) {
                    if (settings[key] && typeof settings[key] === 'object' && typeof value === 'object') {
                        settings[key] = { ...settings[key], ...value as Record<string, any> };
                    } else {
                        settings[key] = value;
                    }
                }
            } catch (err) {}
        }

        // 2. Load from .env and apply overrides
        if (fs.existsSync(envPath)) {
            dotenv.config({ path: envPath, override: true });
        }

        const llmProviderEnv = process.env.LLM_PROVIDER;
        if (llmProviderEnv) {
            settings.llm = settings.llm || {};
            settings.llm.provider = llmProviderEnv;
        }

        const llmApiKeyEnv = process.env.LLM_API_KEY;
        if (llmApiKeyEnv) {
            settings.llm = settings.llm || {};
            const localProviders = settings.llm.provider === 'ollama' || settings.llm.provider === 'local_llm';
            settings.llm.api_key = localProviders ? 'ollama' : llmApiKeyEnv;
        }

        const llmBaseUrlEnv = process.env.LLM_BASE_URL;
        if (llmBaseUrlEnv) {
            settings.llm = settings.llm || {};
            settings.llm.base_url = llmBaseUrlEnv;
        }

        const llmModelEnv = process.env.LLM_MODEL;
        if (llmModelEnv) {
            settings.llm = settings.llm || {};
            settings.llm.model = llmModelEnv;
        }

        applyKnownRemoteLlm(settings);
        if (migrateRetiredLocalLlmModel(settings)) persistRetiredLocalLlmModel();

        if (process.env.NOVASTORY_BUILTIN_AI === 'codex') {
            settings.llm = { provider: 'codex', model: process.env.NOVASTORY_CODEX_MODEL || 'gpt-6.1-sol' };
            settings.image_provider = 'codex';
            settings.comfyui.enabled = false;
        }

        if (settings.comfyui) {
            // The macOS launcher selects remote mode for this process without
            // changing the user's saved settings or backend/.env file.
            if (process.env.NOVASTORY_COMFYUI_MODE || process.env.COMFYUI_MODE) {
                settings.comfyui.mode = process.env.NOVASTORY_COMFYUI_MODE || process.env.COMFYUI_MODE;
            }
            if (process.env.COMFYUI_REMOTE_URL) {
                settings.comfyui.remote_base_url = process.env.COMFYUI_REMOTE_URL;
            }
            if (process.env.COMFYUI_REMOTE_USERNAME) {
                settings.comfyui.remote_username = process.env.COMFYUI_REMOTE_USERNAME;
            }
            if (process.env.COMFYUI_REMOTE_PASSWORD) {
                settings.comfyui.remote_password = process.env.COMFYUI_REMOTE_PASSWORD;
            }
            if (process.env.COMFYUI_LOCAL_URL) {
                settings.comfyui.local_base_url = process.env.COMFYUI_LOCAL_URL;
            }
            if (settings.comfyui.mode === 'remote') {
                settings.comfyui.base_url = settings.comfyui.remote_base_url || process.env.COMFYUI_REMOTE_URL || '';
            } else {
                settings.comfyui.base_url = settings.comfyui.local_base_url || settings.comfyui.base_url || 'http://127.0.0.1:8188';
            }
        }

        if (settings.tts) {
            if (process.env.TTS_BASE_URL) {
                settings.tts.base_url = process.env.TTS_BASE_URL;
            }
        }

        return settings;
    }

    /**
     * Public view for GET /settings — never expose raw API secrets.
     * Clients use has_api_key / empty password fields; POST with blank key keeps existing.
     */
    static toPublicSettings(settings: Record<string, any> = SettingsManager.loadSettings()) {
        const publicSettings = JSON.parse(JSON.stringify(settings));
        const llm = publicSettings.llm || {};
        const rawKey = String(llm.api_key || publicSettings.gemini_api_key || '').trim();
        const provider = String(llm.provider || 'ollama').toLowerCase();
        const hasApiKey =
            provider === 'ollama' || provider === 'local_llm' || provider === 'codex'
                ? true
                : Boolean(rawKey && rawKey !== 'ollama');

        publicSettings.llm = {
            ...llm,
            has_api_key: hasApiKey,
            api_key: ''
        };
        if ('gemini_api_key' in publicSettings) {
            publicSettings.has_gemini_api_key = Boolean(
                String(publicSettings.gemini_api_key || '').trim()
            );
            delete publicSettings.gemini_api_key;
        }
        // Mask remote ComfyUI password
        if (publicSettings.comfyui) {
            const comfy = publicSettings.comfyui;
            const hasRemotePassword = Boolean(String(comfy.remote_password || '').trim());
            publicSettings.comfyui = {
                ...comfy,
                has_remote_password: hasRemotePassword,
                remote_password: ''
            };
        }
        // Nested nebula / other providers if present later
        if (publicSettings.nebula?.api_key) {
            publicSettings.nebula = {
                ...publicSettings.nebula,
                has_api_key: Boolean(String(publicSettings.nebula.api_key).trim()),
                api_key: ''
            };
        }
        return publicSettings;
    }

    static saveSettings(newSettings: Record<string, any>) {
        const currentSettings = SettingsManager.loadSettings();
        const envPath = SettingsManager.getEnvPath();
        fs.mkdirSync(getConfigDirectory(), { recursive: true });

        if (!fs.existsSync(envPath)) {
            fs.writeFileSync(envPath, '');
        }

        let newSettingsCopy = JSON.parse(JSON.stringify(newSettings));
        // Client never needs to echo secrets back
        if (newSettingsCopy.llm) {
            delete newSettingsCopy.llm.has_api_key;
        }
        delete newSettingsCopy.has_gemini_api_key;

        let envContent = fs.readFileSync(envPath, 'utf-8');
        const originalEnvContent = envContent;
        const upsertEnvValue = (content: string, key: string, value: string) => {
            const pattern = new RegExp(`^${key}=.*$`, 'm');
            if (pattern.test(content)) {
                return content.replace(pattern, () => `${key}=${value}`);
            }
            const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
            return `${content}${separator}${key}=${value}\n`;
        };
        const deleteEnvValue = (content: string, key: string) =>
            content.replace(new RegExp(`^${key}=.*(?:\r?\n|$)`, 'm'), '');

        // Extract secrets to .env — blank / placeholder means "keep existing"
        if (newSettingsCopy.llm) {
            const provider = String(
                newSettingsCopy.llm.provider || currentSettings.llm?.provider || ''
            ).toLowerCase();
            const isLocalProvider = provider === 'ollama' || provider === 'local_llm';
            const storedKey = String(
                process.env.LLM_API_KEY || currentSettings.llm?.api_key || ''
            ).trim();
            const apiKey = newSettingsCopy.llm.api_key === undefined
                ? ''
                : String(newSettingsCopy.llm.api_key || '').trim();
            const keepExisting =
                newSettingsCopy.llm.api_key === undefined
                || !apiKey
                || apiKey === '********'
                || apiKey === '••••••••'
                || /^•+$/.test(apiKey);
            const placeholderLeftBehind =
                !isLocalProvider
                && (apiKey === 'ollama' || (keepExisting && storedKey === 'ollama'));

            if (placeholderLeftBehind) {
                envContent = deleteEnvValue(envContent, 'LLM_API_KEY');
                delete process.env.LLM_API_KEY;
            } else if (
                newSettingsCopy.llm.api_key !== undefined
                && !keepExisting
                && !(isLocalProvider && apiKey === 'ollama')
            ) {
                envContent = upsertEnvValue(envContent, 'LLM_API_KEY', apiKey);
            }

            delete newSettingsCopy.llm.api_key;
        }

        // Keep environment overrides in sync with settings saved through the UI.
        // Otherwise stale LLM_* values would silently override system_settings.json.
        if (newSettingsCopy.llm) {
            const envMappings = [
                ['LLM_PROVIDER', newSettingsCopy.llm.provider],
                ['LLM_BASE_URL', newSettingsCopy.llm.base_url],
                ['LLM_MODEL', newSettingsCopy.llm.model]
            ] as const;

            for (const [key, value] of envMappings) {
                if (value !== undefined) {
                    envContent = upsertEnvValue(envContent, key, String(value));
                }
            }
        }

        if (newSettingsCopy.comfyui) {
            delete newSettingsCopy.comfyui.has_remote_password;
            if (newSettingsCopy.comfyui.remote_password !== undefined) {
                const pass = String(newSettingsCopy.comfyui.remote_password || '').trim();
                const keepExisting = !pass || pass === '********' || pass === '••••••••' || /^•+$/.test(pass);
                if (!keepExisting) {
                    envContent = upsertEnvValue(envContent, 'COMFYUI_REMOTE_PASSWORD', pass);
                    currentSettings.comfyui = currentSettings.comfyui || {};
                    currentSettings.comfyui.remote_password = pass;
                }
                delete newSettingsCopy.comfyui.remote_password;
            }

            const comfyEnvMappings = [
                ['COMFYUI_MODE', newSettingsCopy.comfyui.mode],
                ['COMFYUI_REMOTE_URL', newSettingsCopy.comfyui.remote_base_url],
                ['COMFYUI_REMOTE_USERNAME', newSettingsCopy.comfyui.remote_username],
                ['COMFYUI_LOCAL_URL', newSettingsCopy.comfyui.local_base_url]
            ] as const;

            for (const [key, value] of comfyEnvMappings) {
                if (value !== undefined) {
                    envContent = upsertEnvValue(envContent, key, String(value));
                }
            }
        }

        if (newSettingsCopy.tts) {
            const ttsEnvMappings = [
                ['TTS_BASE_URL', newSettingsCopy.tts.base_url]
            ] as const;

            for (const [key, value] of ttsEnvMappings) {
                if (value !== undefined) {
                    envContent = upsertEnvValue(envContent, key, String(value));
                }
            }
        }

        if (envContent !== originalEnvContent) {
            fs.writeFileSync(envPath, envContent);
        }

        for (const [key, value] of Object.entries(newSettingsCopy)) {
            if (currentSettings[key] && typeof currentSettings[key] === 'object' && typeof value === 'object') {
                currentSettings[key] = { ...currentSettings[key], ...value as Record<string, any> };
            } else {
                currentSettings[key] = value;
            }
        }

        if (currentSettings.comfyui) {
            if (currentSettings.comfyui.mode === 'remote') {
                currentSettings.comfyui.base_url = currentSettings.comfyui.remote_base_url || process.env.COMFYUI_REMOTE_URL || '';
            } else {
                currentSettings.comfyui.base_url = currentSettings.comfyui.local_base_url || currentSettings.comfyui.base_url || 'http://127.0.0.1:8188';
            }
        }

        if (currentSettings.tts) {
            if (process.env.TTS_BASE_URL) {
                currentSettings.tts.base_url = process.env.TTS_BASE_URL;
            }
        }

        const jsonSettingsToSave = JSON.parse(JSON.stringify(currentSettings));
        if (jsonSettingsToSave.llm && jsonSettingsToSave.llm.api_key !== undefined) {
            jsonSettingsToSave.llm.api_key = '';
        }
        if (jsonSettingsToSave.comfyui && jsonSettingsToSave.comfyui.remote_password !== undefined) {
            jsonSettingsToSave.comfyui.remote_password = '';
        }

        fs.writeFileSync(SettingsManager.getFilePath(), JSON.stringify(jsonSettingsToSave, null, 4), 'utf-8');
        return SettingsManager.toPublicSettings(SettingsManager.loadSettings());
    }
}
