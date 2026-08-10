import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, LoaderCircle, RefreshCw, Sparkles, Zap } from 'lucide-react';
import { api } from '../services/api';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import {
  VRAM_SCHEDULER_EVENT,
  type VramSchedulerDetail,
  type VramSchedulerPhase,
} from '../services/vram_scheduler_ui';

export type VramLevel = 'good' | 'warning' | 'critical' | 'unknown';

export type VramStatus = {
  level: VramLevel;
  percent: number | null;
  used_bytes: number | null;
  total_bytes: number | null;
  free_bytes: number | null;
  gpu_name: string | null;
  ollama: {
    online: boolean;
    base_url: string;
    used_bytes: number;
    models: Array<{ name: string; size_vram: number; size: number; processor?: string }>;
  };
  comfyui: {
    online: boolean;
    base_url: string;
    used_bytes: number | null;
    total_bytes: number | null;
    torch_used_bytes: number | null;
  };
  processes: Array<{ name: string; bytes: number; detail?: string }>;
  summary: string;
  summary_zh: string;
  tip: string;
  tip_zh: string;
  source: string;
  polled_at: string;
};

const POLL_MS = 8000;

function formatGiB(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0G';
  const gib = bytes / 1024 ** 3;
  return `${gib.toFixed(1)}G`;
}

function levelStyles(level: VramLevel): {
  pill: string;
  dot: string;
  ring: string;
  label: string;
} {
  switch (level) {
    case 'good':
      return {
        pill: 'bg-emerald-950/80 border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/70',
        dot: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.85)]',
        ring: 'ring-emerald-500/40',
        label: 'text-emerald-300',
      };
    case 'warning':
      return {
        pill: 'bg-amber-950/80 border-amber-700/60 text-amber-100 hover:bg-amber-900/70',
        dot: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)] animate-pulse',
        ring: 'ring-amber-500/40',
        label: 'text-amber-300',
      };
    case 'critical':
      return {
        pill: 'bg-rose-950/85 border-rose-600/70 text-rose-100 hover:bg-rose-900/75',
        dot: 'bg-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.95)] animate-pulse',
        ring: 'ring-rose-500/50',
        label: 'text-rose-300',
      };
    default:
      return {
        pill: 'bg-slate-900/90 border-slate-700 text-slate-300 hover:bg-slate-800',
        dot: 'bg-slate-500',
        ring: 'ring-slate-600/40',
        label: 'text-slate-400',
      };
  }
}

function levelTitle(level: VramLevel, percent: number | null, language: string): string {
  const pct = percent != null ? ` (${Math.round(percent)}%)` : '';
  if (language === 'zh') {
    if (level === 'good') return `显存良好${pct}`;
    if (level === 'warning') return `高负载预警${pct}`;
    if (level === 'critical') return `显存紧张${pct}`;
    return `显存未知${pct}`;
  }
  if (level === 'good') return `VRAM OK${pct}`;
  if (level === 'warning') return `High load${pct}`;
  if (level === 'critical') return `VRAM critical${pct}`;
  return `VRAM unknown${pct}`;
}

function schedulerPhaseFallback(phase: VramSchedulerPhase, language: string): string {
  if (language === 'zh') {
    if (phase === 'vram_tuning') return '正在调优显存环境…';
    if (phase === 'vram_ready') return '启动生图渲染…';
    if (phase === 'rendering') return '生图渲染中…';
    return '';
  }
  if (phase === 'vram_tuning') return 'Optimizing VRAM…';
  if (phase === 'vram_ready') return 'Starting render…';
  if (phase === 'rendering') return 'Rendering…';
  return '';
}

