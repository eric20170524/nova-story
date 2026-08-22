import React from 'react';
import { User, Edit2, Trash2, Sparkles, Image as ImageIcon, Upload, CheckCircle } from 'lucide-react';
import { Character } from '../../types';
import { CHARACTER_ROLES } from '../../constants';
import { useLanguage } from '../../LanguageContext';
import { PreviewableImage, ZoomHint } from '../ImageLightbox';

interface CharacterCardProps {
  char: Character;
  expandedDesc: boolean;
  expandedTags: boolean;
  onToggleDesc: (id: number) => void;
  onToggleTags: (id: number) => void;
  onEdit: (char: Character) => void;
  onDelete: (id: number) => void;
  onOpenSheetModal: (char: Character, initialGenType?: 'turnaround' | 'portrait') => void;
  onCropFace: (id: number) => void;
  onTrainLora: (id: number) => void;
  onUploadAsset: (e: React.ChangeEvent<HTMLInputElement>, assetType: 'avatar' | 'turnaround' | 'face', charId: number) => void;
  onSwitchVersion: (charId: number, version: number) => void;
  onCreateVersion: (charId: number) => void;
  onOpenPreview: (url?: string | null) => void;
}

export const CharacterCard: React.FC<CharacterCardProps> = ({
  char,
  expandedDesc,
  expandedTags,
  onToggleDesc,
  onToggleTags,
  onEdit,
  onDelete,
  onOpenSheetModal,
  onCropFace,
  onTrainLora,
  onUploadAsset,
  onSwitchVersion,
  onCreateVersion,
  onOpenPreview,
}) => {
  const { t } = useLanguage();

  const roleObj = CHARACTER_ROLES.find((r) => r.value === char.role);
  const roleLabel = roleObj ? (t(`roles.${roleObj.value}`) || roleObj.label) : char.role;

  const visualTagsObj = char.visual_tags?.base_model?.tags || char.visual_tags || {};
  const tagEntries = Object.entries(visualTagsObj).filter(
    ([, v]) => !(typeof v === 'object' && v !== null)
  );

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 flex flex-col justify-between hover:border-slate-700 transition-all shadow-lg relative group/card">
      <div>
        {/* Card Header: Avatar & Info */}
        <div className="flex justify-between items-start mb-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center overflow-hidden flex-shrink-0 relative group">
              {char.avatar_url ? (
                <>
                  <PreviewableImage
                    src={char.avatar_url}
                    alt={char.name}
                    className="w-full h-full object-cover"
                  />
                  <ZoomHint />
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center transition-opacity">
                    <label className="cursor-pointer text-[10px] text-white underline">
                      {t("casting.change", "更换")}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => onUploadAsset(e, 'avatar', char.id)}
                      />
                    </label>
                  </div>
                </>
              ) : (
                <div className="relative w-full h-full flex flex-col items-center justify-center">
                  <User className="text-slate-500" size={24} />
                  <label className="absolute inset-0 bg-black/70 opacity-0 hover:opacity-100 flex items-center justify-center cursor-pointer transition-opacity">
                    <Upload size={12} className="text-white" />
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => onUploadAsset(e, 'avatar', char.id)}
                    />
                  </label>
                </div>
              )}
            </div>
            <div>
              <h3 className="font-bold text-white text-base sm:text-lg flex items-center gap-2">
                {char.name}
                {char.lora_ready && (
                  <span
                    className="flex items-center gap-1 text-[10px] bg-emerald-950/80 text-emerald-400 border border-emerald-800/80 px-1.5 py-0.5 rounded font-mono font-medium"
                    title={t("casting.lora_ready_hint")}
                  >
                    <CheckCircle size={10} /> LoRA
                  </span>
                )}
              </h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-medium inline-block mt-0.5 border border-slate-700">
                {roleLabel}
              </span>
            </div>
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => onEdit(char)}
              className="p-1.5 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors"
              title="Edit"
            >
              <Edit2 size={16} />
            </button>
            <button
              onClick={() => onDelete(char.id)}
              className="p-1.5 text-slate-400 hover:text-red-400 rounded hover:bg-slate-800 transition-colors"
              title="Delete"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>

        {/* Character Versions Bar */}
        <div className="mb-3 px-2 py-1.5 bg-slate-950/70 border border-slate-800 rounded-lg flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar py-0.5">
            <span className="text-[10px] text-slate-500 uppercase font-mono font-bold">
              {t("characters.versions_title", "版本")}
            </span>
            {(char.versions || []).map((ver) => (
              <button
                key={ver.version}
                type="button"
                onClick={() => onSwitchVersion(char.id, ver.version)}
                className={`text-[10px] px-2 py-0.5 rounded font-mono transition-colors ${
                  (char.active_version || 1) === ver.version
                    ? 'bg-indigo-600 text-white font-bold shadow'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
                title={ver.label || `V${ver.version}`}
              >
                V{ver.version}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onCreateVersion(char.id)}
            className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-indigo-700 text-slate-300 hover:text-white transition-colors flex-shrink-0"
          >
            +{t("characters.new_version", "新版本")}
          </button>
        </div>

        {/* Description Section */}
        {char.description && (
          <div className="mb-3">
            <p
              className={`text-slate-400 text-xs sm:text-sm leading-relaxed ${
                expandedDesc ? '' : 'line-clamp-2'
              }`}
            >
              {char.description}
            </p>
            {char.description.length > 80 && (
              <button
                type="button"
                onClick={() => onToggleDesc(char.id)}
                className="mt-1 text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
              >
                {expandedDesc
                  ? t('characters.collapse', '收起')
                  : t('characters.expand_desc', '展开完整设定')}
              </button>
            )}
          </div>
        )}

        {/* Asset Slot: Turnaround Sheet / Portrait */}
        <div className="space-y-2 mb-4">
          <div className="grid grid-cols-1 gap-2">
            <div className="aspect-[21/9] bg-slate-950 border border-slate-800 rounded-lg overflow-hidden flex items-center justify-center relative group">
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
                      onClick={(e) => { e.stopPropagation(); onOpenPreview(char.turnaround_url); }}
                      className="pointer-events-auto bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-medium px-2 py-1 rounded shadow"
                    >
                      大图
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onOpenSheetModal(char, 'turnaround'); }}
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
                        onChange={(e) => onUploadAsset(e, 'turnaround', char.id)}
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
                      onClick={() => onOpenSheetModal(char, 'turnaround')}
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
                        onChange={(e) => onUploadAsset(e, 'turnaround', char.id)}
                      />
                    </label>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Visual Tags Section */}
        <div className="border-t border-slate-800 pt-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-slate-500">
              {t('characters.visual_tags')}
            </h4>
            {tagEntries.length > 0 && (
              <span className="text-[10px] text-slate-600 font-mono">
                {tagEntries.length}
              </span>
            )}
          </div>
          <div
            className={`flex flex-wrap gap-2 ${
              expandedTags
                ? 'max-h-40 overflow-y-auto custom-scrollbar pr-0.5'
                : 'max-h-16 overflow-hidden'
            }`}
          >
            {tagEntries.length === 0 ? (
              <span className="text-[11px] text-slate-600 italic">
                {t('characters.no_visual_tags', '暂无视觉标签（定稿章节可自动提取）')}
              </span>
            ) : (
              tagEntries.map(([k, v]) => (
                <span
                  key={k}
                  className="px-2 py-1 bg-slate-800 rounded text-xs text-slate-300 border border-slate-700 max-w-full"
                  title={`${k}: ${String(v)}`}
                >
                  <span className="text-indigo-400">{k}:</span>{' '}
                  <span className="break-all">{String(v)}</span>
                </span>
              ))
            )}
          </div>
          {tagEntries.length > 4 && (
            <button
              type="button"
              onClick={() => onToggleTags(char.id)}
              className="mt-1.5 text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
            >
              {expandedTags
                ? t('characters.collapse', '收起')
                : t('characters.expand_tags', '展开全部标签')}
            </button>
          )}
        </div>
      </div>

      {/* Action Bar for Turnaround, Face Crop, and LoRA */}
      <div className="mt-4 pt-3 border-t border-slate-800/60 flex flex-col gap-2">
        <button
          onClick={() => onOpenSheetModal(char)}
          className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-indigo-600 text-slate-200 hover:text-white px-3 py-2 rounded-lg text-xs font-medium transition-all"
        >
          <Sparkles size={14} className="text-indigo-400" />
          {t('characters.generate_sheet')}
        </button>

        <div className="flex gap-2">
          <button
            onClick={() => onCropFace(char.id)}
            disabled={!char.turnaround_url && !char.avatar_url}
            className="flex-1 flex items-center justify-center gap-1.5 bg-slate-900 hover:bg-amber-900/40 text-slate-300 hover:text-amber-200 border border-slate-800 hover:border-amber-700/50 disabled:opacity-40 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all"
          >
            {t('characters.crop_face')}
          </button>
          <button
            onClick={() => onTrainLora(char.id)}
            className="flex-1 flex items-center justify-center gap-1.5 bg-slate-900 hover:bg-emerald-900/40 text-slate-300 hover:text-emerald-200 border border-slate-800 hover:border-emerald-700/50 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all"
          >
            {t('characters.train_lora')}
          </button>
        </div>
      </div>
    </div>
  );
};
