import React, { useEffect, useRef, useState } from 'react';
import { Save, CheckCircle, AlertCircle, Server, Workflow as WorkflowIcon, Cloud, Settings, Sliders } from 'lucide-react';
import { api } from '../services/api';
import { useLanguage } from '../LanguageContext';
import { WorkflowSettings } from '../components/WorkflowSettings';
import {
  ADVANCED_VISUAL_STYLES,
  isAdvancedStylesEnabled,
  setAdvancedStylesEnabled,
} from '../constants';

export const SettingsPage: React.FC = () => {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState<'general' | 'workflow'>('general');
  const [settings, setSettings] = useState<any>({ 
    llm_model: 'gemini-3-flash-preview',
    comfyui: {
      base_url: 'http://127.0.0.1:8188',
      enabled: false,
      selected_workflow_file: null
    }
  });
  const [workflowFiles, setWorkflowFiles] = useState<string[]>([]);
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
      secretClicksRef.current.count = 0;
    }
    secretClicksRef.current.count += 1;
    secretClicksRef.current.lastAt = now;

    if (secretClicksRef.current.count >= 5) {
      secretClicksRef.current.count = 0;
      const next = !isAdvancedStylesEnabled();
      setAdvancedStylesEnabled(next);
      setAdvancedEnabled(next);
      if (next && ADVANCED_VISUAL_STYLES.length === 0) {
        setMessage({
          type: 'error',
          text: t('settings_page.advanced_styles_missing'),
        });
      } else {
        setMessage({
          type: 'success',
          text: next
            ? t('settings_page.advanced_styles_on')
            : t('settings_page.advanced_styles_off'),
        });
      }
      setTimeout(() => setMessage(null), 4000);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [settingsData, filesData] = await Promise.all([
        api.getSettings(),
        api.getWorkflowFiles()
      ]);
      
      const defaultComfyUI = {
        base_url: 'http://127.0.0.1:8188',
        enabled: false,
        selected_workflow_file: null
      };

      const defaultLLM = {
        provider: 'gemini',
        api_key: '',
        base_url: '',
        model: 'gemini-2.5-flash'
      };

      setSettings({
        ...settingsData,
        comfyui: { ...defaultComfyUI, ...(settingsData.comfyui || {}) },
        llm: { ...defaultLLM, ...(settingsData.llm || {}) }
      });
      setWorkflowFiles(filesData);
    } catch (error) {
      console.error("Failed to load data", error);
      setMessage({ type: 'error', text: t('settings_page.error') });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await api.updateSettings(settings);
      setMessage({ type: 'success', text: t('settings_page.success') });
      setTimeout(() => setMessage(null), 3000);
    } catch (error) {
      console.error("Failed to save settings", error);
      setMessage({ type: 'error', text: t('settings_page.error') });
    } finally {
      setSaving(false);
    }
  };

  const handleModelChange = (model: string) => {
    if (model === 'qwen3.5:9b') {
      setSettings({
        ...settings,
        llm_model: model,
        llm: {
          ...settings.llm,
          provider: 'ollama',
          base_url: settings.llm?.base_url || 'http://127.0.0.1:11434/v1',
          model: 'qwen3.5:9b',
          api_key: settings.llm?.api_key || 'ollama'
        }
      });
    } else {
      setSettings({
        ...settings,
        llm_model: model,
        llm: {
          ...settings.llm,
          model: model
        }
      });
    }
  };

  const handleComfyUIChange = (field: string, value: any) => {
    setSettings({
      ...settings,
      comfyui: {
        ...settings.comfyui,
        [field]: value
      }
    });
  };

  const handleLLMChange = (field: string, value: any) => {
    setSettings({
      ...settings,
      llm: {
        ...settings.llm,
        [field]: value
      }
    });
  };

  const handleVerifyLLM = async () => {
    setVerifyingLLM(true);
    setMessage(null);
    try {
      await api.verifyLLMConnection(settings.llm);
      setMessage({ type: 'success', text: t('settings_page.llm_verify_success') });
    } catch (error) {
      console.error("LLM verification failed", error);
      setMessage({ type: 'error', text: t('settings_page.llm_verify_failed') });
    } finally {
      setVerifyingLLM(false);
    }
  };

  if (loading) {
    return <div className="p-12 text-center text-slate-500">{t('dashboard.loading')}</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto w-full bg-slate-950 p-4 sm:p-6 lg:p-10">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6 sm:mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2">{t('app.settings')}</h1>
          <p className="text-slate-400 text-sm sm:text-base">{t('settings_page.subtitle')}</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 sm:gap-4 mb-6 sm:mb-8 border-b border-slate-800 overflow-x-auto pb-1 custom-scrollbar">
           <button
             onClick={() => setActiveTab('general')}
             className={`pb-3 px-3 sm:px-4 text-sm font-medium transition-colors border-b-2 flex items-center gap-2 whitespace-nowrap ${
               activeTab === 'general' 
                 ? 'border-indigo-500 text-indigo-400' 
                 : 'border-transparent text-slate-400 hover:text-slate-200'
             }`}
           >
             <Settings size={16} />
             {t('settings_page.tabs.general')}
           </button>
           <button
             onClick={() => setActiveTab('workflow')}
             className={`pb-3 px-3 sm:px-4 text-sm font-medium transition-colors border-b-2 flex items-center gap-2 whitespace-nowrap ${
               activeTab === 'workflow' 
                 ? 'border-indigo-500 text-indigo-400' 
                 : 'border-transparent text-slate-400 hover:text-slate-200'
             }`}
           >
             <Sliders size={16} />
             {t('settings_page.tabs.workflow')}
           </button>
        </div>

        {activeTab === 'workflow' ? (
          <div className="animate-in fade-in slide-in-from-left-4 duration-300 space-y-8">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-8 shadow-sm space-y-8 sm:space-y-10">
              {/* ComfyUI Configuration */}
              <section>
                <div className="flex items-center gap-2 mb-6">
                  <Server className="w-5 h-5 text-indigo-400" />
                  <h2 className="text-lg sm:text-xl font-semibold text-white">{t('settings_page.comfyui_config')}</h2>
                </div>
                
                <div className="space-y-6">
                  {/* Enable Toggle */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-slate-950 border border-slate-800 rounded-lg gap-4">
                    <div>
                      <h3 className="text-slate-200 font-medium text-sm sm:text-base">{t('settings_page.comfyui_enable_title')}</h3>
                      <p className="text-xs sm:text-sm text-slate-500">{t('settings_page.comfyui_enable_desc')}</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer self-start sm:self-auto">
                      <input 
                        type="checkbox" 
                        className="sr-only peer"
                        checked={settings.comfyui?.enabled || false}
                        onChange={(e) => handleComfyUIChange('enabled', e.target.checked)}
                      />
                      <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                    </label>
                  </div>

                  {/* Base URL */}
                  <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                      {t('settings_page.comfyui_url_label')}
                    </label>
                    <input
                      type="text"
                      value={settings.comfyui?.base_url || ''}
                      onChange={(e) => handleComfyUIChange('base_url', e.target.value)}
                      placeholder="http://127.0.0.1:8188"
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-slate-200 text-sm sm:text-base focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                    />
                  </div>

                  {/* Workflow Selection */}
                  <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                      {t('settings_page.comfyui_workflow_label')}
                    </label>
                    <div className="relative">
                      <select
                        value={settings.comfyui?.selected_workflow_file || ''}
                        onChange={(e) => handleComfyUIChange('selected_workflow_file', e.target.value || null)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 pr-10 text-slate-200 text-sm sm:text-base focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent appearance-none transition-all"
                      >
                        <option value="">{t('settings_page.comfyui_workflow_placeholder')}</option>
                        {workflowFiles.map((file) => (
                          <option key={file} value={file}>
                            {file}
                          </option>
                        ))}
                      </select>
                      <WorkflowIcon className="absolute right-3 top-2.5 w-5 h-5 text-slate-500 pointer-events-none" />
                    </div>
                    <p className="text-xs text-slate-500 mt-2">
                      {t('settings_page.comfyui_workflow_desc')}
                    </p>
                  </div>
                </div>
              </section>

              <div className="mt-8 sm:mt-10 pt-6 border-t border-slate-800 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
                <div>
                  {message && (
                    <div className={`flex items-center gap-2 text-sm ${message.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                      {message.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                      <span>{message.text}</span>
                    </div>
                  )}
                </div>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className={`flex items-center justify-center gap-2 px-6 py-2.5 rounded-lg font-medium text-white transition-all ${
                    saving 
                      ? 'bg-indigo-600/50 cursor-not-allowed' 
                      : 'bg-indigo-600 hover:bg-indigo-500 shadow-lg shadow-indigo-600/20'
                  }`}
                >
                  <Save size={18} />
                  {saving ? t('settings_page.saving') : t('settings_page.save')}
                </button>
              </div>
            </div>

            <WorkflowSettings />
          </div>
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-8 shadow-sm space-y-8 sm:space-y-10 animate-in fade-in slide-in-from-left-4 duration-300">
            {/* Model Configuration */}
            <section>
              <h2 className="text-lg sm:text-xl font-semibold text-white mb-6">{t('settings_page.model_config')}</h2>
              
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-400 mb-3">
                    {t('settings_page.gemini_select')}
                  </label>
                  <div className="space-y-3">
                    <ModelOption 
                      id="gemini-2.5-flash"
                      name="Gemini 2.5 Flash"
                      description={t('settings_page.model_desc_flash25')}
                      selected={settings.llm_model === 'gemini-2.5-flash'}
                      onSelect={() => handleModelChange('gemini-2.5-flash')}
                    />
                    <ModelOption 
                      id="gemini-2.5-pro"
                      name="Gemini 2.5 Pro"
                      description={t('settings_page.model_desc_pro25')}
                      selected={settings.llm_model === 'gemini-2.5-pro'}
                      onSelect={() => handleModelChange('gemini-2.5-pro')}
                    />
                    <ModelOption 
                      id="qwen3.5:9b"
                      name="Ollama Qwen 3.5 9B (Local / 本机)"
                      description={t('settings_page.model_desc_qwen35')}
                      selected={settings.llm_model === 'qwen3.5:9b' || settings.llm?.provider === 'ollama'}
                      onSelect={() => handleModelChange('qwen3.5:9b')}
                    />
                  </div>

                  {/* Custom / Manual Model Input */}
                  <div className="mt-4 pt-4 border-t border-slate-800">
                    <label className="block text-xs font-medium text-slate-400 mb-2">
                      {t('settings_page.custom_model_input_label')}
                    </label>
                    <input 
                      type="text"
                      value={settings.llm_model || ''}
                      onChange={(e) => handleModelChange(e.target.value)}
                      placeholder={t('settings_page.custom_model_input_placeholder')}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                    />
                  </div>
                </div>

                {/* Image Model Selection */}
                <div>
                  <label className="block text-sm font-medium text-slate-400 mb-3">
                    {t('settings_page.image_model_select')}
                  </label>
                  <p className="text-xs text-slate-500 mb-3">{t('settings_page.image_model_desc')}</p>
                  <div className="space-y-3">
                    <ModelOption 
                      id="gemini-2.5-flash-image"
                      name="Gemini 2.5 Flash Image"
                      description={t('settings_page.model_desc_flash_image')}
                      selected={settings.image_model === 'gemini-2.5-flash-image'}
                      onSelect={() => setSettings({ ...settings, image_model: 'gemini-2.5-flash-image' })}
                    />
                  </div>
                  {/* Custom Image Model Input */}
                  <div className="mt-3">
                    <input 
                      type="text"
                      value={settings.image_model || ''}
                      onChange={(e) => setSettings({ ...settings, image_model: e.target.value })}
                      placeholder={t('settings_page.custom_image_model_placeholder')}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                    />
                  </div>
                </div>
              </div>
            </section>

            <div className="border-t border-slate-800" />

            {/* Independent LLM Configuration */}
            <section>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                <div className="flex items-center gap-2">
                  <Cloud className="w-5 h-5 text-indigo-400" />
                  <h2 className="text-lg sm:text-xl font-semibold text-white">{t('settings_page.llm_title')}</h2>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSettings({
                      ...settings,
                      llm: {
                        provider: 'ollama',
                        base_url: 'http://127.0.0.1:11434/v1',
                        model: 'qwen3.5:9b',
                        api_key: 'ollama'
                      }
                    });
                  }}
                  className="text-xs bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 px-3 py-2 rounded-lg transition-colors flex items-center justify-center gap-1.5 self-start sm:self-auto font-medium"
                  title="Click to auto fill Ollama local qwen3.5:9b settings"
                >
                  <span>⚡ {t('settings_page.ollama_preset_btn')}</span>
                </button>
              </div>
              
              <div className="space-y-6">
                {/* LLM Provider Selection */}
                <div>
                  <label className="block text-sm font-medium text-slate-400 mb-2">
                    {t('settings_page.llm_provider_label')}
                  </label>
                  <select
                    value={settings.llm?.provider || 'gemini'}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === 'ollama') {
                        setSettings({
                          ...settings,
                          llm: {
                            ...settings.llm,
                            provider: 'ollama',
                            base_url: settings.llm?.base_url || 'http://127.0.0.1:11434/v1',
                            model: settings.llm?.model || 'qwen3.5:9b',
                            api_key: settings.llm?.api_key || 'ollama'
                          }
                        });
                      } else {
                        handleLLMChange('provider', val);
                      }
                    }}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-slate-200 text-sm sm:text-base focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                  >
                    <option value="gemini">Google Gemini</option>
                    <option value="ollama">Ollama (Local / 本机 - qwen3.5:9b)</option>
                    <option value="openai">OpenAI</option>
                    <option value="custom">Custom / OpenAI Compatible (DeepSeek, etc.)</option>
                    <option value="grok">xAI Grok</option>
                  </select>
                </div>

                {/* API Key */}
                <div>
                  <label className="block text-sm font-medium text-slate-400 mb-2">
                    {t('settings_page.llm_apikey_label')}
                  </label>
                  <input
                    type="password"
                    value={settings.llm?.api_key || ''}
                    onChange={(e) => handleLLMChange('api_key', e.target.value)}
                    placeholder="AIzaSy... / sk-..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-slate-200 text-sm sm:text-base focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                  />
                </div>

                {/* Base URL */}
                <div>
                  <label className="block text-sm font-medium text-slate-400 mb-2">
                    {t('settings_page.llm_baseurl_label')}
                  </label>
                  <input
                    type="text"
                    value={settings.llm?.base_url || ''}
                    onChange={(e) => handleLLMChange('base_url', e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-slate-200 text-sm sm:text-base focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                  />
                </div>

                {/* Model Name */}
                <div>
                  <label className="block text-sm font-medium text-slate-400 mb-2">
                    {t('settings_page.llm_model_label')}
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={settings.llm?.model || ''}
                      onChange={(e) => handleLLMChange('model', e.target.value)}
                      placeholder="gemini-2.5-flash / gpt-4o / deepseek-chat"
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-slate-200 text-sm sm:text-base focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                    />
                    <button
                      onClick={handleVerifyLLM}
                      disabled={verifyingLLM}
                      className={`w-full sm:w-auto px-4 py-2.5 rounded-lg font-medium text-white transition-all whitespace-nowrap ${
                        verifyingLLM
                          ? 'bg-slate-800 text-slate-500 cursor-not-allowed' 
                          : 'bg-indigo-600 hover:bg-indigo-500'
                      }`}
                    >
                      {verifyingLLM ? 'Verifying...' : t('settings_page.llm_verify_btn')}
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <div className="mt-8 sm:mt-10 pt-6 border-t border-slate-800 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
              <div>
                {message && (
                  <div className={`flex items-center gap-2 text-sm ${message.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                    {message.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                    <span>{message.text}</span>
                  </div>
                )}
              </div>
              <button
                onClick={handleSave}
                disabled={saving}
                className={`flex items-center justify-center gap-2 px-6 py-2.5 rounded-lg font-medium text-white transition-all ${
                  saving 
                    ? 'bg-indigo-600/50 cursor-not-allowed' 
                    : 'bg-indigo-600 hover:bg-indigo-500 shadow-lg shadow-indigo-600/20'
                }`}
              >
                <Save size={18} />
                {saving ? t('settings_page.saving') : t('settings_page.save')}
              </button>
            </div>

            {/* Once unlocked, allow easy toggle off without re-discovering the secret */}
            {advancedEnabled && (
              <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3">
                <div>
                  <p className="text-sm text-slate-300">{t('settings_page.advanced_styles_title')}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{t('settings_page.advanced_styles_desc')}</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={advancedEnabled}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setAdvancedStylesEnabled(next);
                      setAdvancedEnabled(next);
                      setMessage({
                        type: 'success',
                        text: next
                          ? t('settings_page.advanced_styles_on')
                          : t('settings_page.advanced_styles_off'),
                      });
                      setTimeout(() => setMessage(null), 3000);
                    }}
                  />
                  <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                </label>
              </div>
            )}

            {/* Hidden unlock: click this empty strip 5 times (no label by design) */}
            <div
              role="presentation"
              onClick={handleSecretAreaClick}
              className="mt-6 h-8 w-full select-none"
              aria-hidden="true"
            />
          </div>
        )}
      </div>
    </div>
  );
};

interface ModelOptionProps {
  id: string;
  name: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}

const ModelOption: React.FC<ModelOptionProps> = ({ id, name, description, selected, onSelect }) => (
  <div 
    onClick={onSelect}
    className={`relative flex items-start p-4 cursor-pointer rounded-lg border transition-all ${
      selected 
        ? 'bg-indigo-600/10 border-indigo-500 ring-1 ring-indigo-500/50' 
        : 'bg-slate-950 border-slate-800 hover:border-slate-700'
    }`}
  >
    <div className="flex items-center h-5">
      <input
        type="radio"
        name="model-selection"
        checked={selected}
        onChange={onSelect}
        className="h-4 w-4 text-indigo-600 border-gray-300 focus:ring-indigo-500 bg-slate-800"
      />
    </div>
    <div className="ml-3 text-sm">
      <label className={`font-medium ${selected ? 'text-indigo-300' : 'text-slate-200'}`}>
        {name}
      </label>
      <p className="text-slate-500 mt-1">{description}</p>
    </div>
  </div>
);