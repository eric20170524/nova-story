const normalized = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');

export function shotSpec(shot) {
  return typeof shot.shot_spec === 'string' ? JSON.parse(shot.shot_spec || '{}') : shot.shot_spec || {};
}

export function resolveAssetBindings(shot, assets, bound = []) {
  const spec = shotSpec(shot);
  const required = [...new Map([
    { kind: 'location', name: spec.location },
    ...(spec.key_props || []).map(name => ({ kind: 'prop', name })),
  ].filter(item => String(item.name || '').trim()).map(item => [`${item.kind}:${normalized(item.name)}`, item])).values()];
  const matches = required.map(item => assets.filter(asset => asset.kind === item.kind && normalized(asset.name) === normalized(item.name)));
  const canonicalIds = new Set(matches.flatMap(items => items.map(item => item.id)));
  // An explicit Director binding can map an alias to a canonical asset. Reserve all
  // exact matches first, so an alias cannot consume another named prop's binding.
  const manual = bound.filter(asset => !canonicalIds.has(asset.id));
  const blockers = [];
  const selected = [];
  if (!required.length && !bound.length) return { asset_ids: [], required, blockers: [] };
  required.forEach((item, index) => {
    const exact = matches[index];
    if (exact.length > 1) {
      blockers.push(`Ambiguous ${item.kind} name: ${item.name}`);
      return;
    }
    const itemNorm = normalized(item.name);
    const contained = exact.length ? [] : assets.filter(asset => {
      const name = normalized(asset.name);
      return asset.kind === item.kind && name.length >= 2 && itemNorm.includes(name);
    });
    const longest = contained.reduce((best, asset) => Math.max(best, normalized(asset.name).length), 0);
    const uniqueContained = contained.filter(asset => normalized(asset.name).length === longest);
    const resolved = exact.length === 1 ? exact : uniqueContained;
    if (resolved.length > 1) {
      blockers.push(`Ambiguous ${item.kind} name: ${item.name}`);
      return;
    }
    if (resolved.length === 1) {
      selected.push(resolved[0].id);
      if (bound.length && !bound.some(asset => asset.id === resolved[0].id)) blockers.push(`Missing ${item.kind} binding: ${item.name}`);
      return;
    }
    const manualIndex = manual.findIndex(asset => asset.kind === item.kind);
    if (manualIndex >= 0) selected.push(manual.splice(manualIndex, 1)[0].id);
    else blockers.push(`No exact ${item.kind} asset match or explicit binding: ${item.name}`);
  });
  if (bound.some(asset => asset.stale || asset.status !== 'completed' || !asset.image_url)) blockers.push('Bound assets are stale or unfinished');
  return { asset_ids: [...new Set(selected)], required, blockers };
}

export function resolveShotCharacter(shot, characters) {
  const spec = shotSpec(shot);
  const match = subject => {
    const name = normalized(subject);
    if (!name) return null;
    const exact = characters.filter(character => normalized(character.name) === name);
    if (exact.length === 1) return exact[0];
    const included = characters.filter(character => name.includes(normalized(character.name)));
    return included.length === 1 ? included[0] : null;
  };
  // Focus identity takes precedence over database order and supporting characters.
  return match(spec.primary_subject) || (spec.visible_subjects || []).map(match).find(Boolean) || null;
}

export function resolveVisibleShotCharacters(shot, characters, limit = 4) {
  const spec = shotSpec(shot);
  const names = [spec.primary_subject, ...(spec.visible_subjects || [])];
  const selected = [];
  for (const name of names) {
    if (!normalized(name)) continue;
    const match = characters.find(character => normalized(character.name) === normalized(name));
    if (match?.avatar_url && !selected.some(character => character.id === match.id)) selected.push(match);
    if (selected.length >= limit) break;
  }
  return selected;
}

export function resolveVisibleShotCast(shot, characters) {
  const spec = shotSpec(shot);
  const names = [spec.primary_subject, ...(spec.visible_subjects || [])];
  const selected = [];
  for (const name of names) {
    if (!normalized(name)) continue;
    const match = characters.find(character => normalized(character.name) === normalized(name));
    if (match && !selected.some(character => character.id === match.id)) selected.push(match);
  }
  return selected;
}

export function resolveTimedOutCodexJobId(error) {
  return String(error || '').match(/Codex image job ([0-9a-f-]{36}) timed out/i)?.[1] || null;
}

export function keyframeUsesBindings(shot, bound, snapshots) {
  const snapshot = snapshots.find(item => item.scene_id === shot.id && item.image_url === shot.asset_url);
  if (!snapshot) return false;
  try {
    const order = list => list.map(item => ({ id: item.id, revision: item.revision })).sort((a, b) => a.id - b.id);
    return JSON.stringify(order(JSON.parse(snapshot.references_json))) === JSON.stringify(order(bound));
  } catch { return false; }
}

