/**
 * Scene content + asset versioning for A/B testing generations.
 * Scene row always mirrors the active version (denormalized for existing readers).
 */
import { db } from '../db/database';

export const SCENE_VERSION_FIELDS = [
  'visual_prompt',
  'audio_prompt',
  'dialogue',
  'narration',
  'duration',
  'shot_type',
  'camera_movement',
  'camera_angle',
  'negative_prompt',
  'asset_status',
  'task_id',
  'asset_url',
  'english_visual_prompt'
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
  narration?: string | null;
  duration?: number | null;
  shot_type?: string | null;
  camera_movement?: string | null;
  camera_angle?: string | null;
  negative_prompt?: string | null;
  asset_status?: string | null;
  task_id?: string | null;
  asset_url?: string | null;
  english_visual_prompt?: string | null;
  continuity_status?: string;
  continuity_reason_json?: string | null;
  continuity_snapshot_id?: string | null;
  continuity_revision?: number | null;
  shot_spec?: string | null;
  created_at?: string;
}

function englishPromptFromScene(scene: any): string | null {
  try { return JSON.parse(scene.shot_spec || '{}').english_visual_prompt ?? null; }
  catch { return null; }
}

const snapshotFromScene = (scene: any, version: number, label?: string | null) => ({
  scene_id: scene.id,
  version,
  label: label ?? `v${version}`,
  visual_prompt: scene.visual_prompt ?? null,
  audio_prompt: scene.audio_prompt ?? null,
  dialogue: scene.dialogue ?? null,
  narration: scene.narration ?? null,
  duration: scene.duration ?? 3.0,
  shot_type: scene.shot_type ?? null,
  camera_movement: scene.camera_movement ?? null,
  camera_angle: scene.camera_angle ?? null,
  negative_prompt: scene.negative_prompt ?? null,
  asset_status: scene.asset_status || 'idle',
  task_id: scene.task_id ?? null,
  asset_url: scene.asset_url ?? null,
  english_visual_prompt: englishPromptFromScene(scene),
  continuity_status: scene.continuity_status || 'legacy',
  continuity_reason_json: scene.continuity_reason_json ?? null,
  continuity_snapshot_id: scene.continuity_snapshot_id ?? null,
  continuity_revision: scene.continuity_revision ?? null,
  shot_spec: scene.shot_spec ?? null,
});

