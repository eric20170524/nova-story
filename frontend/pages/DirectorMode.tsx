import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../services/api';
import { Chapter, Scene, Workflow, StreamMessage, AssetMode } from '../types';
import { API_BASE_URL, findVisualStyle, getVisualStyles, STANDARD_VISUAL_STYLES } from '../constants';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import { ComicViewer } from '../components/ComicViewer';
import { DirectorSidebar } from '../components/Director/DirectorSidebar';
import { DirectorTimeline } from '../components/Director/DirectorTimeline';
import { DirectorRightPanel } from '../components/Director/DirectorRightPanel';
import { AlertTriangle, Film } from 'lucide-react';

export const DirectorMode: React.FC = () => {
  const { id: projectId } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapterId, setSelectedChapterId] = useState<string>('');
  const [timeline, setTimeline] = useState<Scene[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  
  // Style Settings
  const [selectedStyle, setSelectedStyle] = useState<string>(() => {
    const saved = localStorage.getItem('director_selectedStyle');
    const styles = getVisualStyles();
    if (saved && styles.some((s) => s.value === saved)) return saved;
    return STANDARD_VISUAL_STYLES[0].value;
  });
  const [styleStrength, setStyleStrength] = useState<number>(1.0); // 0.1 to 2.0
  
  // Decoupled Asset Mode
  const [assetMode, setAssetMode] = useState<AssetMode>(() => {
    return (localStorage.getItem('director_assetMode') as AssetMode) || 'single_image';
  });

  // Re-storyboard Confirmation Modal
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const [loading, setLoading] = useState(false);
  const [renderingVideo, setRenderingVideo] = useState(false);
  const [projectCharacters, setProjectCharacters] = useState<any[]>([]);
  const [showRightPanel, setShowRightPanel] = useState(false);
  const [activeTab, setActiveTab] = useState<'control' | 'agent'>('control');

  // Comic State
  const [generatingComic, setGeneratingComic] = useState(false);
  const [comicPages, setComicPages] = useState<any[]>([]);
  const [comicPdf, setComicPdf] = useState<string | null>(null);
  const [showComicViewer, setShowComicViewer] = useState(false);

  // Batch Generation State
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const stopBatchRef = React.useRef<boolean>(false);
  const activeEvtSourceRef = React.useRef<EventSource | null>(null);

  // Persist settings
  useEffect(() => {
    localStorage.setItem('director_selectedStyle', selectedStyle);
  }, [selectedStyle]);

  // Drop advanced style selection if advanced styles are disabled
  useEffect(() => {
    const refresh = () => {
      const styles = getVisualStyles();
      if (!styles.some((s) => s.value === selectedStyle)) {
        setSelectedStyle(STANDARD_VISUAL_STYLES[0].value);
      }
    };
    window.addEventListener('novastory-advanced-styles-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('novastory-advanced-styles-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [selectedStyle]);

  useEffect(() => {
    localStorage.setItem('director_assetMode', assetMode);
  }, [assetMode]);

  useEffect(() => {
    if (projectId && selectedChapterId) {
      localStorage.setItem(`director_project_${projectId}_chapter`, selectedChapterId);
    }
  }, [projectId, selectedChapterId]);

  // Load initial data
  useEffect(() => {
    if (projectId) {
      api.getChapters(Number(projectId)).then(data => {
        if(Array.isArray(data)) {
          const sorted = data.sort((a, b) => a.index - b.index);
          setChapters(sorted);
          const savedChapterId = localStorage.getItem(`director_project_${projectId}_chapter`);
          if (savedChapterId && data.some(c => c.id === savedChapterId)) {
            setSelectedChapterId(savedChapterId);
          } else if (data.length > 0) {
            setSelectedChapterId(data[0].id);
          }
        }
      }).catch(console.error);

      api.getCharacters(Number(projectId)).then(data => {
          if(Array.isArray(data)) {
              setProjectCharacters(data);
          }
      }).catch(console.error);
      
      api.getWorkflows().then(data => {
        if(Array.isArray(data)) {
          setWorkflows(data);
        }
      }).catch(console.error);
    }
  }, [projectId]);

  const loadTimeline = (chapterId: string) => {
    if (!chapterId) return;
    setLoading(true);
    api.getTimeline(chapterId)
      .then(data => {
        if (data && data.timeline) {
          const scenes = data.timeline.map((s: Scene) => ({ 
            ...s, 
            asset_status: s.asset_status || 'idle' 
          }));
          setTimeline(scenes);
        } else {
          setTimeline([]);
        }
      })
      .catch(() => setTimeline([]))
      .finally(() => setLoading(false));
  };

  // Load timeline when chapter is selected
  useEffect(() => {
    if (selectedChapterId) {
      loadTimeline(selectedChapterId);
    }
  }, [selectedChapterId]);

  const triggerGenerateTimeline = () => {
    if (!selectedChapterId) return;
    if (timeline.length > 0) {
      setShowConfirmModal(true);
    } else {
      executeGenerateTimeline();
    }
  };

  const executeGenerateTimeline = async () => {
    if (!selectedChapterId) return;
    setShowConfirmModal(false);
    setLoading(true);
    try {
      const res = await api.generateTimeline(selectedChapterId, 'narrative');
      const scenes = res.timeline.map((s: Scene) => ({ ...s, asset_status: s.asset_status || 'idle' }));
      setTimeline(scenes);
      showToast(t('director.timeline_generated') || "Timeline generated", 'success');
    } catch (e: any) {
      const errMsg = e.message || t('director.error_timeline');
      showToast(errMsg, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateScene = (id: number | string, field: keyof Scene, value: any) => {
    setTimeline(prev => prev.map(s => s.id === id ? { ...s, [field]: value } : s));
    
    // Save edit persistence to backend
    if (typeof id === 'number') {
      api.updateScene(id, { [field]: value }).catch(err => {
        console.error("Failed to persist scene update:", err);
      });
    }
  };

  const generateAsset = async (sceneId: number | string) => {
    const scene = timeline.find(s => s.id === sceneId);
    if (!scene) return;

    const styleObj = findVisualStyle(selectedStyle);
    const stylePromptRaw = styleObj ? styleObj.prompt : '';
    const globalNegative = styleObj && styleObj.negative_prompt ? styleObj.negative_prompt : '';
    
    let finalPrompt = "";

    const cameraDetails = [
      scene.shot_type, 
      scene.camera_movement, 
      scene.camera_angle
    ].filter(Boolean).join(", ");
    
    if (cameraDetails) {
        finalPrompt += `(${cameraDetails}), `;
    }

    finalPrompt += scene.visual_prompt || "";

    if (projectCharacters.length > 0 && scene.visual_prompt) {
        const lowerPrompt = scene.visual_prompt.toLowerCase();
        projectCharacters.forEach(char => {
            if (char.name && lowerPrompt.includes(char.name.toLowerCase())) {
                let tagStr = "";
                const tags = char.visual_tags;
                
                if (tags && typeof tags === 'object') {
                    if ("base_model" in tags) {
                        const baseTags = tags.base_model?.tags || {};
                        let variantTags = {};
                        const timelineMap = tags.timeline_map || {};
                        let variantId = timelineMap[selectedChapterId];
                        const variants = tags.variants || [];
                        if (variantId) {
                            const variant = variants.find((v: any) => v.id === variantId);
                            if (variant) variantTags = variant.tags || {};
                        }
                        const combined = { ...baseTags, ...variantTags };
                        tagStr = Object.values(combined).join(", ");
                    } else {
                        tagStr = Object.values(tags).join(", ");
                    }
                }

                if (tagStr) {
                    finalPrompt += `, ${char.name} appearance: ${tagStr}`;
                }
            }
        });
    }

    if (stylePromptRaw) {
        if (styleStrength !== 1.0) {
            finalPrompt += `, (${stylePromptRaw}:${styleStrength})`;
        } else {
            finalPrompt += `, ${stylePromptRaw}`;
        }
    }

    let finalNegative = globalNegative;
    if (scene.negative_prompt) {
        finalNegative = finalNegative ? `${finalNegative}, ${scene.negative_prompt}` : scene.negative_prompt;
    }

    setTimeline(prev => prev.map(s => s.id === sceneId ? { ...s, asset_status: 'generating' } : s));

    try {
      const backendAssetMode = assetMode === 'contact_sheet_3x3' ? 'cinematic_grid' : 'standard';
      const payload = { 
          prompt: finalPrompt,
          negative_prompt: finalNegative,
          style_preset: selectedStyle,
          mode: backendAssetMode
      };
      
      const response = await api.generateAsset(payload, sceneId);
      const taskId = response.task_id;

      setTimeline(prev => prev.map(s => s.id === sceneId ? { ...s, task_id: taskId } : s));

      return new Promise<void>((resolve) => {
          if (taskId === 'mock-task-999') {
            setTimeout(() => {
              setTimeline(prev => prev.map(s => 
                s.id === sceneId ? { ...s, asset_status: 'completed', asset_url: `https://placehold.co/600x600/1e293b/6366f1?text=Scene+${sceneId}+Generated` } : s
              ));
              resolve();
            }, 3000);
          } else {
            const evtSource = new EventSource(`${API_BASE_URL}/assets/stream/${taskId}`);
            activeEvtSourceRef.current = evtSource;
            
            evtSource.onmessage = (event) => {
              const data: StreamMessage = JSON.parse(event.data);
              
              if (data.status === 'completed' && data.image_url) {
                setTimeline(prev => prev.map(s => 
                  s.id === sceneId ? { ...s, asset_status: 'completed', asset_url: data.image_url } : s
                ));
                evtSource.close();
                activeEvtSourceRef.current = null;
                resolve();
              } else if (data.status === 'failed') {
                const errorDetail = (data as any).error || ("Generation failed for scene " + sceneId);
                showToast(errorDetail, 'error');
                setTimeline(prev => prev.map(s => s.id === sceneId ? { ...s, asset_status: 'failed' } : s));
                evtSource.close();
                activeEvtSourceRef.current = null;
                resolve();
              }
            };

            evtSource.onerror = () => {
              evtSource.close();
              activeEvtSourceRef.current = null;
              setTimeline(prev => prev.map(s => s.id === sceneId ? { ...s, asset_status: 'failed' } : s));
              resolve(); 
            };
          }
      });

    } catch (e: any) {
      console.error(e);
      setTimeline(prev => prev.map(s => s.id === sceneId ? { ...s, asset_status: 'failed' } : s));
      showToast(e.message || ("Generation failed for scene " + sceneId), 'error');
    }
  };

  const handleBatchGenerate = async () => {
      if (isBatchGenerating || timeline.length === 0) return;

      stopBatchRef.current = false;
      setIsBatchGenerating(true);
      showToast("Sequential batch generation started", 'info');
      
      for (const scene of timeline) {
          if (stopBatchRef.current) break;

          await generateAsset(scene.id);

          if (stopBatchRef.current) break;

          await new Promise(r => setTimeout(r, 500));
      }
      
      const wasStopped = stopBatchRef.current;
      setIsBatchGenerating(false);
      stopBatchRef.current = false;

      if (wasStopped) {
          showToast(t('director.batch_stopped') || "Batch generation stopped", 'warning');
      } else {
          showToast("Batch generation complete", 'success');
      }
  };

  const handleStopBatchGenerate = async () => {
      stopBatchRef.current = true;
      if (activeEvtSourceRef.current) {
          activeEvtSourceRef.current.close();
          activeEvtSourceRef.current = null;
      }
      try {
          await api.cancelAssetGeneration();
      } catch (e) {
          console.error("Failed to cancel asset generation on backend:", e);
      }
      setIsBatchGenerating(false);
      showToast(t('director.batch_stopped') || "Batch generation stopped", 'warning');
  };

  const handleGenerateComic = async () => {
    if (!selectedChapterId) return;
    setGeneratingComic(true);
    try {
        const res = await api.generateComic(selectedChapterId);
        if (res.pages) {
            setComicPages(res.pages);
            setComicPdf(res.pdf_url);
            setShowComicViewer(true);
            showToast("Comic generated successfully", 'success');
        } else {
            showToast("No pages generated.", 'error');
        }
    } catch (e) {
        console.error(e);
        showToast("Failed to generate comic. Ensure all scenes have images.", 'error');
    } finally {
        setGeneratingComic(false);
    }
  };

  const handleRenderVideo = async () => {
      if (timeline.length === 0) return;
      setRenderingVideo(true);
      try {
          const res = await api.renderVideo(timeline, Number(projectId));
          if (res.video_url) {
              window.open(res.video_url, '_blank');
              showToast("Video rendering completed", 'success');
          } else {
              showToast("Video rendering started", 'info');
          }
      } catch (e) {
          console.error(e);
          showToast("Failed to start video rendering.", 'error');
      } finally {
          setRenderingVideo(false);
      }
  };

  return (
    <div className="flex h-full bg-slate-950">
      
      <DirectorSidebar 
        chapters={chapters}
        selectedChapterId={selectedChapterId}
        onSelectChapter={setSelectedChapterId}
      />

      <DirectorTimeline 
        timeline={timeline}
        loading={loading}
        selectedChapterId={selectedChapterId}
        onGenerateTimeline={triggerGenerateTimeline}
        showRightPanel={showRightPanel}
        setShowRightPanel={setShowRightPanel}
        onGenerateAsset={generateAsset}
        onUpdateScene={handleUpdateScene}
        onRefreshTimeline={() => loadTimeline(selectedChapterId)}
      />
      
      <DirectorRightPanel
        showRightPanel={showRightPanel}
        setShowRightPanel={setShowRightPanel}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedStyle={selectedStyle}
        setSelectedStyle={setSelectedStyle}
        styleStrength={styleStrength}
        setStyleStrength={setStyleStrength}
        assetMode={assetMode}
        setAssetMode={setAssetMode}
        renderingVideo={renderingVideo}
        onRenderVideo={handleRenderVideo}
        generatingComic={generatingComic}
        onGenerateComic={handleGenerateComic}
        comicPages={comicPages}
        showComicViewer={showComicViewer}
        setShowComicViewer={setShowComicViewer}
        timeline={timeline}
        projectId={projectId}
        selectedChapterId={selectedChapterId}
        onRefreshTimeline={triggerGenerateTimeline}
        isBatchGenerating={isBatchGenerating}
        onBatchGenerate={handleBatchGenerate}
        onStopBatchGenerate={handleStopBatchGenerate}
      />

      {showComicViewer && (
        <ComicViewer 
            pages={comicPages} 
            pdfUrl={comicPdf} 
            onClose={() => setShowComicViewer(false)} 
        />
      )}

      {/* Re-storyboard Overwrite Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
            <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-md p-6 shadow-2xl space-y-4">
                <div className="flex items-center gap-3 text-amber-400">
                    <AlertTriangle size={24} />
                    <h3 className="text-lg font-bold text-white">{t('director.confirm_title')}</h3>
                </div>
                <p className="text-sm text-slate-300 leading-relaxed">
                    {t('director.confirm_desc')}
                </p>
                <div className="flex justify-end gap-3 pt-2">
                    <button 
                        onClick={() => setShowConfirmModal(false)}
                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors"
                    >
                        {t('director.confirm_no')}
                    </button>
                    <button 
                        onClick={() => executeGenerateTimeline()}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                    >
                        <Film size={16} />
                        {t('director.confirm_yes')}
                    </button>
                </div>
            </div>
        </div>
      )}

    </div>
  );
};
