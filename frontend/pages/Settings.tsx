import React, { useEffect, useState } from 'react';
import { Save, CheckCircle, AlertCircle, Server, Workflow as WorkflowIcon, Cloud, Settings, Sliders } from 'lucide-react';
import { api } from '../services/api';
import { useLanguage } from '../LanguageContext';
import { WorkflowSettings } from '../components/WorkflowSettings';

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
  const [verifyingNebula, setVerifyingNebula] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

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

      const defaultNebula = {
        enabled: false,
        base_url: 'https://www.chuangyi.chat/v2',
        system_token: ''
      };

      setSettings({
        ...settingsData,
        comfyui: { ...defaultComfyUI, ...(settingsData.comfyui || {}) },
        nebula: { ...defaultNebula, ...(settingsData.nebula || {}) }
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
    setSettings({ ...settings, llm_model: model });
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

  const handleNebulaChange = (field: string, value: any) => {
    setSettings({
      ...settings,
      nebula: {
        ...settings.nebula,
        [field]: value
      }
    });
  };

  const handleVerifyNebula = async () => {
    setVerifyingNebula(true);
    setMessage(null);
    try {
      await api.verifyNebulaConnection(settings.nebula);
      setMessage({ type: 'success', text: "Nebula Connection Verified!" });
    } catch (error) {
      console.error("Nebula verification failed", error);
      setMessage({ type: 'error', text: "Nebula Connection Failed" });
    } finally {
      setVerifyingNebula(false);
    }
  };

  if (loading) {
    return <div className="p-12 text-center text-slate-500">{t('dashboard.loading')}</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-6 lg:p-12">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">{t('app.settings')}</h1>
        <p className="text-slate-400">{t('settings_page.subtitle')}</p>
      </div>

        {/* Tabs */}
        <div className="flex gap-4 mb-8 border-b border-slate-800">
           <button
             onClick={() => setActiveTab('general')}
             className={`pb-3 px-4 text-sm font-medium transition-colors border-b-2 flex items-center gap-2 ${
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
             className={`pb-3 px-4 text-sm font-medium transition-colors border-b-2 flex items-center gap-2 ${
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
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 shadow-sm space-y-10">
              {/* ComfyUI Configuration */}
              <section>
                <div className="flex items-center gap-2 mb-6">
                  <Server className="w-5 h-5 text-indigo-400" />
                  <h2 className="text-xl font-semibold text-white">{t('settings_page.comfyui_config')}</h2>
                </div>
                
                <div className="space-y-6">
                  {/* Enable Toggle */}
                  <div className="flex items-center justify-between p-4 bg-slate-950 border border-slate-800 rounded-lg">
                    <div>
                      <h3 className="text-slate-200 font-medium">{t('settings_page.comfyui_enable_title')}</h3>
                      <p className="text-sm text-slate-500">{t('settings_page.comfyui_enable_desc')}</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
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
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
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
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent appearance-none transition-all"
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

              <div className="mt-10 pt-6 border-t border-slate-800 flex items-center justify-between">
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
                  className={`flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-white transition-all ${
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
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 shadow-sm space-y-10 animate-in fade-in slide-in-from-left-4 duration-300">
            {/* Model Configuration */}
            <section>
              <h2 className="text-xl font-semibold text-white mb-6">{t('settings_page.model_config')}</h2>
              
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
                      id="gemini-3-flash-preview"
                      name="Gemini 3.0 Flash (Preview)"
                      description={t('settings_page.model_desc_flash30')}
                      selected={settings.llm_model === 'gemini-3-flash-preview'}
                      onSelect={() => handleModelChange('gemini-3-flash-preview')}
                    />
                    <ModelOption 
                      id="gemini-3-pro-preview"
                      name="Gemini 3.0 Pro (Preview)"
                      description={t('settings_page.model_desc_pro30')}
                    selected={settings.llm_model === 'gemini-3-pro-preview'}
                    onSelect={() => handleModelChange('gemini-3-pro-preview')}
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
                  <ModelOption 
                    id="gemini-3-pro-image-preview"
                    name="Gemini 3.0 Pro Image (Preview)"
                    description={t('settings_page.model_desc_pro_image')}
                    selected={settings.image_model === 'gemini-3-pro-image-preview'}
                    onSelect={() => setSettings({ ...settings, image_model: 'gemini-3-pro-image-preview' })}
                  />
                </div>
              </div>
            </div>
            </section>

            <div className="border-t border-slate-800" />

            {/* Nebula Configuration */}
            <section>
              <div className="flex items-center gap-2 mb-6">
                <Cloud className="w-5 h-5 text-indigo-400" />
                <h2 className="text-xl font-semibold text-white">{t('settings_page.nebula_title')}</h2>
              </div>
              
              <div className="space-y-6">
                {/* Enable Toggle */}
                <div className="flex items-center justify-between p-4 bg-slate-950 border border-slate-800 rounded-lg">
                  <div>
                    <h3 className="text-slate-200 font-medium">{t('settings_page.nebula_integration')}</h3>
                    <p className="text-sm text-slate-500">{t('settings_page.nebula_desc')}</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="sr-only peer"
                      checked={settings.nebula?.enabled || false}
                      onChange={(e) => handleNebulaChange('enabled', e.target.checked)}
                    />
                    <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                  </label>
                </div>

                {settings.nebula?.enabled && (
                  <div className="space-y-6 animate-in fade-in slide-in-from-top-4 duration-300">
                    {/* Base URL */}
                    <div>
                      <label className="block text-sm font-medium text-slate-400 mb-2">
                        Nebula API URL
                      </label>
                      <input
                        type="text"
                        value={settings.nebula?.base_url || ''}
                        onChange={(e) => handleNebulaChange('base_url', e.target.value)}
                        placeholder="https://www.chuangyi.chat/v2"
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                      />
                    </div>

                    {/* System Token */}
                    <div>
                      <label className="block text-sm font-medium text-slate-400 mb-2">
                        System Token
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={settings.nebula?.system_token || ''}
                          onChange={(e) => handleNebulaChange('system_token', e.target.value)}
                          placeholder="sk-..."
                          className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                        />
                        <button
                          onClick={handleVerifyNebula}
                          disabled={verifyingNebula || !settings.nebula?.system_token}
                          className={`px-4 py-2.5 rounded-lg font-medium text-white transition-all whitespace-nowrap ${
                            verifyingNebula || !settings.nebula?.system_token
                              ? 'bg-slate-800 text-slate-500 cursor-not-allowed' 
                              : 'bg-indigo-600 hover:bg-indigo-500'
                          }`}
                        >
                          {verifyingNebula ? 'Verifying...' : 'Verify'}
                        </button>
                      </div>
                      <p className="text-xs text-slate-500 mt-2">
                        Your unique system token for authentication.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <div className="mt-10 pt-6 border-t border-slate-800 flex items-center justify-between">
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
                className={`flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-white transition-all ${
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
        )}
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