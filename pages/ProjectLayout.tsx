import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { BookOpen, Users, Clapperboard, Settings, Sparkles } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api } from '../services/api';
import {
  ProjectAgentProvider,
  useProjectAgent,
} from '../contexts/ProjectAgentContext';
import { ProjectAgentPanel } from '../components/agent/ProjectAgentPanel';
import { ProjectDocumentsPanel } from '../components/ProjectDocumentsPanel';

export const ProjectLayout: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const [projectTitle, setProjectTitle] = useState<string>('');

  useEffect(() => {
    if (id) {
      api.getProject(Number(id))
        .then(project => {
          setProjectTitle(project.title);
        })
        .catch(console.error);
    }
  }, [id]);

  if (!id) {
    return null;
  }

  return (
    <ProjectAgentProvider projectId={id}>
      <div className="flex flex-col h-full">
        {/* Project Top Bar Navigation */}
        <div className="h-14 bg-slate-900 border-b border-slate-800 flex items-center px-4 sm:px-6 gap-2 sm:gap-6 flex-shrink-0 overflow-x-auto custom-scrollbar">
          
          {projectTitle && (
              <div className="hidden sm:flex items-center gap-2 mr-2 border-r border-slate-800 pr-6">
                  <span className="font-semibold text-slate-200 truncate max-w-[200px]" title={projectTitle}>
                      {projectTitle}
                  </span>
              </div>
          )}

          <TabLink to={`/project/${id}/story`} icon={<BookOpen size={16} />} label={t('project_nav.story')} />
          <TabLink to={`/project/${id}/characters`} icon={<Users size={16} />} label={t('project_nav.characters')} />
          <TabLink to={`/project/${id}/director`} icon={<Clapperboard size={16} />} label={t('project_nav.director')} />
          
          <div className="flex-1 min-w-[1rem]" />

          <ProjectAgentNavButton />
          
          <NavLink
            to={`/project/${id}/settings`}
            className={({ isActive }) =>
              `flex items-center gap-2 text-sm font-medium transition-colors p-2 rounded-lg flex-shrink-0 ${
                isActive
                  ? 'bg-slate-800 text-indigo-400'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`
            }
            title={t('project_nav.settings')}
          >
             <Settings size={16} />
          </NavLink>
        </div>

        {/* Project Content Area — min-h-0 so nested pages can own vertical scroll */}
        <div className="flex-1 min-h-0 overflow-hidden relative">
          <Outlet />
        </div>

        {/* Global Agent OS floating panel */}
        <ProjectAgentPanel projectId={id} />

        {/* Project-scoped supplemental documents; intentionally separate from chapters/Story Bible. */}
        <ProjectDocumentsPanel projectId={id} />
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
      className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors flex-shrink-0 border ${
        open
          ? 'bg-indigo-600 text-white border-indigo-500'
          : 'bg-indigo-950/50 text-indigo-300 border-indigo-800/50 hover:bg-indigo-900/60 hover:text-indigo-200'
      }`}
      title={t('agent.open_panel', '打开 Agent OS')}
    >
      <Sparkles size={15} />
      <span className="hidden sm:inline">{t('agent.fab_label', 'Agent OS')}</span>
    </button>
  );
};

const TabLink: React.FC<{ to: string; icon: React.ReactNode; label: string }> = ({ to, icon, label }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      `flex items-center gap-2 text-sm font-medium transition-colors border-b-2 py-4 flex-shrink-0 whitespace-nowrap ${
        isActive
          ? 'border-indigo-500 text-indigo-400'
          : 'border-transparent text-slate-400 hover:text-slate-200'
      }`
    }
  >
    {icon}
    <span>{label}</span>
  </NavLink>
);
