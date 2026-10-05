import type { MediaAsset, VideoWorkflowId } from '../types';

export const PROJECT_VIDEO_WORKFLOW_IDS = [
  'grok_imagine_browser',
  'minimax_h3_ref2va_official_12gb',
  'minimax_h3_fl2va_official_12gb',
  'minimax_h3_multiframe_official_12gb',
  'minimax_h3_hongchao_a2a_12gb',
] as const satisfies readonly VideoWorkflowId[];

export const readProjectVideoWorkflow = (settings: unknown): VideoWorkflowId | null => {
  const raw = settings && typeof settings === 'object'
    ? (settings as { video_generation?: { workflow_id?: unknown } }).video_generation?.workflow_id
    : null;
  return typeof raw === 'string' && (PROJECT_VIDEO_WORKFLOW_IDS as readonly string[]).includes(raw)
    ? raw as VideoWorkflowId
    : null;
};

/** The scene's reference roles choose the official H3 workflow. */
export const recommendVideoWorkflow = (assets: MediaAsset[]): { workflowId: VideoWorkflowId; reason: string } => {
  const has = (role: MediaAsset['role']) => assets.some(asset => asset.role === role && asset.status === 'ready');
  if (has('guide_frame_reference') || has('composition_reference')) {
    return { workflowId: 'minimax_h3_multiframe_official_12gb', reason: '导引帧指定片段内的关键动作位置，使用 Official Multi-Frame。' };
  }
  if (has('last_frame_reference')) {
    return { workflowId: 'minimax_h3_fl2va_official_12gb', reason: '尾帧需要固定起止边界，使用 Official FL2VA。' };
  }
  return {
    workflowId: 'minimax_h3_ref2va_official_12gb',
    reason: has('character_reference')
      ? '人物身份参考与 Shot Master 一起进入 Official Ref2VA。'
      : '普通叙事镜头以 Shot Master 为首帧，使用 Official Ref2VA。',
  };
};

/**
 * A project default replaces only the ordinary-shot fallback.
 * Guide frames and last frames still select Multi-Frame or FL2VA.
 */
export const resolveProjectVideoWorkflow = (
  assets: MediaAsset[],
  projectDefault: VideoWorkflowId | null | undefined,
): { workflowId: VideoWorkflowId; reason: string } => {
  const recommended = recommendVideoWorkflow(assets);
  const structural = recommended.workflowId === 'minimax_h3_fl2va_official_12gb'
    || recommended.workflowId === 'minimax_h3_multiframe_official_12gb';
  if (structural || !projectDefault || projectDefault === recommended.workflowId) return recommended;
  return {
    workflowId: projectDefault,
    reason: '使用项目默认生视频工作流。有尾帧或引导帧的镜头仍按镜头参考选择。',
  };
};

/** Choose at most two recent views of one bound character for the initial UI state. */
export const defaultIdentityReferenceIds = (assets: MediaAsset[]): number[] => {
  const refs = assets.filter(asset => asset.role === 'character_reference' && asset.id != null
    && asset.status === 'ready')
    .sort((a, b) => Number(b.id) - Number(a.id));
  const first = refs[0];
  if (!first) return [];
  return refs.filter(asset => asset.character_id === first.character_id).slice(0, 2).map(asset => asset.id!);
};

export const appendUploadedIdentityReference = (
  selectedIds: number[],
  existingAssets: MediaAsset[],
  uploaded: MediaAsset,
): number[] => {
  if (uploaded.id == null) return selectedIds;
  const boundIds = new Set(existingAssets
    .filter(asset => selectedIds.includes(asset.id) && asset.character_id != null)
    .map(asset => Number(asset.character_id)));
  if (uploaded.character_id != null && boundIds.size && !boundIds.has(Number(uploaded.character_id))) {
    return [uploaded.id];
  }
  return [...selectedIds.filter(id => id !== uploaded.id), uploaded.id].slice(-3);
};
