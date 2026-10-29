import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  GitPullRequest,
  Sparkles,
  Layers,
  ChevronUp,
  ArrowRight,
  SlidersHorizontal
} from 'lucide-react';
import { ContinuityPanel } from './ContinuityPanel';
import { SceneProductionPanel } from './SceneProductionPanel';
import { DirectorStoryboardCandidates, isReviewableStoryboardChange, type DirectorScreenplay } from './DirectorStoryboardCandidates';
import { useLanguage } from '../../LanguageContext';

export interface DirectorWorkbenchDeckProps {
  script: any | null;
  projectId: string | number;
  screenplay: DirectorScreenplay | null;
  sceneIds: number[] | null;
  timelineReady: boolean;
  onTimelineRefresh: () => void;
  onScreenplayRefresh: () => void;
}

type WorkbenchTab = 'candidates' | 'continuity' | 'production';

export const DirectorWorkbenchDeck: React.FC<DirectorWorkbenchDeckProps> = ({
  script,
  projectId,
  screenplay,
  sceneIds,
  timelineReady,
  onTimelineRefresh,
  onScreenplayRefresh,
}) => {
  const { t } = useLanguage();
  const candidates = (screenplay?.pendingChanges || []).filter(isReviewableStoryboardChange);
  const candidateCount = candidates.length;
  const [openTaskCount, setOpenTaskCount] = useState(0);
  const [activeTab, setActiveTab] = useState<WorkbenchTab | null>(() => (candidateCount > 0 ? 'candidates' : null));
  const candidateCountRef = useRef(candidateCount);
  const openTaskCountRef = useRef(0);
  const badgeCount = candidateCount > 0 ? candidateCount : openTaskCount;

  const revealCandidates = useCallback(() => {
    setActiveTab((tab) => (tab === 'continuity' || tab === 'production' ? tab : 'candidates'));
  }, []);

  useEffect(() => {
    const previous = candidateCountRef.current;
    candidateCountRef.current = candidateCount;
    if (candidateCount > previous) revealCandidates();
  }, [candidateCount, revealCandidates]);

  useEffect(() => {
    const previous = openTaskCountRef.current;
    openTaskCountRef.current = openTaskCount;
    if (openTaskCount > previous) revealCandidates();
  }, [openTaskCount, revealCandidates]);

  const onAttentionChange = useCallback((count: number) => {
    setOpenTaskCount(count);
  }, []);

  const shell = (tab: WorkbenchTab) => (activeTab === tab ? '' : 'hidden');

  return (
    <div className="w-full flex flex-col flex-shrink-0 min-w-0 border-b border-slate-200/90 dark:border-slate-800/90 bg-white/95 dark:bg-[#0f172a]/95 backdrop-blur-md z-10">
      <div className="px-4 py-2 flex items-center justify-between flex-wrap gap-2 text-xs">
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200">
            <SlidersHorizontal size={14} className="text-amber-500" />
            <span className="tracking-wide">{t('director.workbench_title')}</span>
          </div>

          <div className="flex items-center bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-xl border border-slate-200/70 dark:border-slate-700/60 gap-1">
            <button
              type="button"
              data-testid="storyboard-candidate-toggle"
              onClick={() => setActiveTab(activeTab === 'candidates' ? null : 'candidates')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'candidates'
                  ? 'bg-amber-500 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-white/60 dark:hover:bg-slate-700/60'
              }`}
            >
              <GitPullRequest size={12} />
              <span>{t('director.storyboard_panel_title')}</span>
              {badgeCount > 0 ? (
                <span data-testid="workbench-candidate-count" className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-white text-amber-700 shadow-2xs">
                  {badgeCount}
                </span>
              ) : (
                <span data-testid="workbench-candidate-count" className="text-[10px] opacity-60 font-mono">(0)</span>
              )}
            </button>

            <button
              type="button"
              data-testid="continuity-toggle"
              onClick={() => setActiveTab(activeTab === 'continuity' ? null : 'continuity')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'continuity'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-white/60 dark:hover:bg-slate-700/60'
              }`}
            >
              <Sparkles size={12} />
              <span>{t('continuity.title')}</span>
            </button>

            <button
              type="button"
              data-testid="production-toggle"
              onClick={() => setActiveTab(activeTab === 'production' ? null : 'production')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'production'
                  ? 'bg-purple-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-white/60 dark:hover:bg-slate-700/60'
              }`}
            >
              <Layers size={12} />
              <span>{t('production.title')}</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {activeTab && (
            <button
              type="button"
              onClick={() => setActiveTab(null)}
              className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 flex items-center gap-1 px-2 py-0.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <ChevronUp size={13} />
              <span>{t('director.workbench_collapse')}</span>
            </button>
          )}
          <Link
            to={`/project/${projectId}/script`}
            className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 font-medium"
          >
            <span>{t('director.workbench_open_script')}</span>
            <ArrowRight size={11} />
          </Link>
        </div>
      </div>

      <div
        data-testid="workbench-candidates-shell"
        className={`${shell('candidates')} border-t border-amber-200 dark:border-amber-900/60 bg-white dark:bg-slate-950`}
      >
        <DirectorStoryboardCandidates
          script={screenplay}
          sceneIds={sceneIds}
          timelineReady={timelineReady}
          onApplied={() => {
            onTimelineRefresh();
            onScreenplayRefresh();
          }}
          onScriptChanged={onScreenplayRefresh}
          isOpen={true}
          onToggleOpen={() => setActiveTab(null)}
          hideHeader={false}
          onAttentionChange={onAttentionChange}
        />
      </div>

      <div className={`${shell('continuity')} border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950`}>
        <ContinuityPanel
          key={script ? script.id : 'no-script'}
          script={script}
          projectId={projectId}
          onChanged={() => {
            onTimelineRefresh();
            onScreenplayRefresh();
          }}
          isOpen={true}
          onToggleOpen={() => setActiveTab(null)}
          hideStandaloneHeader={false}
        />
      </div>

      <div
        data-testid="workbench-production-shell"
        className={`${shell('production')} border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950`}
      >
        <SceneProductionPanel
          key={`production-${script ? script.id : 'no-script'}`}
          script={script}
          onChanged={() => {
            onTimelineRefresh();
            onScreenplayRefresh();
          }}
          isOpen={true}
          onToggleOpen={() => setActiveTab(null)}
          hideStandaloneHeader={false}
        />
      </div>
    </div>
  );
};