export function keyframeUsesCharacterVersions(shot, characters, snapshots, requiredIds = []) {
  const snapshot = snapshots.find(item => item.scene_id === shot.id && item.image_url === shot.asset_url);
  if (!snapshot?.character_versions_json) return characters.length === 0;
  try {
    const recorded = JSON.parse(snapshot.character_versions_json);
    if (!Array.isArray(recorded)) return false;
    const current = new Map(characters.map(character => [Number(character.id), Number(character.active_version || 1)]));
    const captured = new Map(recorded.map(character => [Number(character.id), Number(character.version)]));
    return recorded.every(character => current.get(Number(character.id)) === Number(character.version))
      && requiredIds.every(id => captured.has(Number(id)));
  } catch { return false; }
}

const PROJECT_VIDEO_WORKFLOW_IDS = new Set([
  'grok_imagine_browser',
  'minimax_h3_ref2va_official_12gb',
  'minimax_h3_fl2va_official_12gb',
  'minimax_h3_multiframe_official_12gb',
  'minimax_h3_hongchao_a2a_12gb',
]);

function referenceSlot(asset) {
  if (!asset?.metadata_json) return null;
  try {
    const slot = JSON.parse(asset.metadata_json).source_slot;
    return slot === 'face' || slot === 'body' ? slot : null;
  } catch {
    return null;
  }
}

export function platesFromCharacter(character) {
  const tags = character?.visual_tags;
  let parsed = {};
  if (typeof tags === 'string') {
    try { parsed = JSON.parse(tags || '{}'); } catch { parsed = {}; }
  } else if (tags && typeof tags === 'object') parsed = tags;
  const assets = parsed.assets && typeof parsed.assets === 'object' ? parsed.assets : {};
  return {
    face: String(assets.avatar_url || parsed.avatar_url || character?.avatar_url || '').trim() || null,
    body: String(assets.turnaround_front_url || parsed.turnaround_front_url || '').trim() || null,
  };
}

/**
 * Face then body. Pinned URLs win. Slotted assets ignore a newer portrait with no slot.
 * Assets with no slots keep the two newest ids. Keep this in step with
 * services/videoWorkflowPolicy.ts selectIdentityReferenceIds.
 */
export function selectIdentityReferenceIds(assets, characterId, plates) {
  const refs = (assets || []).filter(asset => asset.role === 'character_reference' && asset.status === 'ready'
    && asset.character_id === characterId && asset.id != null);
  const face = String(plates?.face || '').trim();
  const body = String(plates?.body || '').trim();
  if (face || body) {
    const match = url => refs.filter(asset => asset.url === url).sort((a, b) => Number(b.id) - Number(a.id))[0];
    const faceAsset = face ? match(face) : null;
    const bodyAsset = body && body !== face ? match(body) : null;
    const ids = [faceAsset?.id, bodyAsset?.id].filter(id => id != null);
    if (ids.length) return ids;
  }
  const slotted = refs.filter(asset => referenceSlot(asset));
  if (slotted.length) {
    const newest = slot => slotted.filter(asset => referenceSlot(asset) === slot).sort((a, b) => Number(b.id) - Number(a.id))[0];
    return [newest('face')?.id, newest('body')?.id].filter(id => id != null);
  }
  return refs.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 2).map(asset => asset.id);
}

export function coreCharactersReadyForAcceptance(coreNames, characters, shots) {
  const appearing = new Set();
  for (const shot of shots || []) {
    const spec = shotSpec(shot);
    for (const name of [spec.primary_subject, ...(spec.visible_subjects || [])]) {
      const key = normalized(name);
      if (!key) continue;
      if ([...coreNames].some(core => normalized(core) === key)) appearing.add(key);
    }
  }
  const required = (characters || []).filter(character => appearing.has(normalized(character.name)));
  const missingRecords = [...appearing].filter(key => !required.some(character => normalized(character.name) === key));
  return missingRecords.length === 0 && required.every(character => character.avatar_url && character.turnaround_url);
}

export function readProjectVideoWorkflow(settings) {
  const raw = settings?.video_generation?.workflow_id;
  return PROJECT_VIDEO_WORKFLOW_IDS.has(raw) ? raw : null;
}

export function shotVideoPreset(shot, speechLayout = null) {
  const measured = typeof speechLayout === 'number'
    ? speechLayout
    : Number(speechLayout?.duration) || 0;
  const effectiveDuration = Math.max(Number(shot?.duration) || 0, measured);
  return effectiveDuration > 5 ? 'standard_720p_8s' : 'standard_720p_5s';
}

