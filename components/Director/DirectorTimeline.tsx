import React, { useState } from 'react';
import { Loader2, Film, PanelRight, ImageIcon, RefreshCw, ChevronDown, ChevronUp, AlertCircle, Music, Grid, X, Check, ArrowRight, Sparkles } from 'lucide-react';
import { Scene, CoverageGroup, CoverageShot } from '../../types';
import { SHOT_TYPES, CAMERA_MOVEMENTS, CAMERA_ANGLES, OPENPOSE_PRESETS } from '../../constants';
import { useLanguage } from '../../LanguageContext';
import { useProjectAgentOptional } from '../../contexts/ProjectAgentContext';
import { SceneCardSkeleton } from '../Skeleton';
import { api } from '../../services/api';
import { PreviewableImage, useImagePreview, ZoomHint } from '../ImageLightbox';

interface DirectorTimelineProps {
  timeline: Scene[];
  loading: boolean;
  selectedChapterId: string;
  onGenerateTimeline: () => void;
  showRightPanel: boolean;
  setShowRightPanel: (show: boolean) => void;
  onGenerateAsset: (sceneId: number | string, options?: { newVersion?: boolean }) => void;
  onUpdateScene: (id: number | string, field: keyof Scene, value: any) => void;
  onRefreshTimeline?: () => void;
  onActivateVersion?: (sceneId: number | string, version: number) => void;
  onCreateVersion?: (sceneId: number | string, clearAsset?: boolean) => void;
}

