import React, { useEffect, useState } from 'react';
import { Plus, Search, Folder, Clock, MoreVertical, Trash2, Upload } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { Project } from '../types';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import { CardSkeleton } from '../components/Skeleton';

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [newProject, setNewProject] = useState({ title: '', description: '' });
  const [importFile, setImportFile] = useState<File | null>(null);

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    // Add a slight artificial delay to show off the skeleton if response is too fast
    const start = Date.now();
    try {
      const data = await api.getProjects();
      if (Array.isArray(data)) {
        setProjects(data);
      }
    } catch (error) {
      console.error("Failed to load projects", error);
      showToast("Failed to load projects", 'error');
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 500) await new Promise(r => setTimeout(r, 500 - elapsed));
      setLoading(false);
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProject.title) return;
    try {
      const created = await api.createProject(newProject);
      setProjects([...projects, created]);
      setShowCreateModal(false);
      setNewProject({ title: '', description: '' });
      showToast("Project created successfully", 'success');
    } catch (error) {
      showToast('Failed to create project', 'error');
    }
  };

  const handleImportProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importFile) return;
    try {
        const imported = await api.importProject(importFile);
        setProjects([...projects, imported]);
        setShowImportModal(false);
        setImportFile(null);
        showToast("Project imported successfully", 'success');
    } catch (error) {
        showToast('Failed to import project. Please check the file format.', 'error');
        console.error(error);
    }
  }

  const handleDelete = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    if (confirm(t('dashboard.confirm_delete'))) {
      try {
        await api.deleteProject(id);
        setProjects(projects.filter(p => p.id !== id));
        showToast("Project deleted", 'success');
      } catch (error) {
        console.error("Delete failed", error);
        showToast("Failed to delete project", 'error');
      }
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-4 sm:p-8 lg:p-12">
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 sm:mb-10 gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2">{t('dashboard.title')}</h1>
            <p className="text-slate-400 text-sm sm:text-base">{t('dashboard.subtitle')}</p>
          </div>
          <div className="flex gap-3 w-full sm:w-auto">
            <button
                onClick={() => setShowImportModal(true)}
                className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-white px-4 sm:px-5 py-2.5 rounded-lg transition-all shadow-lg font-medium text-sm sm:text-base"
            >
                <Upload size={18} />
                {t('dashboard.import_btn')}
            </button>
            <button
                onClick={() => setShowCreateModal(true)}
                className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 sm:px-5 py-2.5 rounded-lg transition-all shadow-lg shadow-indigo-600/20 font-medium text-sm sm:text-base"
            >
                <Plus size={18} />
                {t('dashboard.create_btn')}
            </button>
          </div>
        </header>

        {/* Search Bar */}
        <div className="relative mb-8 w-full max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-500" size={18} />
          <input
            type="text"
            placeholder={t('dashboard.search_placeholder')}
            className="w-full bg-slate-900 border border-slate-800 text-slate-200 pl-10 pr-4 py-2 text-sm sm:text-base rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-slate-600"
          />
        </div>

        {/* Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {loading ? (
                // Skeletons
                Array.from({ length: 3 }).map((_, i) => <CardSkeleton key={i} />)
            ) : (
                <>
                    {projects.map((project) => (
                    <div
                        key={project.id}
                        onClick={() => navigate(`/project/${project.id}/story`)}
                        className="group bg-slate-900 border border-slate-800 hover:border-indigo-500/50 rounded-xl p-6 cursor-pointer transition-all hover:shadow-xl hover:shadow-indigo-500/5 relative animate-in fade-in zoom-in-95 duration-300"
                    >
                        <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                            onClick={(e) => handleDelete(e, project.id)}
                            className="p-1.5 hover:bg-red-500/10 hover:text-red-500 text-slate-500 rounded-md transition-colors"
                        >
                            <Trash2 size={16} />
                        </button>
                        </div>

                        <div className="flex items-center gap-3 mb-4">
                        <div className="p-3 bg-indigo-900/30 text-indigo-400 rounded-lg">
                            <Folder size={24} />
                        </div>
                        </div>
                        <h3 className="text-xl font-semibold text-slate-100 mb-2">{project.title}</h3>
                        <p className="text-slate-400 text-sm mb-6 line-clamp-2 h-10">
                        {project.description || "No description provided."}
                        </p>
                        <div className="flex items-center justify-between text-xs text-slate-500 pt-4 border-t border-slate-800">
                        <div className="flex items-center gap-1">
                            <Clock size={12} />
                            <span>{t('dashboard.edited_recently')}</span>
                        </div>
                        <span className="group-hover:text-indigo-400 transition-colors">{t('dashboard.enter_studio')} &rarr;</span>
                        </div>
                    </div>
                    ))}
                    
                    {/* Empty State / Add New Placeholder */}
                    {projects.length === 0 && (
                    <div 
                        onClick={() => setShowCreateModal(true)}
                        className="border-2 border-dashed border-slate-800 hover:border-slate-700 rounded-xl flex flex-col items-center justify-center p-6 cursor-pointer text-slate-500 hover:text-slate-400 transition-colors h-64"
                    >
                        <Plus size={48} className="mb-4 opacity-50" />
                        <span className="font-medium">{t('dashboard.empty_title')}</span>
                    </div>
                    )}
                </>
            )}
        </div>
      </div>

      {/* Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 p-6 sm:p-8 rounded-2xl w-full max-w-md shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <h2 className="text-xl sm:text-2xl font-bold text-white mb-6">{t('dashboard.modal_title')}</h2>
            <form onSubmit={handleCreateProject} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">{t('dashboard.field_title')}</label>
                <input
                  autoFocus
                  type="text"
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none text-sm sm:text-base"
                  value={newProject.title}
                  onChange={(e) => setNewProject({ ...newProject, title: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">{t('dashboard.field_desc')}</label>
                <textarea
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none h-24 resize-none text-sm sm:text-base"
                  value={newProject.description}
                  onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
                />
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-slate-300 hover:text-white text-sm"
                >
                  {t('dashboard.cancel')}
                </button>
                <button
                  type="submit"
                  className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium text-sm"
                >
                  {t('dashboard.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 p-6 sm:p-8 rounded-2xl w-full max-w-md shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <h2 className="text-xl sm:text-2xl font-bold text-white mb-6">{t('dashboard.import_modal_title')}</h2>
            <form onSubmit={handleImportProject} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">{t('dashboard.field_path')}</label>
                <div className="relative">
                    <input
                      type="file"
                      accept=".txt"
                      required
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 text-sm"
                      onChange={(e) => {
                          if (e.target.files && e.target.files.length > 0) {
                              setImportFile(e.target.files[0]);
                          }
                      }}
                    />
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="px-4 py-2 text-slate-300 hover:text-white text-sm"
                >
                  {t('dashboard.cancel')}
                </button>
                <button
                  type="submit"
                  className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium text-sm"
                >
                  {t('dashboard.import')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};