import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../services/api';
import { Chapter, Scene, Workflow, StreamMessage } from '../types';
import { API_BASE_URL, VISUAL_STYLES } from '../constants';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import { ComicViewer } from '../components/ComicViewer';
import { DirectorSidebar } from '../components/Director/DirectorSidebar';
import { DirectorTimeline } from '../components/Director/DirectorTimeline';
import { DirectorRightPanel } from '../components/Director/DirectorRightPanel';

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
    return localStorage.getItem('director_selectedStyle') || VISUAL_STYLES[0].value;
  });
  const [styleStrength, setStyleStrength] = useState<number>(1.0); // 0.1 to 2.0
  const [assetMode, setAssetMode] = useState<'standard' | 'cinematic_grid'>('standard');

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

  // Load timeline when chapter is selected
  useEffect(() => {
    if (selectedChapterId) {
      setLoading(true);
      api.getTimeline(selectedChapterId)
        .then(data => {
          if (data && data.timeline) {
            // Ensure UI state properties exist
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
    }
  }, [selectedChapterId]);

  const generateTimeline = async (mode: 'standard' | 'cinematic_grid' = 'standard') => {
    if (!selectedChapterId) return;
    setLoading(true);
    try {
      const res = await api.generateTimeline(selectedChapterId, mode);
      // Ensure each scene has local state properties for UI
      const scenes = res.timeline.map((s: Scene) => ({ ...s, asset_status: s.asset_status || 'idle' }));
      setTimeline(scenes);
      showToast(t('director.timeline_generated') || "Timeline generated", 'success');
    } catch (e) {
      showToast(t('director.error_timeline'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateScene = (id: number | string, field: keyof Scene, value: any) => {
    setTimeline(prev => prev.map(s => s.id === id ? { ...s, [field]: value } : s));
  };

  const generateAsset = async (sceneId: number | string) => {
    // Find the current scene
    const scene = timeline.find(s => s.id === sceneId);
    if (!scene) return;

    // Find style prompt
    const styleObj = VISUAL_STYLES.find(s => s.value === selectedStyle);
    const stylePromptRaw = styleObj ? styleObj.prompt : '';
    const globalNegative = styleObj && styleObj.negative_prompt ? styleObj.negative_prompt : '';
    
    // Construct final prompt with "Camera -> Content -> Character -> Style" logic
    let finalPrompt = "";

    // 0. Camera Constraints (Hard Constraint at the beginning)
    // Join defined camera params
    const cameraDetails = [
      scene.shot_type, 
      scene.camera_movement, 
      scene.camera_angle
    ].filter(Boolean).join(", ");
    
    if (cameraDetails) {
        finalPrompt += `(${cameraDetails}), `;
    }

    // 1. Scene Content (User editable)
    finalPrompt += scene.visual_prompt || "";

    // 2. Inject Character Visual Tags (if character name is in prompt)
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

    // 3. Append Style with Weighting
    if (stylePromptRaw) {
        if (styleStrength !== 1.0) {
            finalPrompt += `, (${stylePromptRaw}:${styleStrength})`;
        } else {
            finalPrompt += `, ${stylePromptRaw}`;
        }
    }

    // 4. Combine Negative Prompts (Scene Specific + Global Style)
    let finalNegative = globalNegative;
    if (scene.negative_prompt) {
        finalNegative = finalNegative ? `${finalNegative}, ${scene.negative_prompt}` : scene.negative_prompt;
    }

    const fullPromptWithNegative = finalNegative ? `${finalPrompt} --no ${finalNegative}` : finalPrompt;

    console.log(`[DirectorMode] Generated Prompt: ${finalPrompt}`);

    // Optimistic Update
    setTimeline(prev => prev.map(s => s.id === sceneId ? { ...s, asset_status: 'generating' } : s));

    try {
      const payload = { 
          prompt: fullPromptWithNegative, // Fallback for simple APIs
          negative_prompt: finalNegative,  // Explicit field for sophisticated APIs
          style_preset: selectedStyle,
          mode: assetMode // Add mode to payload
      };
      
      const response = await api.generateAsset(payload, sceneId);
      const taskId = response.task_id;

      // Update state with taskId
      setTimeline(prev => prev.map(s => s.id === sceneId ? { ...s, task_id: taskId } : s));

      // Return promise for batch handling
      return new Promise<void>((resolve, reject) => {
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
                resolve(); // Resolve even on failure to continue batch
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

    } catch (e) {
      console.error(e);
      setTimeline(prev => prev.map(s => s.id === sceneId ? { ...s, asset_status: 'failed' } : s));
      showToast("Generation failed for scene " + sceneId, 'error');
    }
  };

  const handleBatchGenerate = async () => {
      if (isBatchGenerating || timeline.length === 0) return;
      
      if (!confirm(`Generate assets for ${timeline.length} scenes? This may take a while.`)) return;

      stopBatchRef.current = false;
      setIsBatchGenerating(true);
      showToast("Batch generation started", 'info');
      
      for (const scene of timeline) {
          if (stopBatchRef.current) break;

          if (scene.asset_status === 'generating') continue;
          if (scene.asset_status === 'completed') continue; 

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
        onGenerateTimeline={generateTimeline}
        assetMode={assetMode}
        showRightPanel={showRightPanel}
        setShowRightPanel={setShowRightPanel}
        onGenerateAsset={generateAsset}
        onUpdateScene={handleUpdateScene}
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
        onRefreshTimeline={generateTimeline}
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

    </div>
  );
};