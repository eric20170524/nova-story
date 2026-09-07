import React, { useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
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
  Check,
  SlidersHorizontal,
  Upload,
  Image as ImageIcon,
  Film,
  X,
  Link2
} from 'lucide-react';
import {
  Scene,
  MediaAsset,
  VideoTaskState,
  VideoQAReport,
  VideoWorkflowId
} from '../../types';
import { useLanguage } from '../../LanguageContext';
import { useToast } from '../../ToastContext';
import { API_BASE_URL } from '../../constants';
import { api } from '../../services/api';

interface SceneVideoPlayerProps {
  scene: Scene;
  mediaAssets?: MediaAsset[];
  taskState?: VideoTaskState;
  onGenerateVideo?: (options?: any) => void;
  onPromoteAsset?: (assetId: number) => void;
  onReprocessAsset?: (assetId: number) => void;
  onCancelTask?: (taskId: string) => void;
}

type ReferenceUploadRole =
  | 'video_keyframe'
  | 'last_frame_reference'
  | 'character_reference'
  | 'motion_reference';

const WORKFLOWS: Array<{
  id: VideoWorkflowId;
  label: string;
  badge: string;
  description: string;
}> = [
  {
    id: 'minimax_h3_hongchao_a2a_12gb',
    label: 'Hybrid A2A',
    badge: '实验',
    description: '人物参考 + 动作参考，可选硬尾帧。'
  },
  {
    id: 'minimax_h3_ref2va_official_12gb',
    label: 'Official Ref2VA',
    badge: '候选',
    description: '人物/动作参考；不支持硬尾帧。'
  },
  {
    id: 'minimax_h3_fl2va_official_12gb',
    label: 'Official FL2VA',
    badge: '候选',
    description: '首帧/尾帧边界；不消费人物/动作参考。'
  }
];

const WORKFLOW_IDS = new Set(WORKFLOWS.map((workflow) => workflow.id));

const isFinalVideo = (asset?: MediaAsset | null) =>
  Boolean(asset && (asset.role === 'loop_master' || asset.role === 'narrative_final'));

const latestAsset = (assets: MediaAsset[]) =>
  [...assets].sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];

const assetLabel = (asset: MediaAsset, prefix?: string) => {
  const name = String(asset.url || '').split('/').filter(Boolean).pop() || `asset-${asset.id}`;
  return `${prefix ? `${prefix} · ` : ''}#${asset.id} ${name}`;
};

