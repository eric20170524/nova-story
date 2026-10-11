/**
 * Track 8 FS02. Draft generation skips the continuity gate. A formal request
 * keeps that gate, then stores the image on an inactive scene version until
 * an explicit six-check adoption.
 */

import { db, withImmediateTransaction } from '../db/database';
import { hashCanonical } from '../schemas/story_plan';
import { ContinuityStoreError } from './continuity_store';
import { continuityHash } from './continuity_replay';
import { requireCurrentContinuityShot } from './continuity_shot_gate';
import { requireFormalPinStillCurrent, requireProductionReferencePin, type ProductionReferencePin } from './scene_production_media';
import { createSceneVersion, ensureSceneVersionBaseline, activateSceneVersion } from './scene_versions';
import { recordShotMasterSnapshot } from './video/shot_master_snapshot';
import { assembleFormalReferences } from './formal_storyboard_plan';

export interface FormalCandidateMarker {
  publish: false;
  production_stage: 'draft' | 'production';
  scene_version: number;
  source_version: number;
  reference_hash: string;
}

export interface FormalRequestRecord {
  production_stage: 'draft' | 'production';
  source_version: number;
  reference_hash: string;
  model_fingerprint: { model: string | null; style: string | null };
  request_snapshot: { mode: string; generation_params: unknown; production_stage: 'draft' | 'production' };
  control_branch: string;
  unused_reasons: string[];
}

const fail = (code: string, message: string, statusCode: 404 | 409 | 422 = 409): never => {
  throw new ContinuityStoreError(code, message, statusCode);
};

