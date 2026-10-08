import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { BookOpen, Film, Users, Clapperboard, Settings, Sparkles, Sun, Moon, Loader2 } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useTheme } from '../ThemeContext';
import { useToast } from '../ToastContext';
import { api } from '../services/api';
import { resumePersistedProjectWork, useProjectWorkJobs, type ProjectWorkJob } from '../services/project_work_tracker';
import { rememberLastProjectId } from '../services/characters_entry';
import {
  ProjectAgentProvider,
  useProjectAgent,
} from '../contexts/ProjectAgentContext';
import { ProjectAgentPanel } from '../components/agent/ProjectAgentPanel';

export const ProjectLayout: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const { theme, toggleTheme } = useTheme();
  const [projectTitle, setProjectTitle] = useState<string>('');

  useEffect(() => {
    const onNotice = (event: Event) => {
      const detail = (event as CustomEvent<{
        messageKey?: string;
        tone?: 'success' | 'error' | 'info';
        params?: Record<string, string | number>;
      }>).detail;
      if (!detail?.messageKey) return;
      showToast(t(detail.messageKey, detail.params), detail.tone || 'info');
    };
    window.addEventListener('novastory-project-work-notice', onNotice);
    resumePersistedProjectWork();
    return () => window.removeEventListener('novastory-project-work-notice', onNotice);
  }, [showToast, t]);

  useEffect(() => {
    if (id) {
      const projectId = Number(id);
      if (Number.isInteger(projectId) && projectId > 0) {
        rememberLastProjectId(projectId);
      }
      api.getProject(projectId)
        .then(project => {
          setProjectTitle(project.title);
        })
        .catch(console.error);
    }
  }, [id]);

  if (!id) {
    return null;
  }

  const isDark = theme === 'dark';

  return (
    <ProjectAgentProvider projectId={id}>
      <div className="flex flex-col h-full bg-slate-50 dark:bg-[#090d16] text-slate-900 dark:text-slate-100 transition-colors duration-200">
        {/* Project Top Bar Navigation */}
        <div className="h-14 bg-white/90 dark:bg-[#0c1322]/90 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800/80 flex items-center px-4 sm:px-6 gap-2 sm:gap-6 flex-shrink-0 overflow-x-auto custom-scrollbar shadow-xs">
          
          {projectTitle && (
              <div className="hidden sm:flex items-center gap-2 mr-2 border-r border-slate-200 dark:border-slate-800 pr-5">
                  <div className="w-6 h-6 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-xs">
                    <BookOpen size={13} />
                  </div>
                  <span className="font-semibold text-sm text-slate-800 dark:text-slate-200 truncate max-w-[180px]" title={projectTitle}>
                      {projectTitle}
                  </span>
              </div>
          )}

          <div className="flex items-center gap-1 sm:gap-2">
            <TabLink to={`/project/${id}/story`} icon={<BookOpen size={16} />} label={t('project_nav.story')} />
            <TabLink to={`/project/${id}/script`} icon={<Film size={16} />} label={t('project_nav.script')} />
            <TabLink to={`/project/${id}/assets`} icon={<Users size={16} />} label="资产管理" />
            <TabLink to={`/project/${id}/director`} icon={<Clapperboard size={16} />} label={t('project_nav.director')} />
          </div>
          
          <div className="flex-1 min-w-[1rem]" />

          <div className="flex items-center gap-2">
            {/* Quick theme toggle */}
            <button
              type="button"
              onClick={toggleTheme}
              className="p-2 rounded-xl text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
              title={isDark ? t('theme.light_mode', '切换至白天模式') : t('theme.dark_mode', '切换至黑夜模式')}
            >
              {isDark ? <Sun size={16} className="text-amber-400" /> : <Moon size={16} className="text-indigo-600" />}
            </button>

            <ProjectAgentNavButton />
            
            <NavLink
              to={`/project/${id}/settings`}
              className={({ isActive }) =>
                `flex items-center gap-2 text-sm font-medium transition-colors p-2 rounded-xl flex-shrink-0 ${
                  isActive
                    ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 ring-1 ring-indigo-500/20'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`
              }
              title={t('project_nav.settings')}
            >
               <Settings size={17} />
            </NavLink>
          </div>
        </div>

        <ProjectWorkBanner projectId={id} />

        {/* Project Content Area */}
        <div className="flex-1 min-h-0 overflow-hidden relative flex flex-col h-full w-full">
          <Outlet />
        </div>

        {/* Global Agent OS floating panel */}
        <ProjectAgentPanel projectId={id} />
      </div>
    </ProjectAgentProvider>
  );
};

