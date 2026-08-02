import React, { useEffect, useRef, useState } from 'react';
import { Save, CheckCircle, AlertCircle, Server, Workflow as WorkflowIcon, Cloud, Settings, Sliders, Shield } from 'lucide-react';
import { api } from '../services/api';
import { useLanguage } from '../LanguageContext';
import { WorkflowSettings } from '../components/WorkflowSettings';
import {
  ADVANCED_VISUAL_STYLES,
  isAdvancedStylesEnabled,
  setAdvancedStylesEnabled,
} from '../constants';

const LOCAL_OLLAMA_MODEL = 'novastory-qwen3:8b';

export const SettingsPage: React.FC = () => {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState<'general' | 'workflow' | 'advanced'>('general');
  const [isUnlocked, setIsUnlocked] = useState<boolean>(() => {
    return localStorage.getItem('settings_advanced_unlocked') !== 'false';
  });
  const [titleClicks, setTitleClicks] = useState(0);

  const [settings, setSettings] = useState<any>({ 
    llm_model: 'gemini-3-flash-preview',
    comfyui: {
      base_url: 'http://127.0.0.1:8188',
      enabled: false,
      selected_workflow_file: null,
      default_workflow: null
    },
    advanced: {
      nsfw_enabled: false,
      pony_nsfw_lora: 'Incase_Style_PonyXL.safetensors',
      flux_nsfw_lora: 'aidmaNSFWunlock.safetensors',
      nsfw_lora_strength: 0.55
    }
  });
  const [workflowFiles, setWorkflowFiles] = useState<string[]>([]);
  const [availableLoras, setAvailableLoras] = useState<string[]>([]);
  const [loraDirectoryInfo, setLoraDirectoryInfo] = useState<{ lora_directory: string; exists: boolean }>({ lora_directory: 'D:\\ComfyUI\\models\\loras', exists: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifyingLLM, setVerifyingLLM] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [advancedEnabled, setAdvancedEnabled] = useState(() => isAdvancedStylesEnabled());
  const secretClicksRef = useRef({ count: 0, lastAt: 0 });

  /** Hidden area: 5 consecutive clicks (within 1.5s gaps) toggles advanced styles */
  const handleSecretAreaClick = () => {
    const now = Date.now();
    if (now - secretClicksRef.current.lastAt > 1500) {
      secretClicksRef.current.count = 1;
    } else {
      secretClicksRef.current.count += 1;
    }
    secretClicksRef.current.lastAt = now;

    if (secretClicksRef.current.count >= 5) {
      const next = !advancedEnabled;
      setAdvancedStylesEnabled(next);
      setAdvancedEnabled(next);
      secretClicksRef.current.count = 0;
      setMessage({
        type: 'success',
        text: next
          ? '高级风格画风面板已开启！'
          : '高级风格画风面板已隐藏。',
      });
    }
  };

  /** Secret unlock logic: click page title 5 times */
  const handleTitleClick = () => {
    const newCount = titleClicks + 1;
    if (newCount >= 5) {
      setIsUnlocked(true);
      localStorage.setItem('settings_advanced_unlocked', 'true');
      setMessage({ type: 'success', text: '开发者选项已解锁！隐藏页面已开放。' });
      setTitleClicks(0);
    } else {
      setTitleClicks(newCount);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const [settingsData, filesData, lorasData] = await Promise.all([
        api.getSettings(),
        api.getWorkflowFiles(),
        api.getLoras().catch(() => ({ lora_directory: 'D:\\ComfyUI\\models\\loras', exists: false, loras: [] }))
      ]);

      const comfy = settingsData.comfyui || {
        base_url: 'http://127.0.0.1:8188',
        enabled: false,
        selected_workflow_file: null,
        flux_lora: 'XLabs_Flux_Realism.safetensors',
        pony_lora: 'Pony_DetailV2.0.safetensors',
        flux_lora_strength: 0.75,
        pony_lora_strength: 0.65
      };

      const advanced = settingsData.advanced || {
        nsfw_enabled: false,
        pony_nsfw_lora: 'Incase_Style_PonyXL.safetensors',
        flux_nsfw_lora: 'aidmaNSFWunlock.safetensors',
        nsfw_lora_strength: 0.55
      };

      setSettings({
        ...settingsData,
        comfyui: comfy,
        advanced: advanced
      });
      setWorkflowFiles(filesData || []);
      if (lorasData?.loras) {
        setAvailableLoras(lorasData.loras);
        setLoraDirectoryInfo({ lora_directory: lorasData.lora_directory, exists: lorasData.exists });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: t('load_failed') + ': ' + (err.message || 'Unknown error') });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      await api.updateSettings(settings);
      setMessage({ type: 'success', text: t('save_success') });
    } catch (err: any) {
      setMessage({ type: 'error', text: t('save_failed') + ': ' + (err.message || 'Unknown error') });
    } finally {
      setSaving(false);
    }
  };

  const handleVerifyLLM = async () => {
    setVerifyingLLM(true);
    setMessage(null);

    try {
      const response = await api.verifyLLMConnection(settings);
      const okMessage = typeof response?.message === 'string'
        ? response.message
        : t('save_success');
      setMessage({ type: 'success', text: `LLM 连接成功！${okMessage}` });
    } catch (err: any) {
      setMessage({ type: 'error', text: `LLM 连接验证失败: ${err.message || 'Unknown error'}` });
    } finally {
      setVerifyingLLM(false);
    }
  };

  const handleComfyChange = (key: string, value: any) => {
    setSettings((prev: any) => ({
      ...prev,
      comfyui: {
        ...(prev.comfyui || {}),
        [key]: value
      }
    }));
  };

  const handleLLMChange = (key: string, value: any) => {
    setSettings((prev: any) => {
      const currentLLM = prev.llm || {};
      const updatedLLM = { ...currentLLM, [key]: value };
      
      // Keep legacy root fields in sync for backward compatibility
      const rootUpdates: Record<string, any> = {};
      if (key === 'provider') rootUpdates.llm_provider = value;
      if (key === 'model') rootUpdates.llm_model = value;
      if (key === 'api_key') rootUpdates.gemini_api_key = value;
      if (key === 'base_url') rootUpdates.openai_base_url = value;

      return {
        ...prev,
        ...rootUpdates,
        llm: updatedLLM
      };
    });
  };

  const handleAdvancedChange = (key: string, value: any) => {
    setSettings((prev: any) => ({
      ...prev,
      advanced: {
        ...(prev.advanced || {}),
        [key]: value
      }
    }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <div>
        <h1 
          className="text-2xl font-bold text-slate-100 flex items-center gap-2 cursor-pointer select-none"
          onClick={handleTitleClick}
        >
          <Settings className="w-6 h-6 text-indigo-400" />
          {t('settings_title')}
        </h1>
        <p className="text-slate-400 text-sm mt-1">{t('settings_subtitle')}</p>
      </div>

      {/* Secret click trigger zone */}
      <div
        className="text-xs text-slate-400/50 hover:text-slate-400 select-none cursor-pointer py-1 px-2 rounded bg-slate-900/30 border border-slate-800/40 inline-flex items-center gap-1.5 transition-colors"
        onClick={handleSecretAreaClick}
        title="连续点击 5 次切换高级画风配置面板"
      >
        <Sliders className="w-3.5 h-3.5" />
        <span>画风选项模式: {advancedEnabled ? '高级（全量）' : '精简（推荐）'}</span>
      </div>

      {message && (
        <div className={`p-4 rounded-xl flex items-center gap-3 border ${
          message.type === 'success' 
            ? 'bg-emerald-950/40 border-emerald-800/50 text-emerald-300' 
            : 'bg-red-950/40 border-red-800/50 text-red-300'
        }`}>
          {message.type === 'success' ? (
            <CheckCircle className="w-5 h-5 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
          )}
          <span className="text-sm font-medium">{message.text}</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-slate-800">
        <button
          onClick={() => setActiveTab('general')}
          className={`py-3 px-6 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'general'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Cloud className="w-4 h-4" />
          API & 服务配置
        </button>
        <button
          onClick={() => setActiveTab('workflow')}
          className={`py-3 px-6 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'workflow'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <WorkflowIcon className="w-4 h-4" />
          工作流预设 (Workflows)
        </button>

        <button
          onClick={() => setActiveTab('advanced')}
          className={`py-3 px-6 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'advanced'
              ? 'border-rose-500 text-rose-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Shield className="w-4 h-4" />
          {t('advanced_settings.advanced_tab_title')}
        </button>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {activeTab === 'general' && (
          <>
            {/* LLM Engine Configuration Card */}
            <div className="bg-slate-900/60 backdrop-blur-sm border border-slate-800/80 rounded-2xl p-6 space-y-6">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-indigo-500/10 rounded-lg border border-indigo-500/20 text-indigo-400">
                    <Cloud className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-slate-200">LLM 语言模型服务</h2>
                    <p className="text-xs text-slate-400">配置文本生成、角色提取和剧本推导的核心大语言模型引擎</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${
                    (settings.llm?.provider || settings.llm_provider || 'gemini') === 'local_llm'
                      ? 'bg-amber-950/40 border-amber-800/50 text-amber-300'
                      : (settings.llm?.provider || settings.llm_provider || 'gemini') === 'openai'
                      ? 'bg-blue-950/40 border-blue-800/50 text-blue-300'
                      : 'bg-emerald-950/40 border-emerald-800/50 text-emerald-300'
                  }`}>
                    {((settings.llm?.provider || settings.llm_provider || 'gemini') === 'local_llm')
                      ? '离线模式'
                      : (settings.llm?.provider || settings.llm_provider || 'gemini').toUpperCase()}
                  </span>
                  <button
                    type="button"
                    onClick={handleVerifyLLM}
                    disabled={verifyingLLM}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {verifyingLLM ? (
                      <>
                        <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-indigo-400"></div>
                        <span>验证中...</span>
                      </>
                    ) : (
                      <span>测试连接</span>
                    )}
                  </button>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    模型提供方 (Provider)
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    <button
                      type="button"
                      onClick={() => handleLLMChange('provider', 'gemini')}
                      className={`p-3 rounded-xl border text-left transition-all ${
                        (settings.llm?.provider || settings.llm_provider || 'gemini') === 'gemini'
                          ? 'bg-indigo-600/10 border-indigo-500/50 text-indigo-300 ring-1 ring-indigo-500/30'
                          : 'bg-slate-800/40 border-slate-700/60 text-slate-400 hover:bg-slate-800/80 hover:text-slate-300'
                      }`}
                    >
                      <div className="text-sm font-semibold mb-0.5">Google Gemini</div>
                      <div className="text-xs opacity-75">自带 API 密钥，推荐使用 3.6 Flash / 2.5 Flash</div>
                    </button>
                    
                    <button
                      type="button"
                      onClick={() => handleLLMChange('provider', 'openai')}
                      className={`p-3 rounded-xl border text-left transition-all ${
                        (settings.llm?.provider || settings.llm_provider || 'gemini') === 'openai'
                          ? 'bg-indigo-600/10 border-indigo-500/50 text-indigo-300 ring-1 ring-indigo-500/30'
                          : 'bg-slate-800/40 border-slate-700/60 text-slate-400 hover:bg-slate-800/80 hover:text-slate-300'
                      }`}
                    >
                      <div className="text-sm font-semibold mb-0.5">OpenAI API 兼容</div>
                      <div className="text-xs opacity-75">支持 DeepSeek, Claude, ChatGPT 或自建转发中转</div>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleLLMChange('provider', 'local_llm')}
                      className={`p-3 rounded-xl border text-left transition-all ${
                        (settings.llm?.provider || settings.llm_provider || 'gemini') === 'local_llm'
                          ? 'bg-indigo-600/10 border-indigo-500/50 text-indigo-300 ring-1 ring-indigo-500/30'
                          : 'bg-slate-800/40 border-slate-700/60 text-slate-400 hover:bg-slate-800/80 hover:text-slate-300'
                      }`}
                    >
                      <div className="text-sm font-semibold mb-0.5">本地部署 (Ollama)</div>
                      <div className="text-xs opacity-75">完全本地运行，0 API 费用，配合一键启动脚本</div>
                    </button>
                  </div>
                </div>

                {/* Gemini Specific Settings */}
                {(settings.llm?.provider || settings.llm_provider || 'gemini') === 'gemini' && (
                  <div className="space-y-4 pt-2 border-t border-slate-800/60">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Gemini API Key
                      </label>
                      <input
                        type="password"
                        value={settings.llm?.api_key || settings.gemini_api_key || ''}
                        onChange={(e) => handleLLMChange('api_key', e.target.value)}
                        placeholder="AIzaSy..."
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Gemini 模型版本
                      </label>
                      <select
                        value={settings.llm?.model || settings.llm_model || 'gemini-3.6-flash'}
                        onChange={(e) => handleLLMChange('model', e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none transition-colors"
                      >
                        <option value="gemini-3.6-flash">gemini-3.6-flash (最新版，强烈推荐)</option>
                        <option value="gemini-2.5-flash">gemini-2.5-flash (稳定，速度极快)</option>
                        <option value="gemini-2.5-pro">gemini-2.5-pro (推理能力极强)</option>
                        <option value="gemini-1.5-flash">gemini-1.5-flash</option>
                      </select>
                    </div>
                  </div>
                )}

                {/* OpenAI / Custom Proxy Settings */}
                {(settings.llm?.provider || settings.llm_provider || 'gemini') === 'openai' && (
                  <div className="space-y-4 pt-2 border-t border-slate-800/60">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        API Key
                      </label>
                      <input
                        type="password"
                        value={settings.llm?.api_key || ''}
                        onChange={(e) => handleLLMChange('api_key', e.target.value)}
                        placeholder="sk-..."
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Base URL
                      </label>
                      <input
                        type="text"
                        value={settings.llm?.base_url || settings.openai_base_url || 'https://api.openai.com/v1'}
                        onChange={(e) => handleLLMChange('base_url', e.target.value)}
                        placeholder="https://api.openai.com/v1"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        模型名称
                      </label>
                      <input
                        type="text"
                        value={settings.llm?.model || settings.llm_model || 'gpt-4o-mini'}
                        onChange={(e) => handleLLMChange('model', e.target.value)}
                        placeholder="gpt-4o-mini 或 deepseek-chat"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none transition-colors"
                      />
                    </div>
                  </div>
                )}

                {/* Local LLM Settings */}
                {(settings.llm?.provider || settings.llm_provider || 'gemini') === 'local_llm' && (
                  <div className="space-y-4 pt-2 border-t border-slate-800/60">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Ollama 服务端地址
                      </label>
                      <input
                        type="text"
                        value={settings.llm?.base_url || 'http://127.0.0.1:11434/v1'}
                        onChange={(e) => handleLLMChange('base_url', e.target.value)}
                        placeholder="http://127.0.0.1:11434/v1"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        本地模型名称
                      </label>
                      <input
                        type="text"
                        value={settings.llm?.model || LOCAL_OLLAMA_MODEL}
                        onChange={(e) => handleLLMChange('model', e.target.value)}
                        placeholder={LOCAL_OLLAMA_MODEL}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none transition-colors"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ComfyUI Image Generation Engine Card */}
            <div className="bg-slate-900/60 backdrop-blur-sm border border-slate-800/80 rounded-2xl p-6 space-y-6">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-emerald-500/10 rounded-lg border border-emerald-500/20 text-emerald-400">
                    <Server className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-slate-200">{t('comfyui_settings')}</h2>
                    <p className="text-xs text-slate-400">配置本地/远程 ComfyUI 绘图引擎服务</p>
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.comfyui?.enabled ?? false}
                    onChange={(e) => handleComfyChange('enabled', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                </label>
              </div>

              {settings.comfyui?.enabled && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      {t('comfyui_url')}
                    </label>
                    <input
                      type="text"
                      value={settings.comfyui?.base_url || 'http://127.0.0.1:8188'}
                      onChange={(e) => handleComfyChange('base_url', e.target.value)}
                      placeholder="http://127.0.0.1:8188"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none transition-colors"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      ComfyUI 安装根目录 (用来检测本地与加载 LoRA 路径)
                    </label>
                    <input
                      type="text"
                      value={settings.comfyui?.install_path || 'D:\\ComfyUI'}
                      onChange={(e) => handleComfyChange('install_path', e.target.value)}
                      placeholder="D:\ComfyUI"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none transition-colors"
                    />
                  </div>

                  {/* Detected LoRAs Section */}
                  <div className="pt-2 border-t border-slate-800/60 space-y-4">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-medium text-slate-300">
                        {t('detected_loras_title')}
                      </label>
                      <span className={`text-xs px-2 py-0.5 rounded ${loraDirectoryInfo.exists ? 'bg-emerald-950/50 text-emerald-400 border border-emerald-800/40' : 'bg-amber-950/50 text-amber-400 border border-amber-800/40'}`}>
                        {loraDirectoryInfo.exists ? `找到 ${availableLoras.length} 个 LoRA 模型` : '路径未发现或为空'}
                      </span>
                    </div>

                    {/* Default FLUX.1 LoRA Dropdown */}
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        {t('comfyui_flux_lora_label')}
                      </label>
                      <select
                        value={settings.comfyui?.flux_lora || ''}
                        onChange={(e) => handleComfyChange('flux_lora', e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none transition-colors"
                      >
                        <option value="">(自动发现 · 写实/东亚/国风)</option>
                        {availableLoras.map((lora) => (
                          <option key={lora} value={lora}>{lora}</option>
                        ))}
                        {settings.comfyui?.flux_lora
                          && !availableLoras.includes(settings.comfyui.flux_lora) && (
                          <option value={settings.comfyui.flux_lora}>
                            {settings.comfyui.flux_lora} (自定义配置)
                          </option>
                        )}
                      </select>
                    </div>

                    {/* Default Pony XL LoRA Dropdown */}
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        {t('comfyui_pony_lora_label')}
                      </label>
                      <select
                        value={settings.comfyui?.pony_lora || ''}
                        onChange={(e) => handleComfyChange('pony_lora', e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none transition-colors"
                      >
                        <option value="">(自动发现 · Detail 细节)</option>
                        {availableLoras.map((lora) => (
                          <option key={lora} value={lora}>{lora}</option>
                        ))}
                        {settings.comfyui?.pony_lora
                          && !availableLoras.includes(settings.comfyui.pony_lora) && (
                          <option value={settings.comfyui.pony_lora}>
                            {settings.comfyui.pony_lora} (自定义配置)
                          </option>
                        )}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      {t('comfyui_workflow')}
                    </label>
                    <select
                      value={settings.comfyui?.selected_workflow_file || ''}
                      onChange={(e) => handleComfyChange('selected_workflow_file', e.target.value || null)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none transition-colors"
                    >
                      <option value="">-- {t('comfyui_default')} --</option>
                      {workflowFiles.map((file) => (
                        <option key={file} value={file}>
                          {file}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === 'workflow' && (
          <div className="bg-slate-900/60 backdrop-blur-sm border border-slate-800/80 rounded-2xl p-6">
            <WorkflowSettings />
          </div>
        )}

        {activeTab === 'advanced' && (
          <div className="bg-slate-900/60 backdrop-blur-sm border border-rose-900/40 rounded-2xl p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-rose-900/40 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-rose-500/10 rounded-lg border border-rose-500/20 text-rose-400">
                  <Shield className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-rose-200">{t('advanced_settings.advanced_config_title')}</h2>
                  <p className="text-xs text-rose-300/80 mt-1">
                    {t('advanced_settings.nsfw_enable_title')}
                    <br/>{t('advanced_settings.nsfw_enable_desc')}
                  </p>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.advanced?.nsfw_enabled ?? false}
                  onChange={(e) => handleAdvancedChange('nsfw_enabled', e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-rose-600"></div>
              </label>
            </div>

            {settings.advanced?.nsfw_enabled && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    {t('advanced_settings.pony_nsfw_lora_label')}
                  </label>
                  <select
                    value={settings.advanced?.pony_nsfw_lora || ''}
                    onChange={(e) => handleAdvancedChange('pony_nsfw_lora', e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-rose-500 focus:outline-none transition-colors"
                  >
                    <option value="">(自动发现 · Incase / ExpressiveH 等)</option>
                    {availableLoras.map((lora) => (
                      <option key={lora} value={lora}>{lora}</option>
                    ))}
                    {settings.advanced?.pony_nsfw_lora
                      && !availableLoras.includes(settings.advanced.pony_nsfw_lora) && (
                      <option value={settings.advanced.pony_nsfw_lora}>
                        {settings.advanced.pony_nsfw_lora} (自定义配置)
                      </option>
                    )}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    {t('advanced_settings.flux_nsfw_lora_label')}
                  </label>
                  <select
                    value={settings.advanced?.flux_nsfw_lora || ''}
                    onChange={(e) => handleAdvancedChange('flux_nsfw_lora', e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:border-rose-500 focus:outline-none transition-colors"
                  >
                    <option value="">(自动发现 · aidmaNSFWunlock)</option>
                    {availableLoras.map((lora) => (
                      <option key={lora} value={lora}>{lora}</option>
                    ))}
                    {settings.advanced?.flux_nsfw_lora
                      && !availableLoras.includes(settings.advanced.flux_nsfw_lora) && (
                      <option value={settings.advanced.flux_nsfw_lora}>
                        {settings.advanced.flux_nsfw_lora} (自定义配置)
                      </option>
                    )}
                  </select>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-xs font-medium text-slate-300">
                      {t('advanced_settings.nsfw_lora_strength_label')}
                    </label>
                    <span className="text-xs text-rose-400 font-mono">
                      {settings.advanced?.nsfw_lora_strength ?? 0.55}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.05"
                    value={settings.advanced?.nsfw_lora_strength ?? 0.55}
                    onChange={(e) => handleAdvancedChange('nsfw_lora_strength', parseFloat(e.target.value))}
                    className="w-full accent-rose-500 cursor-pointer"
                  />
                  <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                    开启 NSFW 后：自动叠加载 细节/风格 LoRA + 成人向 LoRA（去重），并按题材注入触发词与分镜策略。
                    关闭时：仅风格/细节 LoRA，并强制 SFW 负向词。文件缺失时会按文件名模式自动发现。
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-4 border-t border-slate-800/80">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-xl shadow-lg shadow-indigo-600/20 transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                <span>{t('saving')}...</span>
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                <span>{t('save_settings')}</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
