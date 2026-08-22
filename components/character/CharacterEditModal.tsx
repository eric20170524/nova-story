import React, { useState } from 'react';
import { X, Plus, User, Image as ImageIcon, Upload } from 'lucide-react';
import { Character } from '../../types';
import { CHARACTER_ROLES } from '../../constants';
import { useLanguage } from '../../LanguageContext';
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
  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');

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
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col">
        <div className="p-4 sm:p-6 border-b border-slate-800 flex justify-between items-center sticky top-0 bg-slate-900 z-10">
          <h3 className="text-lg sm:text-xl font-bold text-white">
            {editingChar.id ? t('characters.edit_title') : t('characters.new_title')}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X size={24} />
          </button>
        </div>

        <form onSubmit={onSave} className="p-4 sm:p-6 space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">{t('characters.name')}</label>
              <input
                required
                className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white text-sm sm:text-base"
                value={editingChar.name || ''}
                onChange={(e) => setEditingChar({ ...editingChar, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">{t('characters.role')}</label>
              <select
                className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white text-sm sm:text-base"
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
            <label className="block text-sm text-slate-400 mb-1">{t('characters.desc')}</label>
            <textarea
              className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white min-h-[6rem] h-40 resize-y text-sm sm:text-base custom-scrollbar"
              value={editingChar.description || ''}
              onChange={(e) => setEditingChar({ ...editingChar, description: e.target.value })}
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
                    onChange={(e) => onUploadAsset(e, 'avatar', editingChar.id)}
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
                    onChange={(e) => onUploadAsset(e, 'turnaround', editingChar.id)}
                  />
                </label>
              </div>
            </div>
          </div>

          {/* Visual Tags Editor */}
          <div className="bg-slate-950 rounded-lg p-4 border border-slate-800">
            <label className="block text-sm font-semibold text-indigo-400 mb-3">{t('characters.visual_tags_sub')}</label>
            <div className="flex flex-col sm:flex-row gap-2 mb-3">
              <input
                placeholder={t('characters.key_placeholder')}
                className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white"
                value={tagKey}
                onChange={(e) => setTagKey(e.target.value)}
              />
              <input
                placeholder={t('characters.val_placeholder')}
                className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white"
                value={tagValue}
                onChange={(e) => setTagValue(e.target.value)}
              />
              <button
                type="button"
                onClick={handleAddTag}
                className="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded text-white self-end sm:self-auto flex items-center justify-center gap-1"
              >
                <Plus size={16} />
                <span className="sm:hidden text-xs">{t("characters.add_tag", "Add")}</span>
              </button>
            </div>
            <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto custom-scrollbar">
              {Object.entries(flatEditableVisualTags(editingChar.visual_tags)).map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-center gap-2 px-3 py-1 bg-indigo-900/30 border border-indigo-500/30 rounded-full text-sm max-w-full"
                >
                  <span className="text-indigo-300 font-mono shrink-0">{k}:</span>
                  <span className="text-slate-200 break-all">{v}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(k)}
                    className="hover:text-red-400 shrink-0"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end pt-4">
            <button
              type="submit"
              className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg font-medium"
            >
              {t('characters.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
