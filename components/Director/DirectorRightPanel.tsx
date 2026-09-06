import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Loader2,
  Video,
  BookOpen,
  X,
  Sliders,
  Zap,
  PlayCircle,
  Square,
  Library,
  Film,
  ShieldCheck,
  Cpu,
  RefreshCw,
  Sparkles
} from 'lucide-react';
import { Scene, AssetMode, ImageOutputSpec, VideoProfile, VideoPreset, VideoCapabilities } from '../../types';
import { API_BASE_URL, formatVisualStyleLabel, getVisualStyles, type VisualStyleDef } from '../../constants';
import { useLanguage } from '../../LanguageContext';
import { useToast } from '../../ToastContext';
import { api } from '../../services/api';

export type ProjectNsfwMode = 'inherit' | 'on' | 'off';

interface DirectorRightPanelProps {
  showRightPanel: boolean;
  setShowRightPanel: (show: boolean) => void;
  selectedStyle: string;
  setSelectedStyle: (style: string) => void;
  styleStrength?: number;
  setStyleStrength?: (val: number) => void;
  assetMode: AssetMode;
  setAssetMode: (mode: AssetMode) => void;
  renderingVideo: boolean;
  onRenderVideo: () => void;
  generatingComic: boolean;
  onGenerateComic: () => void;
  comicPages: any[];
  showComicViewer: boolean;
  setShowComicViewer: (show: boolean) => void;
  timeline: Scene[];
  isBatchGenerating?: boolean;
  onBatchGenerate?: () => void;
  onStopBatchGenerate?: () => void;
  projectModelType?: string;
  effectiveNsfw?: boolean;
  outputSpec?: ImageOutputSpec;
  // Video Generation Controls
  videoProfile?: VideoProfile;
  setVideoProfile?: (profile: VideoProfile) => void;
  videoPreset?: VideoPreset;
  setVideoPreset?: (preset: VideoPreset) => void;
  runLoopCloser?: boolean;
  setRunLoopCloser?: (run: boolean) => void;
  videoMotionPrompt?: string;
  setVideoMotionPrompt?: (prompt: string) => void;
  onBatchGenerateVideo?: () => void;
  isBatchGeneratingVideo?: boolean;
  onStopBatchGenerateVideo?: () => void;
}

