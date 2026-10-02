import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../services/api';
import { readLastProjectId, resolveCharactersEntry } from '../services/characters_entry';
import { useLanguage } from '../LanguageContext';

type EntryState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'empty' }
  | { kind: 'redirect'; projectId: number }
  | { kind: 'pick'; projects: Array<{ id: number; title: string }> };

export const CharactersEntry: React.FC = () => {
  const { t } = useLanguage();
  const [state, setState] = useState<EntryState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const projects = await api.getProjects();
        if (cancelled) return;
        const list = Array.isArray(projects) ? projects : [];
        const decision = resolveCharactersEntry(list, readLastProjectId());
        if (decision.type === 'redirect') {
          setState({ kind: 'redirect', projectId: decision.projectId });
          return;
        }
        if (decision.type === 'empty') {
          setState({ kind: 'empty' });
          return;
        }
        setState({
          kind: 'pick',
          projects: list.map((project) => ({
            id: Number(project.id),
            title: typeof project.title === 'string' && project.title.trim()
              ? project.title.trim()
              : `#${project.id}`,
          })),
        });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'redirect') {
    return <Navigate to={`/project/${state.projectId}/characters`} replace />;
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-10">
      {state.kind === 'loading' && (
        <div
          data-testid="characters-entry-loading"
          className="flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300"
        >
          <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          {t('characters_entry.loading', '正在读取项目…')}
        </div>
      )}
      {state.kind === 'error' && (
        <div data-testid="characters-entry-error" className="space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-200">
            {t('characters_entry.load_failed', '项目列表加载失败')}
          </p>
          <Link to="/" className="text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline">
            {t('characters_entry.back_home', '返回项目大厅')}
          </Link>
        </div>
      )}
      {state.kind === 'empty' && (
        <div data-testid="characters-entry-empty" className="space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-200">
            {t('characters_entry.empty', '还没有项目。先创建一个，再为角色设定音色。')}
          </p>
          <Link to="/" className="text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline">
            {t('characters_entry.back_home', '返回项目大厅')}
          </Link>
        </div>
      )}
      {state.kind === 'pick' && (
        <div data-testid="characters-entry-picker" className="space-y-4">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t('characters_entry.pick_title', '选择要打开的项目')}
          </h1>
          <ul className="space-y-2">
            {state.projects.map((project) => (
              <li key={project.id}>
                <Link
                  to={`/project/${project.id}/characters`}
                  data-testid={`characters-entry-project-${project.id}`}
                  className="block rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 text-sm font-medium text-slate-800 dark:text-slate-100 hover:border-indigo-300 dark:hover:border-indigo-700"
                >
                  {project.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