const readSpec = (raw: unknown): Record<string, any> => {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export async function sceneHasInflightImage(sceneId: number): Promise<boolean> {
  const row = await db.get(
    "SELECT 1 AS ok FROM generation_task WHERE scene_id = ? AND status IN ('queued', 'processing')",
    sceneId
  );
  return Boolean(row);
}

async function rememberCandidate(sceneId: number, version: number, record: FormalRequestRecord, pin: ProductionReferencePin | null) {
  const versionRow = await db.get('SELECT shot_spec FROM scene_version WHERE scene_id = ? AND version = ?', sceneId, version);
  const spec = readSpec(versionRow?.shot_spec);
  spec.formal_request = record;
  await db.run('UPDATE scene_version SET shot_spec = ? WHERE scene_id = ? AND version = ?', JSON.stringify(spec), sceneId, version);
  const referenceJson = pin
    ? JSON.stringify(pin)
    : JSON.stringify({ version: 'formal-draft', reference_hash: record.reference_hash, source_version: record.source_version });
  await db.run(
    `INSERT INTO scene_production_frame(scene_id, scene_version, round, reference_versions_json)
     VALUES(?, ?, 'formal', ?)
     ON CONFLICT(scene_id, scene_version) DO UPDATE SET reference_versions_json = excluded.reference_versions_json`,
    sceneId,
    version,
    referenceJson
  );
}

/** Existing image, or an explicit new version, becomes an inactive draft. The active URL stays. */
export async function beginDraftImage(sceneId: number, taskId: string, input: {
  asNewVersion: boolean;
  mode: string;
  generationParams: unknown;
  model: string | null;
  style: string | null;
}): Promise<FormalCandidateMarker | null> {
  if (await sceneHasInflightImage(sceneId)) fail('CONTINUITY_REVISION_CONFLICT', 'This shot is already queued');
  await ensureSceneVersionBaseline(sceneId);
  const scene = await db.get('SELECT * FROM scene WHERE id = ?', sceneId);
  if (!scene) fail('CONTINUITY_SCOPE_INVALID', 'Scene not found');
  const sourceVersion = Number(scene.active_version || 1);
  const fork = Boolean(scene.asset_url) || input.asNewVersion;
  if (!fork) {
    await db.run('UPDATE scene SET asset_status = ?, task_id = ? WHERE id = ?', 'generating', taskId, sceneId);
    await db.run(
      'UPDATE scene_version SET asset_status = ?, task_id = ? WHERE scene_id = ? AND version = ?',
      'generating', taskId, sceneId, sourceVersion
    );
    return null;
  }
  const created = await createSceneVersion(sceneId, { clearAsset: true, activate: false, label: 'draft' });
  if (!created) fail('CONTINUITY_SCOPE_INVALID', 'Could not store a draft version');
  const version = Number(created!.version.version);
  await db.run(
    'UPDATE scene_version SET asset_status = ?, task_id = ? WHERE scene_id = ? AND version = ?',
    'generating', taskId, sceneId, version
  );
  const referenceHash = hashCanonical({
    production_stage: 'draft',
    scene_id: sceneId,
    source_version: sourceVersion,
    mode: input.mode,
    model: input.model,
    style: input.style,
  });
  await rememberCandidate(sceneId, version, {
    production_stage: 'draft',
    source_version: sourceVersion,
    reference_hash: referenceHash,
    model_fingerprint: { model: input.model, style: input.style },
    request_snapshot: { mode: input.mode, generation_params: input.generationParams ?? null, production_stage: 'draft' },
    control_branch: 'draft_text',
    unused_reasons: [],
  }, null);
  return { publish: false, production_stage: 'draft', scene_version: version, source_version: sourceVersion, reference_hash: referenceHash };
}

/** Formal generation validates the current pin, then writes an inactive candidate. */
export async function beginFormalImage(sceneId: number, taskId: string, input: {
  guard: unknown;
  mode: string;
  generationParams: unknown;
  model: string | null;
  style: string | null;
}): Promise<{ marker: FormalCandidateMarker; pin: ProductionReferencePin }> {
  if (await sceneHasInflightImage(sceneId)) fail('CONTINUITY_REVISION_CONFLICT', 'This shot is already queued');
  const scene = await db.get('SELECT * FROM scene WHERE id = ?', sceneId);
  if (!scene) fail('CONTINUITY_SCOPE_INVALID', 'Scene not found');
  const source = readSpec(scene.shot_spec).source;
  if (!source?.script_scene_id) fail('CONTINUITY_ENTRY_REQUIRED', 'Confirm this shot’s entry state and story moment before a formal storyboard');
  await requireCurrentContinuityShot(scene);
  if (input.guard == null) fail('CONTINUITY_REFERENCE_REVIEW_REQUIRED', 'Bind references before generating a formal storyboard');
  const guarded = input.guard as { expected_version?: number; reference_hash?: string };
  const { pin } = await requireProductionReferencePin(scene, {
    expected_version: Number(guarded.expected_version),
    reference_hash: String(guarded.reference_hash || ''),
  });
  const project = await db.get('SELECT c.project_id FROM scene s JOIN chapter c ON c.id = s.chapter_id WHERE s.id = ?', sceneId);
  const spec = readSpec(scene.shot_spec);
  const names = Array.isArray(spec.visible_subjects) ? spec.visible_subjects.map(String) : [];
  const characters = names.length
    ? await db.all('SELECT c.id, c.name, c.project_id, v.visual_tags FROM character c LEFT JOIN character_version v ON v.character_id = c.id AND v.version = COALESCE(c.active_version, 1) WHERE c.project_id = ?', project?.project_id)
    : [];
  const assembly = assembleFormalReferences({
    projectId: Number(project?.project_id),
    visibleNames: names,
    characters,
    locationName: spec.location || null,
    clientWorkflow: {},
  });
  if (!assembly.ok) fail('CONTINUITY_SCOPE_INVALID', `Formal reference assembly failed: ${assembly.code} ${assembly.detail}`);
  const sourceVersion = Number(scene.active_version || 1);
  const created = await createSceneVersion(sceneId, { clearAsset: true, activate: false, label: 'formal-candidate' });
  if (!created) fail('CONTINUITY_SCOPE_INVALID', 'Could not store a formal candidate');
  const version = Number(created!.version.version);
  const candidatePin: ProductionReferencePin = { ...pin, scene_version: version };
  await db.run(
    'UPDATE scene_version SET asset_status = ?, task_id = ? WHERE scene_id = ? AND version = ?',
    'generating', taskId, sceneId, version
  );
  const referenceHash = continuityHash(pin);
  await rememberCandidate(sceneId, version, {
    production_stage: 'production',
    source_version: sourceVersion,
    reference_hash: referenceHash,
    model_fingerprint: { model: input.model, style: input.style },
    request_snapshot: { mode: input.mode, generation_params: input.generationParams ?? null, production_stage: 'production' },
    control_branch: 'continuity_pin',
    unused_reasons: ['formal_combination_not_live_verified', ...(!assembly.ok ? [] : assembly.unused)],
  }, candidatePin);
  return {
    marker: { publish: false, production_stage: 'production', scene_version: version, source_version: sourceVersion, reference_hash: referenceHash },
    pin: candidatePin,
  };
}

/** Write a finished or failed candidate without touching the active scene row. */
export async function persistFormalCandidateResult(sceneId: number, version: number, taskId: string, patch: {
  asset_status: string;
  asset_url?: string | null;
  english_visual_prompt?: string | null;
}) {
  const sets = ['asset_status = ?', 'task_id = ?'];
  const params: unknown[] = [patch.asset_status, taskId];
  if (patch.asset_url !== undefined) {
    sets.push('asset_url = ?');
    params.push(patch.asset_url);
  }
  if (patch.english_visual_prompt !== undefined) {
    sets.push('english_visual_prompt = ?');
    params.push(patch.english_visual_prompt);
  }
  params.push(sceneId, version);
  await db.run(`UPDATE scene_version SET ${sets.join(', ')} WHERE scene_id = ? AND version = ?`, ...params);
}

const checksSchema = ['wardrobe', 'damage', 'count', 'holder', 'openings', 'space'] as const;

const pinFromFrame = (raw: unknown): ProductionReferencePin | null => {
  try {
    const pin = JSON.parse(String(raw || 'null'));
    return pin?.version === 1 ? pin : null;
  } catch {
    return null;
  }
};

/** Copy a current live dependency onto the candidate. A stale row is left unchanged. */
async function refreshCandidateDependency(sceneId: number, candidateVersion: number): Promise<boolean> {
  const scene = await db.get('SELECT active_version FROM scene WHERE id = ?', sceneId);
  const activeVersion = Number(scene?.active_version || 1);
  if (activeVersion === candidateVersion) return true;
  const active = await db.get(`SELECT d.*, l.revision AS current_revision FROM continuity_shot_dependency d LEFT JOIN continuity_ledger l ON l.script_id = d.script_id WHERE d.scene_id = ? AND d.scene_version = ?`, sceneId, activeVersion);
  const candidate = await db.get('SELECT 1 AS ok FROM continuity_shot_dependency WHERE scene_id = ? AND scene_version = ?', sceneId, candidateVersion);
  if (!active || !candidate) return false;
  const revisionMatches = active.current_revision == null || Number(active.ledger_revision) === Number(active.current_revision);
  if (active.status !== 'current' || !revisionMatches) return false;
  await db.run(
    `UPDATE continuity_shot_dependency SET status = ?, reason_json = NULL, snapshot_id = ?, ledger_revision = ?, source_hash = ?, dependency_hash = ?, moment_id = ?, phase = ?, reads_json = ? WHERE scene_id = ? AND scene_version = ?`,
    active.status, active.snapshot_id, active.ledger_revision, active.source_hash, active.dependency_hash, active.moment_id, active.phase, active.reads_json, sceneId, candidateVersion,
  );
  await db.run(
    `UPDATE scene_version SET continuity_status = 'current', continuity_reason_json = NULL, continuity_snapshot_id = ?, continuity_revision = ? WHERE scene_id = ? AND version = ?`,
    active.snapshot_id, active.ledger_revision, sceneId, candidateVersion,
  );
  return true;
}

/** Keep an unverified picture prompt on its own version. Blocking does not change the active scene. */
export async function retainUnverifiedPrompt(sceneId: number, version: number, prompt: string, issues: string[], taskId: string, block: boolean) {
  const row = await db.get('SELECT shot_spec FROM scene_version WHERE scene_id = ? AND version = ?', sceneId, version);
  const spec = readSpec(row?.shot_spec);
  spec.prompt_review = { status: 'needs_review', issues };
  if (block) {
    await db.run(
      'UPDATE scene_version SET shot_spec = ?, english_visual_prompt = ?, asset_status = ?, task_id = ? WHERE scene_id = ? AND version = ?',
      JSON.stringify(spec), prompt, 'failed', taskId, sceneId, version,
    );
    return;
  }
  await db.run(
    'UPDATE scene_version SET shot_spec = ?, english_visual_prompt = ? WHERE scene_id = ? AND version = ?',
    JSON.stringify(spec), prompt, sceneId, version,
  );
}

export async function decideFormalCandidate(sceneId: number, raw: unknown) {
  const body = raw as {
    expected_version?: number;
    reference_hash?: string;
    verdict?: string;
    checks?: Record<string, boolean>;
    note?: string;
  };
  if (!body || !['accepted', 'rejected'].includes(String(body.verdict))) fail('PRODUCTION_INPUT_INVALID', 'Formal decision needs accepted or rejected', 422);
  if (!body.note || String(body.note).trim().length < 1) fail('PRODUCTION_INPUT_INVALID', 'Formal decision needs a note', 422);
  const checks = body.checks || {};
  if (checksSchema.some((key) => typeof checks[key] !== 'boolean')) fail('PRODUCTION_INPUT_INVALID', 'Formal decision needs the six image checks', 422);
  const version = Number(body.expected_version);
  return withImmediateTransaction(async () => {
    const row = await db.get('SELECT * FROM scene_version WHERE scene_id = ? AND version = ?', sceneId, version);
    if (!row) fail('CONTINUITY_SCOPE_INVALID', 'Formal candidate version was not found');
    const record = readSpec(row.shot_spec).formal_request as FormalRequestRecord | undefined;
    if (!record || record.reference_hash !== body.reference_hash) fail('CONTINUITY_REVISION_CONFLICT', 'The formal candidate or reference hash changed');
    const savedRecord = record!;
    if (row.asset_status !== 'completed' || !row.asset_url) fail('CONTINUITY_REVISION_CONFLICT', 'Review the completed candidate image');
    const scene = await db.get('SELECT * FROM scene WHERE id = ?', sceneId);
    const activeUrl = scene?.asset_url || null;
    const activeVersion = Number(scene?.active_version || 1);
    if (body.verdict === 'accepted' && activeVersion === version && activeUrl && activeUrl === row.asset_url) {
      const existingReview = await db.get('SELECT image_review_json FROM scene_production_frame WHERE scene_id = ? AND scene_version = ?', sceneId, version);
      let prior: { verdict?: string; reference_hash?: string } | null = null;
      try { prior = JSON.parse(existingReview?.image_review_json || 'null'); } catch { prior = null; }
      if (prior?.verdict === 'accepted' && prior.reference_hash === body.reference_hash && !checksSchema.some((key) => checks[key] !== true)) {
        return { verdict: 'accepted', active_version: activeVersion, asset_url: activeUrl, candidate_version: version };
      }
    }
    if (body.verdict === 'accepted' && savedRecord.production_stage === 'production') {
      if (Number(savedRecord.source_version) !== activeVersion) fail('CONTINUITY_STALE', 'The shot version changed after this candidate was generated');
      const frame = await db.get('SELECT reference_versions_json FROM scene_production_frame WHERE scene_id = ? AND scene_version = ?', sceneId, version);
      const pin = pinFromFrame(frame?.reference_versions_json);
      if (!pin) fail('CONTINUITY_REFERENCE_REVIEW_REQUIRED', 'Bind references before adopting a formal storyboard');
      else await requireFormalPinStillCurrent(scene, pin);
      if (!await refreshCandidateDependency(sceneId, version)) fail('CONTINUITY_STALE', 'The formal candidate no longer matches the current confirmed state');
    }
    if (body.verdict === 'accepted' && checksSchema.some((key) => checks[key] !== true)) {
      fail('CONTINUITY_REVIEW_REQUIRED', 'Every image check must pass before accepting this image');
    }
    const review = {
      verdict: body.verdict,
      checks,
      note: String(body.note).trim(),
      actor_id: 'local_reviewer',
      reviewed_at: new Date().toISOString(),
      image_only: true,
      reference_hash: savedRecord.reference_hash,
      expected_image_url: row.asset_url,
    };
    await db.run(
      'UPDATE scene_production_frame SET image_review_json = ? WHERE scene_id = ? AND scene_version = ?',
      JSON.stringify(review), sceneId, version
    );
    if (body.verdict === 'rejected') {
      return { verdict: 'rejected', active_version: activeVersion, asset_url: activeUrl, candidate_version: version };
    }
    const activated = await activateSceneVersion(sceneId, version, savedRecord.production_stage === 'production' ? { purpose: 'formal' } : undefined);
    const project = await db.get('SELECT c.project_id FROM scene s JOIN chapter c ON c.id = s.chapter_id WHERE s.id = ?', sceneId);
    await recordShotMasterSnapshot({
      sceneId,
      projectId: Number(project.project_id),
      imageUrl: String(row.asset_url),
      captured: { references: [], versions: [] },
    });
    return { verdict: 'accepted', active_version: Number(activated?.active_version), asset_url: activated?.asset_url, candidate_version: version };
  });
}
