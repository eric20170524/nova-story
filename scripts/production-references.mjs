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
  if (!required.length && !bound.length) blockers.push('No reusable location or prop is specified or explicitly bound');
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
    const match = characters.find(character => normalized(character.name) === normalized(name));
    if (match?.avatar_url && !selected.some(character => character.id === match.id)) selected.push(match);
    if (selected.length >= limit) break;
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
