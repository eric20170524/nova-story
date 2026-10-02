import React, { useState, useEffect, useRef } from 'react';
import { X, Plus, User, Image as ImageIcon, Upload, Volume2, RotateCcw, Loader2 } from 'lucide-react';
import { Character, PublicTtsVoice, TtsStatusResult, TtsVoiceTier } from '../../types';
import { CHARACTER_ROLES } from '../../constants';
import { useLanguage } from '../../LanguageContext';
import { useToast } from '../../ToastContext';
import { api } from '../../services/api';
import { PreviewableImage } from '../ImageLightbox';

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
  };
  const baseModel = { ...(full.base_model || {}) };
  baseModel.tags = { ...flat };
  next.base_model = baseModel;
  for (const [k, v] of Object.entries(flat)) {
    next[k] = v;
  }
  return next;
};

interface CharacterEditModalProps {
  isOpen: boolean;
  editingChar: Partial<Character>;
  setEditingChar: React.Dispatch<React.SetStateAction<Partial<Character>>>;
  onClose: () => void;
  onSave: (e: React.FormEvent) => void;
  onUploadAsset: (e: React.ChangeEvent<HTMLInputElement>, assetType: 'avatar' | 'turnaround' | 'face', charId?: number) => void;
}

export const CharacterEditModal: React.FC<CharacterEditModalProps> = ({
  isOpen,
  editingChar,
  setEditingChar,
  onClose,
  onSave,
  onUploadAsset,
}) => {
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');

  const [ttsStatus, setTtsStatus] = useState<TtsStatusResult | null>(null);
  const [voices, setVoices] = useState<PublicTtsVoice[]>([]);
  const [isLoadingTts, setIsLoadingTts] = useState(false);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const previewEpochRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);

  const stopPreview = () => {
    previewEpochRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setIsPlayingPreview(false);
  };

  useEffect(() => {
    if (!isOpen) {
      stopPreview();
      return;
    }
    let isCancelled = false;
    setIsLoadingTts(true);

    Promise.all([
      api.getTtsStatus().catch(() => ({ ok: false, enabled: false, base_url: '', voice_count: 0 })),
      api.getTtsVoices().catch(() => [] as PublicTtsVoice[]),
    ]).then(([statusRes, voiceList]) => {
      if (isCancelled) return;
      setTtsStatus(statusRes);
      setVoices(voiceList);
    }).finally(() => {
      if (!isCancelled) {
        setIsLoadingTts(false);
      }
    });

    return () => {
      isCancelled = true;
      stopPreview();
    };
  }, [isOpen]);

  const handlePreviewVoice = async () => {
    const voiceId = editingChar.voice_id;
    if (!voiceId) return;

    stopPreview();
    const epoch = previewEpochRef.current;
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setIsPlayingPreview(true);

    try {
      const blob = await api.previewTts(voiceId, undefined, controller.signal);
      if (epoch !== previewEpochRef.current) return;
      const url = URL.createObjectURL(blob);
      if (epoch !== previewEpochRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onended = () => {
        if (epoch === previewEpochRef.current) stopPreview();
      };

      audio.onerror = () => {
        if (epoch !== previewEpochRef.current) return;
        stopPreview();
        showToast(t('characters.voice_preview_failed', '音色试听失败'), 'error');
      };

      await audio.play();
      if (epoch !== previewEpochRef.current) {
        audio.pause();
      }
    } catch (err: any) {
      if (epoch !== previewEpochRef.current || controller.signal.aborted) return;
      stopPreview();
      showToast(err?.message || t('characters.voice_preview_failed', '音色试听失败'), 'error');
    }
  };

  if (!isOpen) return null;

  const handleAddTag = () => {
    if (!tagKey.trim() || !tagValue.trim()) return;
    const cur = flatEditableVisualTags(editingChar.visual_tags);
    cur[tagKey.trim()] = tagValue.trim();
    setEditingChar((prev) => ({
      ...prev,
      visual_tags: applyFlatVisualTags(prev.visual_tags, cur),
    }));
    setTagKey('');
    setTagValue('');
  };

  const handleRemoveTag = (key: string) => {
    const cur = flatEditableVisualTags(editingChar.visual_tags);
    delete cur[key];
    setEditingChar((prev) => ({
      ...prev,
      visual_tags: applyFlatVisualTags(prev.visual_tags, cur),
    }));
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-[#0f172a] border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col shadow-2xl custom-scrollbar animate-in zoom-in-95 duration-200">
        <div className="p-4 sm:p-6 border-b border-slate-200/80 dark:border-slate-800/80 flex justify-between items-center sticky top-0 bg-white dark:bg-[#0f172a] z-10 flex-shrink-0">
          <h3 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white">
            {editingChar.id ? t('characters.edit_title') : t('characters.new_title')}
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={onSave} className="p-4 sm:p-6 space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-1.5">{t('characters.name')}</label>
              <input
                required
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-indigo-500/50 focus:outline-none transition-all"
                value={editingChar.name || ''}
                onChange={(e) => setEditingChar({ ...editingChar, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-1.5">{t('characters.role')}</label>
              <select
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-indigo-500/50 focus:outline-none transition-all"
                value={editingChar.role || 'protagonist'}
                onChange={(e) => setEditingChar({ ...editingChar, role: e.target.value })}
              >
                {CHARACTER_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {t(`roles.${r.value}`) || r.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-1.5">{t('characters.desc')}</label>
            <textarea
              className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-white min-h-[6rem] h-36 resize-y text-sm focus:ring-2 focus:ring-indigo-500/50 focus:outline-none custom-scrollbar transition-all"
              value={editingChar.description || ''}
              onChange={(e) => setEditingChar({ ...editingChar, description: e.target.value })}
            />
          </div>

          {/* Character Voice Section */}
          <div className="bg-slate-50 dark:bg-slate-950/70 rounded-2xl p-4 border border-slate-200/80 dark:border-slate-800 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                {t('characters.voice_title', '角色音色')}
              </label>
              <div>
                {isLoadingTts ? (
                  <span
                    data-testid="character-voice-status"
                    className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
                  >
                    <Loader2 size={12} className="animate-spin" />
                    <span>加载中…</span>
                  </span>
                ) : ttsStatus?.ok ? (
                  <span
                    data-testid="character-voice-status"
                    className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/80"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span>
                      {t('characters.voice_status_connected', '已连通（共 {count} 个可用音色）', {
                        count: voices.length || ttsStatus.voice_count,
                      })}
                    </span>
                  </span>
                ) : (
                  <span
                    data-testid="character-voice-status"
                    className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/80"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    <span>
                      {t('characters.voice_status_disconnected', 'TTS 服务未连通，暂时不能更换音色')}
                    </span>
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <div className="flex-1 min-w-0">
                <select
                  data-testid="character-voice-select"
                  disabled={!ttsStatus?.ok && voices.length === 0}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-indigo-500/50 focus:outline-none transition-all disabled:opacity-60"
                  value={editingChar.voice_id || ''}
                  onChange={(e) => {
                    const nextId = e.target.value || null;
                    const v = voices.find((item) => item.id === nextId);
                    setEditingChar((prev) => ({
                      ...prev,
                      voice_id: nextId,
                      voice_label: nextId && v ? `${v.id} · ${v.name} · ${v.style}` : (nextId ? prev.voice_label : null),
                    }));
                  }}
                >
                  <option value="">{t('characters.voice_none', '未设定音色（留空）')}</option>
                  {Boolean(editingChar.voice_id && !voices.some((v) => v.id === editingChar.voice_id)) && (
                    <option value={editingChar.voice_id!}>
                      {editingChar.voice_label || editingChar.voice_id} ({t('characters.voice_missing', '本机目录中已没有这个音色')})
                    </option>
                  )}
                  {(['light', 'quality', 'clone', 'online'] as TtsVoiceTier[]).map((tier) => {
                    const tierVoices = voices.filter((v) => v.tier === tier);
                    if (tierVoices.length === 0) return null;
                    const tierLabels: Record<TtsVoiceTier, string> = {
                      light: t('characters.voice_tier_light', '轻量内置'),
                      quality: t('characters.voice_tier_quality', '高质模型'),
                      clone: t('characters.voice_tier_clone', '克隆音色'),
                      online: t('characters.voice_tier_online', '在线扩展'),
                    };
                    return (
                      <optgroup key={tier} label={tierLabels[tier]}>
                        {tierVoices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.id} · {v.name} · {v.style}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  type="button"
                  data-testid="character-voice-preview"
                  onClick={handlePreviewVoice}
                  disabled={!editingChar.voice_id || isPlayingPreview || (!voices.some((v) => v.id === editingChar.voice_id) && !ttsStatus?.ok)}
                  className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-semibold bg-indigo-50 dark:bg-indigo-950/80 hover:bg-indigo-100 dark:hover:bg-indigo-900 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/80 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-2xs"
                >
                  {isPlayingPreview ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      <span>{t('characters.voice_previewing', '试听中…')}</span>
                    </>
                  ) : (
                    <>
                      <Volume2 size={14} />
                      <span>{t('characters.voice_preview', '试听')}</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  data-testid="character-voice-clear"
                  onClick={() => {
                    stopPreview();
                    setEditingChar((prev) => ({
                      ...prev,
                      voice_id: null,
                      voice_label: null,
                    }));
                  }}
                  disabled={!editingChar.voice_id}
                  className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-semibold bg-white dark:bg-slate-900 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-700 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 border border-slate-200 dark:border-slate-700 hover:border-rose-300 dark:hover:border-rose-800/60 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-2xs"
                >
                  <RotateCcw size={13} />
                  <span>{t('characters.voice_clear', '清除音色')}</span>
                </button>
              </div>
            </div>

            {Boolean(editingChar.voice_id && !voices.some((v) => v.id === editingChar.voice_id)) && (
              <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                {t('characters.voice_missing', '本机目录中已没有这个音色')}
              </p>
            )}

            {(() => {
              const sel = voices.find((v) => v.id === editingChar.voice_id);
              if (sel?.tier === 'online') {
                return (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t('characters.voice_hint_online', '在线档首次合成需要网络连接')}
                  </p>
                );
              }
              if (sel?.tier === 'quality' || sel?.tier === 'clone') {
                return (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t('characters.voice_hint_quality', '高质/克隆音色首次播放需要加载较大模型，可能稍慢')}
                  </p>
                );
              }
              return null;
            })()}
          </div>

          {/* Local Visual Assets Upload */}
          <div className="bg-slate-50 dark:bg-slate-950/70 rounded-2xl p-4 border border-slate-200/80 dark:border-slate-800 space-y-4">
            <label className="block text-xs font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
              {t('characters.upload_hint') || t("casting.upload_hint")}
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Front Portrait Upload */}
              <div className="bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200/80 dark:border-slate-800 flex flex-col items-center space-y-2">
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-semibold">{t('characters.upload_portrait')}</span>
                {editingChar.avatar_url ? (
                  <div className="w-full h-24 rounded-lg overflow-hidden relative border border-emerald-300 dark:border-emerald-500/40">
                    <PreviewableImage src={editingChar.avatar_url} alt="Portrait" className="w-full h-full object-cover" />
                  </div>
                ) : (
                  <div className="w-full h-24 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 text-xs">
                    <User size={20} className="mb-1 opacity-50" />
                    <span>{t("casting.no_local_portrait")}</span>
                  </div>
                )}
                <label className="cursor-pointer bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/80 dark:hover:bg-emerald-900 text-emerald-700 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-700/50 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all shadow-2xs">
                  <Upload size={13} />
                  <span>{t("casting.select_local_portrait")}</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => onUploadAsset(e, 'avatar', editingChar.id)}
                  />
                </label>
              </div>

              {/* Turnaround Sheet Upload */}
              <div className="bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200/80 dark:border-slate-800 flex flex-col items-center space-y-2">
                <span className="text-xs text-indigo-600 dark:text-indigo-400 font-semibold">{t('characters.upload_turnaround')}</span>
                {editingChar.turnaround_url ? (
                  <div className="w-full h-24 rounded-lg overflow-hidden relative border border-indigo-300 dark:border-indigo-500/40">
                    <PreviewableImage src={editingChar.turnaround_url} alt="Turnaround" className="w-full h-full object-cover" />
                  </div>
                ) : (
                  <div className="w-full h-24 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 text-xs">
                    <ImageIcon size={20} className="mb-1 opacity-50" />
                    <span>{t("casting.no_local_turnaround")}</span>
                  </div>
                )}
                <label className="cursor-pointer bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/80 dark:hover:bg-indigo-900 text-indigo-700 dark:text-indigo-200 border border-indigo-300 dark:border-indigo-700/50 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all shadow-2xs">
                  <Upload size={13} />
                  <span>{t("casting.select_local_turnaround")}</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => onUploadAsset(e, 'turnaround', editingChar.id)}
                  />
                </label>
              </div>
            </div>
          </div>

          {/* Visual Tags Editor */}
          <div className="bg-slate-50 dark:bg-slate-950/70 rounded-2xl p-4 border border-slate-200/80 dark:border-slate-800">
            <label className="block text-xs font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 mb-3">{t('characters.visual_tags_sub')}</label>
            <div className="flex flex-col sm:flex-row gap-2 mb-3">
              <input
                placeholder={t('characters.key_placeholder')}
                className="flex-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-xs sm:text-sm text-slate-900 dark:text-white"
                value={tagKey}
                onChange={(e) => setTagKey(e.target.value)}
              />
              <input
                placeholder={t('characters.val_placeholder')}
                className="flex-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-xs sm:text-sm text-slate-900 dark:text-white"
                value={tagValue}
                onChange={(e) => setTagValue(e.target.value)}
              />
              <button
                type="button"
                onClick={handleAddTag}
                className="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-xl text-white self-end sm:self-auto flex items-center justify-center gap-1 text-xs font-semibold shadow-xs transition-all"
              >
                <Plus size={15} />
                <span>{t("characters.add_tag", "添加")}</span>
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto custom-scrollbar">
              {Object.entries(flatEditableVisualTags(editingChar.visual_tags)).map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-center gap-2 px-3 py-1 bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-500/30 rounded-full text-xs max-w-full shadow-2xs"
                >
                  <span className="text-indigo-600 dark:text-indigo-400 font-semibold font-mono shrink-0">{k}:</span>
                  <span className="text-slate-700 dark:text-slate-200 break-all">{v}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(k)}
                    className="text-slate-400 hover:text-rose-500 shrink-0 ml-1"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end pt-3 border-t border-slate-100 dark:border-slate-800">
            <button
              type="submit"
              className="w-full sm:w-auto bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white px-6 py-2.5 rounded-xl font-semibold text-sm shadow-md shadow-indigo-500/20 transition-all"
            >
              {t('characters.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
