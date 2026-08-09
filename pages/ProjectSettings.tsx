import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Save, Loader2, Trash2, AlertCircle } from 'lucide-react';
import { api } from '../services/api';
import { Project } from '../types';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import {
  formatVisualStyleLabel,
  getVisualStyles,
  STANDARD_VISUAL_STYLES,
  type VisualStyleDef,
} from '../constants';

export const ProjectSettings: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [visualStyles, setVisualStyles] = useState<VisualStyleDef[]>(() => getVisualStyles());
  
  // Form State
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [defaultStyle, setDefaultStyle] = useState(STANDARD_VISUAL_STYLES[0].value);
  const [defaultModelType, setDefaultModelType] = useState<'pony' | 'sd15'>('pony');
  const [defaultWorkflowId, setDefaultWorkflowId] = useState<number | null>(null);
  const [workflows, setWorkflows] = useState<any[]>([]);
  /** inherit | on | off — project-level NSFW policy */
  const [nsfwMode, setNsfwMode] = useState<'inherit' | 'on' | 'off'>('inherit');
  const [genre, setGenre] = useState('');
  const [storyStyle, setStoryStyle] = useState('');
  const [mainPlot, setMainPlot] = useState('');
  const [characterRelations, setCharacterRelations] = useState('');
  const [glossary, setGlossary] = useState<
    Array<{ id: number; term: string; definition?: string | null; category?: string | null }>
  >([]);
  const [newTerm, setNewTerm] = useState('');
  const [newDefinition, setNewDefinition] = useState('');

  useEffect(() => {
    if (id) {
      loadProject();
      api
        .listGlossary(Number(id))
        .then((rows) => setGlossary(Array.isArray(rows) ? rows : []))
        .catch(() => setGlossary([]));
    }
    api.getWorkflows().then((data) => {
      if (Array.isArray(data)) setWorkflows(data);
    }).catch(console.error);
  }, [id]);

  useEffect(() => {
    const refresh = () => {
      const styles = getVisualStyles();
      setVisualStyles(styles);
      setDefaultStyle((prev) => (styles.some((s) => s.value === prev) ? prev : STANDARD_VISUAL_STYLES[0].value));
    };
    window.addEventListener('novastory-advanced-styles-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('novastory-advanced-styles-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const loadProject = async () => {
    try {
      const data = await api.getProject(Number(id));
      setProject(data);
      setTitle(data.title);
      setDescription(data.description || '');
      
      // Parse settings JSON if available
      try {
          const raw = data.settings;
          const settingsObj = typeof raw === 'string'
            ? (raw ? JSON.parse(raw) : {})
            : (raw && typeof raw === 'object' ? raw : {});
          if (settingsObj.default_style) {
              setDefaultStyle(settingsObj.default_style);
          }
          if (settingsObj.default_model_type === 'sd15' || settingsObj.default_model_type === 'pony') {
              setDefaultModelType(settingsObj.default_model_type);
          } else if (settingsObj.default_model_type === 'flux') {
              // FLUX.1-dev GGUF retired — migrate to Pony XL
              setDefaultModelType('pony');
          }
          if (typeof settingsObj.default_workflow_id === 'number') {
              setDefaultWorkflowId(settingsObj.default_workflow_id);
          }
          if (settingsObj.nsfw_mode === 'on' || settingsObj.nsfw_mode === 'off' || settingsObj.nsfw_mode === 'inherit') {
              setNsfwMode(settingsObj.nsfw_mode);
          } else if (typeof settingsObj.nsfw_enabled === 'boolean') {
              setNsfwMode(settingsObj.nsfw_enabled ? 'on' : 'off');
          } else {
              setNsfwMode('inherit');
          }
          setGenre(typeof settingsObj.genre === 'string' ? settingsObj.genre : '');
          setStoryStyle(typeof settingsObj.style === 'string' ? settingsObj.style : '');
          setMainPlot(typeof settingsObj.main_plot === 'string' ? settingsObj.main_plot : '');
          setCharacterRelations(
            typeof settingsObj.character_relations === 'string'
              ? settingsObj.character_relations
              : ''
          );
      } catch (e) {
          console.error("Failed to parse project settings", e);
      }
    } catch (e) {
      console.error(e);
      showToast(t("settings.failed_load", "Failed to load project"), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setSaving(true);
    
    try {
        const settingsJson = JSON.stringify({
            default_style: defaultStyle,
            default_model_type: defaultModelType,
            default_workflow_id: defaultWorkflowId,
            nsfw_mode: nsfwMode,
            genre,
            style: storyStyle,
            main_plot: mainPlot,
            character_relations: characterRelations,
        });

        await api.updateProject(project.id, {
            title,
            description,
            settings: settingsJson
        });
        
        // Seed Director Mode & Character Mode settings for this session
        localStorage.setItem('director_selectedStyle', defaultStyle);
        if (id) {
          localStorage.setItem(`director_project_${id}_style`, defaultStyle);
          localStorage.setItem(`director_project_${id}_model_type`, defaultModelType);
          localStorage.setItem(`director_project_${id}_nsfw_mode`, nsfwMode);
        }
        window.dispatchEvent(new Event('novastory-project-settings-changed'));
        
        showToast(t("settings.updated", "Project updated successfully"), 'success');
    } catch (e) {
        console.error(e);
        showToast(t("settings.failed_update", "Failed to update project"), 'error');
    } finally {
        setSaving(false);
    }
  };

  const handleDelete = async () => {
      if (!project) return;
      if (!confirm(t('dashboard.confirm_delete'))) return;
      
      setDeleting(true);
      try {
          await api.deleteProject(project.id);
          showToast(t("settings.deleted", "Project deleted"), 'success');
          navigate('/');
      } catch (e) {
          console.error(e);
          showToast(t("settings.failed_delete", "Failed to delete project"), 'error');
          setDeleting(false);
      }
  };

  if (loading) return <div className="p-12 text-center text-slate-500">{t('dashboard.loading')}</div>;
  if (!project) return <div className="p-12 text-center text-red-500">Project not found</div>;

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-4 sm:p-8 lg:p-12">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl sm:text-3xl font-bold text-white mb-6 sm:mb-8">{t('project_settings.title')}</h1>
        
        <form onSubmit={handleSave} className="space-y-6 sm:space-y-8">
            {/* General Info */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-6 space-y-6">
                <h2 className="text-lg sm:text-xl font-semibold text-slate-200 border-b border-slate-800 pb-4">
                    {t('project_settings.general')}
                </h2>
                
                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                        {t('dashboard.field_title')}
                    </label>
                    <input
                        type="text"
                        required
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none text-sm sm:text-base"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                    />
                </div>

                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                        {t('dashboard.field_desc')}
                    </label>
                    <textarea
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none h-32 resize-none text-sm sm:text-base"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                    />
                </div>
            </div>

            {/* Defaults */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-6 space-y-6">
                <h2 className="text-lg sm:text-xl font-semibold text-slate-200 border-b border-slate-800 pb-4">
                    {t('project_settings.defaults')}
                </h2>
                
                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                        {t('project_settings.default_style')}
                    </label>
                    <p className="text-xs text-slate-500 mb-2">
                        {t('project_settings.default_style_desc')}
                    </p>
                    <select
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none text-sm sm:text-base"
                        value={defaultStyle}
                        onChange={(e) => setDefaultStyle(e.target.value)}
                    >
                        {visualStyles.map(s => (
                            <option key={s.value} value={s.value}>
                                {formatVisualStyleLabel(s, t(`director.styles.${s.value}`) || s.label)}
                            </option>
                        ))}
                    </select>
                </div>

                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                        {t('project_settings.default_model_preset')}
                    </label>
                    <p className="text-xs text-slate-500 mb-2">
                        {t('project_settings.default_model_preset_desc')}
                    </p>
                    <select
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none text-sm sm:text-base"
                        value={defaultWorkflowId ? `wf_${defaultWorkflowId}` : defaultModelType}
                        onChange={(e) => {
                            const val = e.target.value;
                            if (val.startsWith('wf_')) {
                                const wfId = Number(val.replace('wf_', ''));
                                setDefaultWorkflowId(wfId);
                                const foundWf = workflows.find((w) => w.id === wfId);
                                if (foundWf) {
                                    const nameLower = (foundWf.name || '').toLowerCase();
                                    if (nameLower.includes('sd15') || nameLower.includes('sd1.5') || nameLower.includes('1.5')) {
                                      setDefaultModelType('sd15');
                                    } else {
                                      setDefaultModelType('pony');
                                    }
                                }
                            } else {
                                setDefaultWorkflowId(null);
                                setDefaultModelType(val as 'pony' | 'sd15');
                            }
                        }}
                    >
                        <optgroup label="内置基础模型 (Base Models)">
                            <option value="pony">Pony XL (SDXL 二次元/国风 · 成片)</option>
                            <option value="sd15">SD 1.5 Draft (轻量草稿 · 快速迭代)</option>
                        </optgroup>
                        {workflows.length > 0 && (
                            <optgroup label="ComfyUI 工作流预设 (Custom Workflows)">
                                {workflows.map((wf) => (
                                    <option key={wf.id} value={`wf_${wf.id}`}>
                                        {wf.name} {wf.description ? `(${wf.description})` : ''}
                                    </option>
                                ))}
                            </optgroup>
                        )}
                    </select>
                </div>

                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                        {t('project_settings.nsfw_mode')}
                    </label>
                    <p className="text-xs text-slate-500 mb-2">
                        {t('project_settings.nsfw_mode_desc')}
                    </p>
                    <select
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-rose-500 focus:outline-none text-sm sm:text-base"
                        value={nsfwMode}
                        onChange={(e) => setNsfwMode(e.target.value as 'inherit' | 'on' | 'off')}
                    >
                        <option value="inherit">{t('project_settings.nsfw_inherit')}</option>
                        <option value="on">{t('project_settings.nsfw_on')}</option>
                        <option value="off">{t('project_settings.nsfw_off')}</option>
                    </select>
                </div>
            </div>

            {/* Story Bible */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-6 space-y-6">
                <h2 className="text-lg sm:text-xl font-semibold text-slate-200 border-b border-slate-800 pb-4">
                    {t('project_settings.story_bible', 'Story Bible')}
                </h2>
                <p className="text-xs text-slate-500 -mt-2">
                    {t(
                      'project_settings.story_bible_desc',
                      'Used by Agent OS and chapter drafting (local LLM context).'
                    )}
                </p>
                <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-slate-400 mb-2">
                            {t('project_settings.genre', 'Genre')}
                        </label>
                        <input
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                            value={genre}
                            onChange={(e) => setGenre(e.target.value)}
                            placeholder="xianxia / urban / suspense…"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-400 mb-2">
                            {t('project_settings.story_style', 'Writing style')}
                        </label>
                        <input
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                            value={storyStyle}
                            onChange={(e) => setStoryStyle(e.target.value)}
                            placeholder="cinematic, webnovel…"
                        />
                    </div>
                </div>
                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                        {t('project_settings.main_plot', 'Main plot')}
                    </label>
                    <textarea
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white h-28 resize-none text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        value={mainPlot}
                        onChange={(e) => setMainPlot(e.target.value)}
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                        {t('project_settings.character_relations', 'Character relations')}
                    </label>
                    <textarea
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white h-20 resize-none text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        value={characterRelations}
                        onChange={(e) => setCharacterRelations(e.target.value)}
                    />
                </div>
            </div>

            {/* Glossary */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
                <h2 className="text-lg sm:text-xl font-semibold text-slate-200 border-b border-slate-800 pb-4">
                    {t('project_settings.glossary', 'Glossary')}
                </h2>
                <div className="flex flex-col sm:flex-row gap-2">
                    <input
                        className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder={t('project_settings.glossary_term', 'Term')}
                        value={newTerm}
                        onChange={(e) => setNewTerm(e.target.value)}
                    />
                    <input
                        className="flex-[2] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder={t('project_settings.glossary_def', 'Definition')}
                        value={newDefinition}
                        onChange={(e) => setNewDefinition(e.target.value)}
                    />
                    <button
                        type="button"
                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm"
                        onClick={async () => {
                            if (!id || !newTerm.trim()) return;
                            try {
                                const row = await api.createGlossary(Number(id), {
                                    term: newTerm.trim(),
                                    definition: newDefinition.trim() || undefined,
                                });
                                setGlossary((g) => [...g, row]);
                                setNewTerm('');
                                setNewDefinition('');
                            } catch (e) {
                                console.error(e);
                                showToast(t('project_settings.glossary_fail', 'Failed to add term'), 'error');
                            }
                        }}
                    >
                        {t('project_settings.glossary_add', 'Add')}
                    </button>
                </div>
                <ul className="space-y-2 max-h-48 overflow-y-auto">
                    {glossary.map((g) => (
                        <li
                            key={g.id}
                            className="flex items-start justify-between gap-2 text-sm bg-slate-950/50 border border-slate-800 rounded-lg px-3 py-2"
                        >
                            <div>
                                <span className="text-indigo-300 font-medium">{g.term}</span>
                                {g.definition && (
                                    <p className="text-xs text-slate-400 mt-0.5">{g.definition}</p>
                                )}
                            </div>
                            <button
                                type="button"
                                className="text-slate-500 hover:text-red-400 p-1"
                                onClick={async () => {
                                    if (!id) return;
                                    try {
                                        await api.deleteGlossary(Number(id), g.id);
                                        setGlossary((list) => list.filter((x) => x.id !== g.id));
                                    } catch (e) {
                                        console.error(e);
                                    }
                                }}
                            >
                                <Trash2 size={14} />
                            </button>
                        </li>
                    ))}
                    {glossary.length === 0 && (
                        <li className="text-xs text-slate-600 py-2">
                            {t('project_settings.glossary_empty', 'No glossary terms yet.')}
                        </li>
                    )}
                </ul>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-4 pt-4 border-t border-slate-800">
                <button
                    type="submit"
                    disabled={saving}
                    className="w-full sm:w-auto flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg font-medium transition-all disabled:opacity-50 text-sm sm:text-base"
                >
                    {saving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
                    {t('project_settings.save')}
                </button>
            </div>
        </form>

        {/* Danger Zone */}
        <div className="mt-10 sm:mt-12 pt-6 sm:pt-8 border-t border-slate-800">
            <h3 className="text-red-400 font-bold mb-4 uppercase text-xs sm:text-sm tracking-wider flex items-center gap-2">
                <AlertCircle size={16} />
                {t('project_settings.danger_zone')}
            </h3>
            <div className="bg-red-900/10 border border-red-900/30 rounded-xl p-5 sm:p-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                    <h4 className="text-red-200 font-medium text-sm sm:text-base">{t('project_settings.delete_project')}</h4>
                    <p className="text-xs sm:text-sm text-red-300/60 mt-1">{t('project_settings.delete_desc')}</p>
                </div>
                <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="w-full sm:w-auto bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex-shrink-0"
                >
                    {deleting ? "Deleting..." : t('project_settings.delete_btn')}
                </button>
            </div>
        </div>
      </div>
    </div>
  );
};