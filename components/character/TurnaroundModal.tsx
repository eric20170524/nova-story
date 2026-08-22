import React from 'react';
import { Sparkles, X, User, Wand2, RefreshCw, CheckCircle, Upload } from 'lucide-react';
import { Character } from '../../types';
import { useLanguage } from '../../LanguageContext';
import { PreviewableImage, ZoomHint } from '../ImageLightbox';

interface TurnaroundModalProps {
  character: Character | null;
  onClose: () => void;
  modelType: 'pony' | 'sd15';
  setModelType: (type: 'pony' | 'sd15') => void;
  genType: 'turnaround' | 'portrait';
  setGenType: (type: 'turnaround' | 'portrait') => void;
  prompt: string;
  setPrompt: React.Dispatch<React.SetStateAction<string>>;
  negativePrompt: string;
  setNegativePrompt: React.Dispatch<React.SetStateAction<string>>;
  isPromptLoading: boolean;
  isGenerating: boolean;
  generatedImageUrl: string | null;
  useRefPortrait: boolean;
  setUseRefPortrait: (val: boolean) => void;
  refImageUrl: string | null;
  projectStyle: string;
  effectiveNsfw: boolean;
  onRebuildPrompt: (modelType: string, genType: string, customUseRef?: boolean, customRefUrl?: string | null) => void;
  onGenerateSheetImage: () => void;
  onSaveAssetToCharacter: (assetType: 'avatar' | 'turnaround', opts?: { newVersion?: boolean }) => void;
  onUploadPortrait: (file: File) => Promise<void>;
}

export const TurnaroundModal: React.FC<TurnaroundModalProps> = ({
  character,
  onClose,
  modelType,
  genType,
  setGenType,
  prompt,
  setPrompt,
  negativePrompt,
  setNegativePrompt,
  isPromptLoading,
  isGenerating,
  generatedImageUrl,
  useRefPortrait,
  setUseRefPortrait,
  refImageUrl,
  projectStyle,
  effectiveNsfw,
  onRebuildPrompt,
  onGenerateSheetImage,
  onSaveAssetToCharacter,
  onUploadPortrait,
}) => {
  const { t } = useLanguage();

  if (!character) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto flex flex-col">
        <div className="p-4 sm:p-6 border-b border-slate-800 flex justify-between items-center sticky top-0 bg-slate-900 z-10">
          <div className="flex items-center gap-3">
            <Sparkles className="text-indigo-400" size={22} />
            <h3 className="text-lg sm:text-xl font-bold text-white">
              {t('characters.generate_sheet')} - {character.name}
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X size={24} />
          </button>
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
                  {modelType === 'sd15' ? 'SD 1.5 Draft' : 'Pony XL (SDXL)'}
                </span>
                <span className="px-2.5 py-1 rounded-md bg-slate-900 border border-slate-700 text-slate-300 text-xs font-medium">
                  画风: {projectStyle}
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-xs font-semibold border ${
                    effectiveNsfw
                      ? 'bg-rose-950/60 border-rose-800 text-rose-300'
                      : 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
                  }`}
                >
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
                  onClick={() => {
                    setGenType('turnaround');
                    onRebuildPrompt(modelType, 'turnaround');
                  }}
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
                  onClick={() => {
                    setGenType('portrait');
                    onRebuildPrompt(modelType, 'portrait');
                  }}
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
                      onRebuildPrompt(modelType, genType, checked, refImageUrl);
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
                    {character.name} - {t("casting.ref_portrait_feature")}
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
                      if (file) {
                        await onUploadPortrait(file);
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
                onClick={() => setPrompt((p) => (p ? `${p}, front view, side view, back view` : 'front view, side view, back view'))}
                className="px-2 py-1 bg-indigo-950/80 hover:bg-indigo-900 text-indigo-300 border border-indigo-700/50 rounded text-[11px] font-mono transition-all"
              >
                {t("casting.angle_full")}
              </button>
              <button
                type="button"
                onClick={() =>
                  setPrompt((p) =>
                    p ? `${p}, full body model sheet, 3 views turnaround sheet` : 'full body model sheet, 3 views turnaround sheet'
                  )
                }
                className="px-2 py-1 bg-indigo-950/80 hover:bg-indigo-900 text-indigo-300 border border-indigo-700/50 rounded text-[11px] font-mono transition-all"
              >
                {t("casting.angle_grid")}
              </button>
              <button
                type="button"
                onClick={() => setPrompt((p) => (p ? `${p}, solid white background, clean simple background` : 'solid white background, clean simple background'))}
                className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded text-[11px] font-mono transition-all"
              >
                {t("casting.white_bg")}
              </button>
              <button
                type="button"
                onClick={() => setPrompt((p) => (p ? `${p}, consistent character design across all views` : 'consistent character design across all views'))}
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
                onClick={() => onRebuildPrompt(modelType, genType)}
                className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
              >
                <Wand2 size={12} /> Re-Generate Prompt
              </button>
            </div>
            <textarea
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white text-xs sm:text-sm font-mono h-24 focus:border-indigo-500 focus:outline-none"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          {/* Negative Prompt Box */}
          <div>
            <label className="block text-sm text-slate-400 mb-1">{t('characters.negative_prompt')}</label>
            <input
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-slate-300 text-xs font-mono focus:border-indigo-500 focus:outline-none"
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
            />
          </div>

          {/* Generation Execution & Preview */}
          <div className="border-t border-slate-800 pt-4 flex flex-col items-center">
            <button
              type="button"
              disabled={isGenerating || isPromptLoading || !prompt.trim()}
              onClick={onGenerateSheetImage}
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
                    onClick={() => onSaveAssetToCharacter('avatar')}
                    className="bg-emerald-900/60 hover:bg-emerald-600 text-emerald-100 hover:text-white px-3 py-2 rounded-lg text-xs font-semibold border border-emerald-500/40 flex items-center gap-1.5 transition-all"
                    title="覆盖当前版本立绘"
                  >
                    <CheckCircle size={14} /> 保存立绘·本版
                  </button>
                  <button
                    type="button"
                    onClick={() => onSaveAssetToCharacter('avatar', { newVersion: true })}
                    className="bg-amber-900/50 hover:bg-amber-700 text-amber-100 hover:text-white px-3 py-2 rounded-lg text-xs font-semibold border border-amber-500/40 flex items-center gap-1.5 transition-all"
                    title="新建版本并保存为立绘"
                  >
                    <CheckCircle size={14} /> 立绘·新版
                  </button>
                  <button
                    type="button"
                    onClick={() => onSaveAssetToCharacter('turnaround')}
                    className="bg-indigo-900/60 hover:bg-indigo-600 text-indigo-100 hover:text-white px-3 py-2 rounded-lg text-xs font-semibold border border-indigo-500/40 flex items-center gap-1.5 transition-all"
                    title="覆盖当前版本三视图"
                  >
                    <CheckCircle size={14} /> 三视图·本版
                  </button>
                  <button
                    type="button"
                    onClick={() => onSaveAssetToCharacter('turnaround', { newVersion: true })}
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
  );
};
