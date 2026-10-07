import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CHARACTER_ROLES } from '../../constants';
import { useLanguage } from '../../LanguageContext';

export type StoryCharacterDraft = {
  id: number;
  name: string;
  role: string;
  description: string;
  personality: string;
  growth_path: string;
  aliases: string[];
};

type Suggestion = {
  plotDirection?: string;
  plotResidue?: string;
  initialRelations?: string;
  relationsResidue?: string;
  plannedRelations?: string;
  characters?: Array<{
    id: number;
    role: string;
    description: string;
    personality: string;
    growthPath: string;
    impactLike?: boolean;
  }>;
};

type CanonChapter = {
  chapterId: string;
  index: number;
  title: string;
  valid: boolean;
  states: string[];
  events: string[];
  foreshadowing: string[];
  relations: string[];
};

type CurrentState = {
  characterId: number;
  line: string;
  chapterTitle: string;
  staleName: boolean;
};

type CurrentRelation = {
  aId: number;
  bId: number;
  line: string;
  chapterTitle: string;
  history: Array<{ line: string; chapterTitle: string }>;
};

export type StoryBibleView = {
  suggestions?: Suggestion | null;
  currentStates?: CurrentState[];
  currentRelations?: CurrentRelation[];
  unresolved?: string[];
  canon?: CanonChapter[];
};

const MAIN_ROLES = new Set(['protagonist', 'antagonist', 'supporting']);
const ROLE_ORDER = ['protagonist', 'antagonist', 'supporting'];

const fieldClass =
  'w-full bg-slate-50/80 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500';

