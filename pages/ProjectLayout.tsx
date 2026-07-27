import React from 'react';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { BookOpen, Users, Clapperboard, Settings } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

export const ProjectLayout: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { t } = useLanguage();

  return (
    <div className="flex flex-col h-full">
      {/* Project Top Bar Navigation */}
      <div className="h-14 bg-slate-900 border-b border-slate-800 flex items-center px-4 sm:px-6 gap-4 sm:gap-8 flex-shrink-0 overflow-x-auto custom-scrollbar">
        <TabLink to={`/project/${id}/story`} icon={<BookOpen size={16} />} label={t('project_nav.story')} />
        <TabLink to={`/project/${id}/characters`} icon={<Users size={16} />} label={t('project_nav.characters')} />
        <TabLink to={`/project/${id}/director`} icon={<Clapperboard size={16} />} label={t('project_nav.director')} />
        
        <div className="flex-1 min-w-[1rem]" />
        
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

      {/* Project Content Area */}
      <div className="flex-1 overflow-hidden relative">
        <Outlet />
      </div>
    </div>
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