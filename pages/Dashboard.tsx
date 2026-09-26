import React, { useEffect, useState } from 'react';
import { Plus, Search, Folder, Clock, Trash2, Upload, Download, LoaderCircle, Sparkles, X, BookOpen, Film } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import {
  commitProjectImport,
  previewProjectImport,
  type ProjectImportPreview,
} from '../services/project_import';
import { Project } from '../types';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import { CardSkeleton } from '../components/Skeleton';

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [newProject, setNewProject] = useState({ title: '', description: '' });
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<ProjectImportPreview | null>(null);
  const [previewingImport, setPreviewingImport] = useState(false);
  const [importingProject, setImportingProject] = useState(false);
  const [exportingProjectId, setExportingProjectId] = useState<number | null>(null);

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    const start = Date.now();
    try {
      const data = await api.getProjects();
      if (Array.isArray(data)) {
        setProjects(data);
      }
    } catch (error) {
      console.error("Failed to load projects", error);
      showToast(t('dashboard.failed_load'), 'error');
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 300) await new Promise(r => setTimeout(r, 300 - elapsed));
      setLoading(false);
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProject.title.trim()) return;
    try {
      const created = await api.createProject(newProject);
      setProjects([...projects, created]);
      setShowCreateModal(false);
      setNewProject({ title: '', description: '' });
      showToast(t('dashboard.created'), 'success');
      navigate(`/project/${created.id}/story`);
    } catch (error) {
      showToast(t('dashboard.failed_create'), 'error');
    }
  };

  const resetImportDialog = () => {
    setImportFile(null);
    setImportPreview(null);
    setPreviewingImport(false);
    setImportingProject(false);
  };

  const closeImportDialog = () => {
    setShowImportModal(false);
    resetImportDialog();
  };

  const handleImportProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importFile) return;

    if (!importPreview) {
      setPreviewingImport(true);
      try {
        const preview = await previewProjectImport(importFile);
        setImportPreview(preview);
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : t('dashboard.import_preview_failed', '无法解析导入文件。');
        showToast(message, 'error');
        console.error(error);
      } finally {
        setPreviewingImport(false);
      }
      return;
    }

    setImportingProject(true);
    try {
      const imported = await commitProjectImport<Project>(importFile);
      setProjects([...projects, imported]);
      closeImportDialog();
      showToast(t('dashboard.imported'), 'success');
      navigate(`/project/${imported.id}/story`);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Failed to import project. Please check the file format.';
      showToast(message, 'error');
      console.error(error);
    } finally {
      setImportingProject(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    if (confirm(t('dashboard.confirm_delete'))) {
      try {
        await api.deleteProject(id);
        setProjects(projects.filter(p => p.id !== id));
        showToast(t('dashboard.deleted'), 'success');
      } catch (error) {
        console.error("Delete failed", error);
        showToast(t('dashboard.failed_delete'), 'error');
      }
    }
  };

  const handleExport = async (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    if (exportingProjectId !== null) return;

    setExportingProjectId(project.id);
    try {
      const exportedProject = await api.exportProject(project.id);
      const blob = new Blob(
        [JSON.stringify(exportedProject, null, 2)],
        { type: 'application/json;charset=utf-8' }
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const safeTitle = project.title
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .trim() || `project-${project.id}`;

      link.href = url;
      link.download = `${safeTitle}.novastory.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast(t('dashboard.export_success'), 'success');
    } catch (error) {
      console.error('Export failed', error);
      showToast(t('dashboard.export_failed'), 'error');
    } finally {
      setExportingProjectId(null);
    }
  };

  const filteredProjects = projects.filter(p => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return p.title.toLowerCase().includes(q) || (p.description && p.description.toLowerCase().includes(q));
  });

  const importGenre = importPreview && typeof importPreview.project.settings.genre === 'string'
    ? importPreview.project.settings.genre
    : '';
  const importStoryTags = importPreview && Array.isArray(importPreview.project.settings.story_tags)
    ? importPreview.project.settings.story_tags.filter((tag): tag is string => typeof tag === 'string')
    : [];

  return (
    <div className="h-full w-full overflow-y-auto overscroll-contain bg-slate-50 dark:bg-[#090d16] text-slate-900 dark:text-slate-100 p-4 sm:p-8 lg:p-12 custom-scrollbar transition-colors duration-200">
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Header Hero Area */}
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-5 pb-6 border-b border-slate-200/80 dark:border-slate-800/80">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60">
                <Sparkles size={12} />
                NovaStory Studio
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">
              {t('dashboard.title')}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm sm:text-base mt-1">
              {t('dashboard.subtitle')}
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button
                onClick={() => {
                  resetImportDialog();
                  setShowImportModal(true);
                }}
                className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-white hover:bg-slate-50 dark:bg-slate-850 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 px-4 sm:px-5 py-2.5 rounded-xl transition-all border border-slate-200 dark:border-slate-700/80 shadow-xs font-medium text-sm sm:text-base hover:scale-[1.02] active:scale-[0.98]"
            >
                <Upload size={17} className="text-slate-500 dark:text-slate-400" />
                {t('dashboard.import_btn')}
            </button>
            <button
                onClick={() => setShowCreateModal(true)}
                className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white px-4 sm:px-5 py-2.5 rounded-xl transition-all shadow-md shadow-indigo-500/20 font-medium text-sm sm:text-base hover:scale-[1.02] active:scale-[0.98]"
            >
                <Plus size={18} />
                {t('dashboard.create_btn')}
            </button>
          </div>
        </header>

        {/* Search Bar & Stats */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
          <div className="relative w-full max-w-md">
            <Search className="absolute left-3.5 top-1/2 transform -translate-y-1/2 text-slate-400 dark:text-slate-500" size={17} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('dashboard.search_placeholder')}
              className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 pl-10 pr-9 py-2.5 text-sm rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/60 placeholder-slate-400 dark:placeholder-slate-500 shadow-xs transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X size={15} />
              </button>
            )}
          </div>

          <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
            <span>{projects.length} {t('dashboard.projects_count', '个剧本 / 项目')}</span>
          </div>
        </div>

        {/* Projects Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {loading ? (
                Array.from({ length: 3 }).map((_, i) => <CardSkeleton key={i} />)
            ) : (
                <>
                    {filteredProjects.map((project) => (
                    <div
                        key={project.id}
                        onClick={() => navigate(`/project/${project.id}/story`)}
                        className="group bg-white dark:bg-[#0f172a] border border-slate-200/80 dark:border-slate-800/80 hover:border-indigo-400/60 dark:hover:border-indigo-500/50 rounded-2xl p-6 cursor-pointer transition-all hover:shadow-xl hover:shadow-indigo-500/5 dark:hover:shadow-indigo-500/10 relative animate-in fade-in zoom-in-95 duration-200 flex flex-col justify-between"
                    >
                        <div>
                          <div className="absolute top-4 right-4 flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={(e) => handleExport(e, project)}
                              disabled={exportingProjectId !== null}
                              title={t('dashboard.export_btn')}
                              aria-label={t('dashboard.export_btn')}
                              className="p-1.5 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-indigo-400 text-slate-400 dark:text-slate-500 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {exportingProjectId === project.id
                                ? <LoaderCircle size={15} className="animate-spin" />
                                : <Download size={15} />}
                            </button>
                            <button
                              type="button"
                              onClick={(e) => handleDelete(e, project.id)}
                              title={t('dashboard.delete_btn')}
                              aria-label={t('dashboard.delete_btn')}
                              className="p-1.5 hover:bg-rose-50 dark:hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400 text-slate-400 dark:text-slate-500 rounded-lg transition-colors"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>

                          <div className="flex items-center gap-3 mb-4">
                            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-indigo-50 to-violet-50 dark:from-indigo-950/60 dark:to-violet-950/60 border border-indigo-100 dark:border-indigo-800/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shadow-xs">
                              <BookOpen size={22} />
                            </div>
                          </div>

                          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-2 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                            {project.title}
                          </h3>
                          <p className="text-slate-500 dark:text-slate-400 text-xs sm:text-sm mb-6 line-clamp-2 h-10 leading-relaxed">
                            {project.description || t('dashboard.no_description')}
                          </p>
                        </div>

                        <div className="flex items-center justify-between text-xs text-slate-400 dark:text-slate-500 pt-4 border-t border-slate-100 dark:border-slate-800/80">
                          <div className="flex items-center gap-1.5">
                              <Clock size={13} />
                              <span>{t('dashboard.edited_recently')}</span>
                          </div>
                          <span className="font-medium text-indigo-600 dark:text-indigo-400 group-hover:translate-x-0.5 transition-transform flex items-center gap-1">
                            {t('dashboard.enter_studio')} &rarr;
                          </span>
                        </div>
                    </div>
                    ))}
                    
                    {/* Empty State / Add New Placeholder */}
                    {filteredProjects.length === 0 && !loading && (
                    <div 
                        onClick={() => setShowCreateModal(true)}
                        className="col-span-full border-2 border-dashed border-slate-200 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-800 rounded-2xl flex flex-col items-center justify-center p-12 cursor-pointer text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all bg-white/40 dark:bg-slate-900/40 min-h-[16rem]"
                    >
                        <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-4 ring-1 ring-indigo-500/20 shadow-xs">
                          <Plus size={32} />
                        </div>
                        <span className="font-semibold text-slate-700 dark:text-slate-300 text-base">{t('dashboard.empty_title')}</span>
                        <span className="text-xs text-slate-400 mt-1">{t('dashboard.empty_subtitle', '点击这里新建一个精彩故事')}</span>
                    </div>
                    )}
                </>
            )}
        </div>
      </div>

      {/* Create Project Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-[#0f172a] border border-slate-200 dark:border-slate-800 p-6 sm:p-8 rounded-2xl w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">{t('dashboard.modal_title')}</h2>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCreateProject} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-1.5">{t('dashboard.field_title')}</label>
                <input
                  autoFocus
                  type="text"
                  required
                  placeholder={t('dashboard.field_title_placeholder', '如：赛博修仙录·序章')}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2.5 text-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 focus:outline-none text-sm transition-all"
                  value={newProject.title}
                  onChange={(e) => setNewProject({ ...newProject, title: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-1.5">{t('dashboard.field_desc')}</label>
                <textarea
                  placeholder={t('dashboard.field_desc_placeholder', '简要记录世界观、核心主题或主要人物…')}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2.5 text-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 focus:outline-none h-28 resize-none text-sm transition-all"
                  value={newProject.description}
                  onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
                />
              </div>
              <div className="flex justify-end gap-3 mt-6 pt-2 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white text-sm font-medium rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  {t('dashboard.cancel')}
                </button>
                <button
                  type="submit"
                  className="px-6 py-2.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-xl font-medium text-sm shadow-md shadow-indigo-500/20 transition-all"
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
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-[#0f172a] border border-slate-200 dark:border-slate-800 p-6 sm:p-8 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl animate-in zoom-in-95 duration-200 custom-scrollbar">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">{t('dashboard.import_modal_title')}</h2>
              <button
                type="button"
                onClick={closeImportDialog}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mb-6">
              {t('dashboard.import_preview_hint', '先解析文档结构并检查预览，确认后才会创建新项目。')}
            </p>
            <form onSubmit={handleImportProject} className="space-y-5">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-2">{t('dashboard.field_path')}</label>
                <div className="relative">
                    <input
                      type="file"
                      accept=".txt,text/plain,.md,.markdown,text/markdown,.json,application/json,.novastory.json"
                      required
                      disabled={previewingImport || importingProject}
                      className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2.5 text-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500/50 focus:outline-none file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-indigo-50 dark:file:bg-indigo-950/60 file:text-indigo-700 dark:file:text-indigo-300 hover:file:bg-indigo-100 text-xs sm:text-sm disabled:opacity-60 transition-all"
                      onChange={(e) => {
                          if (e.target.files && e.target.files.length > 0) {
                              setImportFile(e.target.files[0]);
                              setImportPreview(null);
                          }
                      }}
                    />
                </div>
              </div>

              {importPreview && (
                <div className="space-y-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/70 p-4 sm:p-5">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <h3 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100">{importPreview.project.title}</h3>
                      <span className="rounded-full bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/30 px-2 py-0.5 text-xs text-indigo-700 dark:text-indigo-300 font-semibold">
                        {importPreview.source.format.toUpperCase()}
                      </span>
                      <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-xs text-slate-600 dark:text-slate-400 font-medium">
                        {importPreview.mode === 'novastory-project'
                          ? t('dashboard.import_full_project', '完整项目备份')
                          : t('dashboard.import_novel_manuscript', '小说文稿')}
                      </span>
                    </div>
                    {importPreview.project.description && (
                      <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 line-clamp-3 leading-relaxed">{importPreview.project.description}</p>
                    )}
                  </div>

                  {(importGenre || importStoryTags.length > 0) && (
                    <div className="flex flex-wrap gap-2">
                      {importGenre && (
                        <span className="rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-2.5 py-1 text-xs text-slate-700 dark:text-slate-300 font-medium">
                          {t('project_settings.genre', '题材')}: {importGenre}
                        </span>
                      )}
                      {importStoryTags.map((tag) => (
                        <span key={tag} className="rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-2.5 py-1 text-xs text-slate-600 dark:text-slate-400">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    {[
                      [t('dashboard.import_chapters', '章节'), importPreview.counts.chapters],
                      [t('dashboard.import_summaries', '章节概要'), importPreview.counts.chapter_summaries],
                      [t('dashboard.import_contents', '正文'), importPreview.counts.chapter_contents],
                      [t('dashboard.import_characters', '人物'), importPreview.counts.characters],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-3.5 py-2.5">
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
                        <div className="text-lg font-bold text-slate-900 dark:text-slate-100 mt-0.5">{value}</div>
                      </div>
                    ))}
                  </div>

                  {importPreview.mode === 'novastory-project' && (
                    <div className="grid grid-cols-3 gap-2">
                      <div className="text-xs text-slate-500 dark:text-slate-400">Scenes <span className="font-semibold text-slate-800 dark:text-slate-200">{importPreview.counts.scenes}</span></div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">Coverage <span className="font-semibold text-slate-800 dark:text-slate-200">{importPreview.counts.coverage_groups}</span></div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">Shots <span className="font-semibold text-slate-800 dark:text-slate-200">{importPreview.counts.coverage_shots}</span></div>
                    </div>
                  )}

                  {importPreview.chapters.length > 0 && (
                    <div>
                      <div className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                        {t('dashboard.import_chapter_preview', '章节预览')}
                      </div>
                      <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
                        {importPreview.chapters.slice(0, 12).map((chapter) => (
                          <div key={`${chapter.index}-${chapter.title}`} className="flex items-center justify-between gap-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800/80 px-3 py-2 text-xs sm:text-sm">
                            <span className="truncate text-slate-800 dark:text-slate-200 font-medium">{chapter.index}. {chapter.title}</span>
                            <div className="flex shrink-0 gap-1.5 text-[11px]">
                              {chapter.summary && (
                                <span className="rounded-md bg-emerald-50 dark:bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-300 font-medium">
                                  {t('dashboard.import_has_summary', '概要')}
                                </span>
                              )}
                              <span className={`rounded-md px-2 py-0.5 font-medium ${chapter.has_content ? 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300' : 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300'}`}>
                                {chapter.has_content
                                  ? t('dashboard.import_has_content', '正文')
                                  : t('dashboard.import_missing_content', '缺正文')}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                      {importPreview.chapters.length > 12 && (
                        <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                          {t('dashboard.import_more_chapters', '另有 {count} 个章节', {
                            count: importPreview.chapters.length - 12,
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {importPreview.warnings.length > 0 && (
                    <div className="rounded-xl border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
                      <div className="text-xs font-bold text-amber-800 dark:text-amber-300 mb-1">
                        {t('dashboard.import_warnings', '解析警告')}
                      </div>
                      {importPreview.warnings.map((warning, index) => (
                        <div key={`${warning}-${index}`} className="text-xs text-amber-700 dark:text-amber-200/80">• {warning}</div>
                      ))}
                    </div>
                  )}

                  {importPreview.unmapped_sections.length > 0 && (
                    <div className="text-xs text-slate-500">
                      {t('dashboard.import_unmapped', '有 {count} 个未映射小节将作为导入元信息保留。', {
                        count: importPreview.unmapped_sections.length,
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={closeImportDialog}
                  disabled={previewingImport || importingProject}
                  className="px-4 py-2.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white text-sm font-medium rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors"
                >
                  {t('dashboard.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={!importFile || previewingImport || importingProject}
                  className="min-w-32 px-6 py-2.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-medium text-sm flex items-center justify-center gap-2 shadow-md shadow-indigo-500/20 transition-all"
                >
                  {(previewingImport || importingProject) && <LoaderCircle size={16} className="animate-spin" />}
                  {previewingImport
                    ? t('dashboard.import_previewing', '正在解析…')
                    : importingProject
                      ? t('dashboard.import_importing', '正在导入…')
                      : importPreview
                        ? t('dashboard.import_confirm', '确认导入')
                        : t('dashboard.import_preview', '解析预览')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
