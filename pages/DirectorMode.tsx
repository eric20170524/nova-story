import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../services/api';
import {
  Chapter,
  Scene,
  Workflow,
  StreamMessage,
  AssetMode,
  ImageOutputSpec,
  VideoProfile,
  VideoPreset,
  VideoWorkflowId,
  MediaAsset,
  VideoTaskState,
  VideoGenerationRequest
} from '../types';
import { API_BASE_URL, findVisualStyle, getVisualStyles, STANDARD_VISUAL_STYLES } from '../constants';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import { useProjectAgentOptional } from '../contexts/ProjectAgentContext';
import { ComicViewer } from '../components/ComicViewer';
import { DirectorSidebar } from '../components/Director/DirectorSidebar';
import { DirectorTimeline } from '../components/Director/DirectorTimeline';
import { DirectorRightPanel } from '../components/Director/DirectorRightPanel';
import { AlertTriangle, Film, Settings } from 'lucide-react';
import {
  buildCharacterAppearanceSnippet,
  getCharacterLoraName,
  shouldUsePortraitImg2ImgForScene
} from '../services/character_appearance';
import {
  clearVramSchedulerPhase,
  emitVramSchedulerPhase,
  handleGenerationStreamForVram,
} from '../services/vram_scheduler_ui';

const isCharacterMentionedInPrompt = (prompt: string, char: any): boolean => {
  const charName = char?.name || '';
  if (!charName || !prompt) return false;
  const lower = prompt.toLowerCase();
  if (lower.includes(charName.toLowerCase())) return true;
  const compact = lower.replace(/[\s_\-]/g, '');
  if (compact.includes(charName.toLowerCase().replace(/[\s_\-]/g, ''))) return true;
  const aliases: string[] = Array.isArray(char?.visual_tags?.aliases)
    ? char.visual_tags.aliases
    : (Array.isArray(char?.aliases) ? char.aliases : []);
  return aliases.some((alias: string) => {
    const a = alias.toLowerCase();
    return lower.includes(a) || compact.includes(a.replace(/[\s_\-]/g, ''));
  });
};

const NONHUMAN_SCENE_RE =
  /\b(animal|creature|furry|furred|quadruped|paw|paws|paw pads?|whiskers?|muzzle|snout|tail|kitten|cat|puppy|dog|fox|rabbit|bunny|wolf|bear|otter|hamster|mouse|deer|bird)\b/i;
const HUMAN_SCENE_RE =
  /\b(1girl|2girls|3girls|1boy|2boys|3boys|girl|woman|women|female|boy|man|men|male|person|people|heroine|swordswoman|swordsman|princess|prince)\b/i;

const isNonhumanCharacter = (char: any): boolean => {
  return NONHUMAN_SCENE_RE.test(
    `${char?.description || ''} ${JSON.stringify(char?.visual_tags || {})}`
  );
};

const HUMAN_IDENTITY_NEGATIVE_RE =
  /western face|caucasian|european face|\b(?:male|man|men|boy|boys|androgynous)\b|masculine face|beard|mustache|childlike face/i;

const VIDEO_WORKFLOW_IDS: VideoWorkflowId[] = [
  'minimax_h3_hongchao_a2a_12gb',
  'minimax_h3_ref2va_official_12gb',
  'minimax_h3_fl2va_official_12gb'
];

const getStoredVideoWorkflowId = (): VideoWorkflowId => {
  try {
    const saved = localStorage.getItem('director_videoWorkflowId') as VideoWorkflowId | null;
    if (saved && VIDEO_WORKFLOW_IDS.includes(saved)) return saved;
  } catch {}
  return 'minimax_h3_hongchao_a2a_12gb';
};

const isTerminalVideoStatus = (status?: string) =>
  ['completed', 'review_required', 'rejected', 'failed', 'cancelled', 'interrupted'].includes(String(status || ''));