async function copyContinuityMetadata(sceneId: number, version: number, source: any) {
  await db.run('UPDATE scene_version SET continuity_status=?,continuity_reason_json=?,continuity_snapshot_id=?,continuity_revision=?,shot_spec=? WHERE scene_id=? AND version=?',
    source.continuity_status || 'legacy', source.continuity_reason_json ?? null, source.continuity_snapshot_id ?? null, source.continuity_revision ?? null, source.shot_spec ?? null, sceneId, version);
}

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
      scene_id, version, label, visual_prompt, audio_prompt, dialogue, narration, duration,
      shot_type, camera_movement, camera_angle, negative_prompt,
      asset_status, task_id, asset_url, english_visual_prompt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    snap.scene_id,
    snap.version,
    snap.label,
    snap.visual_prompt,
    snap.audio_prompt,
    snap.dialogue,
    snap.narration,
    snap.duration,
    snap.shot_type,
    snap.camera_movement,
    snap.camera_angle,
    snap.negative_prompt,
    snap.asset_status,
    snap.task_id,
    snap.asset_url,
    snap.english_visual_prompt
  );
  await copyContinuityMetadata(sceneId, 1, snap);
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

  const dependency = await db.get(`SELECT d.*, l.revision AS current_revision FROM continuity_shot_dependency d LEFT JOIN continuity_ledger l ON l.script_id=d.script_id WHERE d.scene_id=? AND d.scene_version=?`, sceneId, version);
  if (dependency && (dependency.status !== 'current' || dependency.ledger_revision !== dependency.current_revision || !ver.shot_spec)) {
    ver.continuity_status = dependency.status === 'conflict' ? 'conflict' : 'stale';
    ver.continuity_reason_json = dependency.reason_json || JSON.stringify({ code: 'CONTINUITY_STALE', old_revision: dependency.ledger_revision, new_revision: dependency.current_revision });
    await copyContinuityMetadata(sceneId, version, ver);
  }

  const current = await db.get('SELECT shot_spec FROM scene WHERE id = ?', sceneId);
  const spec = JSON.parse(ver.shot_spec || current?.shot_spec || '{}');
  delete spec.english_visual_prompt;
  if (ver.english_visual_prompt) spec.english_visual_prompt = ver.english_visual_prompt;

  await db.run(
    `UPDATE scene SET
      active_version = ?,
      visual_prompt = ?,
      audio_prompt = ?,
      dialogue = ?,
      narration = ?,
      duration = ?,
      shot_type = ?,
      camera_movement = ?,
      camera_angle = ?,
      negative_prompt = ?,
      asset_status = ?,
      task_id = ?,
      asset_url = ?,
      shot_spec = ?
    WHERE id = ?`,
    version,
    ver.visual_prompt,
    ver.audio_prompt,
    ver.dialogue,
    ver.narration,
    ver.duration ?? 3.0,
    ver.shot_type,
    ver.camera_movement,
    ver.camera_angle,
    ver.negative_prompt,
    ver.asset_status || 'idle',
    ver.task_id,
    ver.asset_url,
    JSON.stringify(spec),
    sceneId
  );
  await db.run('UPDATE scene SET continuity_status=?,continuity_reason_json=?,continuity_snapshot_id=?,continuity_revision=? WHERE id=?',
    ver.continuity_status || 'legacy', ver.continuity_reason_json ?? null, ver.continuity_snapshot_id ?? null, ver.continuity_revision ?? null, sceneId);

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
      narration = ?,
      duration = ?,
      shot_type = ?,
      camera_movement = ?,
      camera_angle = ?,
      negative_prompt = ?,
      asset_status = ?,
      task_id = ?,
      asset_url = ?,
      english_visual_prompt = ?
    WHERE scene_id = ? AND version = ?`,
    scene.visual_prompt,
    scene.audio_prompt,
    scene.dialogue,
    scene.narration,
    scene.duration ?? 3.0,
    scene.shot_type,
    scene.camera_movement,
    scene.camera_angle,
    scene.negative_prompt,
    scene.asset_status || 'idle',
    scene.task_id,
    scene.asset_url,
    englishPromptFromScene(scene),
    sceneId,
    active
  );
  await copyContinuityMetadata(sceneId, active, scene);
}

/** Push asset status/url/task into active version (after generation) */
export async function syncActiveVersionAssets(
  sceneId: number,
  fields: { asset_status?: string; asset_url?: string | null; task_id?: string | null; english_visual_prompt?: string | null },
  version?: number,
): Promise<void> {
  await ensureSceneVersionBaseline(sceneId);
  const scene = await db.get('SELECT active_version FROM scene WHERE id = ?', sceneId);
  if (!scene) return;
  const active = version ?? Number(scene.active_version || 1);

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
  if (fields.english_visual_prompt !== undefined) {
    sets.push('english_visual_prompt = ?');
    params.push(fields.english_visual_prompt);
  }
  if (!sets.length) return;
  params.push(sceneId, active);
  await db.run(
    `UPDATE scene_version SET ${sets.join(', ')} WHERE scene_id = ? AND version = ?`,
    ...params
  );
  if (version !== undefined) {
    const sceneSets = sets.map(set => set === 'english_visual_prompt = ?'
      ? "shot_spec = json_set(COALESCE(shot_spec, '{}'), '$.english_visual_prompt', ?)"
      : set);
    await db.run(`UPDATE scene SET ${sceneSets.join(', ')} WHERE id = ? AND COALESCE(active_version, 1) = ?`, ...params);
  }
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
      scene_id, version, label, visual_prompt, audio_prompt, dialogue, narration, duration,
      shot_type, camera_movement, camera_angle, negative_prompt,
      asset_status, task_id, asset_url, english_visual_prompt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sceneId,
    nextVersion,
    label,
    source.visual_prompt,
    source.audio_prompt,
    source.dialogue,
    source.narration,
    source.duration ?? 3.0,
    source.shot_type,
    source.camera_movement,
    source.camera_angle,
    source.negative_prompt,
    clearAsset ? 'idle' : source.asset_status || 'idle',
    clearAsset ? null : source.task_id ?? null,
    clearAsset ? null : source.asset_url ?? null,
    clearAsset ? null : source.english_visual_prompt ?? null
  );
  await copyContinuityMetadata(sceneId, nextVersion, source);
  await db.run(`INSERT INTO continuity_shot_dependency(scene_id,scene_version,script_id,script_scene_id,snapshot_id,ledger_revision,moment_id,phase,reads_json,dependency_hash,source_hash,status,reason_json)
    SELECT scene_id,?,script_id,script_scene_id,snapshot_id,ledger_revision,moment_id,phase,reads_json,dependency_hash,source_hash,status,reason_json FROM continuity_shot_dependency WHERE scene_id=? AND scene_version=?`, nextVersion, sceneId, fromVerNum);

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
    versions: versions.map((v) => {
      let referenceHash: string | null = null;
      try {
        const spec = JSON.parse(v.shot_spec || '{}');
        referenceHash = spec?.formal_request?.reference_hash || null;
      } catch { /* Older versions have no formal request. */ }
      return {
        version: v.version,
        label: v.label || `v${v.version}`,
        asset_status: v.asset_status,
        asset_url: v.asset_url,
        has_image: Boolean(v.asset_url),
        formal_stage: v.label === 'formal-candidate' ? 'production' : 'draft',
        reference_hash: referenceHash,
        continuity_status: v.continuity_status || 'legacy',
        continuity_reason_json: v.continuity_reason_json,
        created_at: v.created_at
      };
    })
  };
}

export async function annotateScenesWithVersions(scenes: any[]): Promise<any[]> {
  return Promise.all(scenes.map((s) => annotateSceneWithVersions(s)));
}
