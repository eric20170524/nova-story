import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, withImmediateTransaction } from '../../db/database';
import { logger } from '../../core/logging';
import { getGeneratedDirectory, getStaticDirectory, getVideoStagingDirectory } from '../../core/paths';
import { getPresetDeliveryFrames, MediaAsset, VideoPreset } from '../../schemas/video';
import { recordShotMasterSnapshot } from './shot_master_snapshot';

const execFileAsync = promisify(execFile);
import {
  ComfyInputTransport,
  normalizeReferenceTransportMode,
  shouldUseHttpReferenceTransport
} from './comfy_input_transport';
import { platesFromVisualTags } from './video_identity_plates';

const inferReferenceMimeType = (asset: MediaAsset, sourcePath: string): string => {
  if (asset.mime_type) return asset.mime_type;
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  return asset.media_type === 'video' ? 'video/mp4' : 'application/octet-stream';
};

const inferImageMimeTypeFromPath = (sourcePath: string): string | undefined => {
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return undefined;
};

const normalizeMediaAssetRow = (row: any): MediaAsset => ({
  ...row,
  id: Number(row.id),
  project_id: Number(row.project_id),
  scene_id: row.scene_id != null ? Number(row.scene_id) : null,
  scene_version: row.scene_version != null ? Number(row.scene_version) : null,
  character_id: row.character_id != null ? Number(row.character_id) : null,
  parent_asset_id: row.parent_asset_id != null ? Number(row.parent_asset_id) : null,
  width: row.width != null ? Number(row.width) : null,
  height: row.height != null ? Number(row.height) : null,
  fps: row.fps != null ? Number(row.fps) : null,
  frame_count: row.frame_count != null ? Number(row.frame_count) : null,
  duration_ms: row.duration_ms != null ? Number(row.duration_ms) : null
});

const parseMetadata = (raw?: string | null): Record<string, any> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const CHARACTER_CENTER_ADAPTER_SOURCE = 'character_center_adapter';