export function StoryBiblePanel({
  projectId,
  characters,
  onCharacters,
  plotDirection,
  onPlotDirection,
  initialRelations,
  onInitialRelations,
  plannedRelations,
  onPlannedRelations,
  view,
}: {
  projectId: string;
  characters: StoryCharacterDraft[];
  onCharacters: (next: StoryCharacterDraft[]) => void;
  plotDirection: string;
  onPlotDirection: (value: string) => void;
  initialRelations: string;
  onInitialRelations: (value: string) => void;
  plannedRelations: string;
  onPlannedRelations: (value: string) => void;
  view: StoryBibleView | null;
}) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [openHistory, setOpenHistory] = useState<Record<string, boolean>>({});
  const [openCanon, setOpenCanon] = useState<Record<string, boolean>>({});
  const suggestions = view?.suggestions;
  const mains = characters
    .filter((row) => MAIN_ROLES.has(row.role))
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.id - b.id);
  const extras = characters.filter((row) => !MAIN_ROLES.has(row.role)).length;
  const states = new Map((view?.currentStates || []).map((row) => [row.characterId, row]));
  const names = new Map(characters.map((row) => [row.id, row.name]));
  const update = (id: number, patch: Partial<StoryCharacterDraft>) => {
    onCharacters(characters.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };
  const suggestionFor = (id: number) => suggestions?.characters?.find((row) => row.id === id);
  const canon = [...(view?.canon || [])].sort((a, b) => a.index - b.index);
  const latestCanon = [...canon].reverse().find((chapter) => chapter.valid)?.chapterId;

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {mains.length === 0 && (
          <p className="text-sm text-slate-500" data-testid="story-bible-empty-cast">{t('project_settings.no_main_characters')}</p>
        )}
        {mains.map((row) => {
          const suggestion = suggestionFor(row.id);
          const state = states.get(row.id);
          const alias = row.aliases[0];
          return (
            <article key={row.id} data-testid={`story-character-${row.id}`} className="rounded-2xl border border-slate-200 dark:border-slate-800 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <input
                    data-testid={`story-character-name-${row.id}`}
                    className={`${fieldClass} font-semibold`}
                    value={row.name}
                    onChange={(event) => update(row.id, { name: event.target.value })}
                  />
                  {alias ? <p className="mt-1 text-xs text-slate-500">{row.name} ({alias})</p> : null}
                </div>
                <button type="button" className="text-xs text-indigo-600" onClick={() => navigate(`/project/${projectId}/characters`)}>
                  {t('project_settings.edit_look')}
                </button>
              </div>
              <label className="block text-xs text-slate-500">
                {t('characters.role', '角色定位')}
                <select
                  data-testid={`story-character-role-${row.id}`}
                  className={`${fieldClass} mt-1`}
                  value={row.role}
                  onChange={(event) => update(row.id, { role: event.target.value })}
                >
                  {!MAIN_ROLES.has(row.role) && <option value={row.role}>{row.role}</option>}
                  {CHARACTER_ROLES.filter((role) => role.value !== 'extra').map((role) => (
                    <option key={role.value} value={role.value}>{role.label}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-slate-500">
                {t('project_settings.personality')}
                <textarea data-testid={`story-character-personality-${row.id}`} className={`${fieldClass} mt-1 h-20`} value={row.personality} onChange={(event) => update(row.id, { personality: event.target.value })} />
              </label>
              <label className="block text-xs text-slate-500">
                {t('project_settings.appearance_setting')}
                <textarea data-testid={`story-character-appearance-${row.id}`} className={`${fieldClass} mt-1 h-20`} value={row.description} onChange={(event) => update(row.id, { description: event.target.value })} />
              </label>
              <label className="block text-xs text-slate-500">
                {t('project_settings.growth_path')}
                <textarea data-testid={`story-character-growth-${row.id}`} className={`${fieldClass} mt-1 h-20`} value={row.growth_path} onChange={(event) => update(row.id, { growth_path: event.target.value })} />
              </label>
              <p data-testid={`story-character-state-${row.id}`} className="text-sm text-slate-600 dark:text-slate-300">
                <span className="font-semibold">{t('project_settings.current_state')}：</span>
                {state?.line || t('project_settings.no_current_state')}
                {state?.staleName ? <span className="ml-2 text-xs text-amber-700">{t('project_settings.old_name')}</span> : null}
              </p>
              {suggestion && !hidden[`character-${row.id}`] && (
                <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3 text-xs space-y-2" data-testid={`story-review-character-${row.id}`}>
                  <p className="font-semibold">{t('project_settings.review_title')}</p>
                  {suggestion.impactLike ? <p>{t('project_settings.review_impact_like')}</p> : null}
                  <p>{suggestion.role} / {suggestion.personality} / {suggestion.description} / {suggestion.growthPath}</p>
                  <div className="flex gap-2">
                    <button type="button" className="rounded-lg bg-indigo-600 text-white px-2 py-1" onClick={() => {
                      update(row.id, {
                        role: suggestion.role,
                        description: suggestion.description,
                        personality: suggestion.personality,
                        growth_path: suggestion.growthPath,
                      });
                      setHidden((prev) => ({ ...prev, [`character-${row.id}`]: true }));
                    }}>{t('project_settings.use_blueprint')}</button>
                    <button type="button" className="rounded-lg border px-2 py-1" onClick={() => setHidden((prev) => ({ ...prev, [`character-${row.id}`]: true }))}>{t('project_settings.keep_current')}</button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
        {extras > 0 && <p className="text-xs text-slate-500">{t('project_settings.extra_count')} · {extras}</p>}
        <button
          type="button"
          data-testid="story-character-add"
          className="text-xs font-semibold text-indigo-600"
          onClick={() => navigate(`/project/${projectId}/characters`)}
        >
          {t('project_settings.add_character')}
        </button>
      </div>

      <label className="block text-xs text-slate-500">
        {t('project_settings.plot_direction')}
        <p className="mt-1 mb-1 text-slate-400">{t('project_settings.plot_direction_hint')}</p>
        <textarea data-testid="project-settings-plot" className={`${fieldClass} h-28`} value={plotDirection} onChange={(event) => onPlotDirection(event.target.value)} />
      </label>
      {suggestions?.plotResidue && !hidden.plotResidue && (
        <div className="rounded-xl bg-amber-50 p-3 text-xs space-y-2" data-testid="story-review-plot">
          <p className="font-semibold">{t('project_settings.review_title')}</p>
          <p className="whitespace-pre-wrap">{suggestions.plotResidue}</p>
          <button type="button" className="rounded-lg bg-indigo-600 text-white px-2 py-1" onClick={() => { onPlotDirection(suggestions.plotResidue || ''); setHidden((prev) => ({ ...prev, plotResidue: true })); }}>{t('project_settings.use_residue')}</button>
          <button type="button" className="ml-2 rounded-lg border px-2 py-1" onClick={() => setHidden((prev) => ({ ...prev, plotResidue: true }))}>{t('project_settings.discard_residue')}</button>
        </div>
      )}
      {!plotDirection && suggestions?.plotDirection && !hidden.plotDirection && (
        <div className="rounded-xl bg-amber-50 p-3 text-xs space-y-2" data-testid="story-review-direction">
          <p className="font-semibold">{t('project_settings.review_title')}</p>
          <p>{suggestions.plotDirection}</p>
          <button type="button" className="rounded-lg bg-indigo-600 text-white px-2 py-1" onClick={() => { onPlotDirection(suggestions.plotDirection || ''); setHidden((prev) => ({ ...prev, plotDirection: true })); }}>{t('project_settings.use_blueprint')}</button>
          <button type="button" className="ml-2 rounded-lg border px-2 py-1" onClick={() => setHidden((prev) => ({ ...prev, plotDirection: true }))}>{t('project_settings.keep_current')}</button>
        </div>
      )}

      <label className="block text-xs text-slate-500">
        {t('project_settings.initial_relations')}
        <textarea data-testid="project-settings-initial-relations" className={`${fieldClass} mt-1 h-24`} value={initialRelations} onChange={(event) => onInitialRelations(event.target.value)} />
      </label>
      {!initialRelations && suggestions?.initialRelations && !hidden.initial && (
        <div className="rounded-xl bg-amber-50 p-3 text-xs space-y-2">
          <p>{suggestions.initialRelations}</p>
          <button type="button" className="rounded-lg bg-indigo-600 text-white px-2 py-1" onClick={() => { onInitialRelations(suggestions.initialRelations || ''); setHidden((prev) => ({ ...prev, initial: true })); }}>{t('project_settings.use_blueprint')}</button>
        </div>
      )}
      <div data-testid="story-current-relations" className="space-y-2">
        <p className="text-xs font-semibold text-slate-500">{t('project_settings.current_relations')}</p>
        {(view?.currentRelations || []).map((row) => {
          const key = `${row.aId}:${row.bId}`;
          return (
            <div key={key} data-testid={`story-relation-${row.aId}-${row.bId}`} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 text-sm">
              <button type="button" className="text-left" onClick={() => setOpenHistory((prev) => ({ ...prev, [key]: !prev[key] }))}>
                {names.get(row.aId) || row.aId} · {names.get(row.bId) || row.bId}：{row.line}
                <span className="ml-2 text-xs text-slate-500">{row.chapterTitle}</span>
              </button>
              {openHistory[key] && (
                <ul className="mt-2 space-y-1 text-xs text-slate-500">
                  {row.history.map((item, index) => <li key={`${item.chapterTitle}-${index}`}>{item.chapterTitle}：{item.line}</li>)}
                </ul>
              )}
            </div>
          );
        })}
        {(view?.unresolved || []).length > 0 && (
          <div data-testid="story-unassigned">
            <p className="text-xs font-semibold">{t('project_settings.unassigned')}</p>
            {view?.unresolved?.map((line) => <p key={line} className="text-xs text-slate-500">{line}</p>)}
          </div>
        )}
      </div>
      <label className="block text-xs text-slate-500">
        {t('project_settings.planned_relations')}
        <p className="mt-1 mb-1 text-slate-400">{t('project_settings.planned_relations_hint')}</p>
        <textarea data-testid="project-settings-planned-relations" className={`${fieldClass} h-24`} value={plannedRelations} onChange={(event) => onPlannedRelations(event.target.value)} />
      </label>

      <section data-testid="story-canon">
        <h3 className="text-sm font-bold">{t('project_settings.canon_title')}</h3>
        <p className="text-xs text-slate-500 mb-2">{t('project_settings.canon_hint')}</p>
        {canon.map((chapter) => {
          const open = openCanon[chapter.chapterId] ?? chapter.chapterId === latestCanon;
          return (
            <article key={chapter.chapterId} data-testid={`story-canon-${chapter.chapterId}`} className="mb-2 rounded-xl border border-slate-200 dark:border-slate-800">
              <button type="button" className="w-full text-left px-3 py-2 text-sm font-semibold" onClick={() => setOpenCanon((prev) => ({ ...prev, [chapter.chapterId]: !open }))}>
                第{chapter.index + 1}章 · {chapter.title}
                {!chapter.valid && <span className="ml-2 text-xs text-amber-700">{t('project_settings.canon_invalid')}</span>}
              </button>
              {open && (
                <div className="px-3 pb-3 text-xs space-y-2 text-slate-600 dark:text-slate-300">
                  <List title="角色状态" lines={chapter.states} />
                  <List title="事件" lines={chapter.events} />
                  <List title="伏笔" lines={chapter.foreshadowing} />
                  <List title="这一章的关系变化" lines={chapter.relations} />
                </div>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}

function List({ title, lines }: { title: string; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <div>
      <p className="font-semibold">{title}</p>
      <ul className="list-disc pl-4">{lines.map((line) => <li key={line}>{line}</li>)}</ul>
    </div>
  );
}