export const VramHealthBadge: React.FC = () => {
  const { t, language } = useLanguage();
  const { showToast } = useToast();
  const [status, setStatus] = useState<VramStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'llm' | 'comfy' | null>(null);
  /** Plan 1 auto-scheduler phase (shown in the always-on status strip) */
  const [scheduler, setScheduler] = useState<VramSchedulerDetail | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (silent = true) => {
    try {
      const data = await api.getVramStatus();
      setStatus(data as VramStatus);
    } catch (err) {
      if (!silent) {
        console.error('VRAM status poll failed', err);
      }
      setStatus((prev) =>
        prev
          ? prev
          : {
              level: 'unknown',
              percent: null,
              used_bytes: null,
              total_bytes: null,
              free_bytes: null,
              gpu_name: null,
              ollama: { online: false, base_url: '', used_bytes: 0, models: [] },
              comfyui: {
                online: false,
                base_url: '',
                used_bytes: null,
                total_bytes: null,
                torch_used_bytes: null,
              },
              processes: [],
              summary: 'VRAM status unavailable',
              summary_zh: '显存状态未知',
              tip: 'Backend unreachable',
              tip_zh: '无法连接后端',
              source: 'unavailable',
              polled_at: new Date().toISOString(),
            }
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh(true);
    const id = window.setInterval(() => refresh(true), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Plan 1: listen for silent handoff phases from Director / Character generation
  useEffect(() => {
    const onPhase = (event: Event) => {
      const detail = (event as CustomEvent<VramSchedulerDetail>).detail;
      if (!detail) return;
      if (detail.phase === 'idle') {
        setScheduler(null);
        // Refresh occupancy after handoff / render
        void refresh(true);
        return;
      }
      setScheduler(detail);
      if (detail.phase === 'vram_ready' || detail.phase === 'done') {
        void refresh(true);
      }
    };
    window.addEventListener(VRAM_SCHEDULER_EVENT, onPhase as EventListener);
    return () => window.removeEventListener(VRAM_SCHEDULER_EVENT, onPhase as EventListener);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const applyStatusFromAction = (next?: VramStatus | null) => {
    if (next) setStatus(next);
    else void refresh(true);
  };

  const handleReleaseLlm = async () => {
    setBusy('llm');
    try {
      const res = await api.releaseLlmVram();
      applyStatusFromAction(res.status);
      showToast(
        language === 'zh' ? res.message_zh || res.message : res.message || res.message_zh,
        res.ok ? 'success' : 'error'
      );
    } catch (err: any) {
      showToast(
        err?.message || t('vram.release_llm_failed', '释放 LLM 显存失败'),
        'error'
      );
    } finally {
      setBusy(null);
    }
  };

  const handleFreeComfy = async () => {
    setBusy('comfy');
    try {
      const res = await api.freeComfyVram();
      applyStatusFromAction(res.status);
      showToast(
        language === 'zh' ? res.message_zh || res.message : res.message || res.message_zh,
        res.ok ? 'success' : 'error'
      );
    } catch (err: any) {
      showToast(
        err?.message || t('vram.free_comfy_failed', '重置 ComfyUI 缓存失败'),
        'error'
      );
    } finally {
      setBusy(null);
    }
  };

  const level = status?.level || 'unknown';
  const styles = levelStyles(level);
  const title = levelTitle(level, status?.percent ?? null, language);
  const summary =
    language === 'zh'
      ? status?.summary_zh || t('vram.loading', '读取显存…')
      : status?.summary || t('vram.loading', 'Reading VRAM…');
  const tip =
    language === 'zh'
      ? status?.tip_zh || ''
      : status?.tip || '';

  const schedulerActive =
    scheduler &&
    scheduler.phase !== 'idle' &&
    scheduler.phase !== 'done';
  const schedulerLabel = schedulerActive
    ? language === 'zh'
      ? scheduler!.message_zh || schedulerPhaseFallback(scheduler!.phase, 'zh')
      : scheduler!.message || schedulerPhaseFallback(scheduler!.phase, 'en')
    : null;

  const ollamaLabel =
    status?.ollama.models.length
      ? status.ollama.models.map((m) => m.name).join(', ')
      : status?.ollama.online
        ? t('vram.ollama_idle', '待命 / 未驻留')
        : t('vram.offline', '离线');

  const comfyLabel = status?.comfyui.online
    ? t('vram.comfy_online', '在线')
    : t('vram.offline', '离线');

  return (
    <div className="relative group/vram flex items-center gap-2" ref={rootRef}>
      {/* Plan 1 seamless status text (status bar) */}
      {schedulerLabel && (
        <div
          className="hidden sm:flex items-center gap-1.5 max-w-[18rem] px-2.5 py-1 rounded-full border border-indigo-800/50 bg-indigo-950/60 text-[11px] text-indigo-200 animate-pulse"
          title={schedulerLabel}
        >
          <LoaderCircle size={12} className="animate-spin flex-shrink-0 text-indigo-300" />
          <span className="truncate">{schedulerLabel}</span>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-full border text-xs font-medium transition-all shadow-lg backdrop-blur-sm ${
          schedulerActive
            ? 'bg-indigo-950/80 border-indigo-600/50 text-indigo-100 hover:bg-indigo-900/70 ring-2 ring-indigo-500/30'
            : styles.pill
        } ${open ? `ring-2 ${styles.ring}` : ''}`}
        title={schedulerLabel || tip || title}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span
          className={`relative flex h-2 w-2 flex-shrink-0 rounded-full ${
            schedulerActive
              ? 'bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.9)] animate-pulse'
              : styles.dot
          }`}
        >
          <span
            className={`absolute inset-0 rounded-full opacity-60 ${
              schedulerActive || level === 'critical' || level === 'warning'
                ? 'animate-ping bg-inherit'
                : ''
            }`}
          />
        </span>
        <Activity size={13} className="opacity-80 flex-shrink-0" />
        <span className="whitespace-nowrap">
          {schedulerActive && scheduler?.phase === 'vram_tuning'
            ? t('vram.auto_tuning_short', '调优显存…')
            : loading && !status
              ? t('vram.loading', '显存…')
              : title}
        </span>
        {status?.percent != null && !schedulerActive && (
          <span className={`hidden sm:inline font-mono tabular-nums opacity-80 ${styles.label}`}>
            {Math.round(status.percent)}%
          </span>
        )}
      </button>

      {/* Hover tooltip when panel closed — occupancy breakdown (e.g. Ollama 5.1G / ComfyUI 2.5G) */}
      {!open && tip && (
        <div className="pointer-events-none absolute left-0 top-full mt-2 w-72 opacity-0 group-hover/vram:opacity-100 transition-opacity z-50">
          <div className="rounded-lg border border-slate-700 bg-slate-900/95 px-3 py-2 text-[11px] text-slate-300 shadow-xl leading-relaxed">
            {tip}
          </div>
        </div>
      )}

      {open && (
        <div
          role="dialog"
          aria-label={t('vram.panel_title', '显存快速控制')}
          className="absolute left-0 top-full mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-slate-700 bg-slate-900 shadow-2xl z-50 overflow-hidden animate-in fade-in duration-150"
        >
          <div className="px-4 py-3 border-b border-slate-800 bg-gradient-to-r from-slate-900 to-slate-850">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className={`text-sm font-semibold ${styles.label}`}>{title}</div>
                <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{summary}</div>
              </div>
              <button
                type="button"
                onClick={() => refresh(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors flex-shrink-0"
                title={t('vram.refresh', '刷新')}
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>

            {status?.gpu_name && (
              <div className="mt-2 text-[10px] text-slate-500 truncate" title={status.gpu_name}>
                {status.gpu_name}
                {status.used_bytes != null && status.total_bytes != null && (
                  <span className="ml-1 text-slate-400">
                    · {formatGiB(status.used_bytes)} / {formatGiB(status.total_bytes)}
                  </span>
                )}
              </div>
            )}

            {/* Usage bar */}
            <div className="mt-2.5 h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  level === 'critical'
                    ? 'bg-rose-500'
                    : level === 'warning'
                      ? 'bg-amber-400'
                      : level === 'good'
                        ? 'bg-emerald-400'
                        : 'bg-slate-600'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, status?.percent ?? 0))}%` }}
              />
            </div>
          </div>

          <div className="px-4 py-3 space-y-2.5 border-b border-slate-800">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              {t('vram.breakdown', '占用明细')}
            </div>

            {status?.processes?.length ? (
              <ul className="space-y-1.5">
                {status.processes.map((p) => (
                  <li
                    key={p.name}
                    className="flex items-center justify-between text-xs text-slate-300 bg-slate-950/60 rounded-lg px-2.5 py-1.5 border border-slate-800"
                  >
                    <span className="truncate">
                      {p.name}
                      {p.detail ? (
                        <span className="text-slate-500 ml-1.5 text-[10px]">{p.detail}</span>
                      ) : null}
                    </span>
                    <span className="font-mono text-slate-200 flex-shrink-0 ml-2">
                      {formatGiB(p.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">
                {tip || t('vram.no_processes', '暂无模型占用显存')}
              </p>
            )}

            <div className="grid grid-cols-2 gap-2 pt-1">
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2">
                <div className="text-[10px] text-slate-500">Ollama</div>
                <div className="text-xs text-slate-200 mt-0.5 truncate" title={ollamaLabel}>
                  {status?.ollama.online ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      {formatGiB(status.ollama.used_bytes)}
                    </span>
                  ) : (
                    <span className="text-slate-500">{t('vram.offline', '离线')}</span>
                  )}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5 truncate">{ollamaLabel}</div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2">
                <div className="text-[10px] text-slate-500">ComfyUI</div>
                <div className="text-xs text-slate-200 mt-0.5">
                  {status?.comfyui.online ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                      {formatGiB(
                        status.comfyui.torch_used_bytes ?? status.comfyui.used_bytes ?? 0
                      )}
                    </span>
                  ) : (
                    <span className="text-slate-500">{t('vram.offline', '离线')}</span>
                  )}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">{comfyLabel}</div>
              </div>
            </div>
          </div>

          <div className="p-3 space-y-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={handleReleaseLlm}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors shadow-lg shadow-indigo-900/30"
            >
              {busy === 'llm' ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : (
                <Zap size={16} />
              )}
              <span>{t('vram.release_llm', '一键释放 LLM 显存')}</span>
            </button>
            <p className="text-[10px] text-slate-500 text-center px-2 leading-relaxed">
              {t(
                'vram.release_llm_hint',
                '释放后留给 ComfyUI 畅跑 Pony / SDXL'
              )}
            </p>

            <button
              type="button"
              disabled={busy !== null}
              onClick={handleFreeComfy}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-slate-200 border border-slate-700 transition-colors"
            >
              {busy === 'comfy' ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : (
                <Sparkles size={15} />
              )}
              <span>{t('vram.free_comfy', '重置 ComfyUI 显存缓存')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