/** Top-bar Agent OS entry (visible on story / director / characters / settings). */
const ProjectAgentNavButton: React.FC = () => {
  const { t } = useLanguage();
  const { open, setOpen, toggle } = useProjectAgent();

  return (
    <button
      type="button"
      onClick={() => (open ? setOpen(false) : toggle())}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs sm:text-sm font-medium transition-all flex-shrink-0 border shadow-xs ${
        open
          ? 'bg-indigo-600 text-white border-indigo-500 shadow-md shadow-indigo-500/20'
          : 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 hover:text-indigo-900 dark:hover:text-indigo-200'
      }`}
      title={t('agent.open_panel', '打开 Agent OS')}
    >
      <Sparkles size={14} />
      <span className="hidden sm:inline">{t('agent.fab_label', 'Agent OS')}</span>
    </button>
  );
};

const ProjectWorkBanner: React.FC<{ projectId: string }> = ({ projectId }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { setActiveChapterId } = useProjectAgent();
  const jobs = useProjectWorkJobs(projectId);
  if (jobs.length === 0) return null;

  const bannerText = (job: ProjectWorkJob) => {
    const chapter = job.chapterTitle || t('project_nav.director');
    const detail = job.detail ? ` · ${job.detail}` : '';
    const params = { chapter, detail };
    switch (job.kind) {
      case 'script_outline':
        return t('script_editor.outline_running_banner', params);
      case 'script_full':
        return t('script_editor.script_running_banner', params);
      case 'script_scene':
        return t('script_editor.scene_running_banner', params);
      case 'narration':
        return t('director.narration_running_banner', params);
      case 'video':
        return t('director.video_running_banner', params);
      case 'video_batch':
        return t('director.video_batch_running_banner', params);
      default:
        return t('director.storyboard_running_banner', params);
    }
  };

  const openJob = (job: ProjectWorkJob) => {
    setActiveChapterId(job.chapterId);
    const scriptJob = job.kind === 'script_outline' || job.kind === 'script_full' || job.kind === 'script_scene';
    window.dispatchEvent(
      new CustomEvent(scriptJob ? 'novastory-script-open-chapter' : 'novastory-director-open-chapter', {
        detail: { projectId, chapterId: job.chapterId },
      })
    );
    navigate(scriptJob ? `/project/${projectId}/script` : `/project/${projectId}/director`);
  };

  return (
    <div
      data-testid="project-work-banner"
      className="flex flex-wrap items-center gap-2 border-b border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/40 px-4 sm:px-6 py-2"
    >
      {jobs.map((job) => (
        <button
          key={job.id}
          type="button"
          data-testid={`project-work-banner-${job.id}`}
          onClick={() => openJob(job)}
          className="inline-flex items-center gap-2 rounded-full border border-amber-300 dark:border-amber-800 bg-white/80 dark:bg-slate-900/70 px-3 py-1 text-xs font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/50"
        >
          <Loader2 size={13} className="animate-spin" />
          <span>{bannerText(job)}</span>
          <span className="text-amber-600 dark:text-amber-300">{t('director.storyboard_running_open')}</span>
        </button>
      ))}
    </div>
  );
};

const TabLink: React.FC<{ to: string; icon: React.ReactNode; label: string }> = ({ to, icon, label }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      `flex items-center gap-2 text-xs sm:text-sm font-medium transition-all px-3 py-1.5 rounded-xl flex-shrink-0 whitespace-nowrap ${
        isActive
          ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 shadow-xs ring-1 ring-indigo-500/20 font-semibold'
          : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/80'
      }`
    }
  >
    {icon}
    <span>{label}</span>
  </NavLink>
);