export const DirectorMode: React.FC = () => {
  const { id: projectId } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const agentCtx = useProjectAgentOptional();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapterId, setSelectedChapterId] = useState<string>('');
  const [timeline, setTimeline] = useState<Scene[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  
  // Advanced Generation Params State
  const [showAdvancedParams, setShowAdvancedParams] = useState(false);
  const [genSteps, setGenSteps] = useState(25);
  const [genCfg, setGenCfg] = useState(7.0);
  const [genSampler, setGenSampler] = useState('euler_ancestral');
  const [genScheduler, setGenScheduler] = useState('normal');

  const [selectedStyle, setSelectedStyle] = useState<string>(() => {
    const saved = projectId
      ? localStorage.getItem(`director_project_${projectId}_style`)
      : null;
    const styles = getVisualStyles();
    if (saved && styles.some((s) => s.value === saved)) return saved;
    return STANDARD_VISUAL_STYLES[0].value;
  });
  const [styleStrength, setStyleStrength] = useState<number>(1.0); // 0.1 to 2.0
  
  // Decoupled Asset Mode
  const [assetMode, setAssetMode] = useState<AssetMode>(() => {
    return (localStorage.getItem('director_assetMode') as AssetMode) || 'single_image';
  });

  // Video Pipeline States
  const [mediaAssetsByScene, setMediaAssetsByScene] = useState<Record<number | string, MediaAsset[]>>({});
  const [videoTasksByScene, setVideoTasksByScene] = useState<Record<number | string, VideoTaskState>>({});
  const [videoProfile, setVideoProfile] = useState<VideoProfile>('narrative_clip');
  const [videoPreset, setVideoPreset] = useState<VideoPreset>('preview_480p_5s');
  const [runLoopCloser, setRunLoopCloser] = useState<boolean>(true);
  const [videoMotionPrompt, setVideoMotionPrompt] = useState<string>('');
  const [isBatchGeneratingVideo, setIsBatchGeneratingVideo] = useState<boolean>(false);
  const stopBatchVideoRef = React.useRef<boolean>(false);
  const activeVideoEvtSourcesRef = React.useRef<Map<string, EventSource>>(new Map());
  const activeBatchVideoTaskIdRef = React.useRef<string | null>(null);

  // Re-storyboard Confirmation Modal
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const [loading, setLoading] = useState(false);
  const [generatingNarration, setGeneratingNarration] = useState(false);
  const [renderingVideo, setRenderingVideo] = useState(false);
  const [projectCharacters, setProjectCharacters] = useState<any[]>([]);
  const [showRightPanel, setShowRightPanel] = useState(false);
  const [projectNsfwMode, setProjectNsfwMode] = useState<'inherit' | 'on' | 'off'>('inherit');
  const [projectModelType, setProjectModelType] = useState<'pony' | 'sd15' | 'redcraft_krea2'>('pony');
  const [projectOutputSpec, setProjectOutputSpec] = useState<Required<ImageOutputSpec>>({
    aspect_ratio: '3:4',
    resolution: 'standard',
    orientation_policy: 'fixed',
  });
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

  useEffect(() => {
    return () => {
      if (activeEvtSourceRef.current) {
        activeEvtSourceRef.current.close();
        activeEvtSourceRef.current = null;
      }
      activeVideoEvtSourcesRef.current.forEach((src) => src.close());
      activeVideoEvtSourcesRef.current.clear();
    };
  }, []);

  // Persist settings
  useEffect(() => {
    localStorage.setItem('director_selectedStyle', selectedStyle);
    if (projectId) {
      localStorage.setItem(`director_project_${projectId}_style`, selectedStyle);
    }
  }, [projectId, selectedStyle]);

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

  const setAgentChapterId = agentCtx?.setActiveChapterId;
  useEffect(() => {
    if (projectId && selectedChapterId) {
      localStorage.setItem(`director_project_${projectId}_chapter`, selectedChapterId);
      setAgentChapterId?.(selectedChapterId);
    }
  }, [projectId, selectedChapterId, setAgentChapterId]);

  const loadProjectDefaults = () => {
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
            localStorage.setItem(`director_project_${projectId}_style`, settingsObj.default_style);
          }
        } else {
          const savedProjectStyle = localStorage.getItem(`director_project_${projectId}_style`);
          const styles = getVisualStyles();
          setSelectedStyle(
            savedProjectStyle && styles.some((s) => s.value === savedProjectStyle)
              ? savedProjectStyle
              : STANDARD_VISUAL_STYLES[0].value
          );
        }
        if (settingsObj.default_model_type === 'sd15' || settingsObj.default_model_type === 'pony' || settingsObj.default_model_type === 'redcraft_krea2') {
          setProjectModelType(settingsObj.default_model_type);
        } else if (settingsObj.default_model_type === 'flux') {
          setProjectModelType('pony');
        }
        const savedOutputSpec = settingsObj.output_spec || {};
        setProjectOutputSpec({
          aspect_ratio: ['3:4', '4:3', '1:1', '16:9', '9:16', 'auto'].includes(savedOutputSpec.aspect_ratio)
            ? savedOutputSpec.aspect_ratio
            : '3:4',
          resolution: ['draft', 'standard', 'high'].includes(savedOutputSpec.resolution)
            ? savedOutputSpec.resolution
            : 'standard',
          orientation_policy: ['fixed', 'auto_by_shot'].includes(savedOutputSpec.orientation_policy)
            ? savedOutputSpec.orientation_policy
            : 'fixed',
        });
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
  };

  useEffect(() => {
    if (projectId) {
      loadProjectDefaults();
    }
  }, [projectId]);

  useEffect(() => {
    const handleSettingsChanged = () => loadProjectDefaults();
    window.addEventListener('novastory-project-settings-changed', handleSettingsChanged);
    window.addEventListener('storage', handleSettingsChanged);
    return () => {
      window.removeEventListener('novastory-project-settings-changed', handleSettingsChanged);
      window.removeEventListener('storage', handleSettingsChanged);
    };
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

  const loadSceneMedia = async (sceneId: number | string, version?: number) => {
    try {
      const res = await api.getSceneMediaAssets(sceneId, version);
      if (res?.assets) {
        setMediaAssetsByScene((prev) => ({ ...prev, [sceneId]: res.assets }));
      }
    } catch (_) {}
  };

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
          // Load media assets for all scenes
          scenes.forEach((s: Scene) => {
            loadSceneMedia(s.id, s.active_version);
          });
        } else {
          setTimeline([]);
        }
      })
      .catch(() => setTimeline([]))
      .finally(() => setLoading(false));
  };

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

  const handleGenerateNarration = async () => {
    if (!selectedChapterId || timeline.length === 0) return;
    setGeneratingNarration(true);
    try {
      const result = await api.generateNarration(selectedChapterId);
      await loadTimeline(selectedChapterId);
      showToast(
        t('director.narration_generated', 'Generated narration for {count} scenes', {
          count: result.generated_count || timeline.length,
        }),
        'success'
      );
    } catch (e: any) {
      showToast(
        e.message || t('director.narration_failed', 'Local narration generation failed'),
        'error'
      );
    } finally {
      setGeneratingNarration(false);
    }
  };

  const handleUpdateScene = (id: number | string, field: keyof Scene, value: any) => {
    setTimeline(prev => prev.map(s => s.id === id ? { ...s, [field]: value } : s));
    
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
      loadSceneMedia(sceneId, version);
      showToast(
        t('director.version_switched', 'Switched to v{version}', { version }),
        'success'
      );
    } catch (e: any) {
      showToast(e.message || t('director.version_switch_fail', 'Failed to switch version'), 'error');
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
      showToast(
        t('director.version_created', 'Created {label}', {
          label: res?.version?.label || t('director.version_fallback', 'version'),
        }),
        'success'
      );
    } catch (e: any) {
      showToast(e.message || t('director.version_create_fail', 'Failed to create version'), 'error');
    }
  };

  const generateAsset = async (
    sceneId: number | string,
    options: { newVersion?: boolean; preserveComposition?: boolean; canvasAspectRatio?: string } = {}
  ) => {
    const scene = timeline.find(s => s.id === sceneId);
    if (!scene) return;

    let availableProjectCharacters = projectCharacters;
    if (availableProjectCharacters.length === 0 && projectId) {
      try {
        const fresh = await api.getCharacters(Number(projectId));
        if (Array.isArray(fresh)) {
          availableProjectCharacters = fresh;
          setProjectCharacters(fresh);
        }
      } catch {}
    }

    const styleObj = findVisualStyle(selectedStyle);
    const globalNegativeRaw = styleObj && styleObj.negative_prompt ? styleObj.negative_prompt : '';
    
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

    const shotTypeLower = (scene.shot_type || '').toLowerCase();
    const isWideOrFullShot = ['wide', 'long shot', 'full body', 'extreme long', 'establishing'].some(
      (k) => shotTypeLower.includes(k)
    );
    const promptForMention = `${scene.visual_prompt || ''} ${finalPrompt}`;
    let mentionedChars = availableProjectCharacters.filter((char) =>
      isCharacterMentionedInPrompt(promptForMention, char)
    );
    const hasNonhumanSubject = NONHUMAN_SCENE_RE.test(promptForMention);
    const hasHumanSubject = HUMAN_SCENE_RE.test(promptForMention);

    if (mentionedChars.length === 0 && availableProjectCharacters.length === 1) {
      const onlyCharacter = availableProjectCharacters[0];
      if (
        (hasNonhumanSubject && isNonhumanCharacter(onlyCharacter))
        || (hasHumanSubject && !isNonhumanCharacter(onlyCharacter))
        || /\b(protagonist|main character|the character|hero|heroine)\b/i.test(promptForMention)
      ) {
        mentionedChars = [onlyCharacter];
      }
    }
    const mentionedNonhumanCount = mentionedChars.filter(isNonhumanCharacter).length;
    const sceneSubjectType =
      mentionedNonhumanCount > 0 && mentionedNonhumanCount < mentionedChars.length
        ? 'mixed'
        : mentionedNonhumanCount > 0 || hasNonhumanSubject
        ? 'nonhuman'
        : mentionedChars.length > 0 || hasHumanSubject
          ? 'human'
          : isWideOrFullShot
            ? 'environment'
            : 'unknown';

    const appearanceSnippets: string[] = [];
    for (const char of mentionedChars) {
      const snippet = buildCharacterAppearanceSnippet(char, {
        chapterId: selectedChapterId,
        wideShot: isWideOrFullShot
      });
      if (snippet) {
        appearanceSnippets.push(snippet);
        finalPrompt += `, ${snippet}`;
      }
    }

    const globalNegative = sceneSubjectType === 'nonhuman' || sceneSubjectType === 'environment'
      ? globalNegativeRaw
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part && !HUMAN_IDENTITY_NEGATIVE_RE.test(part))
          .join(', ')
      : globalNegativeRaw;
    let finalNegative = globalNegative;
    if (scene.negative_prompt) {
        finalNegative = finalNegative ? `${finalNegative}, ${scene.negative_prompt}` : scene.negative_prompt;
    }

    setTimeline(prev => prev.map(s => s.id === sceneId ? { ...s, asset_status: 'generating' } : s));
    emitVramSchedulerPhase({
      phase: 'vram_tuning',
      message: 'Optimizing VRAM for image generation…',
      message_zh: '正在调优显存环境…',
    });

    try {
      const backendAssetMode = assetMode === 'contact_sheet_3x3' ? 'cinematic_grid' : 'standard';

      let characterRefUrl: string | null = null;
      let referenceModelType: 'pony' | 'sd15' | 'redcraft_krea2' = projectModelType || 'pony';
      let characterLora: string | null = null;

      if (mentionedChars.length > 0) {
        const char = mentionedChars[0];
        if (char.avatar_url || char.turnaround_url || char.face_url) {
          characterRefUrl = char.face_url || char.avatar_url || char.turnaround_url;
          if (char.model_type === 'sd15') referenceModelType = 'sd15';
          else if (char.model_type === 'redcraft_krea2') referenceModelType = 'redcraft_krea2';
          else if (char.model_type === 'pony') referenceModelType = 'pony';
        }
      }

      const compositionRefUrl =
        options.preserveComposition && scene.asset_url
          ? scene.asset_url
          : null;

      for (const char of mentionedChars) {
        const lora = getCharacterLoraName(char);
        if (lora) {
          characterLora = lora;
          break;
        }
      }

      const useLegacyImg2ImgHint = shouldUsePortraitImg2ImgForScene({
        shotType: scene.shot_type,
        visualPrompt: scene.visual_prompt,
        mentionedCount: mentionedChars.length
      });

      const effectiveOutputSpec = options.canvasAspectRatio
        ? { ...projectOutputSpec, aspect_ratio: options.canvasAspectRatio as any }
        : projectOutputSpec;

      const payload: Record<string, unknown> = {
          prompt: finalPrompt,
          negative_prompt: finalNegative,
          style_preset: selectedStyle,
          style_strength: styleStrength,
          mode: backendAssetMode,
          model_type: referenceModelType,
          shot_type: scene.shot_type || null,
          camera_movement: scene.camera_movement || null,
          camera_angle: scene.camera_angle || null,
          subject_type: sceneSubjectType,
          ref_image_url: characterRefUrl,
          character_ref_url: characterRefUrl,
          composition_ref_url: compositionRefUrl,
          character_appearance_prompt: appearanceSnippets.join(', '),
          character_appearance_snippets: appearanceSnippets,
          character_lora: characterLora,
          reference_model_type: referenceModelType,
          denoise: useLegacyImg2ImgHint && characterRefUrl ? 0.62 : 1.0,
          gen_type: 'scene',
          reference_tier: characterRefUrl || compositionRefUrl ? 'A+B' : 'A',
          new_version: Boolean(options.newVersion),
          project_settings: {
            nsfw_mode: projectNsfwMode,
            default_style: selectedStyle,
            output_spec: effectiveOutputSpec,
          },
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
              handleGenerationStreamForVram(data, taskId);
              
              if (data.status === 'completed' && data.image_url) {
                setTimeline(prev => prev.map(s => {
                  if (s.id !== sceneId) return s;
                  const versions = (s.versions || []).map((v) =>
                    v.version === (s.active_version || 1)
                      ? { ...v, asset_url: data.image_url, asset_status: 'completed', has_image: true }
                      : v
                  );
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

                loadSceneMedia(sceneId);
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
              clearVramSchedulerPhase();
              setTimeline(prev => prev.map(s => s.id === sceneId ? { ...s, asset_status: 'failed' } : s));
              resolve(); 
            };
          }
      });

    } catch (e: any) {
      console.error(e);
      clearVramSchedulerPhase();
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

  const handleGenerateKeyframe = async (sceneId: number | string) => {
    const scene = timeline.find((s) => s.id === sceneId);
    if (!scene) return;

    let availableProjectCharacters = projectCharacters;
    if (availableProjectCharacters.length === 0 && projectId) {
      try {
        const fresh = await api.getCharacters(Number(projectId));
        if (Array.isArray(fresh)) {
          availableProjectCharacters = fresh;
          setProjectCharacters(fresh);
        }
      } catch {}
    }

    const styleObj = findVisualStyle(selectedStyle);
    const globalNegativeRaw = styleObj && styleObj.negative_prompt ? styleObj.negative_prompt : '';

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

    const shotTypeLower = (scene.shot_type || '').toLowerCase();
    const isWideOrFullShot = ['wide', 'long shot', 'full body', 'extreme long', 'establishing'].some(
      (k) => shotTypeLower.includes(k)
    );
    const promptForMention = `${scene.visual_prompt || ''} ${finalPrompt}`;
    let mentionedChars = availableProjectCharacters.filter((char) =>
      isCharacterMentionedInPrompt(promptForMention, char)
    );
    const hasNonhumanSubject = NONHUMAN_SCENE_RE.test(promptForMention);
    const hasHumanSubject = HUMAN_SCENE_RE.test(promptForMention);

    if (mentionedChars.length === 0 && availableProjectCharacters.length === 1) {
      const onlyCharacter = availableProjectCharacters[0];
      if (
        (hasNonhumanSubject && isNonhumanCharacter(onlyCharacter))
        || (hasHumanSubject && !isNonhumanCharacter(onlyCharacter))
        || /\b(protagonist|main character|the character|hero|heroine)\b/i.test(promptForMention)
      ) {
        mentionedChars = [onlyCharacter];
      }
    }
    const mentionedNonhumanCount = mentionedChars.filter(isNonhumanCharacter).length;
    const sceneSubjectType =
      mentionedNonhumanCount > 0 && mentionedNonhumanCount < mentionedChars.length
        ? 'mixed'
        : mentionedNonhumanCount > 0 || hasNonhumanSubject
        ? 'nonhuman'
        : mentionedChars.length > 0 || hasHumanSubject
          ? 'human'
          : isWideOrFullShot
            ? 'environment'
            : 'unknown';

    const appearanceSnippets: string[] = [];
    for (const char of mentionedChars) {
      const snippet = buildCharacterAppearanceSnippet(char, {
        chapterId: selectedChapterId,
        wideShot: isWideOrFullShot
      });
      if (snippet) {
        appearanceSnippets.push(snippet);
        finalPrompt += `, ${snippet}`;
      }
    }

    const globalNegative = sceneSubjectType === 'nonhuman' || sceneSubjectType === 'environment'
      ? globalNegativeRaw
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part && !HUMAN_IDENTITY_NEGATIVE_RE.test(part))
          .join(', ')
      : globalNegativeRaw;
    let finalNegative = globalNegative;
    if (scene.negative_prompt) {
      finalNegative = finalNegative ? `${finalNegative}, ${scene.negative_prompt}` : scene.negative_prompt;
    }

    emitVramSchedulerPhase({
      phase: 'vram_tuning',
      message: 'Generating 16:9 keyframe…',
      message_zh: '正在生成 16:9 视频关键帧…',
    });

    try {
      let characterRefUrl: string | null = null;
      let referenceModelType: 'pony' | 'sd15' | 'redcraft_krea2' = projectModelType || 'pony';
      let characterLora: string | null = null;

      if (mentionedChars.length > 0) {
        const char = mentionedChars[0];
        if (char.avatar_url || char.turnaround_url || char.face_url) {
          characterRefUrl = char.face_url || char.avatar_url || char.turnaround_url;
          if (char.model_type === 'sd15') referenceModelType = 'sd15';
          else if (char.model_type === 'redcraft_krea2') referenceModelType = 'redcraft_krea2';
          else if (char.model_type === 'pony') referenceModelType = 'pony';
        }
      }

      for (const char of mentionedChars) {
        const lora = getCharacterLoraName(char);
        if (lora) {
          characterLora = lora;
          break;
        }
      }

      const payload: Record<string, unknown> = {
        prompt: finalPrompt,
        negative_prompt: finalNegative,
        style_preset: selectedStyle,
        style_strength: styleStrength,
        mode: 'standard',
        model_type: referenceModelType,
        shot_type: scene.shot_type || null,
        camera_movement: scene.camera_movement || null,
        camera_angle: scene.camera_angle || null,
        subject_type: sceneSubjectType,
        ref_image_url: characterRefUrl,
        character_ref_url: characterRefUrl,
        character_appearance_prompt: appearanceSnippets.join(', '),
        character_appearance_snippets: appearanceSnippets,
        character_lora: characterLora,
        reference_model_type: referenceModelType,
        gen_type: 'scene',
        reference_tier: characterRefUrl ? 'A+B' : 'A',
        new_version: false,
        project_settings: {
          nsfw_mode: projectNsfwMode,
          default_style: selectedStyle,
          output_spec: {
            ...projectOutputSpec,
            aspect_ratio: '16:9'
          }
        },
        generation_params: showAdvancedParams ? {
          steps: genSteps,
          cfg: genCfg,
          sampler_name: genSampler,
          scheduler: genScheduler
        } : undefined
      };

      const response = await api.generateAsset(payload, sceneId);
      const taskId = response.task_id;

      showToast('正在生成 16:9 关键帧…', 'info');

      return new Promise<void>((resolve) => {
        const evtSource = new EventSource(`${API_BASE_URL}/assets/stream/${taskId}`);
        activeEvtSourceRef.current = evtSource;

        evtSource.onmessage = async (event) => {
          const data: StreamMessage = JSON.parse(event.data);
          handleGenerationStreamForVram(data, taskId);

          if (data.status === 'completed' && data.image_url) {
            clearVramSchedulerPhase();
            try {
              await api.registerMediaAsset({
                project_id: Number(projectId) || 1,
                scene_id: Number(sceneId),
                scene_version: scene.active_version || 1,
                media_type: 'image',
                role: 'video_keyframe',
                url: data.image_url,
                status: 'ready'
              });
              await loadSceneMedia(sceneId);
              showToast('16:9 关键帧生成完成！', 'success');
            } catch (regErr: any) {
              showToast(`关键帧注册失败: ${regErr.message || regErr}`, 'error');
            }
            evtSource.close();
            activeEvtSourceRef.current = null;
            resolve();
          } else if (data.status === 'failed') {
            clearVramSchedulerPhase();
            showToast((data as any).error || '关键帧生成失败', 'error');
            evtSource.close();
            activeEvtSourceRef.current = null;
            resolve();
          }
        };

        evtSource.onerror = () => {
          evtSource.close();
          activeEvtSourceRef.current = null;
          clearVramSchedulerPhase();
          showToast('关键帧生成连接中断', 'error');
          resolve();
        };
      });
    } catch (e: any) {
      clearVramSchedulerPhase();
      showToast(e.message || '生成关键帧失败', 'error');
    }
  };

  // Video Generation Handlers
  const handleGenerateVideo = async (
    sceneId: number | string,
    options: {
      profile?: VideoProfile;
      preset?: VideoPreset;
      workflowId?: VideoWorkflowId;
      prompt?: string;
      keyframeAssetId?: number;
      lastFrameAssetId?: number;
      characterRefAssetIds?: number[];
      motionRefAssetId?: number;
      batchRun?: boolean;
    } = {}
  ) => {
    const scene = timeline.find((s) => s.id === sceneId);
    if (!scene) return;

    const profile = options.profile || videoProfile;
    const preset = options.preset || videoPreset;
    const workflowId = options.workflowId || getStoredVideoWorkflowId();
    const numericSceneId = Number(sceneId);
    const isFl2va = workflowId === 'minimax_h3_fl2va_official_12gb';
    const isRef2va = workflowId === 'minimax_h3_ref2va_official_12gb';

    const sceneAssets = mediaAssetsByScene[sceneId] || [];
    const existingKeyframe = [...sceneAssets]
      .filter((a) => a.role === 'video_keyframe')
      .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
    const keyframeAssetId = options.keyframeAssetId ?? existingKeyframe?.id ?? 0;

    let lastFrameId = options.lastFrameAssetId;
    if (lastFrameId === undefined && !isRef2va) {
      const lastFrameAsset = [...sceneAssets]
        .filter((a) => a.role === 'last_frame_reference' && a.id)
        .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
      lastFrameId = lastFrameAsset?.id;
    }

    let characterRefIds = options.characterRefAssetIds;
    if (characterRefIds === undefined) {
      characterRefIds = sceneAssets
        .filter((a) => a.role === 'character_reference' && a.id)
        .map((a) => a.id!)
        .slice(-3);
    }
    if (isFl2va) characterRefIds = [];

    let motionRefId = options.motionRefAssetId;
    if (motionRefId === undefined && !isFl2va) {
      const motionAsset = [...sceneAssets]
        .filter((a) => a.role === 'motion_reference' && a.id)
        .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
      motionRefId = motionAsset?.id;
    }
    if (isFl2va) motionRefId = undefined;
    if (isRef2va) lastFrameId = undefined;

    const motionPromptText = options.prompt || (videoMotionPrompt ? `${scene.visual_prompt || ''}, ${videoMotionPrompt}` : undefined);

    const request: VideoGenerationRequest = {
      scene_id: numericSceneId,
      scene_version: scene.active_version || 1,
      profile,
      workflow_id: workflowId,
      preset,
      keyframe_asset_id: keyframeAssetId,
      last_frame_asset_id: lastFrameId,
      character_reference_asset_ids: characterRefIds,
      motion_reference_asset_id: motionRefId,
      prompt_override: motionPromptText,
      run_loop_closer: runLoopCloser
    };

    try {
      // 1. Run Preflight Check
      const preflight = await api.preflightVideo(request);
      if (!preflight.ready && preflight.blockers && preflight.blockers.length > 0) {
        showToast(`前置检查未通过: ${preflight.blockers.join('; ')}`, 'error');
        return;
      }

      emitVramSchedulerPhase({
        phase: 'vram_tuning',
        message: 'Optimizing VRAM for H3 video generation…',
        message_zh: '正在调优显存环境以运行 H3 视频模型…',
      });

      setVideoTasksByScene((prev) => ({
        ...prev,
        [sceneId]: {
          task_id: '',
          scene_id: numericSceneId,
          status: 'queued',
          stage: 'queued'
        }
      }));

      const response = await api.generateVideo(request);
      const taskId = response.task_id;
      if (options.batchRun) activeBatchVideoTaskIdRef.current = taskId;

      setVideoTasksByScene((prev) => ({
        ...prev,
        [sceneId]: {
          task_id: taskId,
          scene_id: numericSceneId,
          status: 'processing',
          stage: 'vram_tuning',
          queue_position: response.queue_position
        }
      }));

      return new Promise<void>((resolve) => {
        let isDone = false;
        let pollInterval: ReturnType<typeof setInterval> | null = null;

        const cleanup = () => {
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
          const src = activeVideoEvtSourcesRef.current.get(taskId);
          if (src) {
            src.close();
            activeVideoEvtSourcesRef.current.delete(taskId);
          }
          if (activeBatchVideoTaskIdRef.current === taskId) {
            activeBatchVideoTaskIdRef.current = null;
          }
          clearVramSchedulerPhase();
        };

        const onTaskFinished = (status: string, outputUrl?: string, errorMsg?: string, qaReport?: any) => {
          if (isDone) return;
          isDone = true;
          cleanup();

          if (status === 'completed' || status === 'review_required') {
            loadSceneMedia(sceneId);
            showToast(
              status === 'review_required'
                ? '视频已生成，需人工复核后再设为成片'
                : t('director.video_completed', 'H3 视频生成完成！'),
              status === 'review_required' ? 'warning' : 'success'
            );
          } else if (status === 'cancelled') {
            showToast('视频生成任务已取消', 'info');
          } else {
            showToast(errorMsg || t('director.video_failed', '视频生成失败'), 'error');
          }
          resolve();
        };

        const startPollingFallback = () => {
          if (pollInterval || isDone) return;
          pollInterval = setInterval(async () => {
            try {
              const taskState = await api.getVideoTask(taskId);
              if (taskState) {
                setVideoTasksByScene((prev) => ({
                  ...prev,
                  [sceneId]: { ...prev[sceneId], ...taskState }
                }));
                if (isTerminalVideoStatus(taskState.status)) {
                  onTaskFinished(taskState.status, taskState.output_url || undefined, taskState.error || undefined, taskState.qa_report);
                }
              }
            } catch (_) {}
          }, 2000);
        };

        const evtSource = new EventSource(`${API_BASE_URL}/videos/tasks/${taskId}/stream`);
        activeVideoEvtSourcesRef.current.set(taskId, evtSource);

        evtSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'snapshot' && data.task) {
              setVideoTasksByScene((prev) => ({
                ...prev,
                [sceneId]: { ...prev[sceneId], ...data.task }
              }));
              if (isTerminalVideoStatus(data.task.status)) {
                onTaskFinished(data.task.status, data.task.output_url, data.task.error, data.task.qa_report);
              }
            } else if (data.stage || data.status || data.phase) {
              const updatedStatus = data.status || 'processing';
              const updatedStage = data.stage || data.phase;
              setVideoTasksByScene((prev) => ({
                ...prev,
                [sceneId]: {
                  ...prev[sceneId],
                  status: updatedStatus,
                  stage: updatedStage || prev[sceneId]?.stage,
                  output_url: data.output_url || prev[sceneId]?.output_url,
                  qa_report: data.qa_report || prev[sceneId]?.qa_report,
                  error: data.error
                }
              }));

              if (isTerminalVideoStatus(updatedStatus)) {
                onTaskFinished(updatedStatus, data.output_url, data.error, data.qa_report);
              }
            }
          } catch (_) {}
        };

        evtSource.onerror = () => {
          startPollingFallback();
        };
      });
    } catch (err: any) {
      clearVramSchedulerPhase();
      if (options.batchRun) activeBatchVideoTaskIdRef.current = null;
      setVideoTasksByScene((prev) => ({
        ...prev,
        [sceneId]: { task_id: '', scene_id: numericSceneId, status: 'failed', error: err.message }
      }));
      showToast(err.message || 'Failed to submit video generation', 'error');
    }
  };

  const handleBatchGenerateVideo = async () => {
    if (isBatchGeneratingVideo || timeline.length === 0) return;

    stopBatchVideoRef.current = false;
    activeBatchVideoTaskIdRef.current = null;
    setIsBatchGeneratingVideo(true);
    showToast(t('director.batch_started', 'Sequential batch video generation started'), 'info');

    for (const scene of timeline) {
      if (stopBatchVideoRef.current) break;
      await handleGenerateVideo(scene.id, { batchRun: true });
      if (stopBatchVideoRef.current) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const wasStopped = stopBatchVideoRef.current;
    setIsBatchGeneratingVideo(false);
    stopBatchVideoRef.current = false;
    activeBatchVideoTaskIdRef.current = null;

    if (wasStopped) {
      showToast(t('director.batch_stopped', 'Batch video generation stopped'), 'warning');
    } else {
      showToast(t('director.batch_complete', 'Batch video generation complete'), 'success');
    }
  };

  const handleStopBatchGenerateVideo = async () => {
    stopBatchVideoRef.current = true;
    const activeTaskId = activeBatchVideoTaskIdRef.current;
    activeBatchVideoTaskIdRef.current = null;

    if (activeTaskId) {
      const src = activeVideoEvtSourcesRef.current.get(activeTaskId);
      if (src) {
        src.close();
        activeVideoEvtSourcesRef.current.delete(activeTaskId);
      }
      try {
        await api.cancelVideoTask(activeTaskId);
        setVideoTasksByScene((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(next)) {
            if (next[key].task_id === activeTaskId) {
              next[key] = { ...next[key], status: 'cancelled', stage: 'cancelled' };
            }
          }
          return next;
        });
      } catch (error) {
        console.error('Failed to cancel active batch video task:', error);
      }
    }

    setIsBatchGeneratingVideo(false);
    clearVramSchedulerPhase();
    showToast(t('director.batch_stopped', 'Batch generation stopped'), 'warning');
  };

  const handleCancelVideoTask = async (taskId: string) => {
    const src = activeVideoEvtSourcesRef.current.get(taskId);
    if (src) {
      src.close();
      activeVideoEvtSourcesRef.current.delete(taskId);
    }
    if (activeBatchVideoTaskIdRef.current === taskId) {
      activeBatchVideoTaskIdRef.current = null;
      stopBatchVideoRef.current = true;
    }
    try {
      await api.cancelVideoTask(taskId);
      setVideoTasksByScene((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          if (next[k].task_id === taskId) {
            next[k] = { ...next[k], status: 'cancelled', stage: 'cancelled' };
          }
        }
        return next;
      });
      showToast('视频生成任务已取消', 'info');
    } catch (_) {}
  };

  const handlePromoteVideoAsset = async (assetId: number) => {
    try {
      const promoted = await api.promoteVideoAsset(assetId);
      if (promoted.scene_id) {
        await loadSceneMedia(promoted.scene_id);
      }
      showToast(t('director.coverage_promote_ok', '已设为主成片'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Failed to promote video', 'error');
    }
  };

  const handleReprocessVideoAsset = async (assetId: number) => {
    try {
      await api.reprocessVideoAsset(assetId, runLoopCloser);
      timeline.forEach((s) => loadSceneMedia(s.id));
      showToast('已重新执行 LoopCloser 闭环分析与平滑融合', 'success');
    } catch (err: any) {
      showToast(err.message || 'Failed to reprocess video', 'error');
    }
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

  return (
    <div className="flex-1 flex overflow-hidden bg-slate-950 text-slate-100 h-full w-full min-h-0">
      {/* Sidebar: Chapters */}
      <DirectorSidebar
        chapters={chapters}
        selectedChapterId={selectedChapterId}
        onSelectChapter={setSelectedChapterId}
      />

      {/* Main Content Area: Timeline */}
      <DirectorTimeline
        timeline={timeline}
        loading={loading}
        selectedChapterId={selectedChapterId}
        onGenerateTimeline={triggerGenerateTimeline}
        onGenerateNarration={handleGenerateNarration}
        generatingNarration={generatingNarration}
        showRightPanel={showRightPanel}
        setShowRightPanel={setShowRightPanel}
        onGenerateAsset={generateAsset}
        onGenerateKeyframe={handleGenerateKeyframe}
        onUpdateScene={handleUpdateScene}
        onRefreshTimeline={() => loadTimeline(selectedChapterId)}
        onActivateVersion={handleActivateVersion}
        onCreateVersion={handleCreateVersion}
        mediaAssetsByScene={mediaAssetsByScene}
        videoTasksByScene={videoTasksByScene}
        onGenerateVideo={handleGenerateVideo}
        onPromoteVideoAsset={handlePromoteVideoAsset}
        onReprocessVideoAsset={handleReprocessVideoAsset}
        onCancelVideoTask={handleCancelVideoTask}
      />

      {/* Right Drawer: Style, Asset Mode, Production, Video Controls */}
      <DirectorRightPanel
        showRightPanel={showRightPanel}
        setShowRightPanel={setShowRightPanel}
        selectedStyle={selectedStyle}
        setSelectedStyle={setSelectedStyle}
        styleStrength={styleStrength}
        setStyleStrength={setStyleStrength}
        assetMode={assetMode}
        setAssetMode={setAssetMode}
        renderingVideo={renderingVideo}
        onRenderVideo={() => {}}
        generatingComic={generatingComic}
        onGenerateComic={handleGenerateComic}
        comicPages={comicPages}
        showComicViewer={showComicViewer}
        setShowComicViewer={setShowComicViewer}
        timeline={timeline}
        isBatchGenerating={isBatchGenerating}
        onBatchGenerate={handleBatchGenerate}
        onStopBatchGenerate={handleStopBatchGenerate}
        projectModelType={projectModelType}
        effectiveNsfw={effectiveNsfw}
        outputSpec={projectOutputSpec}
        videoProfile={videoProfile}
        setVideoProfile={setVideoProfile}
        videoPreset={videoPreset}
        setVideoPreset={setVideoPreset}
        runLoopCloser={runLoopCloser}
        setRunLoopCloser={setRunLoopCloser}
        videoMotionPrompt={videoMotionPrompt}
        setVideoMotionPrompt={setVideoMotionPrompt}
        onBatchGenerateVideo={handleBatchGenerateVideo}
        isBatchGeneratingVideo={isBatchGeneratingVideo}
        onStopBatchGenerateVideo={handleStopBatchGenerateVideo}
      />

      {/* Re-storyboard Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-amber-400">
              <AlertTriangle size={24} />
              <h3 className="text-lg font-bold text-white">
                {t('director.re_generate_confirm_title', '重新生成分镜')}
              </h3>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">
              {t(
                'director.re_generate_confirm_desc',
                '重新生成分镜将覆盖当前章节的所有镜头与参数设置。确认继续？'
              )}
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                onClick={executeGenerateTimeline}
                className="px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-500 rounded-lg transition-colors shadow-lg shadow-amber-600/30"
              >
                {t('common.confirm', '确认重新生成')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Comic Viewer Modal */}
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
