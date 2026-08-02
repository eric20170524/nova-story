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
import { AlertTriangle, Film, Settings } from 'lucide-react';

/** Match Chinese character names against English/pinyin mentions in visual_prompt */
const CHARACTER_NAME_ALIASES: Record<string, string[]> = {
  陆嘉静: ['lu jiajing', 'lujiajing', 'jiajing', 'lu jia jing'],
  裴雨涵: ['pei yuhan', 'peiyuhan', 'yuhan', 'pei yu han'],
  南宫雪: ['nangong xue', 'nangongxue', 'nangong', 'xue'],
};

const isCharacterMentionedInPrompt = (prompt: string, charName: string): boolean => {
  if (!charName || !prompt) return false;
  const lower = prompt.toLowerCase();
  if (lower.includes(charName.toLowerCase())) return true;
  const compact = lower.replace(/[\s_\-]/g, '');
  if (compact.includes(charName.toLowerCase().replace(/[\s_\-]/g, ''))) return true;
  const aliases = CHARACTER_NAME_ALIASES[charName] || [];
  return aliases.some((alias) => lower.includes(alias) || compact.includes(alias.replace(/[\s_\-]/g, '')));
};

export const DirectorMode: React.FC = () => {
  const { id: projectId } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapterId, setSelectedChapterId] = useState<string>('');
  const [timeline, setTimeline] = useState<Scene[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  
  // Style Settings

  // Advanced Generation Params State
  const [showAdvancedParams, setShowAdvancedParams] = useState(false);
  const [genSteps, setGenSteps] = useState(25);
  const [genCfg, setGenCfg] = useState(7.0);
  const [genSampler, setGenSampler] = useState('euler_ancestral');
  const [genScheduler, setGenScheduler] = useState('normal');

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
  const [projectNsfwMode, setProjectNsfwMode] = useState<'inherit' | 'on' | 'off'>('inherit');
  const [systemNsfw, setSystemNsfw] = useState(false);

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

  // Load project defaults + system NSFW (style + policy strip)
  useEffect(() => {
    if (!projectId) return;
    Promise.all([
      api.getProject(Number(projectId)).catch(() => null),
      api.getSettings().catch(() => null)
    ]).then(([data, sys]) => {
      const sysOn = Boolean(sys?.advanced?.nsfw_enabled);
      setSystemNsfw(sysOn);

      try {
        const raw = data?.settings;
        const settingsObj = typeof raw === 'string'
          ? (raw ? JSON.parse(raw) : {})
          : (raw && typeof raw === 'object' ? raw : {});
        if (settingsObj.default_style) {
          const styles = getVisualStyles();
          if (styles.some((s) => s.value === settingsObj.default_style)) {
            setSelectedStyle(settingsObj.default_style);
            localStorage.setItem('director_selectedStyle', settingsObj.default_style);
          }
        }
        let mode: 'inherit' | 'on' | 'off' = 'inherit';
        if (settingsObj.nsfw_mode === 'on' || settingsObj.nsfw_mode === 'off' || settingsObj.nsfw_mode === 'inherit') {
          mode = settingsObj.nsfw_mode;
        } else if (typeof settingsObj.nsfw_enabled === 'boolean') {
          mode = settingsObj.nsfw_enabled ? 'on' : 'off';
        }
        setProjectNsfwMode(mode);
        localStorage.setItem(`director_project_${projectId}_nsfw_mode`, mode);
      } catch {
        /* ignore */
      }
    });
  }, [projectId]);

  const effectiveNsfw =
    projectNsfwMode === 'on' ? true
    : projectNsfwMode === 'off' ? false
    : systemNsfw;

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

  const handleActivateVersion = async (sceneId: number | string, version: number) => {
    if (typeof sceneId !== 'number') return;
    try {
      const updated = await api.activateSceneVersion(sceneId, version);
      setTimeline((prev) => prev.map((s) => (s.id === sceneId ? { ...s, ...updated } : s)));
      showToast(`已切换到 v${version}`, 'success');
    } catch (e: any) {
      showToast(e.message || '切换版本失败', 'error');
    }
  };

  const handleCreateVersion = async (sceneId: number | string, clearAsset = true) => {
    if (typeof sceneId !== 'number') return;
    try {
      const res = await api.createSceneVersion(sceneId, {
        clear_asset: clearAsset,
        activate: true
      });
      if (res?.scene) {
        setTimeline((prev) => prev.map((s) => (s.id === sceneId ? { ...s, ...res.scene } : s)));
      }
      showToast(`已新建 ${res?.version?.label || '版本'}`, 'success');
    } catch (e: any) {
      showToast(e.message || '新建版本失败', 'error');
    }
  };

  const generateAsset = async (
    sceneId: number | string,
    options: { newVersion?: boolean } = {}
  ) => {
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
        const shotTypeLower = (scene.shot_type || "").toLowerCase();
        const isWideOrFullShot = ["wide", "long shot", "full body", "extreme long", "establishing"].some(k => shotTypeLower.includes(k));

        projectCharacters.forEach(char => {
            if (!isCharacterMentionedInPrompt(scene.visual_prompt || '', char.name)) return;

            let tagMap: Record<string, string> = {};
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
                    tagMap = { ...(typeof baseTags === 'object' ? baseTags : {}), ...(typeof variantTags === 'object' ? variantTags : {}) };
                } else {
                    // Flat tag map: only visual keys
                    const skip = new Set(['assets', 'timeline_map', 'variants', 'base_model', 'model_type', 'avatar_url', 'turnaround_url', 'face_url']);
                    tagMap = Object.fromEntries(
                      Object.entries(tags).filter(([k, v]) => !skip.has(k) && typeof v === 'string')
                    ) as Record<string, string>;
                }
            }

            if (isWideOrFullShot && Object.keys(tagMap).length > 0) {
                const filtered = Object.entries(tagMap)
                    .filter(([k]) => !['eyes', 'face_features', 'skin_tone', 'eyebrows', 'lashes'].includes(k.toLowerCase()))
                    .map(([, v]) => v);
                if (filtered.length > 0) {
                    finalPrompt += `, ${char.name} outfit & build: ${filtered.join(", ")}`;
                }
            } else {
                const tagStr = Object.values(tagMap).join(", ");
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
      
      let referenceImageUrl = null;
      let referenceModelType = 'pony';

      // Portrait img2img only for single-character close-ups.
      // Multi-person / action / wide shots must stay txt2img or the latent collapses to a solo portrait.
      if (projectCharacters.length > 0 && scene.visual_prompt) {
        const shotTypeLower = (scene.shot_type || '').toLowerCase();
        const isClose = ['close-up', 'close up', 'portrait', 'medium close', 'extreme close'].some(
          (k) => shotTypeLower.includes(k)
        );
        const isWide = ['wide', 'long shot', 'full body', 'extreme long', 'establishing'].some(
          (k) => shotTypeLower.includes(k)
        );
        const mentioned = projectCharacters.filter((char) =>
          isCharacterMentionedInPrompt(scene.visual_prompt || '', char.name)
        );
        const multiFromPrompt = /\b[23]girls?\b|\b[23]boys?\b/i.test(scene.visual_prompt || '');
        const storyAction =
          /\b(embrac|kiss|sitting|lying|straddl|between|on bed|couch|yuri|tendril|walking|reaching)\b/i.test(
            scene.visual_prompt || ''
          );
        if (
          mentioned.length === 1
          && isClose
          && !isWide
          && !multiFromPrompt
          && !storyAction
        ) {
          const char = mentioned[0];
          if (char.avatar_url || char.turnaround_url) {
            referenceImageUrl = char.avatar_url || char.turnaround_url;
            referenceModelType = char.model_type || 'pony';
          }
        }
      }

      const payload = { 
          prompt: finalPrompt,
          negative_prompt: finalNegative,
          style_preset: selectedStyle,
          mode: backendAssetMode,
          ref_image_url: referenceImageUrl,
          reference_model_type: referenceModelType,
          // Close single: mild identity lock. Story frames: no ref / denoise 1 (txt2img).
          denoise: referenceImageUrl ? 0.62 : 1.0,
          gen_type: 'scene',
          new_version: Boolean(options.newVersion),
          generation_params: showAdvancedParams ? {
             steps: genSteps,
             cfg: genCfg,
             sampler_name: genSampler,
             scheduler: genScheduler
          } : undefined
      };
      
      const response = await api.generateAsset(payload, sceneId);
      const taskId = response.task_id;
      const activeVer = response.active_version;

      setTimeline(prev => prev.map(s => s.id === sceneId ? {
        ...s,
        task_id: taskId,
        asset_status: 'generating',
        asset_url: options.newVersion ? undefined : s.asset_url,
        active_version: activeVer ?? s.active_version
      } : s));

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
                setTimeline(prev => prev.map(s => {
                  if (s.id !== sceneId) return s;
                  const versions = (s.versions || []).map((v) =>
                    v.version === (s.active_version || 1)
                      ? { ...v, asset_url: data.image_url, asset_status: 'completed', has_image: true }
                      : v
                  );
                  // Ensure active version appears in list after new_version fork
                  const active = s.active_version || 1;
                  if (!versions.some((v) => v.version === active)) {
                    versions.push({
                      version: active,
                      label: `v${active}`,
                      asset_url: data.image_url,
                      asset_status: 'completed',
                      has_image: true
                    });
                    versions.sort((a, b) => a.version - b.version);
                  }
                  return {
                    ...s,
                    asset_status: 'completed',
                    asset_url: data.image_url,
                    versions
                  };
                }));
                // Refresh versions from server for accuracy
                if (typeof sceneId === 'number') {
                  api.listSceneVersions(sceneId).then((res) => {
                    setTimeline((prev) => prev.map((s) =>
                      s.id === sceneId
                        ? {
                            ...s,
                            active_version: res.active_version,
                            versions: res.versions.map((v: any) => ({
                              version: v.version,
                              label: v.label,
                              asset_status: v.asset_status,
                              asset_url: v.asset_url,
                              has_image: Boolean(v.asset_url),
                              created_at: v.created_at
                            }))
                          }
                        : s
                    ));
                  }).catch(() => {});
                }
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
      showToast(t("director.batch_started", "Sequential batch generation started"), 'info');
      
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
          showToast(t("director.batch_complete", "Batch generation complete"), 'success');
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
            showToast(t("director.comic_generated", "Comic generated successfully"), 'success');
        } else {
            showToast(t("director.comic_no_pages", "No pages generated."), 'error');
        }
    } catch (e) {
        console.error(e);
        showToast(t("director.comic_failed", "Failed to generate comic. Ensure all scenes have images."), 'error');
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
              showToast(t("director.video_completed", "Video rendering completed"), 'success');
          } else {
              showToast(t("director.video_started", "Video rendering started"), 'info');
          }
      } catch (e) {
          console.error(e);
          showToast(t("director.video_failed", "Failed to start video rendering."), 'error');
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
        onActivateVersion={handleActivateVersion}
        onCreateVersion={handleCreateVersion}
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
        projectNsfwMode={projectNsfwMode}
        effectiveNsfw={effectiveNsfw}
        systemNsfw={systemNsfw}
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
