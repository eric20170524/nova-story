import React, { useEffect, useState } from 'react';
import { Loader2, Video, BookOpen, Settings, X, Sliders, Bot, Zap, PlayCircle, Square } from 'lucide-react';
import { Scene, AssetMode } from '../../types';
import { formatVisualStyleLabel, getVisualStyles, type VisualStyleDef } from '../../constants';
import { useLanguage } from '../../LanguageContext';
import { AgentAssistant } from '../AgentAssistant';

export type ProjectNsfwMode = 'inherit' | 'on' | 'off';

interface DirectorRightPanelProps {
  showRightPanel: boolean;
  setShowRightPanel: (show: boolean) => void;
  activeTab: 'control' | 'agent';
  setActiveTab: (tab: 'control' | 'agent') => void;
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
  projectId: string | undefined;
  selectedChapterId: string;
  onRefreshTimeline: () => void;
  isBatchGenerating?: boolean;
  onBatchGenerate?: () => void;
  onStopBatchGenerate?: () => void;
  /** Project nsfw_mode from settings */
  projectNsfwMode?: ProjectNsfwMode;
  /** Effective NSFW after resolve(system, project) */
  effectiveNsfw?: boolean;
  systemNsfw?: boolean;
}

export const DirectorRightPanel: React.FC<DirectorRightPanelProps> = ({
  showRightPanel,
  setShowRightPanel,
  activeTab,
  setActiveTab,
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
  projectId,
  selectedChapterId,
  onRefreshTimeline,
  isBatchGenerating,
  onBatchGenerate,
  onStopBatchGenerate,
  projectNsfwMode = 'inherit',
  effectiveNsfw = false,
  systemNsfw = false
}) => {
  const { t } = useLanguage();
  const [visualStyles, setVisualStyles] = useState<VisualStyleDef[]>(() => getVisualStyles());

  useEffect(() => {
    const refresh = () => setVisualStyles(getVisualStyles());
    window.addEventListener('novastory-advanced-styles-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('novastory-advanced-styles-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return (
    <>
      <div className={`
        fixed inset-y-0 right-0 w-80 bg-slate-900 border-l border-slate-800 shadow-2xl z-50 transform transition-transform duration-300
        lg:static lg:translate-x-0 lg:shadow-none lg:w-80 lg:flex lg:flex-col
        ${showRightPanel ? 'translate-x-0' : 'translate-x-full'}
      `}>
         {/* Mobile Header */}
         <div className="flex justify-between items-center lg:hidden p-4 border-b border-slate-800">
             <h4 className="font-semibold text-white">{t('director.production_controls')}</h4>
             <button onClick={() => setShowRightPanel(false)} className="text-slate-400 hover:text-white">
               <X size={20} />
             </button>
         </div>

         {/* Tab Switcher */}
         <div className="flex border-b border-slate-800 bg-slate-900">
            <button
              onClick={() => setActiveTab('control')}
              className={`flex-1 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                activeTab === 'control' 
                  ? 'text-indigo-400 border-b-2 border-indigo-500 bg-slate-800/50' 
                  : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Sliders size={14} />
              {t('director.controls')}
            </button>
            <button
              onClick={() => setActiveTab('agent')}
              className={`flex-1 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                activeTab === 'agent' 
                  ? 'text-indigo-400 border-b-2 border-indigo-500 bg-slate-800/50' 
                  : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Bot size={14} />
              {t('director.assistant')}
            </button>
         </div>

         {/* Tab Content */}
         <div className="flex-1 overflow-hidden relative">
            
            {/* Control Tab */}
            {activeTab === 'control' && (
              <div className="h-full overflow-y-auto p-4 gap-6 flex flex-col">
                {/* Render Controls */}
                <div className="space-y-4">
                   <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                     <Sliders size={14} />
                     {t('director.production_settings')}
                   </h4>

                   {/* Project image policy strip */}
                   <div className={`rounded-lg border px-3 py-2.5 text-xs space-y-1.5 ${
                     effectiveNsfw
                       ? 'bg-rose-950/40 border-rose-800/50 text-rose-100'
                       : 'bg-emerald-950/30 border-emerald-800/40 text-emerald-100'
                   }`}>
                     <div className="flex items-center justify-between gap-2">
                       <span className="font-semibold tracking-wide uppercase text-[10px] opacity-80">
                         {t('director.policy_title') || 'Image Policy'}
                       </span>
                       <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                         effectiveNsfw
                           ? 'bg-rose-600/80 text-white'
                           : 'bg-emerald-600/80 text-white'
                       }`}>
                         {effectiveNsfw
                           ? (t('director.policy_nsfw_on') || 'NSFW ON')
                           : (t('director.policy_nsfw_off') || 'SFW')}
                       </span>
                     </div>
                     <p className="text-[11px] leading-relaxed opacity-90">
                       {projectNsfwMode === 'on' && (t('director.policy_project_on') || 'Project forces adult LoRA + prompt policy.')}
                       {projectNsfwMode === 'off' && (t('director.policy_project_off') || 'Project forces SFW only.')}
                       {projectNsfwMode === 'inherit' && (
                         effectiveNsfw
                           ? (t('director.policy_inherit_on') || 'Following system NSFW (enabled).')
                           : (t('director.policy_inherit_off') || 'Following system NSFW (disabled).')
                       )}
                       {' '}
                       <span className="opacity-70">
                         ({t('director.policy_system') || 'System'}: {systemNsfw ? 'ON' : 'OFF'})
                       </span>
                     </p>
                   </div>
                   
                   <div className="bg-slate-800/50 p-4 rounded-lg border border-slate-700 space-y-4">
                     <div>
                       <label className="block text-xs font-medium text-slate-400 mb-2">{t('director.asset_mode_label')}</label>
                       <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-700">
                           <button
                               onClick={() => setAssetMode('single_image')}
                               className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${assetMode === 'single_image' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                           >
                               {t('director.asset_mode_single')}
                           </button>
                           <button
                               onClick={() => setAssetMode('contact_sheet_3x3')}
                               className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${assetMode === 'contact_sheet_3x3' ? 'bg-purple-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                           >
                               {t('director.asset_mode_contact_sheet')}
                           </button>
                       </div>
                       <p className="text-[11px] text-slate-400 mt-1.5">
                         {assetMode === 'contact_sheet_3x3' ? t('director.contact_sheet_desc') : '每张分镜卡片生成 1 张单独的普通素材图片。'}
                       </p>
                     </div>

                     <div>
                       <label className="block text-xs font-medium text-slate-400 mb-2">{t('director.style')}</label>
                       <select 
                          className="w-full bg-slate-950 border border-slate-700 text-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                          value={selectedStyle}
                          onChange={(e) => setSelectedStyle(e.target.value)}
                        >
                          {visualStyles.map(s => (
                            <option key={s.value} value={s.value}>
                              {formatVisualStyleLabel(s, t(`director.styles.${s.value}`) || s.label)}
                            </option>
                          ))}
                        </select>
                     </div>

                     {setStyleStrength && (
                       <div>
                         <div className="flex justify-between items-center mb-2">
                            <label className="block text-xs font-medium text-slate-400 flex items-center gap-1">
                               <Zap size={12} className="text-yellow-500" />
                               Style Strength
                            </label>
                            <span className="text-xs text-indigo-400 font-mono">{styleStrength.toFixed(1)}</span>
                         </div>
                         <input 
                           type="range" 
                           min="0.1" 
                           max="2.0" 
                           step="0.1" 
                           value={styleStrength}
                           onChange={(e) => setStyleStrength(parseFloat(e.target.value))}
                           className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                         />
                         <div className="flex justify-between text-[10px] text-slate-600 mt-1">
                           <span>Subtle</span>
                           <span>Balanced</span>
                           <span>Strong</span>
                         </div>
                       </div>
                     )}
                   </div>

                   {/* Action Buttons */}
                   <div className="space-y-2">
                        {isBatchGenerating ? (
                            <button
                                onClick={onStopBatchGenerate}
                                className="w-full bg-red-600 hover:bg-red-500 text-white py-3 rounded-lg flex items-center justify-center gap-2 text-sm font-medium transition-colors shadow-lg shadow-red-900/30 animate-pulse"
                            >
                                <Square size={18} className="fill-current" />
                                {t('director.stop_batch') || 'Stop Batch Generation'}
                            </button>
                        ) : (
                            onBatchGenerate && (
                                <button
                                    onClick={onBatchGenerate}
                                    disabled={timeline.length === 0}
                                    className="w-full bg-slate-700 hover:bg-slate-600 text-white py-3 rounded-lg flex items-center justify-center gap-2 text-sm font-medium disabled:opacity-50 transition-colors"
                                >
                                    <PlayCircle size={18} />
                                    {t('director.generate_all') || 'Generate All Assets'}
                                </button>
                            )
                        )}

                        <button
                            onClick={onRenderVideo}
                            disabled={renderingVideo || timeline.length === 0}
                            className="w-full bg-green-600 hover:bg-green-500 text-white py-3 rounded-lg flex items-center justify-center gap-2 text-sm font-medium disabled:opacity-50 disabled:bg-slate-800 transition-colors shadow-lg shadow-green-900/20"
                            >
                            {renderingVideo ? <Loader2 className="animate-spin" size={18} /> : <Video size={18} />}
                            {t('director.render_video')}
                        </button>

                        <button
                            onClick={onGenerateComic}
                            disabled={generatingComic || timeline.length === 0}
                            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-3 rounded-lg flex items-center justify-center gap-2 text-sm font-medium disabled:opacity-50 disabled:bg-slate-800 transition-colors shadow-lg shadow-indigo-900/20"
                        >
                            {generatingComic ? <Loader2 className="animate-spin" size={18} /> : <BookOpen size={18} />}
                            {t('director.generate_comic')}
                        </button>
                   </div>
                    
                    {comicPages.length > 0 && !showComicViewer && (
                        <button
                            onClick={() => setShowComicViewer(true)}
                            className="w-full bg-slate-700 hover:bg-slate-600 text-white py-2 rounded-lg flex items-center justify-center gap-2 text-xs font-medium transition-colors"
                        >
                            {t('director.view_comic')}
                        </button>
                    )}
                </div>

                {/* Stats / Info */}
                <div className="flex-1">
                   <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                     <Settings size={14} />
                     {t('director.stats')}
                   </h4>
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
            )}

            {/* Agent Tab */}
            {activeTab === 'agent' && (
              <div className="h-full absolute inset-0">
                 <AgentAssistant 
                    projectId={projectId} 
                    chapterId={selectedChapterId} 
                    onRefresh={onRefreshTimeline}
                 />
              </div>
            )}

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