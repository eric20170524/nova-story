/**
 * Scene content + asset versioning for A/B testing generations.
 * Scene row always mirrors the active version (denormalized for existing readers).
 */
import { db } from '../db/database';

export const SCENE_VERSION_FIELDS = [
  'visual_prompt',
  'audio_prompt',
  'dialogue',
  'duration',
  'shot_type',
  'camera_movement',
  'camera_angle',
  'negative_prompt',
  'asset_status',
  'task_id',
  'asset_url'
] as const;

export type SceneVersionField = (typeof SCENE_VERSION_FIELDS)[number];

export interface SceneVersionRow {
  id: number;
  scene_id: number;
  version: number;
  label?: string | null;
  visual_prompt?: string | null;
  audio_prompt?: string | null;
  dialogue?: string | null;
  duration?: number | null;
  shot_type?: string | null;
  camera_movement?: string | null;
  camera_angle?: string | null;
  negative_prompt?: string | null;
  asset_status?: string | null;
  task_id?: string | null;
  asset_url?: string | null;
  created_at?: string;
}

const snapshotFromScene = (scene: any, version: number, label?: string | null) => ({
  scene_id: scene.id,
  version,
  label: label ?? `v${version}`,
  visual_prompt: scene.visual_prompt ?? null,
  audio_prompt: scene.audio_prompt ?? null,
  dialogue: scene.dialogue ?? null,
  duration: scene.duration ?? 3.0,
  shot_type: scene.shot_type ?? null,
  camera_movement: scene.camera_movement ?? null,
  camera_angle: scene.camera_angle ?? null,
  negative_prompt: scene.negative_prompt ?? null,
  asset_status: scene.asset_status || 'idle',
  task_id: scene.task_id ?? null,
  asset_url: scene.asset_url ?? null
});

