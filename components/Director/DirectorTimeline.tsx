import React, { useState } from 'react';
import {
  Loader2,
  Film,
  PanelRight,
  ImageIcon,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Music,
  Grid,
  X,
  Check,
  ArrowRight,
  Sparkles,
  Crop,
  Video
} from 'lucide-react';
import { Scene, CoverageGroup, CoverageShot, MediaAsset, VideoTaskState } from '../../types';
import { SHOT_TYPES, CAMERA_MOVEMENTS, CAMERA_ANGLES, OPENPOSE_PRESETS } from '../../constants';
import { useLanguage } from '../../LanguageContext';
import { useProjectAgentOptional } from '../../contexts/ProjectAgentContext';
import { SceneCardSkeleton } from '../Skeleton';
import { api } from '../../services/api';
import { PreviewableImage, useImagePreview, ZoomHint } from '../ImageLightbox';
import { SceneVideoPlayer } from './SceneVideoPlayer';

interface DirectorTimelineProps {
  timeline: Scene[];
  loading: boolean;
  selectedChapterId: string;
  onGenerateTimeline: () => void;
  onGenerateNarration: () => void;
  generatingNarration: boolean;
  showRightPanel: boolean;
  setShowRightPanel: (show: boolean) => void;
  onGenerateAsset: (sceneId: number | string, options?: { newVersion?: boolean; canvasAspectRatio?: string }) => void;
  onGenerateKeyframe?: (sceneId: number | string) => void;
  onUpdateScene: (id: number | string, field: keyof Scene, value: any) => void;
  onRefreshTimeline?: () => void;
  onActivateVersion?: (sceneId: number | string, version: number) => void;
  onCreateVersion?: (sceneId: number | string, clearAsset?: boolean) => void;
  mediaAssetsByScene?: Record<number | string, MediaAsset[]>;
  videoTasksByScene?: Record<number | string, VideoTaskState>;
  onGenerateVideo?: (sceneId: number | string, options?: any) => void;
  onPromoteVideoAsset?: (assetId: number) => void;
  onReprocessVideoAsset?: (assetId: number) => void;
  onCancelVideoTask?: (taskId: string) => void;
}

