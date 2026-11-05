import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clapperboard,
  Download,
  Film,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Subtitles,
  Volume2,
  X,
} from 'lucide-react';
import type { ChapterVideoStatus } from '../../types';

export type ChapterPlaybackMode = 'assembled' | 'preview' | 'playlist';

interface ChapterVideoPlayerModalProps {
  isOpen: boolean;
  onClose: () => void;
  chapterTitle: string;
  chapterIndex: number;
  videoStatus: ChapterVideoStatus | null;
  isLoading: boolean;
  isAssembling: boolean;
  assembleError?: string | null;
  onAssemble: () => void;
  onRefresh: () => void;
  onJumpToScene?: (sceneId: number) => void;
}

function formatSeconds(sec: number | null | undefined): string {
  const valid = Number.isFinite(Number(sec)) && Number(sec) >= 0 ? Number(sec) : 0;
  const mins = Math.floor(valid / 60);
  const secs = Math.floor(valid % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const ChapterVideoPlayerModal: React.FC<ChapterVideoPlayerModalProps> = ({
  isOpen,
  onClose,
  chapterTitle,
  chapterIndex,
  videoStatus,
  isLoading,
  isAssembling,
  assembleError,
  onAssemble,
  onRefresh,
  onJumpToScene,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const titleId = useId();

  const hasAssembled = Boolean(videoStatus?.assembled?.available && videoStatus?.assembled?.url);
  const hasPreview = Boolean(videoStatus?.preview?.available && videoStatus?.preview?.url);
  const playableShots = useMemo(
    () => (videoStatus?.shot_playlist || []).filter((s) => Boolean(s.video_url)),
    [videoStatus]
  );

  const [mode, setMode] = useState<ChapterPlaybackMode>('assembled');
  const [playlistIdx, setPlaylistIdx] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [showSubtitlesOverlay, setShowSubtitlesOverlay] = useState<boolean>(true);

  useEffect(() => {
    if (hasAssembled) {
      setMode('assembled');
    } else if (hasPreview) {
      setMode('preview');
    } else {
      setMode('playlist');
    }
    setPlaylistIdx(0);
    setCurrentTime(0);
  }, [hasAssembled, hasPreview, videoStatus?.chapter_id]);

  // Open/close native modal <dialog> using platform controls
  useEffect(() => {
    const dialogEl = dialogRef.current;
    if (!dialogEl) return;

    if (isOpen) {
      if (!dialogEl.open && typeof dialogEl.showModal === 'function') {
        dialogEl.showModal();
      }
    } else if (dialogEl.open && typeof dialogEl.close === 'function') {
      dialogEl.close();
      videoRef.current?.pause();
    }
  }, [isOpen]);

  // Sync native dialog close (Escape / light dismiss) back to React state
  useEffect(() => {
    const dialogEl = dialogRef.current;
    if (!dialogEl) return;

    const handleNativeClose = () => {
      videoRef.current?.pause();
      onClose();
    };
    dialogEl.addEventListener('close', handleNativeClose);
    return () => dialogEl.removeEventListener('close', handleNativeClose);
  }, [onClose]);

  // Light-dismiss fallback for browsers without HTMLDialogElement.prototype.closedBy
  useEffect(() => {
    const dialogEl = dialogRef.current;
    if (!dialogEl) return;
    if (typeof HTMLDialogElement !== 'undefined' && !('closedBy' in HTMLDialogElement.prototype)) {
      const handleBackdropClick = (e: MouseEvent) => {
        if (e.target === dialogEl) {
          dialogEl.close();
        }
      };
      dialogEl.addEventListener('click', handleBackdropClick);
      return () => dialogEl.removeEventListener('click', handleBackdropClick);
    }
  }, []);

  const allShots = videoStatus?.shot_playlist || [];
  const activePlaylistShot = playableShots[playlistIdx] || playableShots[0] || null;

  const activeAssembledShot = useMemo(() => {
    if (mode !== 'assembled' || !allShots.length) return null;
    return (
      allShots.find((shot) => currentTime >= shot.start_time && currentTime < shot.end_time) ||
      allShots[allShots.length - 1]
    );
  }, [mode, allShots, currentTime]);

  const activeCue = useMemo(() => {
    if (mode === 'assembled') {
      const cues = videoStatus?.assembled?.cues || [];
      return cues.find((c) => currentTime >= c.start && currentTime <= c.end) || null;
    }
    if (mode === 'playlist' && activePlaylistShot) {
      const text = [activePlaylistShot.dialogue, activePlaylistShot.narration]
        .map((s) => (s || '').trim())
        .filter(Boolean)
        .join(' / ');
      return text
        ? {
            block_id: `shot-${activePlaylistShot.scene_id}`,
            text,
            start: 0,
            end: activePlaylistShot.duration,
          }
        : null;
    }
    return null;
  }, [mode, videoStatus?.assembled?.cues, currentTime, activePlaylistShot]);

  const currentVideoSrc = useMemo(() => {
    if (mode === 'assembled') return videoStatus?.assembled?.url || null;
    if (mode === 'preview') return videoStatus?.preview?.url || null;
    return activePlaylistShot?.video_url || null;
  }, [mode, videoStatus, activePlaylistShot]);

  const currentPosterSrc = useMemo(() => {
    if (mode === 'playlist' && activePlaylistShot?.poster_url) {
      return activePlaylistShot.poster_url;
    }
    return allShots[0]?.poster_url || undefined;
  }, [mode, activePlaylistShot, allShots]);

  const handleShotClick = (shotIndexInAll: number) => {
    const shot = allShots[shotIndexInAll];
    if (!shot) return;
    if (mode === 'assembled' && hasAssembled) {
      if (videoRef.current) {
        videoRef.current.currentTime = shot.start_time;
        setCurrentTime(shot.start_time);
        videoRef.current.play().catch(() => {});
      }
      return;
    }
    const playableIdx = playableShots.findIndex((s) => s.scene_id === shot.scene_id);
    if (playableIdx >= 0) {
      setMode('playlist');
      setPlaylistIdx(playableIdx);
    }
  };

  const handleVideoEnded = () => {
    if (mode === 'playlist' && playlistIdx < playableShots.length - 1) {
      setPlaylistIdx((prev) => prev + 1);
    }
  };

  useEffect(() => {
    if (mode === 'playlist' && isOpen && videoRef.current && currentVideoSrc) {
      videoRef.current.play().catch(() => {});
    }
  }, [playlistIdx, mode, isOpen, currentVideoSrc]);

  // Ensure browser native textTracks do not render a duplicate subtitle layer alongside custom overlay
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !video.textTracks) return;
    const hideNativeTracks = () => {
      try {
        for (let i = 0; i < video.textTracks.length; i++) {
          video.textTracks[i].mode = 'hidden';
        }
      } catch {
        // ignore
      }
    };
    hideNativeTracks();
    video.addEventListener('loadedmetadata', hideNativeTracks);
    return () => {
      video.removeEventListener('loadedmetadata', hideNativeTracks);
    };
  }, [currentVideoSrc]);

  if (!isOpen) return null;

  const summary = videoStatus?.shots_summary || {
    total_shots: 0,
    ready_video_shots: 0,
    any_video_shots: 0,
    all_ready: false,
  };

  const currentShotInfo = mode === 'playlist' ? activePlaylistShot : activeAssembledShot;

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as React.DialogHTMLAttributes<HTMLDialogElement>)}
      aria-labelledby={titleId}
      data-testid="chapter-video-player-modal"
      className="m-auto w-[min(96vw,1180px)] max-h-[92vh] rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xl p-0 overflow-hidden backdrop:bg-slate-950/75"
    >
      <div className="flex flex-col max-h-[92vh]">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/90">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/10 dark:bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
              <Film className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 id={titleId} className="text-base font-bold text-slate-900 dark:text-white truncate">
                  第{chapterIndex}章 · {chapterTitle || `第${chapterIndex}章`} · 章节完整视频预览
                </h2>
                {hasAssembled ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    整章成片已合流 ({formatSeconds(videoStatus?.assembled?.duration)})
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                    已验收镜头 {summary.ready_video_shots}/{summary.total_shots}
                  </span>
                )}
                {videoStatus?.review?.status === 'approved' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30">
                    已通过章节验收
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                封装包含 TTS 角色语音对白、环境音效与同步中文字幕 · 共 {summary.total_shots} 镜
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Mode Switcher */}
            <div className="inline-flex items-center rounded-xl p-1 bg-slate-200/70 dark:bg-slate-800 border border-slate-300/60 dark:border-slate-700">
              <button
                type="button"
                disabled={!hasAssembled}
                onClick={() => setMode('assembled')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  mode === 'assembled'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : hasAssembled
                      ? 'text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                      : 'text-slate-400 dark:text-slate-600 cursor-not-allowed'
                }`}
              >
                整章合流成片
              </button>
              {hasPreview && (
                <button
                  type="button"
                  onClick={() => setMode('preview')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    mode === 'preview'
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {videoStatus?.preview?.label || '阶段预览片'}
                </button>
              )}
              <button
                type="button"
                disabled={playableShots.length === 0}
                onClick={() => setMode('playlist')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  mode === 'playlist'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : playableShots.length > 0
                      ? 'text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                      : 'text-slate-400 dark:text-slate-600 cursor-not-allowed'
                }`}
              >
                分镜连续连播 ({playableShots.length}/{summary.total_shots})
              </button>
            </div>

            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading || isAssembling}
              title="刷新章节视频状态"
              className="p-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>

            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="关闭章节视频预览"
              className="p-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 custom-scrollbar">
          {assembleError && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-700 dark:text-rose-200">
              合成提示：{assembleError}
            </div>
          )}

          {/* Video Player Stage */}
          <div className="relative rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 shadow-xl">
            {currentVideoSrc ? (
              <div className="relative aspect-video w-full bg-black flex items-center justify-center">
                <video
                  ref={videoRef}
                  key={currentVideoSrc}
                  src={currentVideoSrc}
                  poster={currentPosterSrc}
                  controls
                  width="1280"
                  height="720"
                  preload="metadata"
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  onEnded={handleVideoEnded}
                  data-testid="chapter-full-video-element"
                  className="w-full h-full object-contain [&::cue]:hidden [&::-webkit-media-text-track-container]:hidden"
                >
                  {mode === 'assembled' && videoStatus?.assembled?.vtt_url && (
                    <track
                      kind="subtitles"
                      srcLang="zh"
                      label="中文字幕"
                      src={videoStatus.assembled.vtt_url}
                    />
                  )}
                </video>

                {/* Synchronized Chinese Subtitle Overlay */}
                {showSubtitlesOverlay && activeCue && (
                  <div
                    data-testid="chapter-live-subtitle"
                    className="pointer-events-none absolute bottom-14 inset-x-8 flex justify-center"
                  >
                    <div className="max-w-3xl px-4 py-2 rounded-xl bg-black/75 backdrop-blur-sm border border-white/15 text-white text-sm md:text-base font-medium text-center leading-relaxed shadow-lg">
                      {activeCue.text}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="aspect-video w-full flex flex-col items-center justify-center gap-3 p-8 text-center text-slate-400">
                <Clapperboard className="w-12 h-12 text-slate-600" />
                <div className="text-sm font-semibold text-slate-200">
                  当前章节尚未生成可播放的视频文件
                </div>
                <p className="text-xs text-slate-400 max-w-md">
                  当本章全部分镜渲染并验收通过后，会自动触发 Stage Assemble 合流整章成片；您也可以点击下方「合成整章成片」按钮立即合成。
                </p>
              </div>
            )}

            {/* Player Toolbar & Active Shot / Subtitle Status Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-slate-900/95 border-t border-slate-800 text-xs text-slate-300">
              <div className="flex items-center gap-3 min-w-0">
                {currentShotInfo ? (
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-semibold border border-indigo-500/30 shrink-0">
                      镜头 #{currentShotInfo.shot_number} (ID {currentShotInfo.scene_id})
                    </span>
                    <span className="text-slate-400 shrink-0">
                      {formatSeconds(currentShotInfo.start_time)} – {formatSeconds(currentShotInfo.end_time)}
                    </span>
                    <span className="truncate text-slate-200">
                      {currentShotInfo.dialogue || currentShotInfo.narration || currentShotInfo.visual_prompt}
                    </span>
                  </div>
                ) : (
                  <span className="text-slate-400">选择任意分镜节点即可跳转播放位置</span>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setShowSubtitlesOverlay((v) => !v)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-colors ${
                    showSubtitlesOverlay
                      ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-200'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  <Subtitles className="w-3.5 h-3.5" />
                  {showSubtitlesOverlay ? '字幕浮层已开' : '字幕浮层已关'}
                </button>

                {currentShotInfo && onJumpToScene && (
                  <button
                    type="button"
                    onClick={() => {
                      onJumpToScene(currentShotInfo.scene_id);
                      dialogRef.current?.close();
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition-colors"
                  >
                    定位到该分镜
                  </button>
                )}

                {hasAssembled && videoStatus?.assembled?.url && (
                  <a
                    href={videoStatus.assembled.url}
                    download={`chapter-${chapterIndex}.mp4`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    下载成片 (.mp4)
                  </a>
                )}

                {hasAssembled && videoStatus?.assembled?.subtitle_url && (
                  <a
                    href={videoStatus.assembled.subtitle_url}
                    download={`chapter-${chapterIndex}.srt`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    字幕 (.srt)
                  </a>
                )}

                <button
                  type="button"
                  onClick={onAssemble}
                  disabled={isAssembling || !summary.all_ready}
                  title={
                    summary.all_ready
                      ? '合成或重新封装包含 TTS 语音对白与中文字幕的整章成片'
                      : `需全部 ${summary.total_shots} 镜视频验收就绪后可合成整章成片（当前 ${summary.ready_video_shots}/${summary.total_shots}）`
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-semibold transition-colors"
                >
                  {isAssembling ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      正在合流成片...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      {hasAssembled ? '重新合流成片' : '合成整章成片'}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Interactive Shot Scrubber Strip */}
          {allShots.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span className="font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                  <Volume2 className="w-3.5 h-3.5 text-indigo-500" />
                  章节分镜时间轴（点击任意镜头跳转播放）
                </span>
                <span>
                  共 {allShots.length} 镜 · 总时长{' '}
                  {formatSeconds(
                    videoStatus?.assembled?.duration ??
                      allShots[allShots.length - 1]?.end_time ??
                      0
                  )}
                </span>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2 max-h-48 overflow-y-auto p-1 custom-scrollbar">
                {allShots.map((shot, idx) => {
                  const isActive = currentShotInfo?.scene_id === shot.scene_id;
                  const isReady = shot.video_role === 'narrative_final' && shot.video_status === 'ready';
                  const hasClip = Boolean(shot.video_url);
                  return (
                    <button
                      key={shot.scene_id}
                      type="button"
                      onClick={() => handleShotClick(idx)}
                      className={`group flex flex-col text-left rounded-xl p-2 border transition-all ${
                        isActive
                          ? 'border-indigo-500 bg-indigo-500/10 dark:bg-indigo-500/20 ring-1 ring-indigo-500/40'
                          : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:border-indigo-400/60'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1 w-full mb-1">
                        <span className="text-[11px] font-bold text-slate-800 dark:text-slate-200">
                          #{shot.shot_number}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                            isReady
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                              : hasClip
                                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                                : 'bg-slate-200 dark:bg-slate-700 text-slate-500'
                          }`}
                        >
                          {formatSeconds(shot.start_time)}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600 dark:text-slate-400 line-clamp-2 leading-snug">
                        {shot.dialogue || shot.narration || shot.visual_prompt || `镜头 ${shot.shot_number}`}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
};

