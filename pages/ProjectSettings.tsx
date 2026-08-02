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
  /** inherit | on | off — project-level NSFW policy */
  const [nsfwMode, setNsfwMode] = useState<'inherit' | 'on' | 'off'>('inherit');

  useEffect(() => {
    if (id) loadProject();
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
          if (settingsObj.nsfw_mode === 'on' || settingsObj.nsfw_mode === 'off' || settingsObj.nsfw_mode === 'inherit') {
              setNsfwMode(settingsObj.nsfw_mode);
          } else if (typeof settingsObj.nsfw_enabled === 'boolean') {
              setNsfwMode(settingsObj.nsfw_enabled ? 'on' : 'off');
          } else {
              setNsfwMode('inherit');
          }
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
            nsfw_mode: nsfwMode
        });

        await api.updateProject(project.id, {
            title,
            description,
            settings: settingsJson
        });
        
        // Seed Director Mode style for this session
        localStorage.setItem('director_selectedStyle', defaultStyle);
        if (id) {
          localStorage.setItem(`director_project_${id}_style`, defaultStyle);
          localStorage.setItem(`director_project_${id}_nsfw_mode`, nsfwMode);
        }
        
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