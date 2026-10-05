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
    if (exact.length === 1) {
      selected.push(exact[0].id);
      if (bound.length && !bound.some(asset => asset.id === exact[0].id)) blockers.push(`Missing ${item.kind} binding: ${item.name}`);
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

export function readProjectVideoWorkflow(settings) {
  const raw = settings?.video_generation?.workflow_id;
  return PROJECT_VIDEO_WORKFLOW_IDS.has(raw) ? raw : null;
}

export function chooseShotVideoStrategy(assets, override = null, projectDefault = null) {
  const available = assets.filter(asset => asset.status === 'ready');
  const latest = role => available.filter(asset => asset.role === role).sort((a, b) => Number(b.id) - Number(a.id))[0];
  const guide = latest('guide_frame_reference') || latest('composition_reference');
  const last = latest('last_frame_reference');
  const structural = guide
    ? 'minimax_h3_multiframe_official_12gb'
    : last ? 'minimax_h3_fl2va_official_12gb' : null;
  const fallback = PROJECT_VIDEO_WORKFLOW_IDS.has(projectDefault) ? projectDefault : 'minimax_h3_ref2va_official_12gb';
  const selected = override || structural || fallback;
  let guideFrameIdx;
  if (selected === 'minimax_h3_multiframe_official_12gb' && guide) {
    let proposed;
    try { proposed = JSON.parse(guide.metadata_json || '{}').guide_frame_idx; } catch {}
    if (!Number.isInteger(proposed) || proposed < 1 || proposed > 119) {
      throw new Error(`Guide frame asset ${guide.id} requires metadata_json.guide_frame_idx within delivery frames 1..119 (24fps).`);
    }
    guideFrameIdx = proposed;
  }
  return {
    workflow_id: selected,
    reason: override ? 'Explicit workflow override' : guide ? 'Guide frame requires Official Multi-Frame'
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
