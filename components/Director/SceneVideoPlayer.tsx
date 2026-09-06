import React, { useState, useRef, useEffect } from 'react';
import { 
  Play, 
  Pause, 
  Repeat, 
  RotateCcw, 
  CheckCircle, 
  AlertTriangle, 
  ShieldCheck, 
  ExternalLink, 
  Loader2, 
  Video, 
  Sparkles,
  Award,
  Sliders,
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

  // Filter video assets for this scene
  const videoAssets = mediaAssets.filter(
    (a) => a.media_type === 'video' || a.role === 'loop_master' || a.role === 'narrative_final' || a.role === 'raw_video'
  );

  // Preferred / promoted video asset or latest
  const activeAsset = videoAssets.find((a) => (selectedAssetId ? a.id === selectedAssetId : a.status === 'ready')) 
    || videoAssets[0];

  useEffect(() => {
    if (videoAssets.length > 0 && !selectedAssetId) {
      const readyAsset = videoAssets.find((a) => a.status === 'ready');
      if (readyAsset) setSelectedAssetId(readyAsset.id);
    }
  }, [videoAssets, selectedAssetId]);

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

  // Resolve absolute video and poster URLs
  const formatMediaUrl = (url?: string | null) => {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return `${API_BASE_URL.replace(/\/api$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  const videoUrl = formatMediaUrl(activeAsset?.url || taskState?.output_url || taskState?.raw_video_url);
  const posterAsset = mediaAssets.find((a) => a.role === 'poster');
  const posterUrl = formatMediaUrl(posterAsset?.url || taskState?.poster_url || scene.asset_url);

  // Parse QA report if available
  let qaReport: VideoQAReport | null = null;
  if (activeAsset?.metadata_json) {
    try {
      const meta = JSON.parse(activeAsset.metadata_json);
      if (meta?.qa_report) {
        qaReport = meta.qa_report;
      }
    } catch (_) {}
  }
  if (!qaReport && taskState?.qa_report) {
    qaReport = taskState.qa_report;
  }

  const isGenerating = taskState && (taskState.status === 'queued' || taskState.status === 'processing');

  // Helper for QA score display
  const getQABadge = (report?: VideoQAReport | null) => {
    if (!report) return null;
    const score = report.continuity_scores?.normalized_score;
    const grade = report.quality_grade;
    let badgeColor = 'bg-emerald-950/80 border-emerald-600/70 text-emerald-300';
    let label = 'Grade S';

    if (grade === 'reject') {
      badgeColor = 'bg-rose-950/80 border-rose-600/70 text-rose-300';
      label = 'Grade F';
    } else if (grade === 'manual_review') {
      badgeColor = 'bg-amber-950/80 border-amber-600/70 text-amber-300';
      label = 'Grade B';
    } else if (typeof score === 'number') {
      if (score >= 0.95) label = 'Grade S';
      else if (score >= 0.85) label = 'Grade A';
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
        {typeof score === 'number' && <span className="opacity-80">({score.toFixed(2)})</span>}
      </button>
    );
  };

  // If task is generating
  if (isGenerating) {
    const stage = taskState.stage || 'sampling';
    const stageLabels: Record<string, string> = {
      queued: '排队等待 GPU',
      vram_tuning: '显存调优 (VRAM Tuning)',
      sampling: 'H3 采样生成中 (Sampling)',
      postprocessing: '视频标准化 (Postprocess)',
      loop_closing: 'LoopCloser 闭环分析'
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

        {taskState.task_id && onCancelTask && (
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

  // If no video generated yet
  if (!videoUrl) {
    return (
      <div className="w-full h-full min-h-[220px] bg-slate-950/90 flex flex-col items-center justify-center p-4 text-center select-none border-b border-slate-800">
        <div className="w-12 h-12 rounded-full bg-indigo-950/50 border border-indigo-800/40 flex items-center justify-center mb-3 text-indigo-400 shadow-inner">
          <Video size={22} />
        </div>
        <p className="text-xs text-slate-300 font-medium mb-1">
          {t('director.no_video_yet', '暂未生成 H3 视频镜头')}
        </p>
        <p className="text-[10px] text-slate-500 mb-3 max-w-[200px]">
          5.0s / 120帧 / 24fps 电影级动态生成与 LoopCloser 闭环
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

  return (
    <div className="w-full flex flex-col bg-black relative group/player overflow-hidden select-none">
      {/* Video Viewport */}
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

        {/* Floating Top Bar (QA badge, candidate selector, promoted indicator) */}
        <div className="absolute top-2 inset-x-2 flex items-center justify-between gap-1 pointer-events-none z-10">
          <div className="flex items-center gap-1 pointer-events-auto">
            {activeAsset?.status === 'ready' && (
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-950/90 border border-indigo-600 text-indigo-300 flex items-center gap-1 shadow">
                <Check size={10} />
                <span>{t('director.promoted_badge', '成片')}</span>
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

        {/* Center Play Overlay Icon when paused */}
        {!isPlaying && (
          <button
            type="button"
            onClick={handleTogglePlay}
            className="absolute inset-0 m-auto w-12 h-12 rounded-full bg-black/60 hover:bg-black/80 border border-white/20 text-white flex items-center justify-center transition-transform hover:scale-110 shadow-2xl backdrop-blur-sm z-10"
          >
            <Play size={20} className="translate-x-0.5 fill-white" />
          </button>
        )}

        {/* Video Candidate Switcher (if > 1 video) */}
        {videoAssets.length > 1 && (
          <div className="absolute bottom-11 left-2 flex items-center gap-1 z-10 pointer-events-auto">
            {videoAssets.map((asset, i) => (
              <button
                key={asset.id}
                type="button"
                onClick={() => setSelectedAssetId(asset.id)}
                className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-medium transition-all ${
                  (selectedAssetId ? selectedAssetId === asset.id : i === 0)
                    ? 'bg-indigo-600 text-white border border-indigo-400 shadow'
                    : 'bg-slate-900/80 text-slate-400 hover:text-white border border-slate-800'
                }`}
              >
                #{i + 1}
              </button>
            ))}
          </div>
        )}

        {/* Bottom Control Bar */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-2 flex items-center justify-between gap-1 z-10">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleTogglePlay}
              className="p-1 rounded hover:bg-slate-800 text-white transition-colors"
              title={isPlaying ? "暂停" : "播放"}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            </button>

            {/* Loop Toggle */}
            <button
              type="button"
              onClick={handleToggleLoop}
              className={`p-1 rounded text-[10px] flex items-center gap-0.5 font-mono transition-colors ${
                isLooping ? 'text-indigo-400 bg-indigo-950/80 border border-indigo-800/60' : 'text-slate-400 hover:text-white'
              }`}
              title={isLooping ? "已开启循环播放" : "单次播放"}
            >
              <Repeat size={12} />
              <span className="text-[9px]">{t('director.loop_toggle', '循环')}</span>
            </button>

            {/* Speed Switcher */}
            <div className="flex items-center bg-slate-900/90 rounded border border-slate-800 p-0.5">
              {[0.5, 1.0, 2.0].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => handleChangeSpeed(s)}
                  className={`px-1 py-0.2 text-[9px] font-mono rounded ${
                    playbackRate === s
                      ? 'bg-indigo-600 text-white font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => window.open(videoUrl, '_blank')}
              className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors"
              title="在新标签页中打开原始视频"
            >
              <ExternalLink size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* Actions Toolbar Below Player */}
      <div className="p-2 bg-slate-950 border-t border-slate-800/80 flex items-center justify-between gap-1 text-xs">
        {activeAsset && activeAsset.status !== 'ready' && onPromoteAsset && (
          <button
            type="button"
            onClick={() => onPromoteAsset(activeAsset.id)}
            className="flex-1 bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/50 text-indigo-200 py-1 px-2 rounded text-[11px] font-semibold flex items-center justify-center gap-1 transition-all"
            title="将此视频设为本场景的正式成片"
          >
            <CheckCircle size={12} />
            <span>{t('director.promote_video', '设为成片')}</span>
          </button>
        )}

        {activeAsset?.profile === 'character_loop' && onReprocessAsset && (
          <button
            type="button"
            onClick={() => onReprocessAsset(activeAsset.id)}
            className="bg-slate-800 hover:bg-slate-700 text-slate-300 py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 border border-slate-700 transition-colors"
            title="应用 LoopCloser 8帧融合重新闭环"
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

      {/* QA Details Dropdown/Drawer */}
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
              <span className="text-slate-500 block">连续性总分:</span>
              <span className="font-bold text-emerald-400 text-xs">
                {(qaReport.continuity_scores?.normalized_score ?? 0).toFixed(3)}
              </span>
            </div>
            <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
              <span className="text-slate-500 block">外观误差:</span>
              <span className="text-indigo-300">
                {(qaReport.continuity_scores?.appearance_error ?? 0).toFixed(4)}
              </span>
            </div>
            <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
              <span className="text-slate-500 block">运动漂移:</span>
              <span className="text-amber-300">
                {(qaReport.continuity_scores?.motion_error ?? 0).toFixed(4)}
              </span>
            </div>
            <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
              <span className="text-slate-500 block">画面闪烁:</span>
              <span className="text-sky-300">
                {(qaReport.continuity_scores?.flicker_error ?? 0).toFixed(4)}
              </span>
            </div>
          </div>

          {qaReport.reasons && qaReport.reasons.length > 0 && (
            <div className="text-[10px] text-slate-400 bg-slate-950 p-1.5 rounded border border-slate-800">
              <span className="text-slate-500 font-semibold block mb-0.5">评估备注:</span>
              <ul className="list-disc list-inside space-y-0.5">
                {qaReport.reasons.map((r, idx) => (
                  <li key={idx}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
