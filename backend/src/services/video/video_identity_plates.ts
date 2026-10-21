/**
 * H3 identity references are the pinned character version's face and body plates.
 * The stitched sheet and a newer unpinned portrait are not substitutes.
 */
export type IdentityPlates = { face: string | null; body: string | null };

export type IdentityReferenceAsset = {
  url?: string | null;
  metadata_json?: string | null;
};

const parseTags = (tags: unknown): Record<string, any> => {
  if (typeof tags === 'string') {
    try {
      return JSON.parse(tags || '{}');
    } catch {
      return {};
    }
  }
  return tags && typeof tags === 'object' ? tags as Record<string, any> : {};
};

export function platesFromVisualTags(tags: unknown): IdentityPlates {
  const parsed = parseTags(tags);
  const assets = parsed.assets && typeof parsed.assets === 'object' ? parsed.assets : {};
  const face = String(assets.avatar_url || parsed.avatar_url || '').trim() || null;
  const body = String(assets.turnaround_front_url || parsed.turnaround_front_url || '').trim() || null;
  return { face, body };
}

/** Empty when the character has no face or body plate. Otherwise one Chinese blocker. */
export function identityReferenceBlockers(
  version: number | null,
  plates: IdentityPlates,
  assets: IdentityReferenceAsset[],
): string[] {
  const face = plates.face;
  const body = plates.body;
  if (!face && !body) return [];
  const allowed = new Set([face, body].filter((url): url is string => Boolean(url)));
  const seen = new Set<string>();
  let rejected = false;
  for (const asset of assets) {
    const url = String(asset.url || '').trim();
    let slot = '';
    if (asset.metadata_json) {
      try {
        slot = String(JSON.parse(asset.metadata_json)?.source_slot || '');
      } catch {
        slot = '';
      }
    }
    if (!url || !allowed.has(url)) {
      rejected = true;
      continue;
    }
    if (slot && slot !== 'face' && slot !== 'body') {
      rejected = true;
      continue;
    }
    if (slot === 'face' && url !== face) rejected = true;
    if (slot === 'body' && url !== body) rejected = true;
    if (!rejected) seen.add(url);
  }
  if ((face && !seen.has(face)) || (body && !seen.has(body))) rejected = true;
  if (!rejected) return [];
  return [`视频人物参考必须是角色版本 v${version ?? ''} 的定妆和正面单人图。`];
}