export function resolveShotDrivingAudio(shot, mediaAssets = [], workflowId = 'minimax_h3_ref2va_official_12gb', preset = 'standard_720p_5s', speechLayout = null) {
  if (!shot?.dialogue?.trim() || !speechLayout) return {};
  const dialogueLines = new Set(
    String(shot.dialogue || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  );
  const files = speechLayout.files || [];
  const dialogueCues = (speechLayout.cues || []).filter(cue => {
    if (cue.type) return cue.type === 'dialogue';
    const fileEntry = files.find(file => file.block_id === cue.block_id);
    if (fileEntry?.type) return fileEntry.type === 'dialogue';
    return dialogueLines.has(String(cue.text || '').trim());
  });
  if (!dialogueCues.length) return {};
  const presetSeconds = String(preset || '').endsWith('_8s') ? 8 : 5;
  const startSec = Number(Number(dialogueCues[0].start).toFixed(2));
  const rawEndSec = Number(Number(dialogueCues[dialogueCues.length - 1].end).toFixed(2));
  const result = {};
  if (Number.isFinite(startSec) && startSec >= 0 && startSec <= presetSeconds - 0.25) {
    result.driving_audio_start_sec = startSec;
    const endSec = Number(Math.min(rawEndSec, presetSeconds).toFixed(2));
    if (Number.isFinite(endSec) && endSec > startSec && endSec <= 8) {
      result.driving_audio_end_sec = endSec;
    }
  }
  const supportsDrivingAudio = workflowId === 'minimax_h3_ref2va_official_12gb'
    || workflowId === 'minimax_h3_multiframe_official_12gb';
  if (supportsDrivingAudio && dialogueCues.length === 1) {
    const cue = dialogueCues[0];
    const fileEntry = files.find(file => file.block_id === cue.block_id);
    const matchingAsset = (mediaAssets || []).find(asset =>
      asset.role === 'script_speech' &&
      asset.status === 'ready' &&
      asset.id != null &&
      ((fileEntry?.asset_id != null && Number(asset.id) === Number(fileEntry.asset_id)) ||
        (fileEntry?.url && asset.url === fileEntry.url))
    );
    const assetId = matchingAsset?.id != null
      ? Number(matchingAsset.id)
      : (fileEntry?.asset_id != null ? Number(fileEntry.asset_id) : null);
    if (Number.isInteger(assetId) && assetId > 0) {
      result.driving_audio_asset_id = assetId;
    }
  }
  return result;
}

export function chooseShotVideoStrategy(assets, override = null, projectDefault = null, preset = 'standard_720p_5s') {
  const available = assets.filter(asset => asset.status === 'ready');
  const latest = role => available.filter(asset => asset.role === role).sort((a, b) => Number(b.id) - Number(a.id))[0];
  const guide = latest('guide_frame_reference') || latest('composition_reference');
  const last = latest('last_frame_reference');
  const character = latest('character_reference');
  const structural = guide
    ? 'minimax_h3_multiframe_official_12gb'
    : last
      ? (character ? 'minimax_h3_multiframe_official_12gb' : 'minimax_h3_fl2va_official_12gb')
      : null;
  const fallback = PROJECT_VIDEO_WORKFLOW_IDS.has(projectDefault) ? projectDefault : 'minimax_h3_ref2va_official_12gb';
  const selected = override || structural || fallback;
  const maxFrameIdx = String(preset || '').endsWith('_8s') ? 191 : 119;
  let guideFrameIdx;
  if (selected === 'minimax_h3_multiframe_official_12gb' && guide) {
    let proposed;
    try { proposed = JSON.parse(guide.metadata_json || '{}').guide_frame_idx; } catch {}
    if (!Number.isInteger(proposed) || proposed < 1 || proposed > maxFrameIdx) {
      throw new Error(`Guide frame asset ${guide.id} requires metadata_json.guide_frame_idx within delivery frames 1..${maxFrameIdx} (24fps).`);
    }
    guideFrameIdx = proposed;
  }
  return {
    workflow_id: selected,
    reason: override ? 'Explicit workflow override' : guide ? 'Guide frame requires Official Multi-Frame'
      : last && character ? 'Last-frame boundary with character reference requires Official Multi-Frame'
      : last ? 'Last-frame boundary requires Official FL2VA'
      : projectDefault && selected === projectDefault && projectDefault !== 'minimax_h3_ref2va_official_12gb'
        ? 'Project default video workflow'
        : 'Ordinary shot uses Official Ref2VA',
    ...(selected === 'minimax_h3_multiframe_official_12gb' && guide
      ? { guide_frames: [{ asset_id: guide.id, frame_idx: guideFrameIdx }] } : {}),
    ...(['minimax_h3_fl2va_official_12gb', 'minimax_h3_multiframe_official_12gb', 'minimax_h3_hongchao_a2a_12gb'].includes(selected) && last
      ? { last_frame_asset_id: last.id } : {}),
  };
}
