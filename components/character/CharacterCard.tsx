import React from 'react';
import { User, Edit2, Trash2, Sparkles, Image as ImageIcon, Upload, CheckCircle, Volume2, Link2 } from 'lucide-react';
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
  const charAge =
    (typeof visualTagsObj.age === 'string' && visualTagsObj.age.trim()) ||
    (typeof char.visual_tags?.age === 'string' && char.visual_tags.age.trim()) ||
    (typeof char.visual_tags?.visual_bible?.age === 'string' && char.visual_tags.visual_bible.age.trim()) ||
    '';

  const tagEntries = Object.entries(visualTagsObj).filter(
    ([, v]) => !(typeof v === 'object' && v !== null)
  );

  return (
    <div className="bg-white dark:bg-[#0f172a] border border-slate-200/80 dark:border-slate-800/80 rounded-2xl p-4 sm:p-5 flex flex-col justify-between hover:border-indigo-400/60 dark:hover:border-slate-700 transition-all shadow-xs hover:shadow-xl dark:shadow-lg relative group/card">
      <div>
        {/* Card Header: Avatar & Info */}
        <div className="flex justify-between items-start mb-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center overflow-hidden flex-shrink-0 relative group shadow-xs">
              {char.avatar_url ? (
                <>
                  <PreviewableImage
                    src={char.avatar_url}
                    alt={char.name}
                    className="w-full h-full object-cover object-top"
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
                  <User className="text-slate-400 dark:text-slate-500" size={22} />
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
              <h3 className="font-bold text-slate-900 dark:text-white text-base sm:text-lg flex items-center gap-2">
                {char.name}
                {char.lora_ready && (
                  <span
                    className="flex items-center gap-1 text-[10px] bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/80 px-1.5 py-0.5 rounded-md font-mono font-medium"
                    title={t("casting.lora_ready_hint")}
                  >
                    <CheckCircle size={10} /> LoRA
                  </span>
                )}
              </h3>
              <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-medium inline-block border border-slate-200 dark:border-slate-700">
                  {roleLabel}
                </span>
                {charAge && (
                  <span
                    data-testid="character-card-age"
                    className="text-xs px-2.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 font-medium inline-block border border-amber-200 dark:border-amber-800/70"
                    title={`年龄: ${charAge}`}
                  >
                    {charAge}
                  </span>
                )}
                <span
                  data-testid="character-card-voice"
                  className={`text-xs px-2.5 py-0.5 rounded-full font-medium inline-flex items-center gap-1 border ${
                    char.voice_label
                      ? 'bg-violet-50 dark:bg-violet-950/60 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800/70'
                      : 'bg-slate-50 dark:bg-slate-900 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-800'
                  }`}
                  title={char.voice_label || t('characters.voice_unassigned', '未设定音色')}
                >
                  <Volume2 size={11} className="flex-shrink-0" />
                  <span className="truncate max-w-[130px] sm:max-w-[180px]">
                    {char.voice_label || t('characters.voice_unassigned', '未设定音色')}
                  </span>
                </span>
              </div>
            </div>
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => onEdit(char)}
              className="p-1.5 text-slate-400 hover:text-slate-800 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="Edit"
            >
              <Edit2 size={15} />
            </button>
            <button
              onClick={() => onDelete(char.id)}
              className="p-1.5 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="Delete"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        {/* Character Versions Bar */}
        <div className="mb-3 px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950/70 border border-slate-200/80 dark:border-slate-800 rounded-xl flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar py-0.5">
            <span className="text-[10px] text-slate-400 dark:text-slate-500 uppercase font-mono font-bold">
              {t("characters.versions_title", "版本")}
            </span>
            {(char.versions || []).map((ver) => (
              <button
                key={ver.version}
                type="button"
                onClick={() => onSwitchVersion(char.id, ver.version)}
                className={`text-[10px] px-2 py-0.5 rounded-md font-mono transition-all ${
                  (char.active_version || 1) === ver.version
                    ? 'bg-indigo-600 text-white font-bold shadow-xs'
                    : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 border border-slate-200 dark:border-slate-700'
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
            className="text-[10px] px-2 py-0.5 rounded-md bg-white dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-700 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-white border border-slate-200 dark:border-slate-700 transition-colors flex-shrink-0 font-medium"
          >
            +{t("characters.new_version", "新版本")}
          </button>
        </div>

        {/* Description Section */}
        {char.description && (
          <div className="mb-3">
            <p
              className={`text-slate-600 dark:text-slate-400 text-xs sm:text-sm leading-relaxed ${
                expandedDesc ? '' : 'line-clamp-2'
              }`}
            >
              {char.description}
            </p>
            {char.description.length > 80 && (
              <button
                type="button"
                onClick={() => onToggleDesc(char.id)}
                className="mt-1 text-[11px] text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 font-semibold"
              >
                {expandedDesc
                  ? t('characters.collapse', '收起')
                  : t('characters.expand_desc', '展开完整设定')}
              </button>
            )}
          </div>
        )}

        {/* Dual Large Showcase: Upper-Body Front Portrait (定妆照) + 3-View Turnaround Sheet (三视图) */}
        <div className="mb-4" data-testid="character-card-showcase">
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            {/* Left Slot: Upper-Body Front Portrait (定妆照 · 上半身正面大图) */}
            <div
              data-testid="character-card-portrait-slot"
              className="sm:col-span-5 aspect-[3/4] sm:min-h-[240px] bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800 rounded-xl overflow-hidden flex items-center justify-center relative group"
            >
              {char.avatar_url ? (
                <>
                  <PreviewableImage
                    src={char.avatar_url}
                    alt={`${char.name} portrait`}
                    className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-300"
                  />
                  <ZoomHint />
                  <div className="absolute top-2 left-2 bg-black/80 backdrop-blur-sm text-[10px] text-emerald-300 font-semibold px-2 py-0.5 rounded-md border border-emerald-500/30 pointer-events-none">
                    {t("casting.portrait_upper_front", "定妆照 · 上半身正面")}
                  </div>
                  <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/85 via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-wrap items-center justify-center gap-1.5 pointer-events-none">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onOpenPreview(char.avatar_url); }}
                      className="pointer-events-auto bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-medium px-2.5 py-1 rounded-md shadow-xs"
                    >
                      大图
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onOpenSheetModal(char, 'portrait'); }}
                      className="pointer-events-auto bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-medium px-2.5 py-1 rounded-md shadow-xs"
                    >
                      {t("casting.ai_regenerate", "AI 重新生成")}
                    </button>
                    <label className="pointer-events-auto cursor-pointer bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-medium px-2.5 py-1 rounded-md shadow-xs flex items-center gap-1">
                      <Upload size={10} /> {t("casting.upload_local", "上传")}
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
                <div className="text-slate-400 dark:text-slate-500 text-[11px] flex flex-col items-center justify-center gap-2 p-3 text-center">
                  <div className="w-9 h-9 rounded-full bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800/60 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                    <User size={18} />
                  </div>
                  <span className="font-semibold text-slate-600 dark:text-slate-300">
                    {t("casting.portrait_upper_front", "定妆照 · 上半身正面")}
                  </span>
                  <div className="flex flex-col gap-1.5 mt-0.5">
                    <button
                      type="button"
                      onClick={() => onOpenSheetModal(char, 'portrait')}
                      className="text-emerald-600 dark:text-emerald-400 hover:underline font-semibold"
                    >
                      {t("casting.ai_generate_portrait", "+ AI 生成定妆照")}
                    </button>
                    <label className="cursor-pointer text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white underline flex items-center justify-center gap-1">
                      <Upload size={10} /> {t("casting.upload_local", "本地上传")}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => onUploadAsset(e, 'avatar', char.id)}
                      />
                    </label>
                  </div>
                </div>
              )}
            </div>

            {/* Right Slot: 3-View Turnaround Sheet (角色三视图大图) */}
            <div
              data-testid="character-card-turnaround-slot"
              className="sm:col-span-7 aspect-[16/10] sm:aspect-auto sm:min-h-[240px] bg-slate-100/70 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800 rounded-xl overflow-hidden flex items-center justify-center relative group"
            >
              {char.turnaround_url ? (
                <>
                  <PreviewableImage
                    src={char.turnaround_url}
                    alt={`${char.name} turnaround`}
                    className="w-full h-full object-contain group-hover:scale-[1.03] transition-transform duration-300"
                  />
                  <ZoomHint />
                  <div className="absolute top-2 left-2 bg-black/80 backdrop-blur-sm text-[10px] text-indigo-300 font-semibold px-2 py-0.5 rounded-md border border-indigo-500/30 pointer-events-none">
                    {t("casting.turnaround_sheet", "角色三视图")}
                  </div>
                  {char.avatar_url && (
                    <div
                      className="absolute top-2 right-2 bg-emerald-950/85 backdrop-blur-sm text-[9px] text-emerald-300 font-medium px-2 py-0.5 rounded-md border border-emerald-500/30 flex items-center gap-1 pointer-events-none"
                      title="三视图生成时自动参考上半身正面定妆照锁定五官与服饰"
                    >
                      <Link2 size={10} /> 参考定妆照
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/85 via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-wrap items-center justify-center gap-1.5 pointer-events-none">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onOpenPreview(char.turnaround_url); }}
                      className="pointer-events-auto bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-medium px-2.5 py-1 rounded-md shadow-xs"
                    >
                      大图
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onOpenSheetModal(char, 'turnaround'); }}
                      className="pointer-events-auto bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-medium px-2.5 py-1 rounded-md shadow-xs"
                    >
                      {t("casting.ai_regenerate", "AI 重新生成")}
                    </button>
                    <label className="pointer-events-auto cursor-pointer bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-medium px-2.5 py-1 rounded-md shadow-xs flex items-center gap-1">
                      <Upload size={10} /> {t("casting.upload_local", "上传")}
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
                <div className="text-slate-400 dark:text-slate-500 text-[11px] flex flex-col items-center justify-center gap-2 p-3 text-center">
                  <div className="w-9 h-9 rounded-full bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                    <ImageIcon size={18} />
                  </div>
                  <span className="font-semibold text-slate-600 dark:text-slate-300">
                    {t("casting.turnaround_sheet", "角色三视图（正 / 侧 / 背）")}
                  </span>
                  <div className="flex flex-col gap-1.5 mt-0.5">
                    <button
                      type="button"
                      onClick={() => onOpenSheetModal(char, 'turnaround')}
                      className="text-indigo-600 dark:text-indigo-400 hover:underline font-semibold"
                    >
                      {t("casting.ai_generate_turnaround", "+ AI 生成三视图")}
                    </button>
                    <label className="cursor-pointer text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white underline flex items-center justify-center gap-1">
                      <Upload size={10} /> {t("casting.upload_local", "本地上传")}
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
        <div className="border-t border-slate-100 dark:border-slate-800/80 pt-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-bold text-slate-500 dark:text-slate-400">
              {t('characters.visual_tags')}
            </h4>
            {tagEntries.length > 0 && (
              <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                {tagEntries.length}
              </span>
            )}
          </div>
          <div
            className={`flex flex-wrap gap-1.5 ${
              expandedTags
                ? 'max-h-40 overflow-y-auto custom-scrollbar pr-0.5'
                : 'max-h-16 overflow-hidden'
            }`}
          >
            {tagEntries.length === 0 ? (
              <span className="text-[11px] text-slate-400 dark:text-slate-500 italic">
                {t('characters.no_visual_tags', '暂无视觉标签（定稿章节可自动提取）')}
              </span>
            ) : (
              tagEntries.map(([k, v]) => (
                <span
                  key={k}
                  className="px-2 py-0.5 bg-slate-50 dark:bg-slate-800 rounded-md text-[11px] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700/80 max-w-full font-medium"
                  title={`${k}: ${String(v)}`}
                >
                  <span className="text-indigo-600 dark:text-indigo-400 font-semibold">{k}:</span>{' '}
                  <span className="break-all">{String(v)}</span>
                </span>
              ))
            )}
          </div>
          {tagEntries.length > 4 && (
            <button
              type="button"
              onClick={() => onToggleTags(char.id)}
              className="mt-1.5 text-[11px] text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 font-semibold"
            >
              {expandedTags
                ? t('characters.collapse', '收起')
                : t('characters.expand_tags', '展开全部标签')}
            </button>
          )}
        </div>
      </div>

      {/* Action Bar for Portrait, Turnaround, Face Crop, and LoRA */}
      <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/80 flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onOpenSheetModal(char, 'portrait')}
            className="flex items-center justify-center gap-1.5 bg-emerald-50 hover:bg-emerald-600 dark:bg-slate-800 dark:hover:bg-emerald-600 text-emerald-700 hover:text-white dark:text-slate-200 px-3 py-2 rounded-xl text-xs font-semibold transition-all border border-emerald-200/80 dark:border-transparent shadow-xs"
          >
            <User size={13} />
            {t('characters.generate_portrait_btn', '定妆照工作台')}
          </button>
          <button
            type="button"
            onClick={() => onOpenSheetModal(char, 'turnaround')}
            className="flex items-center justify-center gap-1.5 bg-indigo-50 hover:bg-indigo-600 dark:bg-slate-800 dark:hover:bg-indigo-600 text-indigo-700 hover:text-white dark:text-slate-200 px-3 py-2 rounded-xl text-xs font-semibold transition-all border border-indigo-200/80 dark:border-transparent shadow-xs"
          >
            <Sparkles size={13} />
            {t('characters.generate_sheet')}
          </button>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onCropFace(char.id)}
            disabled={!char.turnaround_url && !char.avatar_url}
            className="flex-1 flex items-center justify-center gap-1.5 bg-slate-50 hover:bg-amber-50 dark:bg-slate-900 dark:hover:bg-amber-900/40 text-slate-700 hover:text-amber-800 dark:text-slate-300 dark:hover:text-amber-200 border border-slate-200 dark:border-slate-800 hover:border-amber-300 dark:hover:border-amber-700/50 disabled:opacity-40 px-2 py-1.5 rounded-xl text-[11px] font-medium transition-all"
          >
            {t('characters.crop_face')}
          </button>
          <button
            onClick={() => onTrainLora(char.id)}
            className="flex-1 flex items-center justify-center gap-1.5 bg-slate-50 hover:bg-emerald-50 dark:bg-slate-900 dark:hover:bg-emerald-900/40 text-slate-700 hover:text-emerald-800 dark:text-slate-300 dark:hover:text-emerald-200 border border-slate-200 dark:border-slate-800 hover:border-emerald-300 dark:hover:border-emerald-700/50 px-2 py-1.5 rounded-xl text-[11px] font-medium transition-all"
          >
            {t('characters.train_lora')}
          </button>
        </div>
      </div>
    </div>
  );
};
