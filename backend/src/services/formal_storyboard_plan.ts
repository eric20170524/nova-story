/**
 * Deterministic formal-storyboard rules for FS04–FS16.
 * Live image acceptance stays closed until a combination is recorded in
 * FORMAL_OPEN_COMBINATIONS. Version 1 continuity pins are not rewritten.
 * On 2026-10-21 the operator recorded the current Pony/SDXL path
 * (`sdxl_ip_adapter`) so formal candidates can render. Other combinations stay closed.
 */

export const FORMAL_OPEN_COMBINATIONS: string[] = ['sdxl_ip_adapter'];

export type FormalRole = 'face' | 'body' | 'costume' | 'scene' | 'pose' | 'source_draft' | 'identity_region' | 'inpaint' | 'previous_frame' | 'video_tail';

export interface FormalPinEntry {
  entity_id: string;
  character_id?: number | null;
  role: FormalRole;
  version: number;
  content_hash: string;
  image_url?: string | null;
  lora?: string | null;
  confirmed?: boolean;
  mask?: { x: number; y: number; width: number; height: number } | null;
}

export interface NamedCharacter {
  id: number;
  name: string;
  project_id?: number;
  lora?: string | null;
  visual_tags?: string | null;
  identity_lock?: string | null;
}

const CLIENT_FIELDS = ['character_ref_url', 'ref_image_url', 'force_character_adapter', 'force_no_character_adapter'] as const;

export function readFormalPin(frameJson: string | null | undefined, formalRequest?: { entries?: FormalPinEntry[] } | null) {
  let v1: { version?: number } | null = null;
  try { v1 = JSON.parse(frameJson || 'null'); } catch { v1 = null; }
  const version1 = v1?.version === 1 ? v1 : null;
  const entries = formalRequest?.entries || [];
  return { version1, version2: entries.length > 0 ? { version: 2 as const, entries } : null };
}

export function rolesFromVisualTags(raw: string | null | undefined): Array<{ role: FormalRole; image_url: string }> {
  let tags: any = {};
  try { tags = JSON.parse(raw || '{}'); } catch { tags = {}; }
  const assets = tags.assets || tags;
  const roles: Array<{ role: FormalRole; image_url: string }> = [];
  const face = String(assets.avatar_url || '').trim();
  const body = String(assets.turnaround_front_url || '').trim();
  if (face) roles.push({ role: 'face', image_url: face });
  if (body) roles.push({ role: 'body', image_url: body });
  return roles;
}

export function resolveVisibleCharacters(names: string[], characters: NamedCharacter[], projectId?: number) {
  const resolved: NamedCharacter[] = [];
  const errors: Array<{ name: string; code: 'missing' | 'ambiguous' | 'cross_project' }> = [];
  for (const name of names) {
    const matches = characters.filter((character) => character.name === name);
    const inProject = projectId == null ? matches : matches.filter((character) => character.project_id == null || character.project_id === projectId);
    if (matches.length > 0 && inProject.length === 0) errors.push({ name, code: 'cross_project' });
    else if (inProject.length === 0) errors.push({ name, code: 'missing' });
    else if (inProject.length > 1) errors.push({ name, code: 'ambiguous' });
    else resolved.push(inProject[0]!);
  }
  return { resolved, errors };
}

export function appearanceConflict(visualTags: string | null | undefined, identityLock: string | null | undefined) {
  const tags = String(visualTags || '').trim();
  const lock = String(identityLock || '').trim();
  if (!tags || !lock) return false;
  return tags !== lock;
}

export function suggestSceneBoard(locationName: string | null | undefined, boards: Array<{ id: number; name: string; project_id?: number }>, projectId?: number) {
  if (!locationName) return null;
  const matches = boards.filter((board) => board.name === locationName && (projectId == null || board.project_id == null || board.project_id === projectId));
  if (matches.length !== 1) return null;
  return { asset_id: matches[0]!.id, name: matches[0]!.name, confirmed: false as const };
}

export interface FormalAssemblyInput {
  projectId?: number;
  visibleNames: string[];
  characters: NamedCharacter[];
  sceneBoards?: Array<{ id: number; name: string; project_id?: number }>;
  locationName?: string | null;
  clientWorkflow?: Record<string, unknown>;
  selectedCharacterVersions?: Record<number, number>;
  entries?: FormalPinEntry[];
  loraSlots?: number;
}

export function assembleFormalReferences(input: FormalAssemblyInput) {
  const names = resolveVisibleCharacters(input.visibleNames, input.characters, input.projectId);
  const ignored = CLIENT_FIELDS.filter((field) => input.clientWorkflow?.[field] != null);
  const conflicts = names.resolved.filter((character) => appearanceConflict(character.visual_tags, character.identity_lock));
  const entries: FormalPinEntry[] = [...(input.entries || [])];
  const unused: string[] = [];
  if (names.errors.length > 0) {
    return { ok: false as const, code: names.errors[0]!.code, detail: names.errors[0]!.name, ignored, entries, unused, suggestion: null };
  }
  if (conflicts.length > 0 && conflicts.some((character) => input.selectedCharacterVersions?.[character.id] == null)) {
    return { ok: false as const, code: 'appearance_conflict' as const, detail: conflicts.map((character) => character.name).join(','), ignored, entries, unused, suggestion: null };
  }
  for (const character of names.resolved) {
    const version = input.selectedCharacterVersions?.[character.id] || 1;
    for (const role of rolesFromVisualTags(character.visual_tags)) {
      entries.push({ entity_id: `character:${character.id}`, character_id: character.id, role: role.role, version, content_hash: `${character.id}:${version}:${role.role}`, image_url: role.image_url, lora: character.lora || null, confirmed: true });
    }
  }
  const loras = [...new Set(entries.map((entry) => entry.lora).filter((lora): lora is string => Boolean(lora)))];
  const slots = input.loraSlots ?? 1;
  if (loras.length > slots) unused.push('multiple_character_loras_not_supported');
  const suggestion = suggestSceneBoard(input.locationName, input.sceneBoards || [], input.projectId);
  const boundScene = entries.some((entry) => entry.role === 'scene' && entry.confirmed);
  return { ok: true as const, ignored, entries, unused, suggestion: boundScene ? null : suggestion, loras: loras.slice(0, slots), dropped_loras: loras.slice(slots) };
}

