import type { MediaAsset, VideoWorkflowId, VideoPreset } from '../types';

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
    if (has('character_reference')) {
      return { workflowId: 'minimax_h3_multiframe_official_12gb', reason: '尾帧边界与人物身份参考同时存在，使用 Official Multi-Frame。' };
    }
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
  _preset?: VideoPreset,
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

export type IdentityPlateHint = {
  characterId?: number | null;
  face?: string | null;
  body?: string | null;
};

const referenceSlot = (asset: MediaAsset): 'face' | 'body' | null => {
  if (!asset.metadata_json) return null;
  try {
    const slot = JSON.parse(asset.metadata_json).source_slot;
    return slot === 'face' || slot === 'body' ? slot : null;
  } catch {
    return null;
  }
};

/**
 * Face then body for one character.
 * A pinned plate URL wins. Slotted assets ignore a newer portrait with no slot.
 * Assets with no slots keep the two newest ids. Keep this in step with
 * scripts/production-references.mjs selectIdentityReferenceIds.
 */
export const selectIdentityReferenceIds = (
  assets: MediaAsset[],
  characterId: number,
  plates?: { face?: string | null; body?: string | null } | null,
): number[] => {
  const refs = assets.filter(asset => asset.role === 'character_reference' && asset.status === 'ready'
    && asset.character_id === characterId && asset.id != null);
  const face = String(plates?.face || '').trim();
  const body = String(plates?.body || '').trim();
  if (face || body) {
    const ids: number[] = [];
    const match = (url: string) => refs
      .filter(asset => asset.url === url)
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    const faceAsset = face ? match(face) : undefined;
    const bodyAsset = body && body !== face ? match(body) : undefined;
    if (faceAsset?.id != null) ids.push(faceAsset.id);
    if (bodyAsset?.id != null) ids.push(bodyAsset.id);
    if (ids.length) return ids;
  }
  const slotted = refs.filter(asset => referenceSlot(asset));
  if (slotted.length) {
    const newest = (slot: 'face' | 'body') => slotted
      .filter(asset => referenceSlot(asset) === slot)
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    return [newest('face')?.id, newest('body')?.id].filter((id): id is number => id != null);
  }
  return refs.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 2).map(asset => asset.id!);
};

/** Choose at most two recent views of one bound character for the initial UI state. */
export const defaultIdentityReferenceIds = (assets: MediaAsset[], pin?: IdentityPlateHint): number[] => {
  const refs = assets.filter(asset => asset.role === 'character_reference' && asset.id != null
    && asset.status === 'ready')
    .sort((a, b) => Number(b.id) - Number(a.id));
  const first = refs[0];
  const characterId = pin?.characterId ?? first?.character_id;
  if (characterId == null) return [];
  if (pin && (pin.face || pin.body)) {
    const picked = selectIdentityReferenceIds(assets, Number(characterId), pin);
    if (picked.length) return picked;
  }
  const mine = refs.filter(asset => asset.character_id === characterId);
  if (mine.some(asset => referenceSlot(asset))) {
    return selectIdentityReferenceIds(assets, Number(characterId));
  }
  return mine.slice(0, 2).map(asset => asset.id!);
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