export const DirectorTimeline: React.FC<DirectorTimelineProps> = ({
  timeline,
  loading,
  selectedChapterId,
  onGenerateTimeline,
  showRightPanel,
  setShowRightPanel,
  onGenerateAsset,
  onUpdateScene,
  onRefreshTimeline,
  onActivateVersion,
  onCreateVersion
}) => {
  const { t } = useLanguage();
  const agentCtx = useProjectAgentOptional();
  const [expandedCards, setExpandedCards] = useState<Set<number | string>>(new Set());
  
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
    <div className="flex-1 flex flex-col min-w-0 bg-slate-950">
      {/* Header */}
      <div className="h-14 border-b border-slate-800 flex items-center justify-between px-4 lg:px-6 bg-slate-925 gap-2">
         <div className="flex items-center gap-3 min-w-0">
           <h2 className="text-white font-medium truncate">{t('director.storyboard')}</h2>
           <span className="text-xs px-2 py-0.5 rounded bg-indigo-950/60 border border-indigo-800/50 text-indigo-300 font-mono flex-shrink-0">
             {t('director.shots_badge', '{count} shots', { count: timeline.length })}
           </span>
         </div>
         
         <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            <button
              type="button"
              onClick={() => agentCtx?.setOpen(true)}
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-indigo-300 hover:text-indigo-200 bg-indigo-950/40 hover:bg-indigo-950/60 border border-indigo-800/40 rounded-lg text-xs sm:text-sm font-medium transition-colors"
              title={t('agent.open_panel', '打开 Agent OS')}
            >
              <Sparkles size={15} />
              <span className="hidden sm:inline">{t('agent.fab_label', 'Agent OS')}</span>
            </button>

            <button 
              onClick={onGenerateTimeline}
              disabled={loading || !selectedChapterId}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 sm:px-4 py-1.5 rounded-lg flex items-center gap-2 text-sm font-medium disabled:opacity-50 transition-all shadow-md hover:shadow-indigo-500/20"
            >
              {loading ? <Loader2 className="animate-spin" size={16} /> : <Film size={16} />}
              <span className="hidden xs:inline sm:inline">{t('director.generate_scenes')}</span>
            </button>
            
            {/* Mobile Settings Toggle */}
            <button 
              onClick={() => setShowRightPanel(!showRightPanel)}
              className="lg:hidden p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg"
            >
               <PanelRight size={20} />
            </button>
         </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-8 custom-scrollbar">
         <div className="flex flex-wrap gap-6 justify-center sm:justify-start pb-20">
            {loading ? (
                Array.from({ length: 4 }).map((_, i) => <SceneCardSkeleton key={i} />)
            ) : (
                <>
                    {timeline.length === 0 && (
                    <div className="w-full text-center text-slate-500 flex flex-col items-center mt-20">
                        <Film size={48} className="mb-4 opacity-20" />
                        <p>{t('director.no_scenes')}</p>
                    </div>
                    )}
                    
                    {timeline.map((scene, idx) => {
                    const isExpanded = expandedCards.has(scene.id);
                    return (
                    <div key={scene.id} className="w-full sm:w-80 flex-shrink-0 flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl hover:shadow-2xl transition-all group animate-in fade-in zoom-in-95 duration-300">
                        {/* Header */}
                        <div className="p-3 bg-slate-850 border-b border-slate-800 flex justify-between items-center gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="font-mono text-xs text-indigo-400 font-bold">{t('director.scene')} {idx + 1}</span>
                              <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono">
                                {scene.duration}s
                              </span>
                              {/* Version switcher for A/B testing copy + image */}
                              <div className="flex items-center gap-1">
                                <select
                                  className="bg-slate-950 border border-amber-800/50 text-amber-200 text-[10px] font-mono rounded px-1.5 py-0.5 max-w-[4.5rem] focus:outline-none focus:border-amber-500"
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
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-amber-950/60 hover:bg-amber-900/80 border border-amber-700/50 text-amber-200"
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
                                  className="text-xs bg-purple-950/60 hover:bg-purple-900/80 border border-purple-700/60 text-purple-300 px-2 py-1 rounded flex items-center gap-1 transition-all"
                                  title="单场景九镜头候选覆盖扩展"
                                >
                                  <Grid size={13} />
                                  <span>{t('director.coverage_btn', '9-Shot')}</span>
                                </button>
                            </div>
                        </div>

                        {/* Image Area — click image for full preview; hover for regenerate */}
                        <div className="aspect-square bg-black relative flex items-center justify-center group/image h-64">
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
                                <div className="text-slate-600 flex flex-col items-center">
                                {scene.asset_status === 'generating' ? (
                                    <Loader2 className="animate-spin text-indigo-500 mb-2" size={32} />
                                ) : (
                                    <ImageIcon size={32} className="mb-2 opacity-50" />
                                )}
                                <span className="text-xs capitalize">
                                    {scene.asset_status === 'generating' ? t('director.status_generating') : scene.asset_status === 'failed' ? t('director.status_failed') : scene.asset_status || 'No Asset'}
                                </span>
                                </div>
                            )}
                            
                            {/* Overlay: preview + regenerate (don't block image click on empty area) */}
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

                        {/* Content (Editable) */}
                        <div className="flex-1 p-3 flex flex-col gap-2 bg-slate-900 border-t border-slate-800">
                            {/* Camera Details Dropdowns */}
                            <div className="grid grid-cols-3 gap-1 mb-1">
                                <select 
                                className="bg-slate-800 border border-slate-700 rounded text-[10px] text-sky-300 font-medium py-1 px-1 focus:outline-none"
                                value={scene.shot_type || ''}
                                onChange={(e) => onUpdateScene(scene.id, 'shot_type', e.target.value)}
                                title="Shot Type"
                                >
                                {SHOT_TYPES.map(opt => <option key={opt.value} value={opt.value}>{opt.value || 'Shot...'}</option>)}
                                </select>
                                <select 
                                className="bg-slate-800 border border-slate-700 rounded text-[10px] text-emerald-300 font-medium py-1 px-1 focus:outline-none"
                                value={scene.camera_movement || ''}
                                onChange={(e) => onUpdateScene(scene.id, 'camera_movement', e.target.value)}
                                title="Camera Movement"
                                >
                                {CAMERA_MOVEMENTS.map(opt => <option key={opt.value} value={opt.value}>{opt.value || 'Move...'}</option>)}
                                </select>
                                <select 
                                className="bg-slate-800 border border-slate-700 rounded text-[10px] text-amber-300 font-medium py-1 px-1 focus:outline-none"
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
                                className="w-full bg-slate-950/80 border border-purple-800/40 rounded text-[10px] text-purple-300 font-medium py-1 px-2 focus:outline-none hover:border-purple-600/60"
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
                                    <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 block">{t('director.visual')}</label>
                                    <textarea
                                        className="w-full bg-slate-950/50 border border-slate-800 rounded p-2 text-xs text-slate-300 leading-relaxed resize-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 h-16"
                                        value={scene.visual_prompt || ''}
                                        onChange={(e) => onUpdateScene(scene.id, 'visual_prompt', e.target.value)}
                                        placeholder="Describe the scene..."
                                    />
                                </div>

                                {/* Dialogue */}
                                <div>
                                    <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 block">{t('director.dialogue')}</label>
                                    <textarea
                                        className="w-full bg-slate-950/50 border border-slate-800 rounded p-2 text-xs text-slate-300 italic leading-relaxed resize-none focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 h-10"
                                        value={scene.dialogue || ''}
                                        onChange={(e) => onUpdateScene(scene.id, 'dialogue', e.target.value)}
                                        placeholder="Dialogue..."
                                    />
                                </div>
                            </div>

                            {/* Advanced Toggle */}
                            <button 
                            onClick={() => toggleExpand(scene.id)}
                            className="flex items-center justify-between w-full mt-2 text-[10px] text-slate-500 hover:text-indigo-400 transition-colors"
                            >
                            <span className="uppercase font-bold">Advanced Settings</span>
                            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            </button>

                            {/* Advanced Section */}
                            {isExpanded && (
                            <div className="mt-2 pt-2 border-t border-slate-800 animate-in fade-in slide-in-from-top-1 space-y-2">
                                <div>
                                    <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 flex items-center gap-1">
                                        <Music size={10} /> Audio Prompt
                                    </label>
                                    <textarea
                                        className="w-full bg-slate-950/50 border border-slate-800 rounded p-2 text-xs text-slate-400 leading-relaxed resize-none focus:outline-none focus:border-indigo-500/50 h-12"
                                        value={scene.audio_prompt || ''}
                                        onChange={(e) => onUpdateScene(scene.id, 'audio_prompt', e.target.value)}
                                        placeholder="Sound effects, bgm..."
                                    />
                                </div>

                                <div>
                                    <label className="text-[10px] font-bold text-red-400/80 uppercase mb-1 flex items-center gap-1">
                                        <AlertCircle size={10} /> Negative Prompt
                                    </label>
                                    <textarea
                                        className="w-full bg-red-950/10 border border-red-900/30 rounded p-2 text-xs text-slate-400 leading-relaxed resize-none focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/20 h-12 placeholder-slate-600"
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
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-purple-800/60 rounded-2xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="px-6 py-4 bg-slate-925 border-b border-purple-800/40 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Grid size={18} className="text-purple-400" />
                  <h3 className="text-lg font-semibold text-white">{t('director.coverage_title')}</h3>
                  <span className="text-xs px-2 py-0.5 rounded bg-purple-950 text-purple-300 font-mono border border-purple-700/50">
                    Scene #{activeCoverageScene.id}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1">{t('director.coverage_subtitle')}</p>
              </div>
              <button 
                onClick={() => setActiveCoverageScene(null)}
                className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Notice Banner */}
            {actionNotice && (
              <div className="bg-purple-950/60 border-b border-purple-800/50 px-6 py-2 text-xs text-purple-200 flex items-center justify-between font-medium">
                <span>{actionNotice}</span>
                <button onClick={() => setActionNotice(null)} className="text-purple-400 hover:text-white">
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Controls bar */}
              <div className="flex items-center justify-between bg-slate-950/60 p-4 rounded-xl border border-slate-800">
                <div className="text-xs text-slate-300">
                  <span className="text-slate-500 font-semibold uppercase mr-2">源场景:</span>
                  <span className="italic text-slate-200">"{activeCoverageScene.visual_prompt?.substring(0, 80)}..."</span>
                </div>
                <button
                  onClick={handleGenerateCoverage}
                  disabled={loadingCoverage}
                  className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 disabled:opacity-50 transition-all shadow-md hover:shadow-purple-500/20"
                >
                  {loadingCoverage ? <Loader2 className="animate-spin" size={14} /> : <Grid size={14} />}
                  <span>{coverageGroup ? "重新生成 9 候选" : t('director.generate_coverage')}</span>
                </button>
              </div>

              {/* Coverage Shots Display */}
              {loadingCoverage ? (
                <div className="py-20 flex flex-col items-center justify-center text-purple-400 space-y-3">
                  <Loader2 className="animate-spin" size={36} />
                  <span className="text-sm font-medium">{t('director.generating_coverage')}</span>
                </div>
              ) : coverageGroup && coverageGroup.shots ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {coverageGroup.shots.map((shot) => (
                    <div key={shot.id} className="bg-slate-950 border border-slate-800 rounded-xl p-3 flex flex-col justify-between hover:border-purple-600/50 transition-all space-y-3 group">
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-mono text-xs font-bold text-purple-400 bg-purple-950/70 border border-purple-800/60 px-2 py-0.5 rounded">
                            #{shot.slot} {shot.shot_size}
                          </span>
                          <span className="text-[10px] text-slate-400 bg-slate-900 px-1.5 py-0.5 rounded font-mono">
                            {shot.camera_angle}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 leading-relaxed line-clamp-4 bg-slate-900/60 p-2 rounded border border-slate-800/80">
                          {shot.visual_prompt}
                        </p>
                        {shot.narrative_purpose && (
                          <span className="text-[10px] text-slate-500 italic mt-1 block">
                            定位: {shot.narrative_purpose}
                          </span>
                        )}
                      </div>

                      {/* Card Actions */}
                      <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2">
                        <button
                          onClick={() => handleApplyShot(shot)}
                          className="flex-1 bg-slate-800 hover:bg-purple-900/50 text-slate-200 hover:text-purple-200 py-1.5 px-2 rounded text-[11px] font-medium flex items-center justify-center gap-1 transition-colors border border-slate-700 hover:border-purple-700"
                          title="使用该候选镜头的景别与提示词更新源场景"
                        >
                          <Check size={12} />
                          <span>{t('director.apply_to_scene')}</span>
                        </button>
                        <button
                          onClick={() => handlePromoteShot(shot)}
                          className="flex-1 bg-purple-900/40 hover:bg-purple-800/60 text-purple-300 py-1.5 px-2 rounded text-[11px] font-medium flex items-center justify-center gap-1 transition-colors border border-purple-700/60"
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
                <div className="py-16 text-center text-slate-500 flex flex-col items-center">
                  <Grid size={40} className="mb-3 opacity-30 text-purple-400" />
                  <p className="text-sm">暂无该场景的九镜头覆盖数据。</p>
                  <p className="text-xs text-slate-600 mt-1">点击上方“生成 9 候选镜头”按钮为本场景创建景别扩展。</p>
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