export async function ensureSceneVersionBaseline(sceneId: number): Promise<void> {
  const scene = await db.get('SELECT * FROM scene WHERE id = ?', sceneId);
  if (!scene) return;

  const countRow = await db.get(
    'SELECT COUNT(*) AS n FROM scene_version WHERE scene_id = ?',
    sceneId
  );
  const n = Number((countRow as any)?.n || 0);
  if (n > 0) {
    if (scene.active_version == null) {
      await db.run('UPDATE scene SET active_version = 1 WHERE id = ?', sceneId);
    }
    return;
  }

  const snap = snapshotFromScene(scene, 1, 'v1');
  await db.run(
    `INSERT INTO scene_version (
      scene_id, version, label, visual_prompt, audio_prompt, dialogue, duration,
      shot_type, camera_movement, camera_angle, negative_prompt,
      asset_status, task_id, asset_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    snap.scene_id,
    snap.version,
    snap.label,
    snap.visual_prompt,
    snap.audio_prompt,
    snap.dialogue,
    snap.duration,
    snap.shot_type,
    snap.camera_movement,
    snap.camera_angle,
    snap.negative_prompt,
    snap.asset_status,
    snap.task_id,
    snap.asset_url
  );
  await db.run('UPDATE scene SET active_version = 1 WHERE id = ?', sceneId);
}

export async function listSceneVersions(sceneId: number): Promise<SceneVersionRow[]> {
  await ensureSceneVersionBaseline(sceneId);
  return (await db.all(
    'SELECT * FROM scene_version WHERE scene_id = ? ORDER BY version ASC',
    sceneId
  )) as SceneVersionRow[];
}

export async function getActiveVersionNumber(sceneId: number): Promise<number> {
  await ensureSceneVersionBaseline(sceneId);
  const scene = await db.get('SELECT active_version FROM scene WHERE id = ?', sceneId);
  return Number(scene?.active_version || 1);
}

/** Apply a version row onto the denormalized scene columns and set active_version */
export async function activateSceneVersion(
  sceneId: number,
  version: number
): Promise<any | null> {
  await ensureSceneVersionBaseline(sceneId);
  const ver = await db.get(
    'SELECT * FROM scene_version WHERE scene_id = ? AND version = ?',
    sceneId,
    version
  );
  if (!ver) return null;

  await db.run(
    `UPDATE scene SET
      active_version = ?,
      visual_prompt = ?,
      audio_prompt = ?,
      dialogue = ?,
      duration = ?,
      shot_type = ?,
      camera_movement = ?,
      camera_angle = ?,
      negative_prompt = ?,
      asset_status = ?,
      task_id = ?,
      asset_url = ?
    WHERE id = ?`,
    version,
    ver.visual_prompt,
    ver.audio_prompt,
    ver.dialogue,
    ver.duration ?? 3.0,
    ver.shot_type,
    ver.camera_movement,
    ver.camera_angle,
    ver.negative_prompt,
    ver.asset_status || 'idle',
    ver.task_id,
    ver.asset_url,
    sceneId
  );

  return db.get('SELECT * FROM scene WHERE id = ?', sceneId);
}

/** After editing scene text fields, mirror into the active version row */
export async function syncActiveVersionFromScene(sceneId: number): Promise<void> {
  await ensureSceneVersionBaseline(sceneId);
  const scene = await db.get('SELECT * FROM scene WHERE id = ?', sceneId);
  if (!scene) return;
  const active = Number(scene.active_version || 1);

  await db.run(
    `UPDATE scene_version SET
      visual_prompt = ?,
      audio_prompt = ?,
      dialogue = ?,
      duration = ?,
      shot_type = ?,
      camera_movement = ?,
      camera_angle = ?,
      negative_prompt = ?,
      asset_status = ?,
      task_id = ?,
      asset_url = ?
    WHERE scene_id = ? AND version = ?`,
    scene.visual_prompt,
    scene.audio_prompt,
    scene.dialogue,
    scene.duration ?? 3.0,
    scene.shot_type,
    scene.camera_movement,
    scene.camera_angle,
    scene.negative_prompt,
    scene.asset_status || 'idle',
    scene.task_id,
    scene.asset_url,
    sceneId,
    active
  );
}

/** Push asset status/url/task into active version (after generation) */
export async function syncActiveVersionAssets(
  sceneId: number,
  fields: { asset_status?: string; asset_url?: string | null; task_id?: string | null }
): Promise<void> {
  await ensureSceneVersionBaseline(sceneId);
  const scene = await db.get('SELECT active_version FROM scene WHERE id = ?', sceneId);
  if (!scene) return;
  const active = Number(scene.active_version || 1);

  const sets: string[] = [];
  const params: any[] = [];
  if (fields.asset_status !== undefined) {
    sets.push('asset_status = ?');
    params.push(fields.asset_status);
  }
  if (fields.asset_url !== undefined) {
    sets.push('asset_url = ?');
    params.push(fields.asset_url);
  }
  if (fields.task_id !== undefined) {
    sets.push('task_id = ?');
    params.push(fields.task_id);
  }
  if (!sets.length) return;
  params.push(sceneId, active);
  await db.run(
    `UPDATE scene_version SET ${sets.join(', ')} WHERE scene_id = ? AND version = ?`,
    ...params
  );
}

export async function createSceneVersion(
  sceneId: number,
  options: {
    /** Copy text+image from this version (default: active) */
    fromVersion?: number | null;
    /** Clear image fields for a fresh generation slot */
    clearAsset?: boolean;
    label?: string | null;
    /** Switch scene to the new version (default true) */
    activate?: boolean;
  } = {}
): Promise<{ scene: any; version: SceneVersionRow } | null> {
  await ensureSceneVersionBaseline(sceneId);
  const scene = await db.get('SELECT * FROM scene WHERE id = ?', sceneId);
  if (!scene) return null;

  const maxRow = await db.get(
    'SELECT MAX(version) AS m FROM scene_version WHERE scene_id = ?',
    sceneId
  );
  const nextVersion = Number((maxRow as any)?.m || 0) + 1;
  const fromVerNum = options.fromVersion ?? Number(scene.active_version || 1);
  const source =
    (await db.get(
      'SELECT * FROM scene_version WHERE scene_id = ? AND version = ?',
      sceneId,
      fromVerNum
    )) || snapshotFromScene(scene, fromVerNum);

  const clearAsset = options.clearAsset !== false; // default clear for A/B gen slots
  const label = options.label || `v${nextVersion}`;
  const shouldActivate = options.activate !== false;

  await db.run(
    `INSERT INTO scene_version (
      scene_id, version, label, visual_prompt, audio_prompt, dialogue, duration,
      shot_type, camera_movement, camera_angle, negative_prompt,
      asset_status, task_id, asset_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sceneId,
    nextVersion,
    label,
    source.visual_prompt,
    source.audio_prompt,
    source.dialogue,
    source.duration ?? 3.0,
    source.shot_type,
    source.camera_movement,
    source.camera_angle,
    source.negative_prompt,
    clearAsset ? 'idle' : source.asset_status || 'idle',
    clearAsset ? null : source.task_id ?? null,
    clearAsset ? null : source.asset_url ?? null
  );

  let resultScene = scene;
  if (shouldActivate) {
    resultScene = await activateSceneVersion(sceneId, nextVersion);
  }
  const versionRow = (await db.get(
    'SELECT * FROM scene_version WHERE scene_id = ? AND version = ?',
    sceneId,
    nextVersion
  )) as SceneVersionRow;

  return { scene: resultScene, version: versionRow };
}

export async function annotateSceneWithVersions(scene: any): Promise<any> {
  if (!scene?.id) return scene;
  await ensureSceneVersionBaseline(scene.id);
  const versions = await listSceneVersions(scene.id);
  const active = Number(scene.active_version || 1);
  return {
    ...scene,
    active_version: active,
    versions: versions.map((v) => ({
      version: v.version,
      label: v.label || `v${v.version}`,
      asset_status: v.asset_status,
      asset_url: v.asset_url,
      has_image: Boolean(v.asset_url),
      created_at: v.created_at
    }))
  };
}

export async function annotateScenesWithVersions(scenes: any[]): Promise<any[]> {
  return Promise.all(scenes.map((s) => annotateSceneWithVersions(s)));
}
