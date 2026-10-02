import React from 'react';
import { Volume2, RefreshCw, Check, AlertCircle } from 'lucide-react';
import { TtsStatusResult } from '../../types';
import { useLanguage } from '../../LanguageContext';

export interface TtsStatusCardProps {
  ttsStatus: TtsStatusResult | null;
  loadingTts?: boolean;
  onRefresh?: () => void;
}

const modelFlags = (ttsStatus: TtsStatusResult | null) => ({
  light: Boolean(ttsStatus?.local_models?.light),
  quality: Boolean(ttsStatus?.local_models?.quality),
  clone: Boolean(ttsStatus?.local_models?.clone),
});

const ModelsStatus: React.FC<{ ttsStatus: TtsStatusResult | null }> = ({ ttsStatus }) => {
  const { t } = useLanguage();
  const flags = modelFlags(ttsStatus);
  const ready = Boolean(ttsStatus?.ok && (flags.light || flags.quality || flags.clone));
  const rows: Array<{ key: 'light' | 'quality' | 'clone'; label: string }> = [
    { key: 'light', label: t('settings_tts.model_light', '轻量') },
    { key: 'quality', label: t('settings_tts.model_quality', '高质') },
    { key: 'clone', label: t('settings_tts.model_clone', '克隆') },
  ];

  return (
    <div data-testid="tts-models-status" className="text-sm font-medium text-slate-900 dark:text-slate-100 space-y-2">
      <div className={`inline-flex items-center gap-1 ${ready ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
        {ready ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
        {ready
          ? t('settings_tts.models_ready_yes', '已就绪')
          : t('settings_tts.models_ready_no', '未就绪')}
      </div>
      <ul className="space-y-1 text-xs font-normal text-slate-600 dark:text-slate-300">
        {rows.map((row) => (
          <li key={row.key} data-testid={`tts-model-${row.key}`}>
            {row.label}
            {': '}
            {flags[row.key]
              ? t('settings_tts.model_loaded', '已加载')
              : t('settings_tts.model_missing', '未加载')}
          </li>
        ))}
      </ul>
    </div>
  );
};

export const TtsStatusCard: React.FC<TtsStatusCardProps> = ({
  ttsStatus,
  loadingTts = false,
  onRefresh,
}) => {
  const { t } = useLanguage();

  return (
    <div
      data-testid="tts-status-card"
      className="bg-white dark:bg-slate-900/60 backdrop-blur-sm border border-slate-200/80 dark:border-slate-800/80 rounded-2xl p-6 space-y-6 shadow-sm transition-colors"
    >
      <div className="flex items-center justify-between border-b border-slate-200/80 dark:border-slate-800/80 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-50 dark:bg-indigo-500/10 rounded-xl border border-indigo-100 dark:border-indigo-500/20 text-indigo-600 dark:text-indigo-400">
            <Volume2 className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {t('settings_tts.title', '中文语音合成服务 (TTS)')}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('settings_tts.desc', '连接本机 local-chinese-tts 服务，提供角色音色目录查询与试听代理')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid="tts-refresh-btn"
            onClick={onRefresh}
            disabled={loadingTts}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-50"
            title={t('settings_tts.refresh', '刷新连通状态')}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingTts ? 'animate-spin' : ''}`} />
            <span>{t('settings_tts.refresh', '刷新连通状态')}</span>
          </button>
          <span
            data-testid="tts-status-badge"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-full ${
              ttsStatus?.ok
                ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                : 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${ttsStatus?.ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
            {ttsStatus?.ok
              ? t('settings_tts.connected', '已连通')
              : t('settings_tts.disconnected', '未连通')}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Root Base URL */}
        <div className="p-4 bg-slate-50/80 dark:bg-slate-950/50 border border-slate-200/80 dark:border-slate-800/80 rounded-xl space-y-1">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">
            {t('settings_tts.base_url', '服务根地址')}
          </span>
          <div data-testid="tts-base-url" className="text-sm font-mono font-medium text-slate-900 dark:text-slate-100">
            {ttsStatus?.base_url || 'http://127.0.0.1:8765'}
          </div>
        </div>

        {/* Voice Count */}
        <div className="p-4 bg-slate-50/80 dark:bg-slate-950/50 border border-slate-200/80 dark:border-slate-800/80 rounded-xl space-y-1">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">
            {t('settings_tts.voice_count', '可用音色数量')}
          </span>
          <div data-testid="tts-voice-count" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {ttsStatus?.ok ? `${ttsStatus.voice_count} 个` : '0 个'}
          </div>
        </div>

        {/* Default Voice */}
        <div className="p-4 bg-slate-50/80 dark:bg-slate-950/50 border border-slate-200/80 dark:border-slate-800/80 rounded-xl space-y-1">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">
            {t('settings_tts.default_voice', 'TTS 自身默认音色')}
          </span>
          <div data-testid="tts-default-voice" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {ttsStatus?.ok && ttsStatus.default_voice ? ttsStatus.default_voice : (ttsStatus?.ok ? 'QF1' : '-')}
          </div>
        </div>

        {/* Local Neural Models Ready */}
        <div className="p-4 bg-slate-50/80 dark:bg-slate-950/50 border border-slate-200/80 dark:border-slate-800/80 rounded-xl space-y-1">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">
            {t('settings_tts.models_ready', '本地模型就绪状态')}
          </span>
          <ModelsStatus ttsStatus={ttsStatus} />
        </div>
      </div>

      {/* Hint Notice */}
      <div className="p-3.5 bg-blue-50/50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/30 rounded-xl text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
        {t('settings_tts.hint', '角色音色在资产管理中为各个角色单独挑选绑定；此处仅展示本机 TTS 连通状态，不会改写系统全局朗读默认音色。')}
      </div>
    </div>
  );
};
