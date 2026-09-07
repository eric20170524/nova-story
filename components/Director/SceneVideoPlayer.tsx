import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  Repeat,
  RotateCcw,
  CheckCircle,
  ShieldCheck,
  ExternalLink,
  Loader2,
  Video,
  Sparkles,
  Check
} from 'lucide-react';
import { Scene, MediaAsset, VideoTaskState, VideoQAReport } from '../../types';
import { useLanguage } from '../../LanguageContext';
import { API_BASE_URL } from '../../constants';

interface SceneVideoPlayerProps {
  scene: Scene;
  mediaAssets?: MediaAsset[];
  taskState?: VideoTaskState;
  onGenerateVideo?: (options?: any) => void;
  onPromoteAsset?: (assetId: number) => void;
  onReprocessAsset?: (assetId: number) => void;
  onCancelTask?: (taskId: string) => void;
}

const isFinalVideo = (asset?: MediaAsset | null) =>
  Boolean(asset && (asset.role === 'loop_master' || asset.role === 'narrative_final'));

export const SceneVideoPlayer: React.FC<SceneVideoPlayerProps> = ({
  scene,
  mediaAssets = [],
  taskState,
  onGenerateVideo,
  onPromoteAsset,
  onReprocessAsset,
  onCancelTask
}) => {
  const { t } = useLanguage();
  const videoRef = useRef<HTMLVideoElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(true);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
  const [showQADetails, setShowQADetails] = useState(false);

  const videoAssets = mediaAssets.filter((asset) => asset.media_type === 'video');
  const finalVideoAssets = videoAssets.filter((asset) => isFinalVideo(asset));

  const selectedAsset = selectedAssetId != null
    ? videoAssets.find((asset) => asset.id === selectedAssetId)
    : undefined;

  // Prefer an explicitly promoted final. Otherwise expose the latest QA candidate
  // before falling back to raw evidence. A passing candidate is intentionally draft
  // until the user promotes it.
  const preferredAsset =
    finalVideoAssets.find((asset) => asset.status === 'ready')
    || finalVideoAssets.find((asset) => asset.status === 'review_required')
    || finalVideoAssets.find((asset) => asset.status === 'draft')
    || finalVideoAssets.find((asset) => asset.status === 'rejected')
    || videoAssets.find((asset) => asset.role === 'raw_video')
    || videoAssets[0];

  const activeAsset = selectedAsset || preferredAsset;

  useEffect(() => {
    if (selectedAssetId == null && preferredAsset?.id != null) {
      setSelectedAssetId(preferredAsset.id);
    }
  }, [selectedAssetId, preferredAsset?.id]);

  const handleTogglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  const handleChangeSpeed = (speed: number) => {
    setPlaybackRate(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
  };

  const handleToggleLoop = () => {
    const nextLoop = !isLooping;
    setIsLooping(nextLoop);
    if (videoRef.current) {
      videoRef.current.loop = nextLoop;
    }
  };

  const formatMediaUrl = (url?: string | null) => {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return `${API_BASE_URL.replace(/\/api$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  const videoUrl = formatMediaUrl(activeAsset?.url || taskState?.output_url || taskState?.raw_video_url);
  const posterAsset = activeAsset?.id
    ? mediaAssets.find((asset) => asset.role === 'poster' && asset.parent_asset_id === activeAsset.id)
    : undefined;
  const posterUrl = formatMediaUrl(posterAsset?.url || taskState?.poster_url || scene.asset_url);

  let qaReport: VideoQAReport | null = null;
  if (activeAsset?.metadata_json) {
    try {
      const meta = JSON.parse(activeAsset.metadata_json);
      if (meta?.qa_report) qaReport = meta.qa_report;
    } catch (_) {}
  }
  if (!qaReport && taskState?.qa_report) qaReport = taskState.qa_report;

  const isGenerating = Boolean(
    taskState && (taskState.status === 'queued' || taskState.status === 'processing')
  );

  const getQABadge = (report?: VideoQAReport | null) => {
    if (!report) return null;
    const score = report.continuity_scores?.normalized_score;
    const grade = report.quality_grade;
    let badgeColor = 'bg-emerald-950/80 border-emerald-600/70 text-emerald-300';
    let label = 'Grade A';

    if (grade === 'reject') {
      badgeColor = 'bg-rose-950/80 border-rose-600/70 text-rose-300';
      label = 'Grade F';
    } else if (grade === 'manual_review') {
      badgeColor = 'bg-amber-950/80 border-amber-600/70 text-amber-300';
      label = 'Review';
    } else if (typeof score === 'number') {
      if (score >= 95) label = 'Grade S';
      else if (score >= 85) label = 'Grade A';
      else label = 'Grade B';
    }

    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setShowQADetails(!showQADetails);
        }}
        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border flex items-center gap-1 shadow transition-transform hover:scale-105 ${badgeColor}`}
        title="查看 QA 接缝质检详情"
      >
        <ShieldCheck size={11} />
        <span>{label}</span>
        {typeof score === 'number' && <span className="opacity-80">({score.toFixed(0)})</span>}
      </button>
    );
  };

  if (isGenerating) {
    const stage = taskState?.stage || 'generating';
    const stageLabels: Record<string, string> = {
      queued: '排队等待 GPU',
      preflight: '输入与运行前检查',
      vram_tuning: '显存调优 (VRAM Tuning)',
      vram_ready: '显存已就绪',
      staging_refs: '暂存参考素材',
      model_loading: '加载 H3 工作流',
      generating: 'H3 采样生成中 (Sampling)',
      collecting: '收取原始视频',
      postprocessing: '视频标准化 / LoopCloser',
      qa_running: '连续性 QA'
    };

    return (
      <div className="w-full h-full min-h-[220px] bg-slate-950 flex flex-col items-center justify-center p-4 text-center select-none relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-950/30 to-purple-950/30 animate-pulse pointer-events-none" />
        <Loader2 className="animate-spin text-indigo-400 mb-3" size={32} />
        <span className="text-xs font-semibold text-indigo-200 mb-1">
          {t('director.generating_video_status', 'H3 视频生成中...')}
        </span>
        <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-indigo-950/80 border border-indigo-700/50 text-indigo-300 mb-3">
          {stageLabels[stage] || stage}
        </span>
        {taskState?.task_id && onCancelTask && (
          <button
            type="button"
            onClick={() => onCancelTask(taskState.task_id)}
            className="px-3 py-1 rounded-md text-[11px] bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 border border-slate-700 hover:border-rose-800 transition-colors shadow"
          >
            取消任务
          </button>
        )}
      </div>
    );
  }

  if (!videoUrl) {
    return (
      <div className="w-full h-full min-h-[220px] bg-slate-950/90 flex flex-col items-center justify-center p-4 text-center select-none border-b border-slate-800">
        <div className="w-12 h-12 rounded-full bg-indigo-950/50 border border-indigo-800/40 flex items-center justify-center mb-3 text-indigo-400 shadow-inner">
          <Video size={22} />
        </div>
        <p className="text-xs text-slate-300 font-medium mb-1">
          {t('director.no_video_yet', '暂未生成 H3 视频镜头')}
        </p>
        <p className="text-[10px] text-slate-500 mb-3 max-w-[220px]">
          H3 模型按 124 帧生成，交付标准化为 5.0s / 120帧 / 24fps
        </p>
        {onGenerateVideo && (
          <button
            type="button"
            onClick={() => onGenerateVideo()}
            className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 shadow-lg shadow-indigo-600/30 hover:shadow-indigo-500/50 transition-all"
          >
            <Sparkles size={14} />
            <span>{t('director.video_generate_btn', '一键生成 5s 视频')}</span>
          </button>
        )}
      </div>
    );
  }

  const canPromote = Boolean(
    activeAsset
    && isFinalVideo(activeAsset)
    && (activeAsset.status === 'draft' || activeAsset.status === 'review_required')
  );
  const canReprocess = Boolean(
    activeAsset
    && activeAsset.profile === 'character_loop'
    && (activeAsset.role === 'raw_video' || isFinalVideo(activeAsset))
  );

  const assetBadge = activeAsset?.status === 'ready'
    ? { label: t('director.promoted_badge', '成片'), cls: 'bg-indigo-950/90 border-indigo-600 text-indigo-300' }
    : activeAsset?.status === 'review_required'
      ? { label: '待人工复核', cls: 'bg-amber-950/90 border-amber-600 text-amber-300' }
      : activeAsset?.status === 'rejected'
        ? { label: 'QA 淘汰', cls: 'bg-rose-950/90 border-rose-700 text-rose-300' }
        : activeAsset?.role === 'raw_video'
          ? { label: 'RAW', cls: 'bg-slate-950/90 border-slate-600 text-slate-300' }
          : { label: 'QA 候选', cls: 'bg-sky-950/90 border-sky-700 text-sky-300' };

  return (
    <div className="w-full flex flex-col bg-black relative group/player overflow-hidden select-none">
      <div className="relative aspect-video bg-black flex items-center justify-center">
        <video
          ref={videoRef}
          src={videoUrl}
          poster={posterUrl}
          loop={isLooping}
          muted
          playsInline
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            if (!isLooping) setIsPlaying(false);
          }}
          className="w-full h-full object-contain cursor-pointer"
          onClick={handleTogglePlay}
        />

        <div className="absolute top-2 inset-x-2 flex items-center justify-between gap-1 pointer-events-none z-10">
          <div className="flex items-center gap-1 pointer-events-auto">
            {activeAsset && (
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold border flex items-center gap-1 shadow ${assetBadge.cls}`}>
                {activeAsset.status === 'ready' && <Check size={10} />}
                <span>{assetBadge.label}</span>
              </span>
            )}
            {activeAsset?.profile && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-slate-900/80 border border-slate-700 text-slate-300">
                {activeAsset.profile === 'character_loop' ? 'Loop' : 'Narrative'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 pointer-events-auto">
            {getQABadge(qaReport)}
          </div>
        </div>

        {!isPlaying && (
          <button
            type="button"
            onClick={handleTogglePlay}
            className="absolute inset-0 m-auto w-12 h-12 rounded-full bg-black/60 hover:bg-black/80 border border-white/20 text-white flex items-center justify-center transition-transform hover:scale-110 shadow-2xl backdrop-blur-sm z-10"
          >
            <Play size={20} className="translate-x-0.5 fill-white" />
          </button>
        )}

        {videoAssets.length > 1 && (
          <div className="absolute bottom-11 left-2 flex items-center gap-1 z-10 pointer-events-auto max-w-[90%] overflow-x-auto">
            {videoAssets.map((asset, i) => {
              const label = asset.role === 'raw_video'
                ? 'RAW'
                : asset.status === 'ready'
                  ? `成片${i + 1}`
                  : asset.status === 'review_required'
                    ? `复核${i + 1}`
                    : asset.status === 'rejected'
                      ? `淘汰${i + 1}`
                      : `候选${i + 1}`;
              return (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => setSelectedAssetId(asset.id)}
                  className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-medium transition-all whitespace-nowrap ${
                    activeAsset?.id === asset.id
                      ? 'bg-indigo-600 text-white border border-indigo-400 shadow'
                      : 'bg-slate-900/80 text-slate-400 hover:text-white border border-slate-800'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-2 flex items-center justify-between gap-1 z-10">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleTogglePlay}
              className="p-1 rounded hover:bg-slate-800 text-white transition-colors"
              title={isPlaying ? '暂停' : '播放'}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              type="button"
              onClick={handleToggleLoop}
              className={`p-1 rounded text-[10px] flex items-center gap-0.5 font-mono transition-colors ${
                isLooping ? 'text-indigo-400 bg-indigo-950/80 border border-indigo-800/60' : 'text-slate-400 hover:text-white'
              }`}
              title={isLooping ? '已开启循环播放' : '单次播放'}
            >
              <Repeat size={12} />
              <span className="text-[9px]">{t('director.loop_toggle', '循环')}</span>
            </button>
            <div className="flex items-center bg-slate-900/90 rounded border border-slate-800 p-0.5">
              {[0.5, 1.0, 2.0].map((speed) => (
                <button
                  key={speed}
                  type="button"
                  onClick={() => handleChangeSpeed(speed)}
                  className={`px-1 py-0.2 text-[9px] font-mono rounded ${
                    playbackRate === speed ? 'bg-indigo-600 text-white font-bold' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {speed}x
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => window.open(videoUrl, '_blank')}
            className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors"
            title="在新标签页中打开当前视频"
          >
            <ExternalLink size={13} />
          </button>
        </div>
      </div>

      <div className="p-2 bg-slate-950 border-t border-slate-800/80 flex items-center justify-between gap-1 text-xs">
        {canPromote && onPromoteAsset && activeAsset && (
          <button
            type="button"
            onClick={() => onPromoteAsset(activeAsset.id)}
            className="flex-1 bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/50 text-indigo-200 py-1 px-2 rounded text-[11px] font-semibold flex items-center justify-center gap-1 transition-all"
            title={activeAsset.status === 'review_required' ? '人工确认后将此候选设为正式成片' : '将已通过自动 QA 的候选设为正式成片'}
          >
            <CheckCircle size={12} />
            <span>{activeAsset.status === 'review_required' ? '复核通过并设为成片' : t('director.promote_video', '设为成片')}</span>
          </button>
        )}

        {canReprocess && onReprocessAsset && activeAsset && (
          <button
            type="button"
            onClick={() => onReprocessAsset(activeAsset.id)}
            className="bg-slate-800 hover:bg-slate-700 text-slate-300 py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 border border-slate-700 transition-colors"
            title="从 immutable raw 创建新的 8 帧闭环候选，不覆盖当前版本"
          >
            <RotateCcw size={11} />
            <span>{t('director.reprocess_loop', '重新闭环')}</span>
          </button>
        )}

        {onGenerateVideo && (
          <button
            type="button"
            onClick={() => onGenerateVideo()}
            className="bg-slate-800 hover:bg-indigo-950 hover:text-indigo-200 text-slate-300 py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 border border-slate-700 hover:border-indigo-700 transition-colors"
            title="重新生成新的 H3 视频候选"
          >
            <Sparkles size={11} />
            <span>+新视频</span>
          </button>
        )}
      </div>

      {showQADetails && qaReport && (
        <div className="p-3 bg-slate-900 border-t border-slate-800 text-[11px] text-slate-300 space-y-2 animate-in slide-in-from-top-2 duration-150">
          <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
            <span className="font-semibold text-white flex items-center gap-1">
              <ShieldCheck size={13} className="text-indigo-400" />
              <span>首尾接缝与连续性 QA 报告</span>
            </span>
            <span className="font-mono text-[10px] text-slate-400">
              {qaReport.profile} · 5.0s (120f)
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
            <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
              <span className="text-slate-500 block">连续性总分 (0-100):</span>
              <span className="font-bold text-emerald-400 text-xs">
                {(qaReport.continuity_scores?.normalized_score ?? 0).toFixed(0)}
              </span>
            </div>
            <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
              <span className="text-slate-500 block">接缝成本:</span>
              <span className="text-rose-300">
                {(qaReport.continuity_scores?.seam_cost ?? 0).toFixed(2)}
              </span>
            </div>
            <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
              <span className="text-slate-500 block">外观误差:</span>
              <span className="text-indigo-300">
                {(qaReport.continuity_scores?.appearance_error ?? 0).toFixed(2)}
              </span>
            </div>
            <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
              <span className="text-slate-500 block">运动边界误差:</span>
              <span className="text-amber-300">
                {(qaReport.continuity_scores?.motion_error ?? 0).toFixed(2)}
              </span>
            </div>
            <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
              <span className="text-slate-500 block">亮度闪烁:</span>
              <span className="text-sky-300">
                {(qaReport.continuity_scores?.flicker_error ?? 0).toFixed(2)}
              </span>
            </div>
            <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
              <span className="text-slate-500 block">质量门:</span>
              <span className={qaReport.quality_grade === 'pass' ? 'text-emerald-300' : qaReport.quality_grade === 'manual_review' ? 'text-amber-300' : 'text-rose-300'}>
                {qaReport.quality_grade}
              </span>
            </div>
          </div>

          {qaReport.reasons && qaReport.reasons.length > 0 && (
            <div className="text-[10px] text-slate-400 bg-slate-950 p-1.5 rounded border border-slate-800">
              <span className="text-slate-500 font-semibold block mb-0.5">评估备注:</span>
              <ul className="list-disc list-inside space-y-0.5">
                {qaReport.reasons.map((reason, idx) => <li key={idx}>{reason}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