export function validateMask(entry: FormalPinEntry, canvas = { width: 1280, height: 720 }) {
  if (entry.role !== 'identity_region' && entry.role !== 'inpaint') return { ok: true as const };
  const mask = entry.mask;
  if (!mask) return { ok: false as const, code: 'mask_missing' };
  const inside = mask.x >= 0 && mask.y >= 0 && mask.width > 0 && mask.height > 0 && mask.x + mask.width <= canvas.width && mask.y + mask.height <= canvas.height;
  return inside ? { ok: true as const } : { ok: false as const, code: 'mask_bounds' };
}

export function masksConflict(entries: FormalPinEntry[]) {
  const regions = entries.filter((entry) => entry.role === 'identity_region' && entry.mask);
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const a = regions[i]!.mask!, b = regions[j]!.mask!;
      const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      if (overlap && regions[i]!.character_id !== regions[j]!.character_id) return true;
    }
  }
  return false;
}

export function selectPreviousFrame(input: {
  scriptSceneId: string;
  momentId: string;
  cameraRelation: 'continuation' | 'coverage' | 'opposite' | 'unknown';
  storyOrder: number;
  candidates: Array<{ id: number; script_scene_id: string; moment_id: string; story_order: number; index: number; asset_url?: string | null; version: number }>;
}) {
  if (input.cameraRelation !== 'continuation') return { ok: false as const, code: 'camera_not_continuation' };
  const prior = input.candidates
    .filter((shot) => shot.script_scene_id === input.scriptSceneId && shot.moment_id === input.momentId && shot.story_order < input.storyOrder && shot.asset_url)
    .sort((a, b) => b.story_order - a.story_order);
  if (prior.length === 0) return { ok: false as const, code: 'no_previous' };
  const source = prior[0]!;
  if (source.id === input.candidates.find((shot) => shot.story_order === input.storyOrder)?.id) return { ok: false as const, code: 'cycle' };
  return { ok: true as const, source_id: source.id, version: source.version, image_url: source.asset_url };
}

export function formalRenderAllowed(combination: string) {
  if (combination === 'qwen_image_native_reference') return true;
  return FORMAL_OPEN_COMBINATIONS.includes(combination);
}

export function krea2ReferenceBoundary(classTypes: string[]) {
  const referenceNode = classTypes.some((name) => /reference|stylemodel|redux/i.test(name));
  return {
    interface_present: referenceNode,
    workflow_valid_for_text: classTypes.includes('UNETLoader') && classTypes.includes('VAELoader'),
    reference_participates: false,
    img2img_separate_from_reference: true,
    identity_locked: false,
    sdxl_adapters_injected: false,
    formal_open: false,
    needs_weights: true,
  };
}

export function planFormalBatch(shots: Array<{ id: number; selected?: boolean; stale?: boolean; missing?: string | null; failed?: boolean; hasFormal?: boolean; redo?: boolean }>) {
  const selected = shots.filter((shot) => shot.selected);
  const skipped = selected.filter((shot) => shot.missing || shot.stale || (shot.hasFormal && !shot.redo));
  const eligible = selected.filter((shot) => !skipped.includes(shot));
  return {
    eligible: eligible.map((shot) => shot.id),
    skipped: skipped.map((shot) => ({ id: shot.id, reason: shot.missing || (shot.stale ? 'stale' : 'formal_exists') })),
    counts: {
      selected: selected.length,
      eligible: eligible.length,
      skipped: skipped.length,
      failed: shots.filter((shot) => shot.failed).length,
      stale: shots.filter((shot) => shot.stale).length,
    },
  };
}

export function selectFormalVideoStill(input: { activeUrl?: string | null; review?: string | null; stale?: boolean; candidateUrl?: string | null }) {
  if (input.review === 'accepted' && !input.stale && input.activeUrl) return { url: input.activeUrl, purpose: 'formal' as const };
  if (input.candidateUrl && input.candidateUrl !== input.activeUrl) return { url: input.activeUrl || null, purpose: 'draft' as const, ignored_candidate: input.candidateUrl };
  return { url: input.activeUrl || null, purpose: input.activeUrl ? 'draft' as const : 'none' as const };
}

export function markFormalStale(entries: Array<{ version: number; asset_url?: string | null; entity_ids: string[]; active?: boolean; review?: string | null }>, changed: string[]) {
  return entries.map((entry) => {
    const affected = entry.entity_ids.some((id) => changed.includes(id));
    if (!affected) return { ...entry, stale: false, asset_url: entry.asset_url };
    return { ...entry, stale: true, asset_url: entry.asset_url, recoverable: true };
  });
}
