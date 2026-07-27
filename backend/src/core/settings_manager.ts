import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const SETTINGS_FILE = 'system_settings.json';
const ENV_FILE = '.env';
const BACKEND_DIR = path.resolve(__dirname, '../../');

const DEFAULT_SETTINGS = {
    llm_model: 'gemini-2.5-flash',
    image_model: 'gemini-2.5-flash-image',
    comfyui: {
        base_url: 'http://127.0.0.1:8188',
        enabled: false,
        selected_workflow_file: null,
        install_path: 'D:\\ComfyUI'
    },
    llm: {
        provider: 'gemini',
        api_key: '',
        base_url: '',
        model: 'gemini-2.5-flash'
    }
};

export class SettingsManager {
    static getFilePath() {
        return path.join(BACKEND_DIR, SETTINGS_FILE);
    }

    static getEnvPath() {
        return path.join(BACKEND_DIR, ENV_FILE);
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
            settings.llm.api_key = llmApiKeyEnv;
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

        return settings;
    }

    static saveSettings(newSettings: Record<string, any>) {
        const currentSettings = SettingsManager.loadSettings();
        const envPath = SettingsManager.getEnvPath();

        if (!fs.existsSync(envPath)) {
            fs.writeFileSync(envPath, '');
        }

        let newSettingsCopy = JSON.parse(JSON.stringify(newSettings));

        // Extract secrets to .env
        if (newSettingsCopy.llm && newSettingsCopy.llm.api_key !== undefined) {
            const apiKey = newSettingsCopy.llm.api_key;
            // Extremely basic dotenv update for MVP
            let envContent = fs.readFileSync(envPath, 'utf-8');
            if (envContent.includes('LLM_API_KEY=')) {
                envContent = envContent.replace(/LLM_API_KEY=.*/, `LLM_API_KEY=${apiKey}`);
            } else {
                envContent += `\nLLM_API_KEY=${apiKey}\n`;
            }
            fs.writeFileSync(envPath, envContent);

            delete newSettingsCopy.llm.api_key;
        }

        for (const [key, value] of Object.entries(newSettingsCopy)) {
            if (currentSettings[key] && typeof currentSettings[key] === 'object' && typeof value === 'object') {
                currentSettings[key] = { ...currentSettings[key], ...value as Record<string, any> };
            } else {
                currentSettings[key] = value;
            }
        }

        const jsonSettingsToSave = JSON.parse(JSON.stringify(currentSettings));
        if (jsonSettingsToSave.llm && jsonSettingsToSave.llm.api_key !== undefined) {
            jsonSettingsToSave.llm.api_key = '';
        }

        fs.writeFileSync(SettingsManager.getFilePath(), JSON.stringify(jsonSettingsToSave, null, 4), 'utf-8');
        return SettingsManager.loadSettings();
    }
}
