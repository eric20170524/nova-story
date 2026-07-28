import type { AIProvider } from './ai/base';
import { GeminiProvider } from './ai/gemini_provider';
import { OpenAIProvider } from './ai/openai_provider';
import { settings as appSettings } from '../core/config';
import { SettingsManager } from '../core/settings_manager';

export class MediaService {
  static getProvider(): AIProvider {
    const systemSettings = SettingsManager.loadSettings();
    const providerName = String(
      systemSettings.image_provider
      || appSettings.AI_IMAGE_PROVIDER
      || 'gemini'
    ).toLowerCase();
    const llmSettings = systemSettings.llm || {};

    if (providerName === 'openai') {
      return new OpenAIProvider(
        systemSettings.image_api_key
          || appSettings.OPENAI_API_KEY
          || (llmSettings.provider === 'openai' ? llmSettings.api_key : ''),
        llmSettings.model || 'gpt-4o'
      );
    }

    if (providerName === 'grok') {
      return new OpenAIProvider(
        systemSettings.image_api_key
          || appSettings.GROK_API_KEY
          || (llmSettings.provider === 'grok' ? llmSettings.api_key : ''),
        llmSettings.model || 'grok-3',
        llmSettings.base_url || 'https://api.x.ai/v1'
      );
    }

    return new GeminiProvider(
      systemSettings.image_api_key
        || appSettings.GEMINI_API_KEY
        || (llmSettings.provider === 'gemini' ? llmSettings.api_key : ''),
      llmSettings.provider === 'gemini'
        ? (llmSettings.model || 'gemini-2.5-flash')
        : 'gemini-2.5-flash'
    );
  }
}