export const DirectorRightPanel: React.FC<DirectorRightPanelProps> = ({
  showRightPanel,
  setShowRightPanel,
  selectedStyle,
  setSelectedStyle,
  styleStrength = 1.0,
  setStyleStrength,
  assetMode,
  setAssetMode,
  renderingVideo,
  onRenderVideo,
  generatingComic,
  onGenerateComic,
  comicPages,
  showComicViewer,
  setShowComicViewer,
  timeline,
  onBatchGenerate,
  onStopBatchGenerate,
  isBatchGenerating,
  projectModelType = 'pony',
  effectiveNsfw = false,
  outputSpec,
  videoProfile = 'narrative_clip',
  setVideoProfile,
  videoPreset = 'preview_480p_5s',
  setVideoPreset,
  runLoopCloser = true,
  setRunLoopCloser,
  videoMotionPrompt = '',
  setVideoMotionPrompt,
  onBatchGenerateVideo,
  isBatchGeneratingVideo = false,
  onStopBatchGenerateVideo
}) => {
  const { id: projectId } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [visualStyles, setVisualStyles] = useState<VisualStyleDef[]>(() => getVisualStyles());
  const [generatingProjectComic, setGeneratingProjectComic] = useState(false);
  const [videoCaps, setVideoCaps] = useState<VideoCapabilities | null>(null);
  const [checkingCaps, setCheckingCaps] = useState(false);

  useEffect(() => {
    const refresh = () => setVisualStyles(getVisualStyles());
    window.addEventListener('novastory-advanced-styles-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('novastory-advanced-styles-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const loadCapabilities = async () => {
    setCheckingCaps(true);
    try {
      const caps = await api.getVideoCapabilities();
      setVideoCaps(caps);
    } catch (_) {
      // capabilities endpoint might be offline or mocked
    } finally {
      setCheckingCaps(false);
    }
  };

  useEffect(() => {
    if (assetMode === 'video_clip') {
      loadCapabilities();
    }
  }, [assetMode]);

  const activeStyleDef = visualStyles.find((s) => s.value === selectedStyle);
  const activeStyleLabel = activeStyleDef
    ? formatVisualStyleLabel(activeStyleDef, t(`director.styles.${activeStyleDef.value}`) || activeStyleDef.label)
    : selectedStyle;

  const handleGenerateProjectComic = async () => {
    const numericProjectId = Number(projectId);
    if (!Number.isFinite(numericProjectId) || generatingProjectComic) return;

    setGeneratingProjectComic(true);
    try {
      const readiness = await api.getProjectComicStatus(numericProjectId);
      if (!readiness.ready) {
        const missingScenes = Math.max(0, readiness.total_scenes - readiness.ready_scenes);
        const noTimeline = readiness.chapters.filter((chapter) => chapter.blocker === 'no_scenes').length;
        showToast(
          t(
            'director.project_comic_not_ready',
            `整本漫画尚未就绪：${readiness.ready_chapters}/${readiness.total_chapters} 章完成，${noTimeline} 章缺少分镜，${missingScenes} 个 Scene 缺图。`
          ),
          'warning'
        );
        return;
      }

      const result = await api.generateProjectComic(numericProjectId);
      if (
        result.status !== 'completed'
        || result.generated_count !== result.total_scenes
        || !result.pdf_url
      ) {
        throw new Error('Project comic generation did not produce a complete PDF');
      }

      const pdfUrl = result.pdf_url.startsWith('http')
        ? result.pdf_url
        : `${API_BASE_URL.replace('/api', '')}${result.pdf_url}`;
      window.open(pdfUrl, '_blank');
      showToast(
        t(
          'director.project_comic_generated',
          `整本漫画已生成：${result.total_chapters} 章 / ${result.generated_count} 页。`
        ),
        'success'
      );
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t('director.project_comic_failed', '整本漫画生成失败'),
        'error'
      );
    } finally {
      setGeneratingProjectComic(false);
    }
  };

  return (
    <>
      <div className={`
        fixed inset-y-0 right-0 w-80 bg-slate-900 border-l border-slate-800 shadow-2xl z-50 transform transition-transform duration-300
        lg:static lg:translate-x-0 lg:shadow-none lg:w-80 lg:flex lg:flex-col lg:h-full lg:min-h-0 lg:flex-shrink-0
        ${showRightPanel ? 'translate-x-0' : 'translate-x-full'}
      `}>
         {/* Header */}
         <div className="flex justify-between items-center p-4 border-b border-slate-800 bg-slate-900 flex-shrink-0">
             <h4 className="font-semibold text-white text-sm flex items-center gap-2">
               <Sliders size={16} className="text-indigo-400" />
               {t('director.production_controls', '制作控制台')}
             </h4>
             <button onClick={() => setShowRightPanel(false)} className="text-slate-400 hover:text-white lg:hidden">
               <X size={20} />
             </button>
         </div>

         {/* Panel Content */}
         <div className="flex-1 overflow-y-auto p-4 gap-6 flex flex-col custom-scrollbar min-h-0">
            {/* Render Controls */}
            <div className="space-y-4">
               <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                 <Sliders size={14} />
                 {t('director.production_settings')}
               </h4>

               {/* Mode Switcher */}
               <div className="bg-slate-800/50 p-3 rounded-lg border border-slate-700 space-y-3">
                 <div>
                   <label className="block text-xs font-medium text-slate-400 mb-2">{t('director.asset_mode_label')}</label>
                   <div className="grid grid-cols-2 bg-slate-950 p-1 rounded-lg border border-slate-700 gap-1">
                       <button
                           onClick={() => setAssetMode('single_image')}
                           className={`py-1.5 text-xs font-medium rounded transition-colors ${assetMode === 'single_image' ? 'bg-indigo-600 text-white shadow-sm font-semibold' : 'text-slate-400 hover:text-slate-200'}`}
                       >
                           {t('director.mode_single_image', '单张绘图')}
                       </button>
                       <button
                           onClick={() => setAssetMode('video_clip')}
                           className={`py-1.5 text-xs font-medium rounded transition-colors flex items-center justify-center gap-1 ${assetMode === 'video_clip' ? 'bg-indigo-600 text-white shadow-sm font-semibold' : 'text-slate-400 hover:text-slate-200'}`}
                       >
                           <Film size={12} />
                           <span>{t('director.mode_video_clip', 'H3 视频生成')}</span>
                       </button>
                   </div>
                 </div>

                 {/* Video Generation Controls */}
                 {assetMode === 'video_clip' ? (
                   <div className="space-y-3 pt-2 border-t border-slate-700/60">
                     {/* Video Profile */}
                     <div>
                       <label className="block text-[11px] font-semibold text-indigo-300 mb-1.5">
                         {t('director.video_profile', '视频生成档案 (Profile)')}
                       </label>
                       <div className="grid grid-cols-1 gap-1.5">
                         <button
                           type="button"
                           onClick={() => setVideoProfile?.('narrative_clip')}
                           className={`p-2 rounded-lg text-left text-xs border transition-all ${
                             videoProfile === 'narrative_clip'
                               ? 'bg-indigo-950/70 border-indigo-500 text-white shadow'
                               : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                           }`}
                         >
                           <div className="font-semibold flex items-center justify-between">
                             <span>叙事单镜头 (Narrative)</span>
                             {videoProfile === 'narrative_clip' && <span className="text-indigo-400 text-[10px]">● 启用</span>}
                           </div>
                           <p className="text-[10px] text-slate-500 mt-0.5">单动作、运镜与情节推进，保持动作自然连贯</p>
                         </button>

                         <button
                           type="button"
                           onClick={() => setVideoProfile?.('character_loop')}
                           className={`p-2 rounded-lg text-left text-xs border transition-all ${
                             videoProfile === 'character_loop'
                               ? 'bg-indigo-950/70 border-indigo-500 text-white shadow'
                               : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                           }`}
                         >
                           <div className="font-semibold flex items-center justify-between">
                             <span>角色循环动态 (Loop Master)</span>
                             {videoProfile === 'character_loop' && <span className="text-indigo-400 text-[10px]">● 启用</span>}
                           </div>
                           <p className="text-[10px] text-slate-500 mt-0.5">5.0s 严格闭环、静态机位、微动态与 LoopCloser 缝合</p>
                         </button>
                       </div>
                     </div>

                     {/* Video Preset */}
                     <div>
                       <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                         {t('director.video_preset', '分辨率与画质预设')}
                       </label>
                       <div className="grid grid-cols-2 gap-1.5">
                         <button
                           type="button"
                           onClick={() => setVideoPreset?.('preview_480p_5s')}
                           className={`py-1.5 px-2 rounded text-[11px] font-medium border text-center transition-all ${
                             videoPreset === 'preview_480p_5s'
                               ? 'bg-indigo-600 border-indigo-400 text-white font-bold shadow'
                               : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                           }`}
                         >
                           480P 快速预览
                         </button>
                         <button
                           type="button"
                           onClick={() => setVideoPreset?.('standard_720p_5s')}
                           className={`py-1.5 px-2 rounded text-[11px] font-medium border text-center transition-all ${
                             videoPreset === 'standard_720p_5s'
                               ? 'bg-indigo-600 border-indigo-400 text-white font-bold shadow'
                               : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                           }`}
                         >
                           720P 标准画质
                         </button>
                       </div>
                     </div>

                     {/* LoopCloser Toggle for Character Loop */}
                     {videoProfile === 'character_loop' && (
                       <div className="bg-slate-950 p-2 rounded border border-slate-800 flex items-center justify-between">
                         <div className="flex flex-col">
                           <span className="text-[11px] font-semibold text-slate-200 flex items-center gap-1">
                             <ShieldCheck size={12} className="text-emerald-400" />
                             <span>LoopCloser 首尾闭环</span>
                           </span>
                           <span className="text-[9px] text-slate-500">8帧时间混合与接缝误差分析</span>
                         </div>
                         <input
                           type="checkbox"
                           checked={runLoopCloser}
                           onChange={(e) => setRunLoopCloser?.(e.target.checked)}
                           className="w-4 h-4 rounded bg-slate-900 border-slate-700 text-indigo-600 focus:ring-indigo-500"
                         />
                       </div>
                     )}

                     {/* Motion Prompt Override */}
                     <div>
                       <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                         {t('director.motion_prompt', '全局动态提示词 (可选)')}
                       </label>
                       <textarea
                         className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-xs text-slate-300 placeholder-slate-600 resize-none focus:outline-none focus:border-indigo-500 h-14"
                         value={videoMotionPrompt}
                         onChange={(e) => setVideoMotionPrompt?.(e.target.value)}
                         placeholder={t('director.motion_prompt_placeholder', '自然身体微动态，轻柔呼吸，闭口静止...')}
                       />
                     </div>

                     {/* Hardware Capability Card */}
                     <div className="bg-slate-950/80 p-2 rounded border border-slate-800 text-[10px] space-y-1">
                       <div className="flex items-center justify-between text-slate-400">
                         <span className="flex items-center gap-1">
                           <Cpu size={11} className="text-indigo-400" />
                           <span>GPU 显存调度器:</span>
                         </span>
                         <span className="font-mono text-emerald-400 font-semibold">排队序列化 (Max 1)</span>
                       </div>
                       {videoCaps && (
                         <div className="text-[9px] text-slate-500 flex justify-between">
                           <span>ComfyUI H3: {videoCaps.comfyui_online ? '在线' : '未连接'}</span>
                           <span>FFmpeg: {videoCaps.ffmpeg_available ? '就绪' : '缺失'}</span>
                         </div>
                       )}
                     </div>

                     {/* Batch Video Generation Button */}
                     {onBatchGenerateVideo && (
                       <div className="pt-1">
                         {isBatchGeneratingVideo ? (
                           <button
                             type="button"
                             onClick={onStopBatchGenerateVideo}
                             className="w-full py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-lg shadow-rose-600/30 animate-pulse"
                           >
                             <Square size={14} className="fill-current" />
                             <span>停止批量生视频</span>
                           </button>
                         ) : (
                           <button
                             type="button"
                             onClick={onBatchGenerateVideo}
                             disabled={timeline.length === 0}
                             className="w-full py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-lg shadow-purple-600/30 hover:shadow-purple-500/50 disabled:opacity-50"
                           >
                             <Zap size={14} className="fill-current" />
                             <span>{t('director.batch_video_generate', '一键批量生视频')}</span>
                           </button>
                         )}
                       </div>
                     )}
                   </div>
                 ) : (
                   /* Batch Image Generation Button */
                   onBatchGenerate && (
                     <div className="pt-2 border-t border-slate-700/50">
                       {isBatchGenerating ? (
                         <button
                           onClick={onStopBatchGenerate}
                           className="w-full py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-lg shadow-rose-600/30 animate-pulse"
                         >
                           <Square size={14} className="fill-current" />
                           <span>{t('director.stop_batch', 'Stop batch generation')}</span>
                         </button>
                       ) : (
                         <button
                           onClick={onBatchGenerate}
                           disabled={timeline.length === 0}
                           className="w-full py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-600/30 hover:shadow-indigo-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
                         >
                           <Zap size={14} className="fill-current" />
                           <span>{t('director.generate_all', 'Generate all shots')}</span>
                         </button>
                       )}
                     </div>
                   )
                 )}
               </div>

               {/* Unified Project Generation Config & Policy Card */}
               <div className="rounded-lg border bg-slate-950 p-3.5 space-y-2.5 border-slate-800">
                 <div className="flex items-center justify-between gap-2">
                   <span className="font-semibold tracking-wide uppercase text-[11px] text-indigo-400">
                     {t('director.project_gen_config', 'Project render config')}
                   </span>
                   <span className={`px-2 py-0.5 rounded text-[10px] font-bold flex-shrink-0 ${
                     effectiveNsfw ? 'bg-rose-950 border border-rose-800 text-rose-300' : 'bg-emerald-950 border border-emerald-800 text-emerald-300'
                   }`}>
                     {effectiveNsfw
                       ? t('director.nsfw_on_badge', 'NSFW ON')
                       : t('director.sfw_badge', 'SFW')}
                   </span>
                 </div>

                 <div className="space-y-1.5 text-xs">
                   <div className="flex justify-between items-center bg-slate-900 px-2.5 py-1.5 rounded border border-slate-800/80 gap-2">
                     <span className="text-slate-400 flex-shrink-0">{t('director.default_style_label', 'Default style')}</span>
                     <span className="text-slate-200 font-medium truncate max-w-[150px]">{activeStyleLabel}</span>
                   </div>

                   <div className="flex justify-between items-center bg-slate-900 px-2.5 py-1.5 rounded border border-slate-800/80 gap-2">
                     <span className="text-slate-400 flex-shrink-0">{t('director.model_preset_label', 'Model preset')}</span>
                     <span className="text-indigo-300 font-semibold">
                       {projectModelType === 'sd15'
                         ? t('director.model_sd15', 'SD 1.5 Draft')
                         : projectModelType === 'redcraft_krea2'
                         ? t('director.model_redcraft_krea2', 'RedCraft 3.0 (Krea2)')
                         : t('director.model_pony', 'Pony XL')}
                     </span>
                   </div>

                   <div className="flex justify-between items-center bg-slate-900 px-2.5 py-1.5 rounded border border-slate-800/80 gap-2">
                     <span className="text-slate-400 flex-shrink-0">{t('director.canvas_label', 'Canvas')}</span>
                     <span className="text-sky-300 font-semibold">
                       {outputSpec?.orientation_policy === 'auto_by_shot'
                         ? t('director.canvas_auto', 'Auto by shot')
                         : `${outputSpec?.aspect_ratio || '3:4'} · ${outputSpec?.resolution || 'standard'}`}
                     </span>
                   </div>
                 </div>
               </div>
            </div>

            {/* Export & Production */}
            <div className="space-y-4">
               <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                 <Video size={14} />
                 {t('director.export_production', 'Export & production')}
               </h4>
               
               <div className="space-y-2">
                  <button 
                    onClick={onGenerateComic}
                    disabled={generatingComic || timeline.length === 0}
                    className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 hover:text-white rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                  >
                     {generatingComic ? <Loader2 className="animate-spin" size={14} /> : <BookOpen size={14} />}
                     {t('director.generate_comic', '生成本章漫画')}
                  </button>

                  <button
                    onClick={() => void handleGenerateProjectComic()}
                    disabled={generatingProjectComic || !projectId}
                    className="w-full py-2.5 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-indigo-200 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="严格模式：所有章节必须已有分镜，且每个正式 Scene 都必须有图片"
                  >
                    {generatingProjectComic ? <Loader2 className="animate-spin" size={14} /> : <Library size={14} />}
                    {t('director.generate_project_comic', '生成整本漫画 PDF')}
                  </button>

                  <p className="px-1 text-[10px] leading-relaxed text-slate-600">
                    {t('director.project_comic_strict_hint', '整本导出采用严格模式：任一章节缺少分镜或任一 Scene 缺图时不会生成不完整 PDF。')}
                  </p>
               </div>

               {comicPages.length > 0 && (
                  <button 
                     onClick={() => setShowComicViewer(true)}
                     className="w-full py-2 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 text-indigo-300 rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition-colors"
                  >
                     <BookOpen size={14} />
                     {t('director.view_comic')} ({comicPages.length}P)
                  </button>
               )}
            </div>

            {/* Stats */}
            <div className="space-y-4 mt-auto">
               <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-800/30 p-3 rounded border border-slate-800 text-center">
                     <span className="block text-xl font-bold text-white">{timeline.length}</span>
                     <span className="text-[10px] text-slate-500 uppercase">{t('director.stats_scenes')}</span>
                  </div>
                  <div className="bg-slate-800/30 p-3 rounded border border-slate-800 text-center">
                     <span className="block text-xl font-bold text-white">
                       {timeline.reduce((acc, curr) => acc + (typeof curr.duration === 'number' ? curr.duration : parseFloat(curr.duration || "0")), 0).toFixed(1)}s
                     </span>
                     <span className="text-[10px] text-slate-500 uppercase">{t('director.stats_duration')}</span>
                  </div>
               </div>
            </div>
         </div>
      </div>

      {/* Backdrop for Mobile Drawer */}
      {showRightPanel && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setShowRightPanel(false)}
        />
      )}
    </>
  );
};