export class MediaAssetService {
  static computeSha256(filePath: string): string {
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  static computeBufferSha256(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  static sanitizeFilename(filename: string): string {
    const basename = path.basename(filename);
    return basename.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  static resolveSafePath(relativeOrUrl: string): string {
    const staticRoot = path.resolve(getStaticDirectory());
    // Strip leading /static/ or http.../static/
    const cleaned = relativeOrUrl.replace(/^[a-zA-Z0-9]+:\/\/[^/]+\/static\//, '').replace(/^\/?static\//, '');
    const absolute = path.resolve(staticRoot, cleaned);
    if (!absolute.startsWith(`${staticRoot}${path.sep}`)) {
      throw new Error(`Path traversal detected for asset path: ${relativeOrUrl}`);
    }
    return absolute;
  }

  /**
   * Build/reuse project-level `character_reference` MediaAsset identities for the
   * Character Center's existing avatar/face/turnaround URLs.
   *
   * This is deliberately a metadata adapter, not an upload/copy operation. The
   * physical Character Center image remains canonical at its current /static URL;
   * only the MediaAsset identity/ownership layer is unified for H3. A later Comfy
   * staging step may copy/upload bytes transiently as required by that transport.
   */
  static async syncCharacterReferenceAssets(characterId: number): Promise<MediaAsset[]> {
    const character = await db.get(
      'SELECT id, project_id, name, visual_tags FROM character WHERE id = ?',
      characterId
    );
    if (!character) {
      throw new Error(`Character ${characterId} not found`);
    }

    let visualTags: Record<string, any> = {};
    try {
      visualTags = typeof character.visual_tags === 'string'
        ? JSON.parse(character.visual_tags || '{}')
        : (character.visual_tags || {});
    } catch {
      visualTags = {};
    }

    const assets = visualTags?.assets || {};
    // Video may see the portrait and the single front panel. The stitched sheet
    // and a corner face crop are not identity references.
    const orderedCandidates: Array<{ slot: string; url: string }> = [
      { slot: 'face', url: String(assets.avatar_url || visualTags.avatar_url || '').trim() },
      { slot: 'body', url: String(assets.turnaround_front_url || visualTags.turnaround_front_url || '').trim() }
    ];
    const seenUrls = new Set<string>();
    const candidates = orderedCandidates.filter((candidate) => {
      if (!candidate.url || seenUrls.has(candidate.url)) return false;
      seenUrls.add(candidate.url);
      return true;
    });

    const existingRows = await db.all(
      `SELECT * FROM media_asset
       WHERE project_id = ?
         AND character_id = ?
         AND scene_id IS NULL
         AND role = 'character_reference'
       ORDER BY id DESC`,
      Number(character.project_id),
      Number(character.id)
    ) as any[];

    const currentUrls = new Set(candidates.map((candidate) => candidate.url));
    const versionRows = await db.all(
      'SELECT version, visual_tags FROM character_version WHERE character_id = ?',
      Number(character.id),
    ) as Array<{ version: number; visual_tags?: string | null }>;
    const versionUrls = new Map<string, number>();
    for (const versionRow of versionRows) {
      const plates = platesFromVisualTags(versionRow.visual_tags);
      for (const url of [plates.face, plates.body]) {
        if (!url) continue;
        const previous = versionUrls.get(url) || 0;
        if (Number(versionRow.version) >= previous) versionUrls.set(url, Number(versionRow.version));
      }
    }
    const retainedUrls = new Set<string>([...currentUrls, ...versionUrls.keys()]);
    for (const row of existingRows) {
      const metadata = parseMetadata(row.metadata_json);
      if (metadata.source !== CHARACTER_CENTER_ADAPTER_SOURCE) continue;
      const url = String(row.url || '');
      if (!retainedUrls.has(url)) {
        if (row.status !== 'archived') {
          await db.run('UPDATE media_asset SET status = ? WHERE id = ?', 'archived', row.id);
        }
        continue;
      }
      if (currentUrls.has(url)) continue;
      const metadataJson = JSON.stringify({
        ...metadata,
        source: CHARACTER_CENTER_ADAPTER_SOURCE,
        character_version: versionUrls.get(url) || null,
      });
      await db.run(
        'UPDATE media_asset SET status = ?, metadata_json = ? WHERE id = ?',
        'ready',
        metadataJson,
        row.id,
      );
    }

    const synced: MediaAsset[] = [];
    for (const candidate of candidates) {
      let sourcePath: string;
      try {
        sourcePath = this.resolveSafePath(candidate.url);
      } catch (err) {
        logger.warn(
          `Skipping Character Center ${candidate.slot} for character ${character.id}: `
          + `H3 MediaAsset adapter only accepts NovaStory /static assets (${err})`
        );
        continue;
      }

      if (!fs.existsSync(sourcePath)) {
        logger.warn(
          `Skipping Character Center ${candidate.slot} for character ${character.id}: `
          + `source file does not exist at ${sourcePath}`
        );
        continue;
      }

      const metadataJson = JSON.stringify({
        source: CHARACTER_CENTER_ADAPTER_SOURCE,
        adapter_version: 1,
        source_slot: candidate.slot,
        character_name: character.name || null,
        no_copy: true
      });
      const sha256 = this.computeSha256(sourcePath);
      const mimeType = inferImageMimeTypeFromPath(sourcePath);

      const existing = existingRows.find(
        (row) => String(row.url || '') === candidate.url && row.status !== 'archived'
      ) || existingRows.find((row) => {
        const metadata = parseMetadata(row.metadata_json);
        return String(row.url || '') === candidate.url
          && metadata.source === CHARACTER_CENTER_ADAPTER_SOURCE;
      });

      if (existing) {
        const metadata = parseMetadata(existing.metadata_json);
        if (metadata.source === CHARACTER_CENTER_ADAPTER_SOURCE) {
          await db.run(
            `UPDATE media_asset
             SET status = 'ready', mime_type = ?, sha256 = ?, metadata_json = ?
             WHERE id = ?`,
            mimeType ?? null,
            sha256,
            metadataJson,
            existing.id
          );
        }
        const refreshed = await this.getAssetById(Number(existing.id));
        if (refreshed && refreshed.status !== 'archived') synced.push(refreshed);
        continue;
      }

      const created = await this.createAsset({
        project_id: Number(character.project_id),
        scene_id: null,
        scene_version: null,
        character_id: Number(character.id),
        media_type: 'image',
        role: 'character_reference',
        status: 'ready',
        url: candidate.url,
        mime_type: mimeType,
        sha256,
        metadata_json: metadataJson
      });
      synced.push(created);
    }

    return synced;
  }

  /**
   * Scene media plus reusable project-level Character Center references. Syncing the
   * adapter here makes existing projects self-healing without copying their images or
   * requiring a one-off migration command.
   *
   * Directly uploaded references are scene-global unless a scene_version was supplied
   * explicitly. Keep those `scene_version IS NULL` rows visible even when Director is
   * viewing a concrete scene version; otherwise a reference disappears after reload.
   */
  static async listSceneContextAssets(sceneId: number, sceneVersion?: number): Promise<MediaAsset[]> {
    const scene = await db.get(
      `SELECT s.id, c.project_id
       FROM scene s
       JOIN chapter c ON c.id = s.chapter_id
       WHERE s.id = ?`,
      sceneId
    );

    const sceneAssets = await this.listAssetsByScene(sceneId, sceneVersion);
    const sceneGlobalReferenceRows = await db.all(
      `SELECT * FROM media_asset
       WHERE scene_id = ?
         AND scene_version IS NULL
         AND role IN ('video_keyframe', 'last_frame_reference', 'character_reference', 'motion_reference', 'guide_frame_reference', 'composition_reference')
         AND status != 'archived'
       ORDER BY id ASC`,
      sceneId
    ) as any[];
    const sceneGlobalReferences = sceneGlobalReferenceRows.map(normalizeMediaAssetRow);

    if (!scene?.project_id) {
      const byId = new Map<number, MediaAsset>();
      for (const asset of [...sceneAssets, ...sceneGlobalReferences]) {
        if (asset.id != null) byId.set(Number(asset.id), asset);
      }
      return Array.from(byId.values());
    }

    const characters = await db.all(
      'SELECT id FROM character WHERE project_id = ? ORDER BY id ASC',
      Number(scene.project_id)
    ) as Array<{ id: number }>;
    for (const character of characters) {
      try {
        await this.syncCharacterReferenceAssets(Number(character.id));
      } catch (err) {
        logger.warn(`Could not sync Character Center MediaAsset adapter for character ${character.id}: ${err}`);
      }
    }

    const referenceRows = await db.all(
      `SELECT * FROM media_asset
       WHERE project_id = ?
         AND scene_id IS NULL
         AND media_type = 'image'
         AND role = 'character_reference'
         AND status = 'ready'
       ORDER BY id ASC`,
      Number(scene.project_id)
    ) as any[];

    const byId = new Map<number, MediaAsset>();
    for (const asset of [
      ...sceneAssets,
      ...sceneGlobalReferences,
      ...referenceRows.map(normalizeMediaAssetRow)
    ]) {
      if (asset.id != null) byId.set(Number(asset.id), asset);
    }
    return Array.from(byId.values());
  }

  static async stageAssetForComfy(asset: MediaAsset, comfyInputDir?: string): Promise<{ stagedFilename: string; stagedPath: string }> {
    const sourcePath = this.resolveSafePath(asset.url);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source asset file does not exist: ${sourcePath} (assetId=${asset.id})`);
    }

    const sha = asset.sha256 || this.computeSha256(sourcePath);
    const prefix = sha.substring(0, 12);
    const safeName = this.sanitizeFilename(path.basename(sourcePath));
    const stagedFilename = `${prefix}_${safeName}`;

    // NovaStory always retains a local staging copy for reproducibility. When callers
    // explicitly provide comfyInputDir this directory itself is the transport target,
    // which preserves the existing unit-test / custom-deployment contract.
    const stagingDir = comfyInputDir || getVideoStagingDirectory();
    fs.mkdirSync(stagingDir, { recursive: true });
    const targetPath = path.join(stagingDir, stagedFilename);

    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(sourcePath, targetPath);
      logger.info(`Staged asset ${asset.id} to ${targetPath}`);
    }

    if (comfyInputDir) {
      return { stagedFilename, stagedPath: targetPath };
    }

    const { SettingsManager } = await import('../../core/settings_manager');
    const settings = SettingsManager.loadSettings();
    const comfySettings = (settings.comfyui || {}) as Record<string, any>;
    const isRemote = comfySettings.mode === 'remote';
    const baseUrl = String(isRemote ? (comfySettings.remote_base_url || comfySettings.base_url || '') : (comfySettings.local_base_url || comfySettings.base_url || 'http://127.0.0.1:8188')).replace(/\/$/, '');
    const transportMode = normalizeReferenceTransportMode(
      process.env.NOVASTORY_COMFY_REFERENCE_TRANSPORT || comfySettings.reference_transport
    );

    let filesystemAvailable = false;
    let filesystemError: Error | null = null;
    if (!isRemote && comfySettings.install_path) {
      const comfyInput = path.join(String(comfySettings.install_path), 'input');
      if (fs.existsSync(comfyInput)) {
        try {
          const comfyTargetPath = path.join(comfyInput, stagedFilename);
          if (!fs.existsSync(comfyTargetPath)) {
            fs.copyFileSync(sourcePath, comfyTargetPath);
            logger.info(`Mirrored staged asset ${asset.id} to ComfyUI input: ${comfyTargetPath}`);
          }
          filesystemAvailable = true;
        } catch (err: any) {
          filesystemError = err instanceof Error ? err : new Error(String(err));
          logger.warn(`Failed to mirror asset ${asset.id} into ComfyUI input: ${filesystemError.message}`);
        }
      }
    }

    if (transportMode === 'filesystem') {
      if (!filesystemAvailable) {
        throw new Error(
          `Comfy reference transport is forced to filesystem, but the configured ComfyUI input directory is unavailable${
            filesystemError ? `: ${filesystemError.message}` : ''
          }`
        );
      }
      return { stagedFilename, stagedPath: targetPath };
    }

    const useHttp = shouldUseHttpReferenceTransport({
      mode: transportMode,
      baseUrl,
      filesystemAvailable,
      comfyEnabled: Boolean(comfySettings.enabled)
    });

    if (useHttp) {
      const timeoutMs = Math.max(
        500,
        Number(process.env.NOVASTORY_COMFY_REFERENCE_UPLOAD_TIMEOUT_MS || 60_000)
      );
      const isRemote = comfySettings.mode === 'remote';
      const uploaded = await ComfyInputTransport.uploadInput({
        baseUrl,
        filename: stagedFilename,
        buffer: fs.readFileSync(sourcePath),
        mimeType: inferReferenceMimeType(asset, sourcePath),
        subfolder: 'novastory',
        timeoutMs,
        isRemote,
        auth: isRemote ? {
          username: comfySettings.remote_username || process.env.COMFYUI_REMOTE_USERNAME || '',
          password: comfySettings.remote_password || process.env.COMFYUI_REMOTE_PASSWORD || ''
        } : undefined
      });
      return {
        stagedFilename: uploaded.inputName,
        stagedPath: targetPath
      };
    }

    if (!filesystemAvailable) {
      logger.warn(
        `Comfy reference asset ${asset.id} remains in NovaStory local staging only. `
        + `Set comfyui.reference_transport=http (or NOVASTORY_COMFY_REFERENCE_TRANSPORT=http) `
        + `when loopback ComfyUI is enabled without a shared install_path.`
      );
    }

    return { stagedFilename, stagedPath: targetPath };
  }

  static async createAsset(data: Omit<MediaAsset, 'id' | 'created_at'>): Promise<MediaAsset> {
    const res = await db.run(
      `INSERT INTO media_asset (
        project_id, scene_id, scene_version, character_id, parent_asset_id,
        media_type, role, profile, status, url, mime_type, width, height,
        fps, frame_count, duration_ms, sha256, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.project_id,
      data.scene_id ?? null,
      data.scene_version ?? null,
      data.character_id ?? null,
      data.parent_asset_id ?? null,
      data.media_type,
      data.role,
      data.profile ?? null,
      data.status || 'ready',
      data.url,
      data.mime_type ?? null,
      data.width ?? null,
      data.height ?? null,
      data.fps ?? null,
      data.frame_count ?? null,
      data.duration_ms ?? null,
      data.sha256 ?? null,
      data.metadata_json ?? null
    );

    const assetId = (res as any).lastID;
    return (await this.getAssetById(assetId))!;
  }

  static async setGuideFrameIdx(assetId: number, frameIdx: number, preset?: VideoPreset): Promise<MediaAsset> {
    const asset = await this.getAssetById(assetId);
    let resolvedPreset: VideoPreset = preset || 'standard_720p_5s';
    if (!preset && asset?.scene_id != null) {
      const sceneRow = await db.get('SELECT duration FROM scene WHERE id = ?', asset.scene_id);
      if (Number(sceneRow?.duration) > 5) resolvedPreset = 'standard_720p_8s';
    }
    const maxFrameIdx = getPresetDeliveryFrames(resolvedPreset) - 1;
    if (!Number.isInteger(frameIdx) || frameIdx < 1 || frameIdx > maxFrameIdx) {
      throw new Error(`guide_frame_idx must be an integer within delivery frames 1..${maxFrameIdx} (24fps).`);
    }
    if (!asset) throw new Error(`Asset ${assetId} does not exist`);
    if (asset.role !== 'guide_frame_reference' && asset.role !== 'composition_reference') {
      throw new Error(`guide_frame_idx can only be stored on a guide frame, not '${asset.role}'`);
    }
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = asset.metadata_json ? JSON.parse(asset.metadata_json) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    } catch { metadata = {}; }
    metadata.guide_frame_idx = frameIdx;
    await db.run('UPDATE media_asset SET metadata_json = ? WHERE id = ?', JSON.stringify(metadata), assetId);
    return (await this.getAssetById(assetId))!;
  }

  static async adoptLastFrameCandidate(
    assetId: number,
    options: { characterIds?: number[] } = {},
  ): Promise<MediaAsset> {
    return withImmediateTransaction(async () => {
      const asset = await this.getAssetById(assetId);
      if (!asset) throw new Error(`Last-frame candidate asset ${assetId} does not exist`);
      if (asset.role !== 'last_frame_reference' || asset.media_type !== 'image') {
        throw new Error(`Asset ${assetId} is not a last_frame_reference image`);
      }
      if (asset.scene_id == null) {
        throw new Error(`Last-frame candidate asset ${assetId} must belong to a scene`);
      }
      if (asset.status === 'rejected' || asset.status === 'archived') {
        throw new Error(`Cannot adopt a ${asset.status} last-frame candidate`);
      }
      await db.run(
        `UPDATE media_asset SET status = 'draft'
         WHERE scene_id = ? AND COALESCE(scene_version, 1) = ? AND id != ?
           AND role = 'last_frame_reference' AND status = 'ready'`,
        asset.scene_id,
        asset.scene_version || 1,
        asset.id,
      );
      await db.run('UPDATE media_asset SET status = ? WHERE id = ?', 'ready', assetId);
      await recordShotMasterSnapshot({
        sceneId: Number(asset.scene_id),
        projectId: Number(asset.project_id),
        imageUrl: asset.url,
        ...(options.characterIds ? { characterIds: options.characterIds } : {}),
      });
      return (await this.getAssetById(assetId))!;
    });
  }

  static async relayKeyframeFromPreviousShot(
    targetSceneId: number,
    sourceSceneId: number,
    options: {
      adopt?: boolean;
      characterIds?: number[];
      extractFrameFn?: (videoPath: string, targetPath: string, frameIndex: number) => Promise<void>;
    } = {},
  ): Promise<MediaAsset> {
    const targetScene = await db.get(
      'SELECT s.id, s.active_version, c.project_id FROM scene s JOIN chapter c ON c.id = s.chapter_id WHERE s.id = ?',
      targetSceneId,
    );
    if (!targetScene) throw new Error(`Target scene ${targetSceneId} not found`);
    const sourceScene = await db.get(
      'SELECT s.id, s.active_version, c.project_id FROM scene s JOIN chapter c ON c.id = s.chapter_id WHERE s.id = ?',
      sourceSceneId,
    );
    if (!sourceScene) throw new Error(`Source scene ${sourceSceneId} not found`);
    if (Number(targetScene.project_id) !== Number(sourceScene.project_id)) {
      throw new Error('Cannot relay keyframe across different projects');
    }
    const projectId = Number(targetScene.project_id);
    const targetVersion = Number(targetScene.active_version || 1);
    const sourceVersion = Number(sourceScene.active_version || 1);
    const shouldAdopt = options.adopt !== false;

    // 1. Keyframe Bridge priority: reuse ready static last_frame_reference when available
    const staticLastFrameRow = await db.get(
      `SELECT * FROM media_asset
       WHERE scene_id = ? AND COALESCE(scene_version, 1) = ?
         AND role = 'last_frame_reference' AND media_type = 'image' AND status = 'ready'
       ORDER BY id DESC LIMIT 1`,
      sourceSceneId,
      sourceVersion,
    );
    if (staticLastFrameRow) {
      const staticAsset = normalizeMediaAssetRow(staticLastFrameRow);
      const sourceMeta = parseMetadata(staticAsset.metadata_json);
      const sourceDepth = Number(sourceMeta.relay_depth || 0);
      if (sourceDepth >= 2) {
        throw new Error('Relay depth limit (2) exceeded; regenerate a fresh static keyframe to prevent VAE degradation.');
      }
      const nextDepth = sourceDepth + 1;
      const created = await this.createAsset({
        project_id: projectId,
        scene_id: targetSceneId,
        scene_version: targetVersion,
        parent_asset_id: staticAsset.id ?? null,
        media_type: 'image',
        role: 'video_keyframe',
        status: shouldAdopt ? 'ready' : 'draft',
        url: staticAsset.url,
        mime_type: staticAsset.mime_type,
        width: staticAsset.width,
        height: staticAsset.height,
        sha256: staticAsset.sha256,
        metadata_json: JSON.stringify({
          relay_mode: 'static_last_frame',
          source_scene_id: sourceSceneId,
          source_asset_id: staticAsset.id,
          relay_depth: nextDepth,
        }),
      });
      if (shouldAdopt) {
        await db.run('UPDATE scene SET asset_url = ?, asset_status = ? WHERE id = ?', created.url, 'completed', targetSceneId);
        await db.run('UPDATE scene_version SET asset_url = ?, asset_status = ? WHERE scene_id = ? AND version = ?', created.url, 'completed', targetSceneId, targetVersion);
        await recordShotMasterSnapshot({
          sceneId: targetSceneId,
          projectId,
          imageUrl: created.url,
          ...(options.characterIds ? { characterIds: options.characterIds } : {}),
        });
      }
      return created;
    }

    // 2. Otherwise extract exact last frame (delivery_frames - 1) from completed narrative_final / loop_master video
    const videoRow = await db.get(
      `SELECT * FROM media_asset
       WHERE scene_id = ? AND COALESCE(scene_version, 1) = ?
         AND role IN ('narrative_final', 'loop_master') AND media_type = 'video' AND status = 'ready'
       ORDER BY id DESC LIMIT 1`,
      sourceSceneId,
      sourceVersion,
    );
    if (!videoRow) {
      throw new Error(`Source scene ${sourceSceneId} has no ready last_frame_reference or narrative_final video to relay from.`);
    }
    const videoAsset = normalizeMediaAssetRow(videoRow);
    const videoMeta = parseMetadata(videoAsset.metadata_json);

    // Determine source relay_depth from the video or the source scene's keyframe
    let sourceDepth = Number(videoMeta.relay_depth || 0);
    if (!sourceDepth) {
      const sourceKfRow = await db.get(
        `SELECT metadata_json FROM media_asset
         WHERE scene_id = ? AND COALESCE(scene_version, 1) = ? AND role = 'video_keyframe' AND status = 'ready'
         ORDER BY id DESC LIMIT 1`,
        sourceSceneId,
        sourceVersion,
      );
      if (sourceKfRow) {
        const kfMeta = parseMetadata(sourceKfRow.metadata_json);
        sourceDepth = Number(kfMeta.relay_depth || 0);
      }
    }
    if (sourceDepth >= 2) {
      throw new Error('Relay depth limit (2) exceeded; regenerate a fresh static keyframe to prevent VAE degradation.');
    }
    const nextDepth = sourceDepth + 1;

    const compiledDeliveryFrames = Number(
      (videoMeta.compiled_params as Record<string, unknown> | undefined)?.delivery_frames
      || videoMeta.delivery_frames
      || (typeof (videoMeta.request as Record<string, unknown> | undefined)?.preset === 'string'
        && String((videoMeta.request as Record<string, unknown>).preset).endsWith('_8s') ? 192 : 0)
    );
    const deliveryFrames = compiledDeliveryFrames >= 192
      || Number(videoAsset.frame_count || 0) >= 180
      || Number(videoAsset.duration_ms || 0) >= 7000
      ? 192
      : 120;
    const frameIndex = deliveryFrames - 1;

    const relayDir = path.join(getGeneratedDirectory(), 'references', String(projectId));
    fs.mkdirSync(relayDir, { recursive: true });
    const filename = `relay_s${sourceSceneId}_to_s${targetSceneId}_f${frameIndex}_${crypto.randomUUID().slice(0, 8)}.png`;
    const targetPath = path.join(relayDir, filename);
    const publicUrl = `/static/generated/references/${projectId}/${filename}`;

    const sourceVideoPath = this.resolveSafePath(videoAsset.url);
    if (options.extractFrameFn) {
      await options.extractFrameFn(sourceVideoPath, targetPath, frameIndex);
    } else {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', sourceVideoPath,
        '-vf', `select=eq(n\\,${frameIndex})`,
        '-frames:v', '1',
        targetPath,
      ]);
    }
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Failed to extract frame ${frameIndex} from source video ${videoAsset.url}`);
    }
    const sha256 = this.computeSha256(targetPath);

    const created = await this.createAsset({
      project_id: projectId,
      scene_id: targetSceneId,
      scene_version: targetVersion,
      parent_asset_id: videoAsset.id ?? null,
      media_type: 'image',
      role: 'video_keyframe',
      status: shouldAdopt ? 'ready' : 'draft',
      url: publicUrl,
      mime_type: 'image/png',
      width: videoAsset.width ?? 1280,
      height: videoAsset.height ?? 720,
      sha256,
      metadata_json: JSON.stringify({
        relay_mode: 'video_last_frame',
        source_scene_id: sourceSceneId,
        source_asset_id: videoAsset.id,
        extracted_frame_idx: frameIndex,
        delivery_frames: deliveryFrames,
        relay_depth: nextDepth,
      }),
    });

    if (shouldAdopt) {
      await db.run('UPDATE scene SET asset_url = ?, asset_status = ? WHERE id = ?', created.url, 'completed', targetSceneId);
      await db.run('UPDATE scene_version SET asset_url = ?, asset_status = ? WHERE scene_id = ? AND version = ?', created.url, 'completed', targetSceneId, targetVersion);
      await recordShotMasterSnapshot({
        sceneId: targetSceneId,
        projectId,
        imageUrl: created.url,
        ...(options.characterIds ? { characterIds: options.characterIds } : {}),
      });
    }
    return created;
  }

  static async getAssetById(id: number): Promise<MediaAsset | null> {
    const row = await db.get('SELECT * FROM media_asset WHERE id = ?', id);
    if (!row) return null;
    return normalizeMediaAssetRow(row);
  }

  static async listAssetsByScene(sceneId: number, sceneVersion?: number): Promise<MediaAsset[]> {
    let sql = 'SELECT * FROM media_asset WHERE scene_id = ?';
    const params: any[] = [sceneId];
    if (sceneVersion != null) {
      sql += ' AND scene_version = ?';
      params.push(sceneVersion);
    }
    sql += ' ORDER BY created_at DESC, id DESC';
    const rows = await db.all(sql, ...params);
    return (rows as any[]).map(normalizeMediaAssetRow);
  }

  /** Resolve either a raw video or a final derivative back to its immutable raw parent. */
  static async resolveRawVideoForReprocess(assetId: number): Promise<MediaAsset> {
    const asset = await this.getAssetById(assetId);
    if (!asset) {
      throw new Error(`Media asset ${assetId} not found`);
    }
    if (asset.media_type !== 'video') {
      throw new Error('Only video assets can be reprocessed');
    }
    if (asset.role === 'raw_video') {
      return asset;
    }
    if (asset.role !== 'loop_master' && asset.role !== 'narrative_final') {
      throw new Error('Asset must be a raw_video, loop_master, or narrative_final video');
    }
    if (!asset.parent_asset_id) {
      throw new Error(`Final asset ${assetId} has no raw-video parent`);
    }
    const raw = await this.getAssetById(asset.parent_asset_id);
    if (!raw || raw.role !== 'raw_video' || raw.media_type !== 'video') {
      throw new Error(`Final asset ${assetId} does not point to a valid raw_video parent`);
    }
    return raw;
  }

  static async promoteAsset(assetId: number): Promise<MediaAsset> {
    return withImmediateTransaction(async () => {
    const asset = await this.getAssetById(assetId);
    if (!asset) {
      throw new Error(`Media asset ${assetId} not found`);
    }
    if (asset.media_type !== 'video' || (asset.role !== 'loop_master' && asset.role !== 'narrative_final')) {
      throw new Error('Only loop_master or narrative_final video assets can be promoted as active final clip');
    }
    if (asset.status === 'rejected' || asset.status === 'archived') {
      throw new Error(`Cannot promote a ${asset.status} video asset`);
    }

    // Demote the previously promoted final only. Draft/review candidates retain
    // their QA disposition and remain available for A/B comparison.
    if (asset.scene_id) {
      await db.run(
        `UPDATE media_asset SET status = 'draft'
         WHERE scene_id = ? AND scene_version = ? AND id != ? AND status = 'ready'
           AND role IN ('loop_master', 'narrative_final')`,
        asset.scene_id,
        asset.scene_version || 1,
        asset.id
      );
    }

    await db.run('UPDATE media_asset SET status = ? WHERE id = ?', 'ready', assetId);
    logger.info(`Promoted asset ${assetId} as active final for scene ${asset.scene_id}`);
    return (await this.getAssetById(assetId))!;
    });
  }

  static async archiveAsset(assetId: number, expectedStatus: string): Promise<MediaAsset> {
    return withImmediateTransaction(async () => {
      const asset = await this.getAssetById(assetId);
      if (!asset) throw new Error(`Media asset ${assetId} not found`);
      if (asset.media_type !== 'video' || !['narrative_final', 'loop_master'].includes(asset.role)) throw new Error('Only final video candidates can be archived');
      if (asset.status === 'archived') return asset;
      if (asset.status !== expectedStatus) throw new Error('Video status changed; refresh before archiving');
      const active = await db.get("SELECT task_id FROM generation_task WHERE scene_id = ? AND kind = 'video' AND status = 'processing' LIMIT 1", asset.scene_id);
      if (active) throw new Error('Wait for the current video task to finish or cancel it before archiving');
      const metadata = parseMetadata(asset.metadata_json);
      await db.run("UPDATE media_asset SET status = 'archived', metadata_json = ? WHERE id = ?", JSON.stringify({ ...metadata, archive: { previous_status: asset.status, archived_at: new Date().toISOString() } }), asset.id);
      return (await this.getAssetById(assetId))!;
    });
  }

  /**
   * Clean up transient staged files in staging directory.
   * @param options.maxAgeMs Only remove files older than this duration (default: 24h). Set 0 to clear all.
   */
  static async cleanupStaging(options: { maxAgeMs?: number } = {}): Promise<{ deletedCount: number; freedBytes: number }> {
    const stagingDir = getVideoStagingDirectory();
    if (!fs.existsSync(stagingDir)) {
      return { deletedCount: 0, freedBytes: 0 };
    }

    const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    const now = Date.now();
    let deletedCount = 0;
    let freedBytes = 0;

    const files = await fs.promises.readdir(stagingDir);
    for (const file of files) {
      const filePath = path.join(stagingDir, file);
      try {
        const stats = await fs.promises.stat(filePath);
        if (stats.isFile()) {
          const age = now - stats.mtimeMs;
          if (age >= maxAgeMs) {
            freedBytes += stats.size;
            await fs.promises.unlink(filePath);
            deletedCount++;
            logger.info(`Cleaned up staging file: ${file} (age: ${Math.round(age / 1000 / 60)}min, size: ${stats.size} bytes)`);
          }
        }
      } catch (err) {
        logger.warn(`Failed to inspect or delete staging file ${filePath}: ${err}`);
      }
    }

    return { deletedCount, freedBytes };
  }
}

