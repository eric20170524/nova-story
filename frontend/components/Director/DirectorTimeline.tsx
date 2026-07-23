import React, { useState } from 'react';
import { Loader2, Film, PanelRight, ImageIcon, RefreshCw, ChevronDown, ChevronUp, AlertCircle, Music, Grid } from 'lucide-react';
import { Scene } from '../../types';
import { API_BASE_URL, SHOT_TYPES, CAMERA_MOVEMENTS, CAMERA_ANGLES } from '../../constants';
import { useLanguage } from '../../LanguageContext';
import { SceneCardSkeleton } from '../Skeleton';

interface DirectorTimelineProps {
  timeline: Scene[];
  loading: boolean;
  selectedChapterId: string;
  onGenerateTimeline: (mode: 'standard' | 'cinematic_grid') => void;
  showRightPanel: boolean;
  setShowRightPanel: (show: boolean) => void;
  onGenerateAsset: (sceneId: number | string) => void;
  onUpdateScene: (id: number | string, field: keyof Scene, value: any) => void;
}

export const DirectorTimeline: React.FC<DirectorTimelineProps> = ({
  timeline,
  loading,
  selectedChapterId,
  onGenerateTimeline,
  showRightPanel,
  setShowRightPanel,
  onGenerateAsset,
  onUpdateScene
}) => {
  const { t } = useLanguage();
  const [expandedCards, setExpandedCards] = useState<Set<number | string>>(new Set());
  const [showGenerateMenu, setShowGenerateMenu] = useState(false);

  const toggleExpand = (id: number | string) => {
    const newSet = new Set(expandedCards);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setExpandedCards(newSet);
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-slate-950">
      {/* Header */}
      <div className="h-14 border-b border-slate-800 flex items-center justify-between px-4 lg:px-6 bg-slate-925">
         <h2 className="text-white font-medium truncate mr-4">{t('director.storyboard')}</h2>
         
         <div className="flex items-center gap-3">
           <button 
              onClick={() => onGenerateTimeline('standard')}
              disabled={loading || !selectedChapterId}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 lg:px-4 py-1.5 rounded flex items-center gap-2 text-sm font-medium disabled:opacity-50 whitespace-nowrap"
            >
              {loading ? <Loader2 className="animate-spin" size={16} /> : <Film size={16} />}
              <span className="hidden sm:inline">{t('director.generate_scenes')}</span>
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
                // Skeletons
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
                        <div className="p-3 bg-slate-850 border-b border-slate-800 flex justify-between items-center">
                            <span className="font-mono text-xs text-indigo-400 font-bold">{t('director.scene')} {idx + 1}</span>
                            <span className="text-xs text-slate-500">{scene.duration}s</span>
                        </div>

                        {/* Image Area */}
                        <div className="aspect-square bg-black relative flex items-center justify-center group/image h-64">
                            {scene.asset_status === 'completed' && scene.asset_url ? (
                                <img 
                                src={scene.asset_url.startsWith('/static') ? `${API_BASE_URL.replace('/api', '')}${scene.asset_url}` : scene.asset_url} 
                                alt="Scene" 
                                className="w-full h-full object-cover" 
                                />
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
                            
                            {/* Overlay Trigger */}
                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover/image:opacity-100 flex items-center justify-center transition-opacity">
                                <button 
                                onClick={() => onGenerateAsset(scene.id)}
                                disabled={scene.asset_status === 'generating'}
                                className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-full font-medium text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                <RefreshCw size={14} className={scene.asset_status === 'generating' ? "animate-spin" : ""} />
                                {scene.asset_status === 'generating' ? t('director.status_generating') : t('director.generate')}
                                </button>
                            </div>
                        </div>

                        {/* Content (Editable) */}
                        <div className="flex-1 p-3 flex flex-col gap-2 bg-slate-900 border-t border-slate-800">
                            {/* Camera Details Dropdowns (Editable) */}
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
                                {/* Audio Prompt */}
                                <div>
                                    <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 flex items-center gap-1">
                                        <Music size={10} />
                                        Audio Prompt
                                    </label>
                                    <textarea
                                        className="w-full bg-slate-950/50 border border-slate-800 rounded p-2 text-xs text-slate-400 leading-relaxed resize-none focus:outline-none focus:border-indigo-500/50 h-12"
                                        value={scene.audio_prompt || ''}
                                        onChange={(e) => onUpdateScene(scene.id, 'audio_prompt', e.target.value)}
                                        placeholder="Sound effects, bgm..."
                                    />
                                </div>

                                {/* Negative Prompt */}
                                <div>
                                    <label className="text-[10px] font-bold text-red-400/80 uppercase mb-1 flex items-center gap-1">
                                        <AlertCircle size={10} />
                                        Negative Prompt
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
    </div>
  );
};