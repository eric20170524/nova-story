import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, Wand2, RefreshCw } from 'lucide-react';
import { api } from '../services/api';
import { Character } from '../types';
import { API_BASE_URL } from '../constants';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import { resolveMediaUrl, useImagePreview } from '../components/ImageLightbox';
import {
  clearVramSchedulerPhase,
  emitVramSchedulerPhase,
  handleGenerationStreamForVram,
} from '../services/vram_scheduler_ui';
import { CharacterCard } from '../components/character/CharacterCard';
import { CharacterEditModal } from '../components/character/CharacterEditModal';
import { TurnaroundModal } from '../components/character/TurnaroundModal';

const formatImageUrl = (url?: string | null) => resolveMediaUrl(url);

export const CharacterManager: React.FC = () => {
  const { id: projectId } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingChar, setEditingChar] = useState<Partial<Character>>({});
  
  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');

  // Turnaround Sheet Modal State
  const [sheetModalChar, setSheetModalChar] = useState<Character | null>(null);
  const [modelType, setModelType] = useState<'pony' | 'sd15'>('pony');
  const [genType, setGenType] = useState<'turnaround' | 'portrait'>('turnaround');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [isPromptLoading, setIsPromptLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [useRefPortrait, setUseRefPortrait] = useState<boolean>(true);
  const [refImageUrl, setRefImageUrl] = useState<string | null>(null);

  // Project policy for consistent style/NSFW on character gens
  const [projectStyle, setProjectStyle] = useState('xianxia_immortal');
  const [projectModelType, setProjectModelType] = useState<'pony' | 'sd15'>('pony');
  const [projectNsfwMode, setProjectNsfwMode] = useState<'inherit' | 'on' | 'off'>('inherit');
  const [systemNsfw, setSystemNsfw] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');
  const stopBatchRef = React.useRef(false);
  /** Expanded description / visual-tag sections on cards (long text after finalize). */
  const [expandedDescIds, setExpandedDescIds] = useState<Record<number, boolean>>({});
  const [expandedTagsIds, setExpandedTagsIds] = useState<Record<number, boolean>>({});
  const { openPreview, lightbox: imageLightbox } = useImagePreview();

  const loadProjectSettings = () => {
    if (!projectId) return;
    Promise.all([
      api.getProject(Number(projectId)).catch(() => null),
      api.getSettings().catch(() => null)
    ]).then(([proj, sys]) => {
      setSystemNsfw(Boolean(sys?.advanced?.nsfw_enabled));
      try {
        const raw = proj?.settings;
        const s = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
        if (s.default_style) setProjectStyle(s.default_style);
        if (s.default_model_type === 'sd15' || s.default_model_type === 'pony') {
          setProjectModelType(s.default_model_type);
        } else if (s.default_model_type === 'flux') {
          setProjectModelType('pony');
        }
        if (s.nsfw_mode === 'on' || s.nsfw_mode === 'off' || s.nsfw_mode === 'inherit') {
          setProjectNsfwMode(s.nsfw_mode);
        }
      } catch { /* ignore */ }
    });
  };

  useEffect(() => {
    if (projectId) {
      loadCharacters();
      loadProjectSettings();
    }
  }, [projectId]);

  useEffect(() => {
    const handleSettingsChanged = () => loadProjectSettings();
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

  const waitForAssetTask = (taskId: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const eventSource = new EventSource(`${API_BASE_URL}/assets/stream/${taskId}`);
      let settled = false;
      const finish = (err?: Error, url?: string) => {
        if (settled) return;
        settled = true;
        eventSource.close();
        if (err) {
          clearVramSchedulerPhase();
          reject(err);
        } else {
          resolve(url || '');
        }
      };
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleGenerationStreamForVram(data, taskId);
          // Append handoff phase only when a batch progress line is already visible
          if (data.type === 'vram_tuning') {
            setBatchProgress((prev) =>
              prev
                ? `${prev.split(' · ')[0]} · ${t('vram.auto_tuning', '正在调优显存环境…')}`
                : prev
            );
          } else if (data.type === 'vram_ready') {
            setBatchProgress((prev) =>
              prev
                ? `${prev.split(' · ')[0]} · ${t('vram.auto_render', '启动生图渲染…')}`
                : prev
            );
          }
          if (data.status === 'failed' || (data.type === 'complete' && data.status === 'failed')) {
            finish(new Error(data.error || 'Generation failed'));
          } else if (data.status === 'completed' || (data.type === 'complete' && data.image_url)) {
            if (data.image_url) finish(undefined, data.image_url);
            else finish(new Error('No image URL'));
          }
        } catch (e) {
          /* ignore parse errors mid-stream */
        }
      };
      eventSource.onerror = () => {
        finish(new Error(t('casting.gen_error_connection') || 'SSE connection error'));
      };
    });

  const loadCharacters = async () => {
    if (!projectId) return;
    try {
      const data = await api.getCharacters(Number(projectId));
      if (Array.isArray(data)) setCharacters(data);
    } catch (e) {
      console.error(e);
      showToast(t("characters.failed_load", "Failed to load characters"), 'error');
    }
  };

  const VISUAL_TAG_META = new Set([
    'assets',
    'timeline_map',
    'variants',
    'base_model',
    'model_type',
    'avatar_url',
    'turnaround_url',
    'face_url',
    'lora_path',
    'lora_ready',
    'lora_name',
    'scene_modifiers',
  ]);

  /** Flatten base_model.tags + top-level strings for the simple key/value editor. */
  const flatEditableVisualTags = (visualTags: any): Record<string, string> => {
    if (!visualTags || typeof visualTags !== 'object') return {};
    const out: Record<string, string> = {};
    const base = visualTags.base_model?.tags;
    if (base && typeof base === 'object') {
      for (const [k, v] of Object.entries(base)) {
        if (typeof v === 'string' && v.trim()) out[k] = v.trim();
      }
    }
    for (const [k, v] of Object.entries(visualTags)) {
      if (VISUAL_TAG_META.has(k)) continue;
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    return out;
  };

  /** Write flat appearance tags without wiping assets / variants / model meta. */
  const applyFlatVisualTags = (
    existing: any,
    flat: Record<string, string>
  ): Record<string, any> => {
    const full =
      existing && typeof existing === 'object' ? { ...existing } : {};
    const next: Record<string, any> = {
      ...full,
      timeline_map: full.timeline_map || {},
      assets: full.assets || {},
      model_type: full.model_type || 'pony',
      base_model: {
        ...(full.base_model || {}),
        tags: { ...flat },
      },
    };
    // Clear previous top-level string appearance keys, then re-apply flat
    for (const k of Object.keys(next)) {
      if (!VISUAL_TAG_META.has(k) && typeof next[k] === 'string') {
        delete next[k];
      }
    }
    Object.assign(next, flat);
    if (Array.isArray(full.variants) && full.variants.length) {
      next.variants = full.variants.map((v: any, i: number) => {
        if (!v || typeof v !== 'object') return v;
        if (v.id === 'v1_default' || i === 0) {
          return { ...v, tags: { ...flat } };
        }
        return v;
      });
    } else {
      next.variants = [{ id: 'v1_default', name: 'Default', tags: { ...flat } }];
    }
    return next;
  };

  const openModal = (char?: Character) => {
    if (char) {
      setEditingChar({ ...char });
    } else {
      setEditingChar({
        project_id: Number(projectId),
        name: '',
        role: 'protagonist',
        description: '',
        visual_tags: {}
      });
    }
    setTagKey('');
    setTagValue('');
    setShowModal(true);
  };

  const handleAddTag = () => {
    if (!tagKey || !tagValue) return;
    setEditingChar((prev) => {
      const flat = {
        ...flatEditableVisualTags(prev.visual_tags),
        [tagKey]: tagValue,
      };
      return {
        ...prev,
        visual_tags: applyFlatVisualTags(prev.visual_tags, flat) as any,
      };
    });
    setTagKey('');
    setTagValue('');
  };

  const removeTag = (key: string) => {
    setEditingChar((prev) => {
      const flat = { ...flatEditableVisualTags(prev.visual_tags) };
      delete flat[key];
      return {
        ...prev,
        visual_tags: applyFlatVisualTags(prev.visual_tags, flat) as any,
      };
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const flat = flatEditableVisualTags(editingChar.visual_tags);
      const payload = {
        ...editingChar,
        visual_tags: applyFlatVisualTags(editingChar.visual_tags, flat),
      };
      if (payload.id) {
        await api.updateCharacter(payload.id, payload);
      } else {
        await api.createCharacter(payload);
      }
      setShowModal(false);
      loadCharacters();
      showToast(t("characters.saved", "Character saved"), 'success');
    } catch (e) {
      showToast(t("characters.failed_save", "Failed to save character"), 'error');
    }
  };
  
  const handleDelete = async (id: number) => {
    if(!confirm(t('characters.delete_confirm'))) return;
    try {
        await api.deleteCharacter(id);
        loadCharacters();
        showToast(t("characters.deleted", "Character deleted"), 'success');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showToast(
          msg || t("characters.failed_delete", "Failed to delete character"),
          'error'
        );
    }
  };

  const handleActivateCharacterVersion = async (charId: number, version: number) => {
    try {
      const updated = await api.activateCharacterVersion(charId, version);
      setCharacters((prev) => prev.map((c) => (c.id === charId ? { ...c, ...updated } : c)));
      if (sheetModalChar?.id === charId) {
        setSheetModalChar({ ...sheetModalChar, ...updated });
      }
      showToast(`角色已切换到 v${version}`, 'success');
    } catch (e: any) {
      showToast(e.message || '切换版本失败', 'error');
    }
  };

  const handleCreateCharacterVersion = async (charId: number, clearAssets = true) => {
    try {
      const res = await api.createCharacterVersion(charId, {
        clear_assets: clearAssets,
        activate: true
      });
      if (res?.character) {
        setCharacters((prev) => prev.map((c) => (c.id === charId ? { ...c, ...res.character } : c)));
      } else {
        await loadCharacters();
      }
      showToast(`已新建角色 ${res?.version?.label || '版本'}`, 'success');
    } catch (e: any) {
      showToast(e.message || '新建版本失败', 'error');
    }
  };

  // Open Turnaround Sheet Generator
  const openSheetModal = async (char: Character, overrideGenType?: 'turnaround' | 'portrait') => {
    setSheetModalChar(char);
    const mType = projectModelType || char.model_type || 'pony';
    setModelType(mType);

    const availableRef = char.avatar_url || char.turnaround_url || null;
    const initialUseRef = !!availableRef;
    setUseRefPortrait(initialUseRef);
    setRefImageUrl(availableRef);

    // Flow sequence: Default to 'portrait' if no image exists yet, otherwise 'turnaround'
    const initialGenType = overrideGenType || ((!char.avatar_url && !char.turnaround_url) ? 'portrait' : 'turnaround');
    setGenType(initialGenType);
    setGeneratedImageUrl(null);
    setPrompt('');
    setNegativePrompt('');
    setIsPromptLoading(true);

    try {
      const res = await api.buildCharacterPrompt(
        char.id, 
        mType, 
        initialGenType, 
        char.description,
        initialUseRef,
        availableRef || undefined
      );
      setPrompt(res.prompt);
      setNegativePrompt(res.negative_prompt);
    } catch (e) {
      // turnaround: appearance base only (backend generates front/side/back then stitches)
      const fallbackComposition = initialGenType === 'portrait'
        ? 'character portrait, full body, front view'
        : 'full body character design, standing, consistent identity';
      setPrompt(`score_9, score_8_up, ${fallbackComposition}, ${char.description || ''}`);
      setNegativePrompt(`score_4, score_3, bad anatomy, low quality`);
    } finally {
      setIsPromptLoading(false);
    }
  };

  const handleRebuildPrompt = async (
    selectedModel: 'pony' | 'sd15', 
    selectedGen: 'turnaround' | 'portrait',
    withRef: boolean = useRefPortrait,
    refUrl: string | null = refImageUrl
  ) => {
    if (!sheetModalChar) return;
    setIsPromptLoading(true);
    try {
      const res = await api.buildCharacterPrompt(
        sheetModalChar.id, 
        selectedModel, 
        selectedGen, 
        sheetModalChar.description,
        withRef,
        refUrl || undefined
      );
      setPrompt(res.prompt);
      setNegativePrompt(res.negative_prompt);
    } catch (e) {
      showToast(t("characters.failed_gen_prompt", "Failed to generate prompt"), 'error');
    } finally {
      setIsPromptLoading(false);
    }
  };

  const handleGenerateSheetImage = async () => {
    if (!sheetModalChar) {
      showToast(t("casting.gen_error_no_char"), 'error');
      return;
    }
    if (!prompt.trim()) {
      showToast(isPromptLoading ? t("casting.prep_prompt") : t("casting.gen_error_no_prompt"), 'error');
      return;
    }
    setIsGenerating(true);
    setGeneratedImageUrl(null);
    emitVramSchedulerPhase({
      phase: 'vram_tuning',
      message: 'Optimizing VRAM for image generation…',
      message_zh: '正在调优显存环境…',
    });

    try {
      // Trigger generation via asset API — attach project style/NSFW so policy stack applies
      const payload: any = {
        prompt: prompt,
        negative_prompt: negativePrompt,
        model_type: modelType,
        mode: 'standard',
        gen_type: genType,
        style_preset: projectStyle,
        nsfw_enabled: effectiveNsfw,
        reference_tier: 'A',
        // Tier B composition slot reserved (portrait/turnaround only need identity)
        composition_ref_url: null,
        project_settings: {
          default_style: projectStyle,
          nsfw_mode: projectNsfwMode
        }
      };

      // Tier A: single character ref → classic img2img for portrait/turnaround only
      if (useRefPortrait && refImageUrl) {
        payload.ref_image_url = refImageUrl;
        payload.character_ref_url = refImageUrl;
      }

      const loraPath = sheetModalChar?.visual_tags?.assets?.lora_ready
        ? (sheetModalChar.visual_tags.assets.lora_path || sheetModalChar.visual_tags.assets.lora_name)
        : null;
      if (loraPath) {
        payload.character_lora = loraPath;
      }

      const res = await api.generateAsset(payload, 999990 + sheetModalChar.id);
      const taskId = res.task_id;
      if (!taskId) {
        throw new Error(t("casting.gen_error_no_task"));
      }

      const imageUrl = await waitForAssetTask(taskId);
      setGeneratedImageUrl(imageUrl);
      showToast(t("characters.gen_success", "Image generated successfully"), 'success');
      setIsGenerating(false);
    } catch (e) {
      console.error(e);
      clearVramSchedulerPhase();
      showToast(e instanceof Error ? e.message : "Generation failed", 'error');
      setIsGenerating(false);
    }
  };

  /** Sequential portrait → turnaround for all project characters using current tags + policy */
  const handleBatchRegenerateAll = async () => {
    if (!characters.length) return;
    if (!confirm(t('characters.batch_confirm') || `Regenerate portrait + turnaround for ${characters.length} characters? This may take several minutes.`)) {
      return;
    }
    stopBatchRef.current = false;
    setBatchRunning(true);
    let ok = 0;
    let fail = 0;

    try {
      for (let i = 0; i < characters.length; i++) {
        if (stopBatchRef.current) break;
        const char = characters[i];
        const mType = (char.model_type === 'sd15' ? 'sd15' : 'pony') as 'pony' | 'sd15';

        // 1) Portrait
        setBatchProgress(`${i + 1}/${characters.length} ${char.name} · portrait…`);
        emitVramSchedulerPhase({
          phase: 'vram_tuning',
          message: 'Optimizing VRAM for image generation…',
          message_zh: '正在调优显存环境…',
        });
        try {
          const portraitPrompt = await api.buildCharacterPrompt(
            char.id, mType, 'portrait', char.description, false
          );
          const portraitRes = await api.generateAsset({
            prompt: portraitPrompt.prompt,
            negative_prompt: portraitPrompt.negative_prompt,
            model_type: mType,
            mode: 'standard',
            gen_type: 'portrait',
            style_preset: projectStyle,
            nsfw_enabled: effectiveNsfw,
            project_settings: { default_style: projectStyle, nsfw_mode: projectNsfwMode }
          }, 999991 + char.id);
          if (!portraitRes.task_id) throw new Error('No task id');
          const portraitUrl = await waitForAssetTask(portraitRes.task_id);
          await api.updateCharacter(char.id, { avatar_url: portraitUrl, model_type: mType });

          if (stopBatchRef.current) break;

          // 2) Turnaround with portrait as ref
          setBatchProgress(`${i + 1}/${characters.length} ${char.name} · turnaround…`);
          const turnPrompt = await api.buildCharacterPrompt(
            char.id, mType, 'turnaround', char.description, true, portraitUrl
          );
          const turnRes = await api.generateAsset({
            prompt: turnPrompt.prompt,
            negative_prompt: turnPrompt.negative_prompt,
            model_type: mType,
            mode: 'standard',
            gen_type: 'turnaround',
            style_preset: projectStyle,
            nsfw_enabled: effectiveNsfw,
            ref_image_url: portraitUrl,
            character_ref_url: portraitUrl,
            composition_ref_url: null,
            reference_tier: 'A',
            project_settings: { default_style: projectStyle, nsfw_mode: projectNsfwMode }
          }, 999992 + char.id);
          if (!turnRes.task_id) throw new Error('No task id');
          const turnUrl = await waitForAssetTask(turnRes.task_id);
          await api.updateCharacter(char.id, { turnaround_url: turnUrl, model_type: mType });
          ok += 1;
        } catch (err) {
          console.error(err);
          fail += 1;
          showToast(`${char.name}: ${err instanceof Error ? err.message : 'failed'}`, 'error');
        }
      }
      await loadCharacters();
      showToast(
        t('characters.batch_done', `Batch done: ${ok} ok, ${fail} failed`)
          .replace('{ok}', String(ok))
          .replace('{fail}', String(fail))
          || `Batch done: ${ok} ok, ${fail} failed`,
        fail ? 'error' : 'success'
      );
    } finally {
      setBatchRunning(false);
      setBatchProgress('');
      clearVramSchedulerPhase();
    }
  };

  const saveAssetToCharacter = async (
    assetType: 'turnaround' | 'avatar',
    options: { newVersion?: boolean } = {}
  ) => {
    if (!sheetModalChar || !generatedImageUrl) return;
    try {
      let charId = sheetModalChar.id;
      if (options.newVersion) {
        // Fork look first (keep previous assets), then write into the new active version
        const forked = await api.createCharacterVersion(charId, {
          clear_assets: true,
          activate: true
        });
        if (forked?.character?.id) {
          charId = forked.character.id;
          setSheetModalChar((prev) => (prev ? { ...prev, ...forked.character } : prev));
        }
      }

      const updatePayload: any = {
        model_type: modelType
      };
      if (assetType === 'turnaround') {
        updatePayload.turnaround_url = generatedImageUrl;
      } else {
        updatePayload.avatar_url = generatedImageUrl;
      }

      const updatedChar = await api.updateCharacter(charId, updatePayload);
      showToast(
        options.newVersion
          ? `已保存到新版本 v${updatedChar.active_version || '?'}`
          : t("characters.asset_saved", "Asset saved to character profile!"),
        'success'
      );
      setCharacters(prev => prev.map(c => c.id === charId ? updatedChar : c));
      setSheetModalChar(null);
    } catch (e) {
      showToast(t("characters.failed_save_asset", "Failed to save asset"), 'error');
    }
  };

  const handleCropFace = async (charId: number) => {
    try {
      const updated = await api.cropCharacterFace(charId);
      showToast(t('characters.crop_face') + " Success!", 'success');
      setCharacters(prev => prev.map(c => c.id === charId ? updated : c));
    } catch (e) {
      showToast(t("characters.failed_crop", "Failed to crop face ref"), 'error');
    }
  };

  const handleTrainLora = async (charId: number) => {
    try {
      const updated = await api.trainCharacterLora(charId);
      showToast(t("characters.lora_ready", "Character LoRA Initialized & Ready!"), 'success');
      setCharacters(prev => prev.map(c => c.id === charId ? updated : c));
    } catch (e) {
      showToast(t("characters.failed_lora", "Failed to initialize LoRA"), 'error');
    }
  };

  const handleDirectUploadAsset = async (e: React.ChangeEvent<HTMLInputElement>, assetType: 'avatar' | 'turnaround', charId?: number) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (charId) {
        const updatedChar = await api.uploadCharacterAsset(charId, assetType, file);
        showToast(t("characters.upload_success", "Local asset uploaded successfully!"), 'success');
        setCharacters(prev => prev.map(c => c.id === charId ? updatedChar : c));
        if (editingChar.id === charId) {
          setEditingChar(updatedChar);
        }
      } else {
        const res = await api.uploadCharacterImage(file);
        if (assetType === 'avatar') {
          setEditingChar(prev => ({ ...prev, avatar_url: res.url }));
        } else {
          setEditingChar(prev => ({ ...prev, turnaround_url: res.url }));
        }
        showToast(t("characters.upload_success", "Image uploaded!"), 'success');
      }
    } catch (err) {
      showToast(t("characters.failed_upload", "Failed to upload image"), 'error');
    }
  };

  return (
    <div className="flex-1 bg-slate-950 p-4 sm:p-8 overflow-y-auto h-full">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6 sm:mb-8">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-white">{t('characters.title')}</h2>
          <p className="text-xs text-slate-500 mt-1 flex flex-wrap items-center gap-2">
            <span className={`px-2 py-0.5 rounded-full font-semibold ${effectiveNsfw ? 'bg-rose-900/60 text-rose-200' : 'bg-emerald-900/50 text-emerald-200'}`}>
              {effectiveNsfw ? 'NSFW' : 'SFW'}
            </span>
            <span className="text-slate-500">style: {projectStyle}</span>
            {batchProgress && <span className="text-indigo-400 animate-pulse">{batchProgress}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {batchRunning ? (
            <button
              type="button"
              onClick={() => { stopBatchRef.current = true; }}
              className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-800/50 px-4 py-2 rounded-lg text-sm font-medium"
            >
              <RefreshCw size={16} className="animate-spin" /> {t('characters.batch_stop') || 'Stop batch'}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleBatchRegenerateAll}
              disabled={!characters.length}
              className="flex items-center gap-2 bg-rose-700 hover:bg-rose-600 disabled:opacity-40 text-white px-4 py-2 rounded-lg text-sm font-medium"
              title={t('characters.batch_hint') || 'Portrait then turnaround for every character'}
            >
              <Wand2 size={16} /> {t('characters.batch_regen') || 'Batch regenerate all'}
            </button>
          )}
          <button
            onClick={() => openModal()}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm sm:text-base font-medium"
          >
            <Plus size={18} /> {t('characters.add_btn')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {characters.map((char) => (
          <CharacterCard
            key={char.id}
            char={char}
            expandedDesc={Boolean(expandedDescIds[char.id])}
            expandedTags={Boolean(expandedTagsIds[char.id])}
            onToggleDesc={(id) => setExpandedDescIds((prev) => ({ ...prev, [id]: !prev[id] }))}
            onToggleTags={(id) => setExpandedTagsIds((prev) => ({ ...prev, [id]: !prev[id] }))}
            onEdit={(c) => openModal(c)}
            onDelete={(id) => handleDelete(id)}
            onOpenSheetModal={(c, initialGenType) => openSheetModal(c, initialGenType)}
            onCropFace={(id) => handleCropFace(id)}
            onTrainLora={(id) => handleTrainLora(id)}
            onUploadAsset={(e, assetType, charId) => handleDirectUploadAsset(e, assetType, charId)}
            onSwitchVersion={(charId, ver) => handleActivateCharacterVersion(charId, ver)}
            onCreateVersion={(charId) => handleCreateCharacterVersion(charId, true)}
            onOpenPreview={(url) => openPreview(url)}
          />
        ))}
      </div>

      <CharacterEditModal
        isOpen={showModal}
        editingChar={editingChar}
        setEditingChar={setEditingChar}
        onClose={() => setShowModal(false)}
        onSave={handleSave}
        onUploadAsset={(e, assetType, charId) => handleDirectUploadAsset(e, assetType, charId)}
      />

      <TurnaroundModal
        character={sheetModalChar}
        onClose={() => setSheetModalChar(null)}
        modelType={modelType}
        setModelType={setModelType}
        genType={genType}
        setGenType={setGenType}
        prompt={prompt}
        setPrompt={setPrompt}
        negativePrompt={negativePrompt}
        setNegativePrompt={setNegativePrompt}
        isPromptLoading={isPromptLoading}
        isGenerating={isGenerating}
        generatedImageUrl={generatedImageUrl}
        useRefPortrait={useRefPortrait}
        setUseRefPortrait={setUseRefPortrait}
        refImageUrl={refImageUrl}
        setRefImageUrl={setRefImageUrl}
        projectStyle={projectStyle}
        effectiveNsfw={effectiveNsfw}
        onRebuildPrompt={(mt, gt, useRef, refUrl) => handleRebuildPrompt(mt as any, gt as any, useRef, refUrl)}
        onGenerateSheetImage={handleGenerateSheetImage}
        onSaveAssetToCharacter={saveAssetToCharacter}
        onUploadPortrait={async (file) => {
          if (sheetModalChar) {
            try {
              const updated = await api.uploadCharacterAsset(sheetModalChar.id, 'avatar', file);
              setRefImageUrl(updated.avatar_url);
              setUseRefPortrait(true);
              setCharacters((prev) => prev.map((c) => (c.id === sheetModalChar.id ? updated : c)));
              showToast(t("casting.upload_portrait_success"), 'success');
              handleRebuildPrompt(modelType, genType, true, updated.avatar_url);
            } catch {
              showToast(t("casting.upload_portrait_fail"), 'error');
            }
          }
        }}
      />

      {imageLightbox}
    </div>
  );
};
