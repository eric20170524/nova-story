import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, X, User, Edit2, Trash2, Sparkles, Image as ImageIcon, CheckCircle, RefreshCw, Wand2, Upload } from 'lucide-react';
import { api } from '../services/api';
import { Character } from '../types';
import { API_BASE_URL, CHARACTER_ROLES } from '../constants';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import { PreviewableImage, resolveMediaUrl, useImagePreview, ZoomHint } from '../components/ImageLightbox';

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
  const [modelType, setModelType] = useState<'pony' | 'flux'>('pony');
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
  const [projectModelType, setProjectModelType] = useState<'pony' | 'flux'>('pony');
  const [projectNsfwMode, setProjectNsfwMode] = useState<'inherit' | 'on' | 'off'>('inherit');
  const [systemNsfw, setSystemNsfw] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');
  const stopBatchRef = React.useRef(false);
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
        if (s.default_model_type === 'flux' || s.default_model_type === 'pony') {
          setProjectModelType(s.default_model_type);
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
        if (err) reject(err);
        else resolve(url || '');
      };
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
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
    setEditingChar(prev => ({
      ...prev,
      visual_tags: { ...prev.visual_tags, [tagKey]: tagValue }
    }));
    setTagKey('');
    setTagValue('');
  };

  const removeTag = (key: string) => {
    const newTags = { ...editingChar.visual_tags };
    delete newTags[key];
    setEditingChar({ ...editingChar, visual_tags: newTags });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingChar.id) {
        await api.updateCharacter(editingChar.id, editingChar);
      } else {
        await api.createCharacter(editingChar);
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
        showToast(t("characters.failed_delete", "Failed to delete character"), 'error');
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
      const fallbackComposition = initialGenType === 'portrait'
        ? 'character portrait, full body, front view'
        : 'character turnaround sheet, multi-view layout, full body, front view, side view, back view';
      setPrompt(`score_9, score_8_up, ${fallbackComposition}, ${char.description || ''}`);
      setNegativePrompt(`score_4, score_3, bad anatomy, low quality`);
    } finally {
      setIsPromptLoading(false);
    }
  };

  const handleRebuildPrompt = async (
    selectedModel: 'pony' | 'flux', 
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
        const mType = (char.model_type as 'pony' | 'flux') || 'pony';

        // 1) Portrait
        setBatchProgress(`${i + 1}/${characters.length} ${char.name} · portrait…`);
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
        {characters.map(char => {
          const isLoraReady = char.visual_tags?.assets?.lora_ready || false;
          return (
          <div key={char.id} className="bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-6 hover:border-indigo-500/30 transition-all flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-start mb-4">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    {char.avatar_url || char.turnaround_url ? (
                      <PreviewableImage
                        src={char.avatar_url || char.turnaround_url}
                        alt={char.name}
                        className="w-14 h-14 rounded-full object-cover border-2 border-indigo-500/50 shadow-md"
                      />
                    ) : (
                      <div className="w-12 h-12 bg-slate-800 rounded-full flex items-center justify-center text-slate-400 flex-shrink-0">
                        <User size={24} />
                      </div>
                    )}
                    {char.face_url && (
                      <PreviewableImage
                        src={char.face_url}
                        alt="Face Ref"
                        title="Face Reference"
                        className="w-6 h-6 rounded-full object-cover border border-amber-400 absolute -bottom-1 -right-1 shadow"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-bold text-lg text-slate-100 truncate flex items-center gap-1.5 flex-wrap">
                      {char.name}
                      {char.model_type && (
                        <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider rounded font-mono bg-indigo-950 text-indigo-300 border border-indigo-800/50">
                          {char.model_type}
                        </span>
                      )}
                      {isLoraReady && (
                        <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider rounded font-mono bg-emerald-950 text-emerald-300 border border-emerald-800/50">
                          LoRA
                        </span>
                      )}
                    </h3>
                    <div className="flex flex-wrap items-center gap-2 mt-0.5">
                      <span className="text-xs uppercase tracking-wide text-indigo-400 font-semibold">
                        {t(`roles.${char.role}`) || char.role}
                      </span>
                      <select
                        className="bg-slate-950 border border-amber-800/50 text-amber-200 text-[10px] font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-amber-500"
                        value={char.active_version || 1}
                        title="切换角色外观版本（描述+标签+立绘/三视图）"
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (v !== (char.active_version || 1)) {
                            handleActivateCharacterVersion(char.id, v);
                          }
                        }}
                      >
                        {(char.versions && char.versions.length > 0
                          ? char.versions
                          : [{ version: char.active_version || 1, label: `v${char.active_version || 1}` }]
                        ).map((v) => (
                          <option key={v.version} value={v.version}>
                            {v.label || `v${v.version}`}{v.has_avatar ? ' ●' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => handleCreateCharacterVersion(char.id, true)}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-amber-950/60 hover:bg-amber-900/80 border border-amber-700/50 text-amber-200"
                        title="新建版本：复制描述/标签，清空图片"
                      >
                        +V
                      </button>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                   <button onClick={() => openModal(char)} className="p-2 hover:bg-slate-800 rounded text-slate-400"><Edit2 size={14}/></button>
                   <button onClick={() => handleDelete(char.id)} className="p-2 hover:bg-slate-800 rounded text-red-400"><Trash2 size={14}/></button>
                </div>
              </div>
              
              <p className="text-slate-400 text-sm mb-4 line-clamp-3 h-14">{char.description}</p>

              {/* Character Visual Assets Dual Preview (Front Portrait + Turnaround) */}
              <div className="mb-4">
                <div className="text-[11px] font-semibold text-slate-400 mb-1.5 flex items-center justify-between">
                  <span>{t("casting.visual_assets_preview")}</span>
                  <span className="text-[10px] text-amber-500/80 font-mono">
                    v{char.active_version || 1}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {/* Front Portrait Box */}
                  <div 
                    className={`rounded-lg overflow-hidden relative group h-32 flex flex-col items-center justify-center transition-all ${
                      char.avatar_url 
                        ? 'bg-slate-950/80 border border-slate-800 hover:border-emerald-500/50' 
                        : 'bg-slate-950/40 border border-dashed border-slate-800 hover:border-emerald-500/40 hover:bg-emerald-950/20'
                    }`}
                  >
                    {char.avatar_url ? (
                      <>
                        <PreviewableImage
                          src={char.avatar_url}
                          alt={`${char.name} portrait`}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                        <ZoomHint />
                        <div className="absolute top-1 left-1 bg-black/80 backdrop-blur-sm text-[9px] text-emerald-300 font-semibold px-1.5 py-0.5 rounded border border-emerald-500/30 pointer-events-none">
                          {t("casting.front_portrait")}
                        </div>
                        <div className="absolute inset-x-0 bottom-0 p-1.5 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-wrap items-center justify-center gap-1 pointer-events-none">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openPreview(char.avatar_url); }}
                            className="pointer-events-auto bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-medium px-2 py-1 rounded shadow"
                          >
                            大图
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openSheetModal(char, 'portrait'); }}
                            className="pointer-events-auto bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-medium px-2 py-1 rounded shadow"
                          >
                            {t("casting.ai_regenerate")}
                          </button>
                          <label className="pointer-events-auto cursor-pointer bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-medium px-2 py-1 rounded shadow flex items-center gap-1">
                            <Upload size={10} /> {t("casting.upload_local")}
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => handleDirectUploadAsset(e, 'avatar', char.id)}
                            />
                          </label>
                        </div>
                      </>
                    ) : (
                      <div className="text-slate-500 text-[10px] flex flex-col items-center gap-1.5 p-2 text-center">
                        <User size={18} className="opacity-60" />
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            onClick={() => openSheetModal(char, 'portrait')}
                            className="text-emerald-400 hover:underline font-medium"
                          >
                            {t("casting.ai_generate_portrait")}
                          </button>
                          <label className="cursor-pointer text-slate-400 hover:text-white underline flex items-center justify-center gap-0.5">
                            <Upload size={10} /> {t("casting.upload_local")}
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => handleDirectUploadAsset(e, 'avatar', char.id)}
                            />
                          </label>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Turnaround Sheet Box */}
                  <div 
                    className={`rounded-lg overflow-hidden relative group h-32 flex flex-col items-center justify-center transition-all ${
                      char.turnaround_url 
                        ? 'bg-slate-950/80 border border-slate-800 hover:border-indigo-500/50' 
                        : 'bg-slate-950/40 border border-dashed border-slate-800 hover:border-indigo-500/40 hover:bg-indigo-950/20'
                    }`}
                  >
                    {char.turnaround_url ? (
                      <>
                        <PreviewableImage
                          src={char.turnaround_url}
                          alt={`${char.name} turnaround`}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                        <ZoomHint />
                        <div className="absolute top-1 left-1 bg-black/80 backdrop-blur-sm text-[9px] text-indigo-300 font-semibold px-1.5 py-0.5 rounded border border-indigo-500/30 pointer-events-none">
                          {t("casting.turnaround_sheet")}
                        </div>
                        <div className="absolute inset-x-0 bottom-0 p-1.5 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-wrap items-center justify-center gap-1 pointer-events-none">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openPreview(char.turnaround_url); }}
                            className="pointer-events-auto bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-medium px-2 py-1 rounded shadow"
                          >
                            大图
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openSheetModal(char, 'turnaround'); }}
                            className="pointer-events-auto bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-medium px-2 py-1 rounded shadow"
                          >
                            {t("casting.ai_regenerate")}
                          </button>
                          <label className="pointer-events-auto cursor-pointer bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-medium px-2 py-1 rounded shadow flex items-center gap-1">
                            <Upload size={10} /> {t("casting.upload_local")}
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => handleDirectUploadAsset(e, 'turnaround', char.id)}
                            />
                          </label>
                        </div>
                      </>
                    ) : (
                      <div className="text-slate-500 text-[10px] flex flex-col items-center gap-1.5 p-2 text-center">
                        <ImageIcon size={18} className="opacity-60" />
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            onClick={() => openSheetModal(char, 'turnaround')}
                            className="text-indigo-400 hover:underline font-medium"
                          >
                            {t("casting.ai_generate_turnaround")}
                          </button>
                          <label className="cursor-pointer text-slate-400 hover:text-white underline flex items-center justify-center gap-0.5">
                            <Upload size={10} /> {t("casting.upload_local")}
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => handleDirectUploadAsset(e, 'turnaround', char.id)}
                            />
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              
              <div className="border-t border-slate-800 pt-3">
                <h4 className="text-xs font-semibold text-slate-500 mb-2">{t('characters.visual_tags')}</h4>
                <div className="flex flex-wrap gap-2 max-h-20 overflow-y-auto">
                  {(() => {
                    const tags = char.visual_tags?.base_model?.tags || char.visual_tags || {};
                    return Object.entries(tags).map(([k, v]) => {
                      if (typeof v === 'object' && v !== null) return null; // Skip complex objects in summary
                      return (
                        <span key={k} className="px-2 py-1 bg-slate-800 rounded text-xs text-slate-300 border border-slate-700">
                          <span className="text-indigo-400">{k}:</span> {String(v)}
                        </span>
                      );
                    });
                  })()}
                </div>
              </div>
            </div>

            {/* Action Bar for Turnaround, Face Crop, and LoRA */}
            <div className="mt-4 pt-3 border-t border-slate-800/60 flex flex-col gap-2">
              <button
                onClick={() => openSheetModal(char)}
                className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-indigo-600 text-slate-200 hover:text-white px-3 py-2 rounded-lg text-xs font-medium transition-all"
              >
                <Sparkles size={14} className="text-indigo-400" />
                {t('characters.generate_sheet')}
              </button>

              <div className="flex gap-2">
                <button
                  onClick={() => handleCropFace(char.id)}
                  disabled={!char.turnaround_url && !char.avatar_url}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-slate-900 hover:bg-amber-900/40 text-slate-300 hover:text-amber-200 border border-slate-800 hover:border-amber-700/50 disabled:opacity-40 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all"
                >
                  {t('characters.crop_face')}
                </button>
                <button
                  onClick={() => handleTrainLora(char.id)}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-slate-900 hover:bg-emerald-900/40 text-slate-300 hover:text-emerald-200 border border-slate-800 hover:border-emerald-700/50 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all"
                >
                  {t('characters.train_lora')}
                </button>
              </div>
            </div>
          </div>
        );
        })}
      </div>

      {/* Edit Character Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col">
            <div className="p-4 sm:p-6 border-b border-slate-800 flex justify-between items-center sticky top-0 bg-slate-900 z-10">
              <h3 className="text-lg sm:text-xl font-bold text-white">{editingChar.id ? t('characters.edit_title') : t('characters.new_title')}</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-white"><X size={24}/></button>
            </div>
            
            <form onSubmit={handleSave} className="p-4 sm:p-6 space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                   <label className="block text-sm text-slate-400 mb-1">{t('characters.name')}</label>
                   <input 
                      required
                      className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white text-sm sm:text-base" 
                      value={editingChar.name || ''} 
                      onChange={e => setEditingChar({...editingChar, name: e.target.value})} 
                   />
                </div>
                <div>
                   <label className="block text-sm text-slate-400 mb-1">{t('characters.role')}</label>
                   <select 
                      className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white text-sm sm:text-base"
                      value={editingChar.role || 'protagonist'}
                      onChange={e => setEditingChar({...editingChar, role: e.target.value})}
                   >
                     {CHARACTER_ROLES.map(r => <option key={r.value} value={r.value}>{t(`roles.${r.value}`) || r.label}</option>)}
                   </select>
                </div>
              </div>
              
              <div>
                 <label className="block text-sm text-slate-400 mb-1">{t('characters.desc')}</label>
                 <textarea 
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white h-24 text-sm sm:text-base"
                    value={editingChar.description || ''}
                    onChange={e => setEditingChar({...editingChar, description: e.target.value})}
                 />
              </div>

              {/* Local Visual Assets Upload */}
              <div className="bg-slate-950 rounded-lg p-4 border border-slate-800 space-y-4">
                <label className="block text-sm font-semibold text-indigo-400">
                  {t('characters.upload_hint') || t("casting.upload_hint")}
                </label>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Front Portrait Upload */}
                  <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 flex flex-col items-center space-y-2">
                    <span className="text-xs text-emerald-400 font-semibold">{t('characters.upload_portrait')}</span>
                    {editingChar.avatar_url ? (
                      <div className="w-full h-24 rounded overflow-hidden relative border border-emerald-500/40">
                        <PreviewableImage src={editingChar.avatar_url} alt="Portrait" className="w-full h-full object-cover" />
                      </div>
                    ) : (
                      <div className="w-full h-24 rounded border border-dashed border-slate-700 flex flex-col items-center justify-center text-slate-500 text-xs">
                        <User size={20} className="mb-1 opacity-50" />
                        <span>{t("casting.no_local_portrait")}</span>
                      </div>
                    )}
                    <label className="cursor-pointer bg-emerald-950/80 hover:bg-emerald-900 text-emerald-200 border border-emerald-700/50 px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition-all">
                      <Upload size={14} />
                      <span>{t("casting.select_local_portrait")}</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => handleDirectUploadAsset(e, 'avatar', editingChar.id)}
                      />
                    </label>
                  </div>

                  {/* Turnaround Sheet Upload */}
                  <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 flex flex-col items-center space-y-2">
                    <span className="text-xs text-indigo-400 font-semibold">{t('characters.upload_turnaround')}</span>
                    {editingChar.turnaround_url ? (
                      <div className="w-full h-24 rounded overflow-hidden relative border border-indigo-500/40">
                        <PreviewableImage src={editingChar.turnaround_url} alt="Turnaround" className="w-full h-full object-cover" />
                      </div>
                    ) : (
                      <div className="w-full h-24 rounded border border-dashed border-slate-700 flex flex-col items-center justify-center text-slate-500 text-xs">
                        <ImageIcon size={20} className="mb-1 opacity-50" />
                        <span>{t("casting.no_local_turnaround")}</span>
                      </div>
                    )}
                    <label className="cursor-pointer bg-indigo-950/80 hover:bg-indigo-900 text-indigo-200 border border-indigo-700/50 px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition-all">
                      <Upload size={14} />
                      <span>{t("casting.select_local_turnaround")}</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => handleDirectUploadAsset(e, 'turnaround', editingChar.id)}
                      />
                    </label>
                  </div>
                </div>
              </div>

              {/* Visual Tags Editor */}
              <div className="bg-slate-950 rounded-lg p-4 border border-slate-800">
                <label className="block text-sm font-semibold text-indigo-400 mb-3">{t('characters.visual_tags_sub')}</label>
                <div className="flex flex-col sm:flex-row gap-2 mb-3">
                  <input placeholder={t('characters.key_placeholder')} className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white" value={tagKey} onChange={e => setTagKey(e.target.value)} />
                  <input placeholder={t('characters.val_placeholder')} className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white" value={tagValue} onChange={e => setTagValue(e.target.value)} />
                  <button type="button" onClick={handleAddTag} className="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded text-white self-end sm:self-auto flex items-center justify-center gap-1"><Plus size={16} /><span className="sm:hidden text-xs">{t("characters.add_tag", "Add")}</span></button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(editingChar.visual_tags || {}).map(([k, v]) => (
                    <div key={k} className="flex items-center gap-2 px-3 py-1 bg-indigo-900/30 border border-indigo-500/30 rounded-full text-sm">
                      <span className="text-indigo-300 font-mono">{k}:</span>
                      <span className="text-slate-200 truncate max-w-[200px]">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                      <button type="button" onClick={() => removeTag(k)} className="hover:text-red-400"><X size={12} /></button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end pt-4">
                <button type="submit" className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg font-medium">
                  {t('characters.save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Turnaround Sheet / Portrait Generator Modal */}
      {sheetModalChar && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto flex flex-col">
            <div className="p-4 sm:p-6 border-b border-slate-800 flex justify-between items-center sticky top-0 bg-slate-900 z-10">
              <div className="flex items-center gap-3">
                <Sparkles className="text-indigo-400" size={22} />
                <h3 className="text-lg sm:text-xl font-bold text-white">
                  {t('characters.generate_sheet')} - {sheetModalChar.name}
                </h3>
              </div>
              <button onClick={() => setSheetModalChar(null)} className="text-slate-400 hover:text-white"><X size={24}/></button>
            </div>

            <div className="p-4 sm:p-6 space-y-6">
              {/* Model & Preset Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 flex flex-col justify-between">
                  <label className="block text-xs uppercase font-semibold tracking-wider text-slate-400 mb-2">
                    {t('project_settings.defaults') || '项目生图预设与策略'}
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2.5 py-1 rounded-md bg-indigo-950 border border-indigo-700/50 text-indigo-200 text-xs font-semibold">
                      {modelType === 'flux' ? 'FLUX.1-dev (GGUF)' : 'Pony XL (SDXL)'}
                    </span>
                    <span className="px-2.5 py-1 rounded-md bg-slate-900 border border-slate-700 text-slate-300 text-xs font-medium">
                      画风: {projectStyle}
                    </span>
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold border ${
                      effectiveNsfw ? 'bg-rose-950/60 border-rose-800 text-rose-300' : 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
                    }`}>
                      {effectiveNsfw ? 'NSFW 开启' : 'SFW 安全'}
                    </span>
                  </div>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                  <label className="block text-xs uppercase font-semibold tracking-wider text-slate-400 mb-2">
                    {t('characters.gen_type')}
                  </label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => { setGenType('turnaround'); handleRebuildPrompt(modelType, 'turnaround'); }}
                      className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold border transition-all ${
                        genType === 'turnaround'
                          ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200'
                          : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t('characters.turnaround_sheet')}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setGenType('portrait'); handleRebuildPrompt(modelType, 'portrait'); }}
                      className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold border transition-all ${
                        genType === 'portrait'
                          ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200'
                          : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t('characters.portrait')}
                    </button>
                  </div>
                </div>
              </div>

              {/* Reference Portrait Card Section */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <User size={16} className="text-emerald-400" />
                    <span className="text-xs uppercase font-semibold tracking-wider text-slate-300">
                      {t('characters.ref_portrait_section')}
                    </span>
                  </div>
                  {refImageUrl && (
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={useRefPortrait}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setUseRefPortrait(checked);
                          handleRebuildPrompt(modelType, genType, checked, refImageUrl);
                        }}
                        className="w-4 h-4 rounded text-emerald-600 bg-slate-900 border-slate-700 focus:ring-emerald-500"
                      />
                      <span className="text-xs text-slate-300 font-medium">{t('characters.use_ref_portrait')}</span>
                    </label>
                  )}
                </div>

                {refImageUrl ? (
                  <div className="flex items-center gap-4 bg-slate-900/80 p-3 rounded-lg border border-slate-800">
                    <PreviewableImage
                      src={refImageUrl}
                      alt="Reference Portrait"
                      className="w-16 h-16 rounded-lg object-cover border border-emerald-500/50 shadow"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-emerald-400 mb-0.5">
                        {useRefPortrait ? t('characters.ref_portrait_active') : t("casting.ref_portrait_inactive")}
                      </p>
                      <p className="text-[11px] text-slate-400 truncate">
                        {sheetModalChar.name} - {t("casting.ref_portrait_feature")}
                      </p>
                      <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
                        {t('characters.ref_tier_a_hint')}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="p-3 bg-amber-950/20 border border-amber-800/40 rounded-lg text-xs text-amber-300 flex items-center justify-between">
                    <span>{t('characters.no_ref_portrait')}</span>
                    <label className="cursor-pointer bg-amber-900/40 hover:bg-amber-800/60 text-amber-200 px-2.5 py-1 rounded text-[11px] font-medium border border-amber-700/50 flex items-center gap-1 transition-all">
                      <Upload size={12} /> {t("casting.upload_portrait_btn")}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (file && sheetModalChar) {
                            try {
                              const updated = await api.uploadCharacterAsset(sheetModalChar.id, 'avatar', file);
                              setRefImageUrl(updated.avatar_url);
                              setUseRefPortrait(true);
                              setCharacters(prev => prev.map(c => c.id === sheetModalChar.id ? updated : c));
                              showToast(t("casting.upload_portrait_success"), 'success');
                              handleRebuildPrompt(modelType, genType, true, updated.avatar_url);
                            } catch(err) {
                              showToast(t("casting.upload_portrait_fail"), 'error');
                            }
                          }
                        }}
                      />
                    </label>
                  </div>
                )}
              </div>

              {/* Quick Turnaround Layout Tags */}
              {genType === 'turnaround' && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] font-semibold text-slate-400 mr-1">{t('characters.quick_tags_label')}:</span>
                  <button
                    type="button"
                    onClick={() => setPrompt(p => p ? `${p}, front view, side view, back view` : 'front view, side view, back view')}
                    className="px-2 py-1 bg-indigo-950/80 hover:bg-indigo-900 text-indigo-300 border border-indigo-700/50 rounded text-[11px] font-mono transition-all"
                  >
                    {t("casting.angle_full")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrompt(p => p ? `${p}, full body model sheet, 3 views turnaround sheet` : 'full body model sheet, 3 views turnaround sheet')}
                    className="px-2 py-1 bg-indigo-950/80 hover:bg-indigo-900 text-indigo-300 border border-indigo-700/50 rounded text-[11px] font-mono transition-all"
                  >
                    {t("casting.angle_grid")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrompt(p => p ? `${p}, solid white background, clean simple background` : 'solid white background, clean simple background')}
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded text-[11px] font-mono transition-all"
                  >
                    {t("casting.white_bg")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrompt(p => p ? `${p}, consistent character design across all views` : 'consistent character design across all views')}
                    className="px-2 py-1 bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/50 rounded text-[11px] font-mono transition-all"
                  >
                    {t("casting.consistent_outfit")}
                  </button>
                </div>
              )}

              {/* Prompt Box */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="block text-sm text-slate-300 font-medium">{t('characters.prompt')}</label>
                  <button
                    type="button"
                    onClick={() => handleRebuildPrompt(modelType, genType)}
                    className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                  >
                    <Wand2 size={12} /> Re-Generate Prompt
                  </button>
                </div>
                <textarea
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white text-xs sm:text-sm font-mono h-24 focus:border-indigo-500 focus:outline-none"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                />
              </div>

              {/* Negative Prompt Box */}
              <div>
                <label className="block text-sm text-slate-400 mb-1">{t('characters.negative_prompt')}</label>
                <input
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-slate-300 text-xs font-mono focus:border-indigo-500 focus:outline-none"
                  value={negativePrompt}
                  onChange={e => setNegativePrompt(e.target.value)}
                />
              </div>

              {/* Generation Execution & Preview */}
              <div className="border-t border-slate-800 pt-4 flex flex-col items-center">
                <button
                  type="button"
                  disabled={isGenerating || isPromptLoading || !prompt.trim()}
                  onClick={handleGenerateSheetImage}
                  className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-8 py-3 rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20"
                >
                  {isPromptLoading ? (
                    <>
                      <RefreshCw size={18} className="animate-spin" />
                      {t("casting.prep_prompt")}
                    </>
                  ) : isGenerating ? (
                    <>
                      <RefreshCw size={18} className="animate-spin" />
                      {t('director.status_generating')}...
                    </>
                  ) : (
                    <>
                      <Sparkles size={18} />
                      {t('characters.generate_now')}
                    </>
                  )}
                </button>

                {/* Image Output Display */}
                {generatedImageUrl && (
                  <div className="mt-6 w-full flex flex-col items-center space-y-4">
                    <div className="relative rounded-xl overflow-hidden border border-indigo-500/40 bg-black/60 max-h-80 shadow-2xl group">
                      <PreviewableImage src={generatedImageUrl} alt="Generated Asset" className="max-h-80 object-contain" />
                      <ZoomHint />
                    </div>

                    <div className="flex flex-wrap gap-2 justify-center">
                      <button
                        type="button"
                        onClick={() => saveAssetToCharacter('avatar')}
                        className="bg-emerald-900/60 hover:bg-emerald-600 text-emerald-100 hover:text-white px-3 py-2 rounded-lg text-xs font-semibold border border-emerald-500/40 flex items-center gap-1.5 transition-all"
                        title="覆盖当前版本立绘"
                      >
                        <CheckCircle size={14} /> 保存立绘·本版
                      </button>
                      <button
                        type="button"
                        onClick={() => saveAssetToCharacter('avatar', { newVersion: true })}
                        className="bg-amber-900/50 hover:bg-amber-700 text-amber-100 hover:text-white px-3 py-2 rounded-lg text-xs font-semibold border border-amber-500/40 flex items-center gap-1.5 transition-all"
                        title="新建版本并保存为立绘"
                      >
                        <CheckCircle size={14} /> 立绘·新版
                      </button>
                      <button
                        type="button"
                        onClick={() => saveAssetToCharacter('turnaround')}
                        className="bg-indigo-900/60 hover:bg-indigo-600 text-indigo-100 hover:text-white px-3 py-2 rounded-lg text-xs font-semibold border border-indigo-500/40 flex items-center gap-1.5 transition-all"
                        title="覆盖当前版本三视图"
                      >
                        <CheckCircle size={14} /> 三视图·本版
                      </button>
                      <button
                        type="button"
                        onClick={() => saveAssetToCharacter('turnaround', { newVersion: true })}
                        className="bg-amber-900/50 hover:bg-amber-700 text-amber-100 hover:text-white px-3 py-2 rounded-lg text-xs font-semibold border border-amber-500/40 flex items-center gap-1.5 transition-all"
                        title="新建版本并保存为三视图"
                      >
                        <CheckCircle size={14} /> 三视图·新版
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {imageLightbox}
    </div>
  );
};