export const DirectorTimeline: React.FC<DirectorTimelineProps> = ({
  timeline,
  loading,
  selectedChapterId,
  onGenerateTimeline,
  onGenerateNarration,
  generatingNarration,
  showRightPanel,
  setShowRightPanel,
  onGenerateAsset,
  onGenerateKeyframe,
  onUpdateScene,
  onRefreshTimeline,
  onActivateVersion,
  onCreateVersion,
  mediaAssetsByScene = {},
  videoTasksByScene = {},
  onGenerateVideo,
  onPromoteVideoAsset,
  onReprocessVideoAsset,
  onCancelVideoTask
}) => {
  const { t } = useLanguage();
  const agentCtx = useProjectAgentOptional();
  const [expandedCards, setExpandedCards] = useState<Set<number | string>>(new Set());
  const [activeMediaTabs, setActiveMediaTabs] = useState<Record<number | string, 'storyboard' | 'keyframe' | 'video'>>({});
  
  // Single-Scene Coverage Modal State
  const [activeCoverageScene, setActiveCoverageScene] = useState<Scene | null>(null);
  const [coverageGroup, setCoverageGroup] = useState<CoverageGroup | null>(null);
  const [loadingCoverage, setLoadingCoverage] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const { openPreview, lightbox } = useImagePreview();

  const toggleExpand = (id: number | string) => {
    const newSet = new Set(expandedCards);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setExpandedCards(newSet);
  };

  const handleOpenCoverage = async (scene: Scene) => {
    setActiveCoverageScene(scene);
    setCoverageGroup(null);
    setActionNotice(null);
    setLoadingCoverage(true);
    try {
      const groups = await api.getSceneCoverage(scene.id);
      if (groups && groups.length > 0) {
        setCoverageGroup(groups[0]);
      }
    } catch (err) {
      console.warn("No existing coverage group found for scene", scene.id);
    } finally {
      setLoadingCoverage(false);
    }
  };

  const handleGenerateCoverage = async () => {
    if (!activeCoverageScene) return;
    setLoadingCoverage(true);
    setActionNotice(null);
    try {
      const group = await api.generateSceneCoverage(activeCoverageScene.id);
      setCoverageGroup(group);
      setActionNotice(t('director.coverage_gen_ok', '9-shot coverage generated.'));
    } catch (err: any) {
      setActionNotice(
        t('director.coverage_gen_fail', 'Generation failed: {msg}', {
          msg: err.message || String(err),
        })
      );
    } finally {
      setLoadingCoverage(false);
    }
  };

  const handleApplyShot = async (shot: CoverageShot) => {
    if (!activeCoverageScene) return;
    try {
      await api.applyCoverageShot(shot.id);
      if (shot.shot_size) onUpdateScene(activeCoverageScene.id, 'shot_type', shot.shot_size);
      if (shot.camera_angle) onUpdateScene(activeCoverageScene.id, 'camera_angle', shot.camera_angle);
      if (shot.camera_movement) onUpdateScene(activeCoverageScene.id, 'camera_movement', shot.camera_movement);
      if (shot.visual_prompt) onUpdateScene(activeCoverageScene.id, 'visual_prompt', shot.visual_prompt);
      setActionNotice(
        t('director.coverage_apply_ok', 'Applied slot #{slot} ({size}) to source scene.', {
          slot: shot.slot,
          size: shot.shot_size || '',
        })
      );
    } catch (err: any) {
      setActionNotice(
        t('director.coverage_apply_fail', 'Apply failed: {msg}', {
          msg: err.message || String(err),
        })
      );
    }
  };

  const handlePromoteShot = async (shot: CoverageShot) => {
    try {
      await api.promoteCoverageShot(shot.id, 'after');
      setActionNotice(
        t('director.coverage_promote_ok', 'Promoted slot #{slot} to timeline.', {
          slot: shot.slot,
        })
      );
      if (onRefreshTimeline) onRefreshTimeline();
    } catch (err: any) {
      setActionNotice(
        t('director.coverage_promote_fail', 'Promote failed: {msg}', {
          msg: err.message || String(err),
        })
      );
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 h-full overflow-hidden bg-slate-50 dark:bg-[#090d16] text-slate-900 dark:text-slate-100 transition-colors duration-200">
      {/* Header */}
      <div className="h-14 border-b border-slate-200/80 dark:border-slate-800/80 flex items-center justify-between px-4 lg:px-6 bg-white/80 dark:bg-[#0c1322]/80 backdrop-blur-md gap-2 flex-shrink-0">
         <div className="flex items-center gap-3 min-w-0">
           <h2 className="text-slate-900 dark:text-white font-bold truncate text-base">{t('director.storyboard')}</h2>
           <span className="text-xs px-2.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800/50 text-indigo-700 dark:text-indigo-300 font-mono font-semibold flex-shrink-0">
             {t('director.shots_badge', '{count} shots', { count: timeline.length })}
           </span>
         </div>
         
         <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            {timeline.length > 0 && (
              <button
                type="button"
                onClick={onGenerateNarration}
                disabled={loading || generatingNarration || !selectedChapterId}
                className="flex items-center gap-1.5 px-3 py-1.5 text-amber-800 dark:text-amber-200 bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/40 dark:hover:bg-amber-950/60 border border-amber-300 dark:border-amber-800/50 rounded-xl text-xs sm:text-sm font-semibold transition-all disabled:opacity-50 shadow-2xs"
                title={t('director.generate_narration_hint', 'Use the local model to add narration without changing images')}
              >
                {generatingNarration ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
                <span className="hidden sm:inline">{t('director.generate_narration', 'Local Narration')}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => agentCtx?.setOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800/40 rounded-xl text-xs sm:text-sm font-semibold transition-colors shadow-2xs"
              title={t('agent.open_panel', '打开 Agent OS')}
            >
              <Sparkles size={14} />
              <span className="hidden sm:inline">{t('agent.fab_label', 'Agent OS')}</span>
            </button>

            <button 
              onClick={onGenerateTimeline}
              disabled={loading || !selectedChapterId}
              className="bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white px-3.5 sm:px-4 py-1.5 rounded-xl flex items-center gap-2 text-xs sm:text-sm font-semibold disabled:opacity-50 transition-all shadow-md shadow-indigo-500/20"
            >
              {loading ? <Loader2 className="animate-spin" size={15} /> : <Film size={15} />}
              <span className="hidden xs:inline sm:inline">{t('director.generate_scenes')}</span>
            </button>
            
            {/* Mobile Settings Toggle */}
            <button 
              onClick={() => setShowRightPanel(!showRightPanel)}
              className="lg:hidden p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl"
            >
               <PanelRight size={18} />
            </button>
         </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-8 custom-scrollbar min-h-0">
         <div className="flex flex-wrap gap-6 justify-center sm:justify-start pb-20">
            {loading ? (
                Array.from({ length: 4 }).map((_, i) => <SceneCardSkeleton key={i} />)
            ) : (
                <>
                    {timeline.length === 0 && (
                    <div className="w-full text-center text-slate-400 dark:text-slate-500 flex flex-col items-center mt-20">
                        <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-4 ring-1 ring-indigo-500/20">
                          <Film size={28} />
                        </div>
                        <p className="font-semibold text-slate-700 dark:text-slate-300 text-base">{t('director.no_scenes')}</p>
                        <p className="text-xs text-slate-400 mt-1">点击上方“生成分镜”以自动拆解剧本镜头</p>
                    </div>
                    )}
                    
                    {timeline.map((scene, idx) => {
                    const isExpanded = expandedCards.has(scene.id);
                    const sceneMedia = mediaAssetsByScene[scene.id] || [];
                    const sceneTask = videoTasksByScene[scene.id];
                    const hasVideoAssets = sceneMedia.some((m) => m.media_type === 'video' || m.role === 'loop_master' || m.role === 'narrative_final' || m.role === 'raw_video');
                    const isVideoGenerating = sceneTask && (sceneTask.status === 'queued' || sceneTask.status === 'processing');
                    const keyframeAsset = sceneMedia.find((m) => m.role === 'video_keyframe');

                    const currentTab = activeMediaTabs[scene.id] || (hasVideoAssets || isVideoGenerating ? 'video' : 'storyboard');

                    return (
                    <div key={scene.id} className="w-full sm:w-80 flex-shrink-0 flex flex-col bg-white dark:bg-[#0f172a] border border-slate-200/80 dark:border-slate-800/80 rounded-2xl overflow-hidden shadow-sm hover:shadow-xl dark:shadow-md hover:border-indigo-400/50 dark:hover:border-slate-700 transition-all group animate-in fade-in zoom-in-95 duration-200">
                        {/* Header */}
                        <div className="p-3 bg-slate-50/80 dark:bg-[#131c2e]/80 border-b border-slate-200/80 dark:border-slate-800/80 flex justify-between items-center gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="font-mono text-xs text-indigo-700 dark:text-indigo-400 font-bold">{t('director.scene')} {idx + 1}</span>
                              <span className="text-[10px] bg-slate-200/70 dark:bg-slate-800 text-slate-700 dark:text-slate-400 px-1.5 py-0.5 rounded-md font-mono font-medium">
                                {scene.duration}s
                              </span>
                              {/* Version switcher for A/B testing copy + image */}
                              <div className="flex items-center gap-1">
                                <select
                                  className="bg-white dark:bg-slate-950 border border-amber-300 dark:border-amber-800/50 text-amber-800 dark:text-amber-200 text-[10px] font-mono rounded-md px-1.5 py-0.5 max-w-[4.5rem] focus:outline-none font-semibold"
                                  value={scene.active_version || 1}
                                  title="切换生成版本（文案+图片）"
                                  onChange={(e) => {
                                    const v = Number(e.target.value);
                                    if (onActivateVersion && v !== (scene.active_version || 1)) {
                                      onActivateVersion(scene.id, v);
                                    }
                                  }}
                                >
                                  {(scene.versions && scene.versions.length > 0
                                    ? scene.versions
                                    : [{ version: scene.active_version || 1, label: `v${scene.active_version || 1}` }]
                                  ).map((v) => (
                                    <option key={v.version} value={v.version}>
                                      {v.label || `v${v.version}`}{v.has_image ? ' ●' : ''}
                                    </option>
                                  ))}
                                </select>
                                {onCreateVersion && (
                                  <button
                                    type="button"
                                    onClick={() => onCreateVersion(scene.id, true)}
                                    className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/60 dark:hover:bg-amber-900/80 border border-amber-300 dark:border-amber-700/50 text-amber-800 dark:text-amber-200 font-semibold"
                                    title="新建版本（复制当前文案，清空图片）"
                                  >
                                    +V
                                  </button>
                                )}
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-2 flex-shrink-0">
                                <button
                                  onClick={() => handleOpenCoverage(scene)}
                                  className="text-xs bg-purple-50 hover:bg-purple-100 dark:bg-purple-950/60 dark:hover:bg-purple-900/80 border border-purple-200 dark:border-purple-700/60 text-purple-700 dark:text-purple-300 px-2 py-1 rounded-lg flex items-center gap-1 transition-all font-semibold shadow-2xs"
                                  title="单场景九镜头候选覆盖扩展"
                                >
                                  <Grid size={12} />
                                  <span>{t('director.coverage_btn', '9-Shot')}</span>
                                </button>
                            </div>
                        </div>

                        {/* Media Tabs Switcher */}
                        <div className="flex bg-slate-100 dark:bg-slate-950 border-b border-slate-200/80 dark:border-slate-800 p-1 text-[10px] font-medium gap-1">
                          <button
                            type="button"
                            onClick={() => setActiveMediaTabs(prev => ({ ...prev, [scene.id]: 'storyboard' }))}
                            className={`flex-1 py-1 rounded-md text-center transition-all flex items-center justify-center gap-1 ${
                              currentTab === 'storyboard'
                                ? 'bg-white dark:bg-indigo-600 text-indigo-700 dark:text-white font-bold shadow-xs'
                                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                            }`}
                          >
                            <ImageIcon size={11} />
                            <span>{t('director.media_tab_storyboard', '漫画图')}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => setActiveMediaTabs(prev => ({ ...prev, [scene.id]: 'keyframe' }))}
                            className={`flex-1 py-1 rounded-md text-center transition-all flex items-center justify-center gap-1 ${
                              currentTab === 'keyframe'
                                ? 'bg-white dark:bg-indigo-600 text-indigo-700 dark:text-white font-bold shadow-xs'
                                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                            }`}
                          >
                            <Crop size={11} />
                            <span>{t('director.media_tab_keyframe', '16:9 关键帧')}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => setActiveMediaTabs(prev => ({ ...prev, [scene.id]: 'video' }))}
                            className={`flex-1 py-1 rounded-md text-center transition-all flex items-center justify-center gap-1 ${
                              currentTab === 'video'
                                ? 'bg-white dark:bg-indigo-600 text-indigo-700 dark:text-white font-bold shadow-xs'
                                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                            }`}
                          >
                            <Film size={11} />
                            <span>{t('director.media_tab_video', '视频')}</span>
                            {hasVideoAssets && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>}
                            {isVideoGenerating && <Loader2 size={10} className="animate-spin text-amber-500" />}
                          </button>
                        </div>

                        {/* Media Viewport */}
                        {currentTab === 'video' ? (
                          <SceneVideoPlayer
                            scene={scene}
                            mediaAssets={sceneMedia}
                            taskState={sceneTask}
                            onGenerateVideo={(opts) => onGenerateVideo?.(scene.id, opts)}
                            onPromoteAsset={onPromoteVideoAsset}
                            onReprocessAsset={onReprocessVideoAsset}
                            onCancelTask={onCancelVideoTask}
                          />
                        ) : currentTab === 'keyframe' ? (
                          <div className="aspect-video bg-black relative flex items-center justify-center group/keyframe h-48">
                            {keyframeAsset?.url ? (
                              <>
                                <PreviewableImage
                                  src={keyframeAsset.url}
                                  alt={`Scene ${scene.id} 16:9 Keyframe`}
                                  className="w-full h-full object-cover"
                                />
                                <ZoomHint className="group-hover/keyframe:opacity-100" />
                                <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover/keyframe:opacity-100 flex items-center justify-center gap-1.5 transition-opacity">
                                  <button
                                    type="button"
                                    onClick={() => onGenerateKeyframe ? onGenerateKeyframe(scene.id) : onGenerateAsset(scene.id, { canvasAspectRatio: '16:9', newVersion: false })}
                                    className="bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1 rounded-full text-[10px] font-medium shadow"
                                    title="生成专用的 16:9 关键帧"
                                  >
                                    重新生成
                                  </button>
                                  {onGenerateVideo && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setActiveMediaTabs(prev => ({ ...prev, [scene.id]: 'video' }));
                                        onGenerateVideo(scene.id);
                                      }}
                                      className="bg-purple-600 hover:bg-purple-500 text-white px-2.5 py-1 rounded-full text-[10px] font-medium shadow"
                                    >
                                      以此帧生视频
                                    </button>
                                  )}
                                </div>
                              </>
                            ) : (
                              <div className="text-slate-500 flex flex-col items-center p-3 text-center">
                                <Crop size={24} className="mb-1 opacity-50" />
                                <span className="text-[11px]">暂无 16:9 关键帧</span>
                                <button
                                  type="button"
                                  onClick={() => onGenerateKeyframe ? onGenerateKeyframe(scene.id) : onGenerateAsset(scene.id, { canvasAspectRatio: '16:9', newVersion: false })}
                                  className="mt-2 bg-slate-800 hover:bg-indigo-600 text-slate-200 hover:text-white px-2.5 py-1 rounded-lg text-[10px] font-medium transition-colors"
                                >
                                  生成 16:9 关键帧
                                </button>
                              </div>
                            )}
                          </div>
                        ) : (
                          /* Storyboard Image Area */
                          <div className="aspect-square bg-slate-900 relative flex items-center justify-center group/image h-64">
                              {scene.asset_status === 'completed' && scene.asset_url ? (
                                  <>
                                    <PreviewableImage
                                      src={scene.asset_url}
                                      alt={`Scene ${scene.id}`}
                                      className="w-full h-full object-cover"
                                    />
                                    <ZoomHint className="group-hover/image:opacity-100" />
                                  </>
                              ) : (
                                  <div className="text-slate-400 dark:text-slate-500 flex flex-col items-center">
                                  {scene.asset_status === 'generating' ? (
                                      <Loader2 className="animate-spin text-indigo-500 mb-2" size={32} />
                                  ) : (
                                      <ImageIcon size={32} className="mb-2 opacity-50" />
                                  )}
                                  <span className="text-xs capitalize font-medium">
                                      {scene.asset_status === 'generating' ? t('director.status_generating') : scene.asset_status === 'failed' ? t('director.status_failed') : scene.asset_status || 'No Asset'}
                                  </span>
                                  </div>
                              )}

                              {/* Overlay: preview + regenerate */}
                              <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover/image:opacity-100 flex flex-wrap items-center justify-center gap-1.5 transition-opacity pointer-events-none">
                                  {scene.asset_status === 'completed' && scene.asset_url && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openPreview(scene.asset_url);
                                      }}
                                      className="pointer-events-auto bg-slate-800/90 hover:bg-slate-700 text-white px-2.5 py-1.5 rounded-full font-medium text-[11px] flex items-center gap-1 shadow-lg border border-slate-600"
                                    >
                                      放大
                                    </button>
                                  )}
                                  <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onGenerateAsset(scene.id, { newVersion: false });
                                  }}
                                  disabled={scene.asset_status === 'generating'}
                                  className="pointer-events-auto bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1.5 rounded-full font-medium text-[11px] flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
                                  title="覆盖当前版本图片"
                                  >
                                  <RefreshCw size={12} className={scene.asset_status === 'generating' ? "animate-spin" : ""} />
                                  {scene.asset_status === 'generating' ? t('director.status_generating') : '生成本版'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onGenerateAsset(scene.id, { newVersion: true });
                                    }}
                                    disabled={scene.asset_status === 'generating'}
                                    className="pointer-events-auto bg-amber-700 hover:bg-amber-600 text-white px-2.5 py-1.5 rounded-full font-medium text-[11px] flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
                                    title="新建版本并生成（保留旧版文案与图片）"
                                  >
                                    +新版生成
                                  </button>
                              </div>
                          </div>
                        )}

                        {/* Content (Editable) */}
                        <div className="flex-1 p-3.5 flex flex-col gap-2.5 bg-white dark:bg-[#0f172a] border-t border-slate-100 dark:border-slate-800/80">
                            {/* Camera Details Dropdowns */}
                            <div className="grid grid-cols-3 gap-1.5 mb-0.5">
                                <select 
                                className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-[10px] text-sky-700 dark:text-sky-300 font-semibold py-1 px-1.5 focus:outline-none"
                                value={scene.shot_type || ''}
                                onChange={(e) => onUpdateScene(scene.id, 'shot_type', e.target.value)}
                                title="Shot Type"
                                >
                                {SHOT_TYPES.map(opt => <option key={opt.value} value={opt.value}>{opt.value || 'Shot...'}</option>)}
                                </select>
                                <select 
                                className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-[10px] text-emerald-700 dark:text-emerald-300 font-semibold py-1 px-1.5 focus:outline-none"
                                value={scene.camera_movement || ''}
                                onChange={(e) => onUpdateScene(scene.id, 'camera_movement', e.target.value)}
                                title="Camera Movement"
                                >
                                {CAMERA_MOVEMENTS.map(opt => <option key={opt.value} value={opt.value}>{opt.value || 'Move...'}</option>)}
                                </select>
                                <select 
                                className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-[10px] text-amber-700 dark:text-amber-300 font-semibold py-1 px-1.5 focus:outline-none"
                                value={scene.camera_angle || ''}
                                onChange={(e) => onUpdateScene(scene.id, 'camera_angle', e.target.value)}
                                title="Camera Angle"
                                >
                                {CAMERA_ANGLES.map(opt => <option key={opt.value} value={opt.value}>{opt.value || 'Angle...'}</option>)}
                                </select>
                            </div>

                            {/* OpenPose Posture Selector */}
                            <div>
                                <select 
                                className="w-full bg-slate-50 dark:bg-slate-950/80 border border-purple-200 dark:border-purple-800/40 rounded-lg text-[10px] text-purple-700 dark:text-purple-300 font-semibold py-1 px-2 focus:outline-none"
                                onChange={(e) => {
                                    const presetId = e.target.value;
                                    if (!presetId) return;
                                    const preset = OPENPOSE_PRESETS.find(p => p.id === presetId);
                                    if (preset) {
                                    const currentPrompt = scene.visual_prompt || '';
                                    const newPrompt = currentPrompt ? `${currentPrompt}, ${preset.prompt_snippet}` : preset.prompt_snippet;
                                    onUpdateScene(scene.id, 'visual_prompt', newPrompt);
                                    }
                                }}
                                defaultValue=""
                                title={t('characters.pose_label') || "OpenPose Posture Preset"}
                                >
                                <option value="">🎭 {t('characters.pose_label') || "OpenPose Posture Preset"}...</option>
                                {OPENPOSE_PRESETS.map(pose => (
                                    <option key={pose.id} value={pose.id}>
                                    {pose.name_zh} ({pose.name})
                                    </option>
                                ))}
                                </select>
                            </div>

                            <div className="flex-1 min-h-0 flex flex-col space-y-2">
                                {/* Visual Prompt */}
                                <div>
                                    <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase mb-1 block">{t('director.visual')}</label>
                                    <textarea
                                        className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2 text-xs text-slate-800 dark:text-slate-200 leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500 h-16 transition-all"
                                        value={scene.visual_prompt || ''}
                                        onChange={(e) => onUpdateScene(scene.id, 'visual_prompt', e.target.value)}
                                        placeholder="Describe the scene..."
                                    />
                                </div>

                                {/* Narration */}
                                <div>
                                    <label className="text-[10px] font-bold text-amber-700 dark:text-amber-400 uppercase mb-1 block">{t('director.narration', 'Narration')}</label>
                                    <textarea
                                        className="w-full bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50 rounded-xl p-2 text-xs text-amber-900 dark:text-amber-100 leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-amber-500 h-14 transition-all"
                                        value={scene.narration || ''}
                                        onChange={(e) => onUpdateScene(scene.id, 'narration', e.target.value)}
                                        placeholder={t('director.narration_placeholder', 'Narration or internal monologue...')}
                                    />
                                </div>

                                {/* Dialogue */}
                                <div>
                                    <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase mb-1 block">{t('director.dialogue')}</label>
                                    <textarea
                                        className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2 text-xs text-slate-800 dark:text-slate-300 italic leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500 h-10 transition-all"
                                        value={scene.dialogue || ''}
                                        onChange={(e) => onUpdateScene(scene.id, 'dialogue', e.target.value)}
                                        placeholder="Dialogue..."
                                    />
                                </div>
                            </div>

                            {/* Advanced Toggle */}
                            <button 
                            onClick={() => toggleExpand(scene.id)}
                            className="flex items-center justify-between w-full mt-1 text-[10px] text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors font-bold"
                            >
                            <span className="uppercase">Advanced Settings</span>
                            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            </button>

                            {/* Advanced Section */}
                            {isExpanded && (
                            <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800 animate-in fade-in slide-in-from-top-1 space-y-2">
                                <div>
                                    <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase mb-1 flex items-center gap-1">
                                        <Music size={10} /> Audio Prompt
                                    </label>
                                    <textarea
                                        className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2 text-xs text-slate-700 dark:text-slate-300 leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500 h-12"
                                        value={scene.audio_prompt || ''}
                                        onChange={(e) => onUpdateScene(scene.id, 'audio_prompt', e.target.value)}
                                        placeholder="Sound effects, bgm..."
                                    />
                                </div>

                                <div>
                                    <label className="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase mb-1 flex items-center gap-1">
                                        <AlertCircle size={10} /> Negative Prompt
                                    </label>
                                    <textarea
                                        className="w-full bg-rose-50/50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 rounded-xl p-2 text-xs text-rose-900 dark:text-slate-300 leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-rose-500 h-12 placeholder-rose-300 dark:placeholder-slate-600"
                                        value={scene.negative_prompt || ''}
                                        onChange={(e) => onUpdateScene(scene.id, 'negative_prompt', e.target.value)}
                                        placeholder="Elements to exclude..."
                                    />
                                </div>
                            </div>
                            )}
                        </div>
                    </div>
                    );
                    })}
                </>
            )}
         </div>
      </div>

      {/* 9-Shot Coverage Modal */}
      {activeCoverageScene && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-[#0f172a] border border-purple-200 dark:border-purple-800/60 rounded-2xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="px-6 py-4 bg-slate-50 dark:bg-[#0c1322] border-b border-purple-100 dark:border-purple-800/40 flex items-center justify-between flex-shrink-0">
              <div>
                <div className="flex items-center gap-2">
                  <Grid size={18} className="text-purple-600 dark:text-purple-400" />
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white">{t('director.coverage_title')}</h3>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-purple-50 dark:bg-purple-950 text-purple-700 dark:text-purple-300 font-mono font-semibold border border-purple-200 dark:border-purple-700/50">
                    Scene #{activeCoverageScene.id}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{t('director.coverage_subtitle')}</p>
              </div>
              <button 
                onClick={() => setActiveCoverageScene(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Notice Banner */}
            {actionNotice && (
              <div className="bg-purple-50 dark:bg-purple-950/60 border-b border-purple-200 dark:border-purple-800/50 px-6 py-2 text-xs text-purple-800 dark:text-purple-200 flex items-center justify-between font-semibold flex-shrink-0">
                <span>{actionNotice}</span>
                <button onClick={() => setActionNotice(null)} className="text-purple-600 dark:text-purple-400 hover:text-purple-800">
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6 min-h-0 custom-scrollbar">
              {/* Controls bar */}
              <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-950/60 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
                <div className="text-xs text-slate-700 dark:text-slate-300">
                  <span className="text-slate-400 font-bold uppercase mr-2">源场景:</span>
                  <span className="italic text-slate-800 dark:text-slate-200">"{activeCoverageScene.visual_prompt?.substring(0, 80)}..."</span>
                </div>
                <button
                  onClick={handleGenerateCoverage}
                  disabled={loadingCoverage}
                  className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 disabled:opacity-50 transition-all shadow-md hover:shadow-purple-500/20"
                >
                  {loadingCoverage ? <Loader2 className="animate-spin" size={14} /> : <Grid size={14} />}
                  <span>{coverageGroup ? "重新生成 9 候选" : t('director.generate_coverage')}</span>
                </button>
              </div>

              {/* Coverage Shots Display */}
              {loadingCoverage ? (
                <div className="py-20 flex flex-col items-center justify-center text-purple-600 dark:text-purple-400 space-y-3">
                  <Loader2 className="animate-spin" size={36} />
                  <span className="text-sm font-semibold">{t('director.generating_coverage')}</span>
                </div>
              ) : coverageGroup && coverageGroup.shots ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {coverageGroup.shots.map((shot) => (
                    <div key={shot.id} className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 flex flex-col justify-between hover:border-purple-400 dark:hover:border-purple-600/50 transition-all space-y-3 group">
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-mono text-xs font-bold text-purple-700 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/70 border border-purple-200 dark:border-purple-800/60 px-2 py-0.5 rounded-md">
                            #{shot.slot} {shot.shot_size}
                          </span>
                          <span className="text-[10px] text-slate-600 dark:text-slate-400 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-1.5 py-0.5 rounded-md font-mono">
                            {shot.camera_angle}
                          </span>
                        </div>
                        <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed line-clamp-4 bg-white dark:bg-slate-900/60 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800/80">
                          {shot.visual_prompt}
                        </p>
                        {shot.narrative_purpose && (
                          <span className="text-[10px] text-slate-400 dark:text-slate-500 italic mt-1.5 block">
                            定位: {shot.narrative_purpose}
                          </span>
                        )}
                      </div>

                      {/* Card Actions */}
                      <div className="pt-2 border-t border-slate-200 dark:border-slate-800/80 flex items-center justify-between gap-2">
                        <button
                          onClick={() => handleApplyShot(shot)}
                          className="flex-1 bg-white hover:bg-purple-50 dark:bg-slate-800 dark:hover:bg-purple-900/50 text-slate-700 hover:text-purple-700 dark:text-slate-200 dark:hover:text-purple-200 py-1.5 px-2 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors border border-slate-200 dark:border-slate-700"
                          title="使用该候选镜头的景别与提示词更新源场景"
                        >
                          <Check size={12} />
                          <span>{t('director.apply_to_scene')}</span>
                        </button>
                        <button
                          onClick={() => handlePromoteShot(shot)}
                          className="flex-1 bg-purple-50 hover:bg-purple-100 dark:bg-purple-900/40 dark:hover:bg-purple-800/60 text-purple-700 dark:text-purple-300 py-1.5 px-2 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors border border-purple-200 dark:border-purple-700/60"
                          title="将该候选镜头插入为主时间线场景卡片"
                        >
                          <ArrowRight size={12} />
                          <span>{t('director.promote_to_timeline')}</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-16 text-center text-slate-400 dark:text-slate-500 flex flex-col items-center">
                  <Grid size={40} className="mb-3 opacity-30 text-purple-500" />
                  <p className="text-sm font-medium">暂无该场景的九镜头覆盖数据。</p>
                  <p className="text-xs text-slate-400 mt-1">点击上方“生成 9 候选镜头”按钮为本场景创建景别扩展。</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {lightbox}
    </div>
  );
};
