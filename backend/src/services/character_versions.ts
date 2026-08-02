/**
 * Character description + visual asset versioning (A/B test looks & tags).
 * Character row always mirrors the active version.
 */
import { db } from '../db/database';

export interface CharacterVersionRow {
  id: number;
  character_id: number;
  version: number;
  label?: string | null;
  description?: string | null;
  visual_tags?: string | null;
  created_at?: string;
}

const tagsToString = (tags: unknown): string => {
  if (typeof tags === 'string') return tags || '{}';
  try {
    return JSON.stringify(tags || {});
  } catch {
    return '{}';
  }
};

const parseTags = (raw: unknown): any => {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
};

const assetSummary = (visualTagsRaw: unknown) => {
  const tags = parseTags(visualTagsRaw);
  const assets = tags.assets || {};
  return {
    avatar_url: assets.avatar_url || tags.avatar_url || null,
    turnaround_url: assets.turnaround_url || tags.turnaround_url || null,
    face_url: assets.face_url || tags.face_url || null,
    has_avatar: Boolean(assets.avatar_url || tags.avatar_url),
    has_turnaround: Boolean(assets.turnaround_url || tags.turnaround_url),
    model_type: tags.model_type || assets.model_type || 'pony'
  };
};

export async function ensureCharacterVersionBaseline(characterId: number): Promise<void> {
  const char = await db.get('SELECT * FROM character WHERE id = ?', characterId);
  if (!char) return;

  const countRow = await db.get(
    'SELECT COUNT(*) AS n FROM character_version WHERE character_id = ?',
    characterId
  );
  if (Number((countRow as any)?.n || 0) > 0) {
    if (char.active_version == null) {
      await db.run('UPDATE character SET active_version = 1 WHERE id = ?', characterId);
    }
    return;
  }

  await db.run(
    `INSERT INTO character_version (character_id, version, label, description, visual_tags)
     VALUES (?, 1, 'v1', ?, ?)`,
    characterId,
    char.description ?? null,
    tagsToString(char.visual_tags)
  );
  await db.run('UPDATE character SET active_version = 1 WHERE id = ?', characterId);
}

export async function listCharacterVersions(characterId: number): Promise<CharacterVersionRow[]> {
  await ensureCharacterVersionBaseline(characterId);
  return (await db.all(
    'SELECT * FROM character_version WHERE character_id = ? ORDER BY version ASC',
    characterId
  )) as CharacterVersionRow[];
}

export async function activateCharacterVersion(
  characterId: number,
  version: number
): Promise<any | null> {
  await ensureCharacterVersionBaseline(characterId);
  const ver = await db.get(
    'SELECT * FROM character_version WHERE character_id = ? AND version = ?',
    characterId,
    version
  );
  if (!ver) return null;

  await db.run(
    `UPDATE character SET
      active_version = ?,
      description = ?,
      visual_tags = ?
    WHERE id = ?`,
    version,
    ver.description,
    ver.visual_tags,
    characterId
  );

  return db.get('SELECT * FROM character WHERE id = ?', characterId);
}

/** Mirror character row into active version after edits / asset uploads */
export async function syncActiveCharacterVersion(characterId: number): Promise<void> {
  await ensureCharacterVersionBaseline(characterId);
  const char = await db.get('SELECT * FROM character WHERE id = ?', characterId);
  if (!char) return;
  const active = Number(char.active_version || 1);

  await db.run(
    `UPDATE character_version SET description = ?, visual_tags = ?
     WHERE character_id = ? AND version = ?`,
    char.description,
    tagsToString(char.visual_tags),
    characterId,
    active
  );
}

export async function createCharacterVersion(
  characterId: number,
  options: {
    fromVersion?: number | null;
    /** Clear avatar/turnaround/face for a fresh look */
    clearAssets?: boolean;
    label?: string | null;
    activate?: boolean;
  } = {}
): Promise<{ character: any; version: CharacterVersionRow } | null> {
  await ensureCharacterVersionBaseline(characterId);
  const char = await db.get('SELECT * FROM character WHERE id = ?', characterId);
  if (!char) return null;

  const maxRow = await db.get(
    'SELECT MAX(version) AS m FROM character_version WHERE character_id = ?',
    characterId
  );
  const nextVersion = Number((maxRow as any)?.m || 0) + 1;
  const fromVerNum = options.fromVersion ?? Number(char.active_version || 1);
  const source =
    (await db.get(
      'SELECT * FROM character_version WHERE character_id = ? AND version = ?',
      characterId,
      fromVerNum
    )) || {
      description: char.description,
      visual_tags: tagsToString(char.visual_tags)
    };

  let visualTags = parseTags(source.visual_tags);
  const clearAssets = options.clearAssets !== false;
  if (clearAssets) {
    visualTags = {
      ...visualTags,
      assets: {
        ...(visualTags.assets || {}),
        avatar_url: null,
        turnaround_url: null,
        face_url: null
      }
    };
  }

  const label = options.label || `v${nextVersion}`;
  await db.run(
    `INSERT INTO character_version (character_id, version, label, description, visual_tags)
     VALUES (?, ?, ?, ?, ?)`,
    characterId,
    nextVersion,
    label,
    source.description ?? char.description ?? null,
    tagsToString(visualTags)
  );

  let resultChar = char;
  if (options.activate !== false) {
    resultChar = await activateCharacterVersion(characterId, nextVersion);
  }

  const versionRow = (await db.get(
    'SELECT * FROM character_version WHERE character_id = ? AND version = ?',
    characterId,
    nextVersion
  )) as CharacterVersionRow;

  return { character: resultChar, version: versionRow };
}

export async function annotateCharacterWithVersions(
  char: any,
  serialize: (row: any) => any
): Promise<any> {
  if (!char?.id) return serialize(char);
  await ensureCharacterVersionBaseline(char.id);
  const versions = await listCharacterVersions(char.id);
  const active = Number(char.active_version || 1);
  const base = serialize(char);
  return {
    ...base,
    active_version: active,
    versions: versions.map((v) => {
      const summary = assetSummary(v.visual_tags);
      return {
        version: v.version,
        label: v.label || `v${v.version}`,
        description: v.description,
        created_at: v.created_at,
        ...summary
      };
    })
  };
}

export async function annotateCharactersWithVersions(
  chars: any[],
  serialize: (row: any) => any
): Promise<any[]> {
  return Promise.all(chars.map((c) => annotateCharacterWithVersions(c, serialize)));
}
