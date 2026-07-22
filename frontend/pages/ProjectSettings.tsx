import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Save, Loader2, Trash2, AlertCircle } from 'lucide-react';
import { api } from '../services/api';
import { Project } from '../types';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import { VISUAL_STYLES } from '../constants';

export const ProjectSettings: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  
  // Form State
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [defaultStyle, setDefaultStyle] = useState(VISUAL_STYLES[0].value);

  useEffect(() => {
    if (id) loadProject();
  }, [id]);

  const loadProject = async () => {
    try {
      const data = await api.getProject(Number(id));
      setProject(data);
      setTitle(data.title);
      setDescription(data.description || '');
      
      // Parse settings JSON if available
      try {
          const settingsObj = data.settings ? JSON.parse(data.settings) : {};
          if (settingsObj.default_style) {
              setDefaultStyle(settingsObj.default_style);
          }
      } catch (e) {
          console.error("Failed to parse project settings", e);
      }
    } catch (e) {
      console.error(e);
      showToast("Failed to load project", 'error');
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
            default_style: defaultStyle
        });

        await api.updateProject(project.id, {
            title,
            description,
            settings: settingsJson
        });
        
        // Also update local storage so Director Mode picks up new default immediately?
        // Actually Director Mode uses its own localStorage override or default.
        // We can update the override key:
        localStorage.setItem('director_selectedStyle', defaultStyle);
        
        showToast("Project updated successfully", 'success');
    } catch (e) {
        console.error(e);
        showToast("Failed to update project", 'error');
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
          showToast("Project deleted", 'success');
          navigate('/');
      } catch (e) {
          console.error(e);
          showToast("Failed to delete project", 'error');
          setDeleting(false);
      }
  };

  if (loading) return <div className="p-12 text-center text-slate-500">{t('dashboard.loading')}</div>;
  if (!project) return <div className="p-12 text-center text-red-500">Project not found</div>;

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-6 md:p-12">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold text-white mb-8">{t('project_settings.title')}</h1>
        
        <form onSubmit={handleSave} className="space-y-8">
            {/* General Info */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
                <h2 className="text-xl font-semibold text-slate-200 border-b border-slate-800 pb-4">
                    {t('project_settings.general')}
                </h2>
                
                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                        {t('dashboard.field_title')}
                    </label>
                    <input
                        type="text"
                        required
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                    />
                </div>

                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                        {t('dashboard.field_desc')}
                    </label>
                    <textarea
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none h-32 resize-none"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                    />
                </div>
            </div>

            {/* Defaults */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
                <h2 className="text-xl font-semibold text-slate-200 border-b border-slate-800 pb-4">
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
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        value={defaultStyle}
                        onChange={(e) => setDefaultStyle(e.target.value)}
                    >
                        {VISUAL_STYLES.map(s => (
                            <option key={s.value} value={s.value}>{t(`director.styles.${s.value}`) || s.label}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-4 pt-4 border-t border-slate-800">
                <button
                    type="submit"
                    disabled={saving}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg font-medium transition-all disabled:opacity-50"
                >
                    {saving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
                    {t('project_settings.save')}
                </button>
            </div>
        </form>

        {/* Danger Zone */}
        <div className="mt-12 pt-8 border-t border-slate-800">
            <h3 className="text-red-400 font-bold mb-4 uppercase text-sm tracking-wider flex items-center gap-2">
                <AlertCircle size={16} />
                {t('project_settings.danger_zone')}
            </h3>
            <div className="bg-red-900/10 border border-red-900/30 rounded-xl p-6 flex justify-between items-center">
                <div>
                    <h4 className="text-red-200 font-medium">{t('project_settings.delete_project')}</h4>
                    <p className="text-sm text-red-300/60 mt-1">{t('project_settings.delete_desc')}</p>
                </div>
                <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                >
                    {deleting ? "Deleting..." : t('project_settings.delete_btn')}
                </button>
            </div>
        </div>
      </div>
    </div>
  );
};