import { FastifyPluginAsync } from 'fastify';
import { SettingsManager } from '../core/settings_manager';

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    return SettingsManager.loadSettings();
  });

  app.post('/', async (request, reply) => {
    const settings = request.body as Record<string, any>;
    return SettingsManager.saveSettings(settings);
  });

  app.post('/verify-llm', async (request, reply) => {
    // Basic implementation for now to satisfy endpoint contract
    // Later we will integrate actual AI providers logic in Phase 4
    const config = request.body as any;
    const llm_config = config.llm || config;
    const providerType = (llm_config.provider || "gemini").toLowerCase();

    // We mock success for Phase 2, full implementation comes in Phase 4
    return {
      status: "success",
      message: "LLM connection verify mocked successfully for fastify migration phase 2.",
      provider: providerType
    };
  });
};
