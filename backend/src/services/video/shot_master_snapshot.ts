import { db } from '../../db/database';

type CharacterVersion = { id: number; version: number };
const normalizeName = (value: unknown) => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');

const visibleCharacterIds = (rawShotSpec: unknown, characters: Array<{ id: number; name: string }>): number[] => {
  let spec: any;
  try { spec = typeof rawShotSpec === 'string' ? JSON.parse(rawShotSpec || '{}') : rawShotSpec || {}; }
  catch { spec = {}; }
  const names = [spec.primary_subject, ...(Array.isArray(spec.visible_subjects) ? spec.visible_subjects : [])];
  const ids = new Set<number>();
  for (const name of names) {
    const normalized = normalizeName(name);
    if (!normalized) continue;
    const match = characters.find(character => normalizeName(character.name) === normalized);
    if (match) ids.add(Number(match.id));
  }
  return [...ids];
};

export async function getShotVisibleCharacterIds(sceneId: number, projectId: number): Promise<number[]> {
  const scene = await db.get('SELECT s.shot_spec FROM scene s JOIN chapter c ON c.id = s.chapter_id WHERE s.id = ? AND c.project_id = ?', sceneId, projectId);
  if (!scene) return [];
  const characters = await db.all('SELECT id, name FROM character WHERE project_id = ?', projectId);
  return visibleCharacterIds(scene.shot_spec, characters);
}

export type ShotMasterInputSnapshot = {
  references: Array<{ id: number; revision: number }>;
  versions: CharacterVersion[];
};

const bindingPairs = (items: Array<{ id: number; revision?: number; version?: number }>, field: 'revision' | 'version') =>
  items.map(item => [Number(item.id), Number(item[field] || 1)] as const).sort((a, b) => a[0] - b[0]);

export const shotMasterInputsMatch = (left: ShotMasterInputSnapshot, right: ShotMasterInputSnapshot) =>
  JSON.stringify(bindingPairs(left.references, 'revision')) === JSON.stringify(bindingPairs(right.references, 'revision'))
  && JSON.stringify(bindingPairs(left.versions, 'version')) === JSON.stringify(bindingPairs(right.versions, 'version'));

/** Versions and asset revisions that will be baked into a Shot Master. Call this before the generation wait. */
export async function captureShotMasterSnapshot(options: {
  sceneId: number;
  projectId: number;
  characterIds?: number[];
}): Promise<ShotMasterInputSnapshot> {
  const owner = await db.get('SELECT c.project_id, s.shot_spec FROM scene s JOIN chapter c ON c.id = s.chapter_id WHERE s.id = ?', options.sceneId);
  if (Number(owner?.project_id) !== options.projectId) throw new Error('Shot Master scene does not belong to the project');
  const refs = await db.all('SELECT asset_id AS id, asset_revision AS revision FROM scene_asset_reference WHERE scene_id = ? ORDER BY asset_id', options.sceneId);
  const characters = await db.all('SELECT id, name, active_version FROM character WHERE project_id = ? ORDER BY id', options.projectId);
  const requiredIds = new Set([...(options.characterIds || []), ...visibleCharacterIds(owner.shot_spec, characters)]);
  const selected = options.characterIds == null
    ? characters
    : characters.filter(character => requiredIds.has(Number(character.id)));
  if (options.characterIds != null && selected.length !== requiredIds.size) {
    throw new Error('Shot Master character binding contains an unknown project character');
  }
  return {
    references: refs.map((ref: { id: number; revision: number }) => ({ id: Number(ref.id), revision: Number(ref.revision) })),
    versions: selected.map((character: { id: number; active_version?: number }) => ({ id: Number(character.id), version: Number(character.active_version || 1) })),
  };
}

/** Record the location/prop and character state represented by a new Shot Master. */
export async function recordShotMasterSnapshot(options: {
  sceneId: number;
  projectId: number;
  imageUrl: string;
  characterIds?: number[];
  /** Inputs captured when generation started. Completion must not substitute the live database state. */
  captured?: ShotMasterInputSnapshot;
}): Promise<{ drifted: boolean }> {
  const owner = await db.get('SELECT c.project_id FROM scene s JOIN chapter c ON c.id = s.chapter_id WHERE s.id = ?', options.sceneId);
  if (Number(owner?.project_id) !== options.projectId) throw new Error('Shot Master scene does not belong to the project');
  const captured = options.captured ?? await captureShotMasterSnapshot(options);
  let drifted = false;
  if (options.captured) {
    try {
      const current = await captureShotMasterSnapshot(options);
      drifted = !shotMasterInputsMatch(options.captured, current);
    } catch {
      drifted = true;
    }
  }
  await db.run(
    `INSERT OR REPLACE INTO scene_asset_image_snapshot
     (scene_id, image_url, references_json, character_versions_json) VALUES (?, ?, ?, ?)`,
    options.sceneId, options.imageUrl, JSON.stringify(captured.references), JSON.stringify(captured.versions)
  );
  return { drifted };
}

export async function validateShotMasterCharacters(options: {
  sceneId: number;
  projectId: number;
  imageUrl: string;
  requiredCharacterIds: number[];
}): Promise<string[]> {
  const snapshot = await db.get(
    'SELECT character_versions_json FROM scene_asset_image_snapshot WHERE scene_id = ? AND image_url = ?',
    options.sceneId, options.imageUrl
  );
  if (!snapshot?.character_versions_json) {
    const currentCharacters = await db.get('SELECT COUNT(*) AS count FROM character WHERE project_id = ?', options.projectId);
    return options.requiredCharacterIds.length || Number(currentCharacters?.count || 0) > 0
      ? ['Shot Master has no character-version snapshot; regenerate or upload the keyframe before video generation.']
      : [];
  }
  let versions: CharacterVersion[];
  try { versions = JSON.parse(snapshot.character_versions_json); }
  catch { return ['Shot Master character-version snapshot is invalid; regenerate the keyframe.']; }
  const current = await db.all('SELECT id, active_version FROM character WHERE project_id = ?', options.projectId);
  const byId = new Map(current.map(character => [Number(character.id), Number(character.active_version || 1)]));
  const captured = new Map(versions.map(character => [character.id, character.version]));
  const blockers: string[] = [];
  for (const version of versions) {
    if (byId.get(version.id) !== version.version) blockers.push(`Character ${version.id} version changed after Shot Master generation; regenerate the keyframe.`);
  }
  for (const id of options.requiredCharacterIds) {
    if (!captured.has(id)) blockers.push(`Character ${id} is absent from the Shot Master; regenerate the keyframe with this character.`);
  }
  return blockers;
}