export const SceneVideoPlayer: React.FC<SceneVideoPlayerProps> = ({
  scene,
  mediaAssets = [],
  taskState,
  onGenerateVideo,
  onPromoteAsset,
  onReprocessAsset,
  onCancelTask
}) => {
  const { id: projectIdParam } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(true);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
  const [showQADetails, setShowQADetails] = useState(false);
  const [showReferenceManager, setShowReferenceManager] = useState(false);
  const [localReferenceAssets, setLocalReferenceAssets] = useState<MediaAsset[]>([]);
  const [uploadingRole, setUploadingRole] = useState<ReferenceUploadRole | null>(null);
  const [workflowId, setWorkflowId] = useState<VideoWorkflowId>(() => {
    try {
      const saved = localStorage.getItem('director_videoWorkflowId') as VideoWorkflowId | null;
      if (saved && WORKFLOW_IDS.has(saved)) return saved;
    } catch {}
    return 'minimax_h3_hongchao_a2a_12gb';
  });
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<number | null>(null);
  const [selectedLastFrameId, setSelectedLastFrameId] = useState<number | null>(null);
  const [selectedCharacterRefIds, setSelectedCharacterRefIds] = useState<number[]>([]);
  const [selectedMotionRefId, setSelectedMotionRefId] = useState<number | null>(null);

  const mergedAssets = React.useMemo(() => {
    const byId = new Map<number, MediaAsset>();
    [...mediaAssets, ...localReferenceAssets].forEach((asset) => {
      if (asset?.id != null) byId.set(asset.id, asset);
    });
    return Array.from(byId.values());
  }, [mediaAssets, localReferenceAssets]);

  const videoAssets = mergedAssets.filter((asset) => asset.media_type === 'video');
  const finalVideoAssets = videoAssets.filter((asset) => isFinalVideo(asset));
  const keyframeAssets = mergedAssets.filter((asset) => asset.role === 'video_keyframe' && asset.media_type === 'image');
  const explicitLastFrameAssets = mergedAssets.filter((asset) => asset.role === 'last_frame_reference' && asset.media_type === 'image');
  const characterReferenceAssets = mergedAssets.filter((asset) => asset.role === 'character_reference' && asset.media_type === 'image');
  const motionReferenceAssets = mergedAssets.filter((asset) => asset.role === 'motion_reference' && asset.media_type === 'video');
  const lastFrameChoices = Array.from(
    new Map([...keyframeAssets, ...explicitLastFrameAssets].map((asset) => [asset.id, asset])).values()
  );

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

  useEffect(() => {
    try {
      localStorage.setItem('director_videoWorkflowId', workflowId);
    } catch {}
  }, [workflowId]);

  useEffect(() => {
    const validKeyframeIds = new Set(keyframeAssets.map((asset) => asset.id));
    if (selectedKeyframeId == null || !validKeyframeIds.has(selectedKeyframeId)) {
      setSelectedKeyframeId(latestAsset(keyframeAssets)?.id ?? null);
    }

    const validLastIds = new Set(lastFrameChoices.map((asset) => asset.id));
    if (selectedLastFrameId != null && !validLastIds.has(selectedLastFrameId)) {
      setSelectedLastFrameId(null);
    }

    const validCharIds = new Set(characterReferenceAssets.map((asset) => asset.id));
    setSelectedCharacterRefIds((current) => {
      const preserved = current.filter((id) => validCharIds.has(id)).slice(0, 3);
      if (preserved.length > 0) return preserved;
      return characterReferenceAssets.slice(-3).map((asset) => asset.id);
    });

    const validMotionIds = new Set(motionReferenceAssets.map((asset) => asset.id));
    if (selectedMotionRefId == null || !validMotionIds.has(selectedMotionRefId)) {
      setSelectedMotionRefId(latestAsset(motionReferenceAssets)?.id ?? null);
    }
  }, [
    keyframeAssets.map((asset) => asset.id).join(','),
    lastFrameChoices.map((asset) => asset.id).join(','),
    characterReferenceAssets.map((asset) => asset.id).join(','),
    motionReferenceAssets.map((asset) => asset.id).join(',')
  ]);

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
    ? mergedAssets.find((asset) => asset.role === 'poster' && asset.parent_asset_id === activeAsset.id)
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

  const isFl2va = workflowId === 'minimax_h3_fl2va_official_12gb';
  const isRef2va = workflowId === 'minimax_h3_ref2va_official_12gb';

  const toggleCharacterRef = (assetId: number) => {
    setSelectedCharacterRefIds((current) => {
      if (current.includes(assetId)) return current.filter((id) => id !== assetId);
      if (current.length >= 3) {
        showToast('人物参考最多选择 3 张', 'warning');
        return current;
      }
      return [...current, assetId];
    });
  };

  const uploadReference = async (role: ReferenceUploadRole, file?: File) => {
    if (!file) return;
    const projectId = Number(projectIdParam || mergedAssets[0]?.project_id || 0);
    const sceneId = Number(scene.id);
    if (!Number.isFinite(projectId) || projectId <= 0 || !Number.isFinite(sceneId) || sceneId <= 0) {
      showToast('无法确定 Project / Scene ID，参考素材未上传', 'error');
      return;
    }

    setUploadingRole(role);
    try {
      const formData = new FormData();
      // Fastify multipart exposes fields already seen when request.file() resolves;
      // append metadata before the file so role/project ownership is deterministic.
      formData.append('project_id', String(projectId));
      formData.append('scene_id', String(sceneId));
      formData.append('role', role);
      formData.append('file', file);

      const asset = await api.uploadVideoReference(formData);
      setLocalReferenceAssets((current) => [
        ...current.filter((item) => item.id !== asset.id),
        asset
      ]);

      if (role === 'video_keyframe') setSelectedKeyframeId(asset.id);
      if (role === 'last_frame_reference') setSelectedLastFrameId(asset.id);
      if (role === 'motion_reference') setSelectedMotionRefId(asset.id);
      if (role === 'character_reference') {
        setSelectedCharacterRefIds((current) => [...current.filter((id) => id !== asset.id), asset.id].slice(-3));
      }
      showToast('参考素材已上传并绑定到当前 Scene', 'success');
    } catch (error: any) {
      showToast(error?.message || '参考素材上传失败', 'error');
    } finally {
      setUploadingRole(null);
    }
  };

  const submitConfiguredGeneration = () => {
    if (!onGenerateVideo) return;
    if (!selectedKeyframeId) {
      showToast('请先选择或上传 First Frame', 'warning');
      return;
    }

    onGenerateVideo({
      workflowId,
      keyframeAssetId: selectedKeyframeId,
      lastFrameAssetId: isRef2va ? undefined : (selectedLastFrameId || undefined),
      characterRefAssetIds: isFl2va ? [] : selectedCharacterRefIds,
      motionRefAssetId: isFl2va ? undefined : (selectedMotionRefId || undefined)
    });
    setShowReferenceManager(false);
  };

  const renderUploadButton = (
    role: ReferenceUploadRole,
    label: string,
    accept: string,
    icon: React.ReactNode
  ) => (
    <label
      className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[10px] cursor-pointer transition-colors ${
        uploadingRole === role
          ? 'bg-slate-800 border-slate-700 text-slate-500 cursor-wait'
          : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-indigo-600 hover:text-indigo-200'
      }`}
    >
      {uploadingRole === role ? <Loader2 size={11} className="animate-spin" /> : icon}
      <span>{label}</span>
      <input
        type="file"
        accept={accept}
        disabled={uploadingRole != null}
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          void uploadReference(role, file);
        }}
      />
    </label>
  );

  const renderReferenceManager = () => {
    if (!showReferenceManager) return null;

    return (
      <div className="p-3 bg-slate-950 border-t border-indigo-900/50 space-y-3 text-[11px]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-indigo-200 font-semibold">
            <SlidersHorizontal size={13} />
            <span>H3 Reference Manager</span>
          </div>
          <button
            type="button"
            className="p-1 rounded text-slate-500 hover:text-white hover:bg-slate-800"
            onClick={() => setShowReferenceManager(false)}
            title="关闭参考配置"
          >
            <X size={13} />
          </button>
        </div>

        <div className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Workflow Strategy</span>
          <div className="grid grid-cols-1 gap-1.5">
            {WORKFLOWS.map((workflow) => (
              <button
                key={workflow.id}
                type="button"
                onClick={() => setWorkflowId(workflow.id)}
                className={`p-2 rounded-lg border text-left transition-all ${
                  workflowId === workflow.id
                    ? 'bg-indigo-950/70 border-indigo-500 text-white'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{workflow.label}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded border ${
                    workflow.id === 'minimax_h3_hongchao_a2a_12gb'
                      ? 'text-amber-300 border-amber-800 bg-amber-950/40'
                      : 'text-sky-300 border-sky-800 bg-sky-950/40'
                  }`}>
                    {workflow.badge}
                  </span>
                </div>
                <p className="mt-0.5 text-[9px] text-slate-500">{workflow.description}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="rounded-lg bg-slate-900/70 border border-slate-800 p-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-300 flex items-center gap-1">
                <ImageIcon size={11} className="text-indigo-400" />
                First Frame <span className="text-rose-400">*</span>
              </span>
              {renderUploadButton('video_keyframe', '上传', 'image/*', <Upload size={10} />)}
            </div>
            <select
              value={selectedKeyframeId ?? ''}
              onChange={(event) => setSelectedKeyframeId(event.target.value ? Number(event.target.value) : null)}
              className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-[10px] text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="">未选择 First Frame</option>
              {keyframeAssets.map((asset) => (
                <option key={asset.id} value={asset.id}>{assetLabel(asset)}</option>
              ))}
            </select>
          </div>

          <div className={`rounded-lg bg-slate-900/70 border p-2 space-y-1.5 ${isRef2va ? 'border-slate-800 opacity-55' : 'border-slate-800'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-300 flex items-center gap-1">
                <Link2 size={11} className="text-emerald-400" />
                Last Frame
              </span>
              {!isRef2va && renderUploadButton('last_frame_reference', '上传', 'image/*', <Upload size={10} />)}
            </div>
            {isRef2va ? (
              <div className="text-[9px] text-amber-400">Ref2VA 不支持硬尾帧；该输入会被明确排除。</div>
            ) : (
              <>
                <select
                  value={selectedLastFrameId ?? ''}
                  onChange={(event) => setSelectedLastFrameId(event.target.value ? Number(event.target.value) : null)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-[10px] text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">不指定 Last Frame</option>
                  {lastFrameChoices.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {assetLabel(asset, asset.role === 'video_keyframe' ? 'K / First Frame' : 'Last')}
                    </option>
                  ))}
                </select>
                {selectedKeyframeId && (
                  <button
                    type="button"
                    onClick={() => setSelectedLastFrameId(selectedKeyframeId)}
                    className="text-[9px] text-indigo-300 hover:text-indigo-200 underline underline-offset-2"
                  >
                    使用 First Frame 作为 Last Frame（K→K）
                  </button>
                )}
              </>
            )}
          </div>

          <div className={`rounded-lg bg-slate-900/70 border border-slate-800 p-2 space-y-1.5 ${isFl2va ? 'opacity-55' : ''}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-300 flex items-center gap-1">
                <ImageIcon size={11} className="text-purple-400" />
                Character Ref 1..3
              </span>
              {!isFl2va && renderUploadButton('character_reference', '上传', 'image/*', <Upload size={10} />)}
            </div>
            {isFl2va ? (
              <div className="text-[9px] text-amber-400">FL2VA 不消费人物 identity reference。</div>
            ) : characterReferenceAssets.length === 0 ? (
              <div className="text-[9px] text-slate-600">暂无人物参考图</div>
            ) : (
              <div className="space-y-1 max-h-24 overflow-y-auto custom-scrollbar">
                {characterReferenceAssets.map((asset) => (
                  <label key={asset.id} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-slate-800/70 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedCharacterRefIds.includes(asset.id)}
                      onChange={() => toggleCharacterRef(asset.id)}
                      className="w-3 h-3 rounded bg-slate-950 border-slate-700 text-indigo-600"
                    />
                    <span className="truncate text-[10px] text-slate-300">{assetLabel(asset)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className={`rounded-lg bg-slate-900/70 border border-slate-800 p-2 space-y-1.5 ${isFl2va ? 'opacity-55' : ''}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-300 flex items-center gap-1">
                <Film size={11} className="text-sky-400" />
                Motion Ref
              </span>
              {!isFl2va && renderUploadButton('motion_reference', '上传', 'video/*', <Upload size={10} />)}
            </div>
            {isFl2va ? (
              <div className="text-[9px] text-amber-400">FL2VA 不消费 motion reference。</div>
            ) : (
              <select
                value={selectedMotionRefId ?? ''}
                onChange={(event) => setSelectedMotionRefId(event.target.value ? Number(event.target.value) : null)}
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-[10px] text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="">未选择 Motion Ref</option>
                {motionReferenceAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>{assetLabel(asset)}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800">
          <div className="text-[9px] text-slate-500 leading-relaxed">
            所有输入在生成前仍会经过后端策略 schema + runtime preflight；不兼容输入不会被静默忽略。
          </div>
          <button
            type="button"
            disabled={!selectedKeyframeId || uploadingRole != null}
            onClick={submitConfiguredGeneration}
            className="flex-shrink-0 px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
          >
            <Sparkles size={11} />
            开始生成
          </button>
        </div>
      </div>
    );
  };

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
        <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-indigo-950/80 border border-indigo-700/50 text-indigo-300 mb-1">
          {stageLabels[stage] || stage}
        </span>
        {typeof taskState?.queue_position === 'number' && taskState.queue_position > 0 && (
          <span className="text-[9px] text-slate-500 mb-3">GPU Queue #{taskState.queue_position}</span>
        )}
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
      <div className="w-full bg-slate-950/90 flex flex-col select-none border-b border-slate-800">
        <div className="min-h-[220px] flex flex-col items-center justify-center p-4 text-center">
          <div className="w-12 h-12 rounded-full bg-indigo-950/50 border border-indigo-800/40 flex items-center justify-center mb-3 text-indigo-400 shadow-inner">
            <Video size={22} />
          </div>
          <p className="text-xs text-slate-300 font-medium mb-1">
            {t('director.no_video_yet', '暂未生成 H3 视频镜头')}
          </p>
          <p className="text-[10px] text-slate-500 mb-3 max-w-[240px]">
            H3 模型按 124 帧生成，交付标准化为 5.0s / 120帧 / 24fps
          </p>
          {onGenerateVideo && (
            <button
              type="button"
              onClick={() => setShowReferenceManager(true)}
              className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 shadow-lg shadow-indigo-600/30 hover:shadow-indigo-500/50 transition-all"
            >
              <SlidersHorizontal size={14} />
              <span>配置参考并生成</span>
            </button>
          )}
        </div>
        {renderReferenceManager()}
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
            onClick={() => setShowReferenceManager((show) => !show)}
            className={`py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 border transition-colors ${
              showReferenceManager
                ? 'bg-indigo-950 text-indigo-200 border-indigo-700'
                : 'bg-slate-800 hover:bg-indigo-950 hover:text-indigo-200 text-slate-300 border-slate-700 hover:border-indigo-700'
            }`}
            title="配置 H3 workflow 与参考素材并生成新候选"
          >
            <SlidersHorizontal size={11} />
            <span>参考/新视频</span>
          </button>
        )}
      </div>

      {renderReferenceManager()}

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
