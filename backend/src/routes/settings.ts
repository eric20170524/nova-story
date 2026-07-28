import { FastifyPluginAsync } from 'fastify';
import { SettingsManager } from '../core/settings_manager';
import { LLMService } from '../services/llm';
import type { LLMProviderConfig } from '../services/llm';

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    return SettingsManager.loadSettings();
  });

  app.post('/', async (request, reply) => {
    const settings = request.body as Record<string, any>;
    return SettingsManager.saveSettings(settings);
  });

  app.post('/verify-llm', async (request, reply) => {
    const config = request.body as any;
    const llmConfig = (config.llm || config) as LLMProviderConfig;
    const providerType = (llmConfig.provider || 'gemini').toLowerCase();

    try {
      const provider = LLMService.getProvider(undefined, llmConfig);
      const result = await provider.generateText(
        'Reply with exactly NOVASTORY_OK and no other text.',
        'This is a connection health check. Follow the user instruction exactly.'
      );

      if (!result.trim()) {
        throw new Error('The provider returned an empty response.');
      }

      return {
        status: 'success',
        message: 'LLM connection and inference verified successfully.',
        provider: providerType,
        model: llmConfig.model
      };
    } catch (error: any) {
      request.log.warn({ err: error, provider: providerType }, 'LLM connection verification failed');
      return reply.status(502).send({
        detail: `LLM verification failed: ${error?.message || String(error)}`
      });
    }
  });
};
