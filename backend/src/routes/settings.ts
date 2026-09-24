import { FastifyPluginAsync } from 'fastify';
import fs from 'fs';
import path from 'path';
import { SettingsManager } from '../core/settings_manager';
import { LLMService } from '../services/llm';
import type { LLMProviderConfig } from '../services/llm';
import { resolveTierBFromSettings } from '../services/tier_b_adapters';
import { VramService } from '../services/vram_service';
import { ComfyUIService } from '../services/ai/comfyui_service';

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => {
    // Never return raw API keys to the browser / LAN
    return SettingsManager.toPublicSettings();
  });

  /** Live GPU / Ollama / ComfyUI VRAM health for the top status badge */
  app.get('/vram-status', async () => {
    return VramService.getStatus();
  });

  /** One-click unload Ollama models to free VRAM for ComfyUI / Pony */
  app.post('/vram/release-llm', async () => {
    return VramService.releaseLlm();
  });

  /** Reset ComfyUI model + torch VRAM cache */
  app.post('/vram/free-comfy', async () => {
    return VramService.freeComfy();
  });

  /** Probe ComfyUI install for Tier B (IP-Adapter + ControlNet) readiness */
  app.get('/tier-b-status', async () => {
    const settings = SettingsManager.loadSettings();
    const capability = await resolveTierBFromSettings(settings, { isFlux: false });
    return {
      ready: capability.characterAdapter || capability.compositionControl,
      full_dual_ref: capability.characterAdapter && capability.compositionControl,
      character_adapter: capability.characterAdapter,
      composition_control: capability.compositionControl,
      character_kind: capability.characterKind,
      composition_kind: capability.compositionKind,
      models: capability.models,
      missing: capability.missing,
      notes: capability.notes,
      install_path: settings.comfyui?.install_path || null
    };
  });

  app.get('/loras', async (request, reply) => {
    const settings = SettingsManager.loadSettings();
    const installPath = settings.comfyui?.install_path || 'D:\\ComfyUI';
    const loraDirectory = path.join(String(installPath), 'models', 'loras');
    
    let loras: string[] = [];
    let exists = false;
    if (fs.existsSync(loraDirectory)) {
      exists = true;
      try {
        loras = fs.readdirSync(loraDirectory)
          .filter((f) => /\.(safetensors|ckpt|pt)$/i.test(f))
          .sort((a, b) => a.localeCompare(b));
      } catch (err) {}
    }

    return {
      lora_directory: loraDirectory,
      exists,
      loras
    };
  });

  app.post('/', async (request, reply) => {
    const settings = request.body as Record<string, any>;
    return SettingsManager.saveSettings(settings);
  });

  app.post('/verify-llm', async (request, reply) => {
    const config = request.body as any;
    const stored = SettingsManager.loadSettings();
    const bodyLlm = (config.llm || config || {}) as LLMProviderConfig;
    // Merge secrets from server-side storage when UI sent redacted/empty key
    const llmConfig: LLMProviderConfig = {
      ...(stored.llm || {}),
      ...bodyLlm,
      api_key:
        bodyLlm.api_key && String(bodyLlm.api_key).trim()
          ? bodyLlm.api_key
          : stored.llm?.api_key
    };
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

  app.post('/verify-comfy', async (request, reply) => {
    const config = (request.body || {}) as any;
    const stored = SettingsManager.loadSettings();
    const storedComfy = stored.comfyui || {};

    const mode = config.mode || storedComfy.mode || 'local';
    const isRemote = mode === 'remote';

    const baseUrl = isRemote
      ? (config.remote_base_url || storedComfy.remote_base_url || process.env.COMFYUI_REMOTE_URL || '')
      : (config.local_base_url || config.base_url || storedComfy.local_base_url || 'http://127.0.0.1:8188');

    const username = config.remote_username || storedComfy.remote_username || process.env.COMFYUI_REMOTE_USERNAME || '';
    const rawPass = config.remote_password;
    const password = rawPass && String(rawPass).trim() && !/^[*•]+$/.test(rawPass)
      ? rawPass
      : (storedComfy.remote_password || process.env.COMFYUI_REMOTE_PASSWORD || '');

    const comfyConfig = {
      mode,
      base_url: baseUrl,
      remote_base_url: baseUrl,
      remote_username: username,
      remote_password: password,
      local_base_url: baseUrl
    };

    try {
      const service = ComfyUIService.fromSettings(comfyConfig);
      if (isRemote && comfyConfig.remote_username && comfyConfig.remote_password) {
        await service.authenticate(false);
      }

      const isOnline = await service.checkStatus();
      if (!isOnline) {
        throw new Error(`无法连接至 ComfyUI 服务 (${baseUrl})，请检查服务是否运行或网络连接。`);
      }

      const stats = await service.fetchSystemStats();
      const firstDevice = Array.isArray(stats?.devices) ? stats.devices[0] : null;
      const deviceName = firstDevice?.name || 'GPU / Device';
      const vramTotalGiB = firstDevice?.vram_total ? (firstDevice.vram_total / (1024 ** 3)).toFixed(1) + 'GB' : null;

      return {
        status: 'success',
        message: isRemote
          ? `远端 ComfyUI (算力机) 连接成功！检测到硬件: ${deviceName}${vramTotalGiB ? ` (${vramTotalGiB} 显存)` : ''}`
          : `本地 ComfyUI 连接成功！检测到硬件: ${deviceName}${vramTotalGiB ? ` (${vramTotalGiB} 显存)` : ''}`,
        mode,
        base_url: baseUrl,
        device_name: deviceName,
        vram_total: vramTotalGiB,
        system: stats.system,
        devices: stats.devices
      };
    } catch (error: any) {
      request.log.warn({ err: error, mode }, 'ComfyUI verification failed');
      return reply.status(502).send({
        status: 'error',
        detail: error?.message || String(error)
      });
    }
  });
};
