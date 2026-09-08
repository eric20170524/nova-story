import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../../db/database';
import { logger } from '../../core/logging';
import { getStaticDirectory, getVideoStagingDirectory } from '../../core/paths';
import { MediaAsset } from '../../schemas/video';
import {
  ComfyInputTransport,
  normalizeReferenceTransportMode,
  shouldUseHttpReferenceTransport
} from './comfy_input_transport';

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
    if (!absolute.startsWith(staticRoot)) {
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
    // Face is the strongest identity signal, then avatar, then turnaround. Deduplicate
    // exact URLs so one physical image never produces duplicate MediaAsset rows merely
    // because Character Center exposes it through multiple slots.
    const orderedCandidates: Array<{ slot: string; url: string }> = [
      { slot: 'face_url', url: String(assets.face_url || visualTags.face_url || '').trim() },
      { slot: 'avatar_url', url: String(assets.avatar_url || visualTags.avatar_url || '').trim() },
      { slot: 'turnaround_url', url: String(assets.turnaround_url || visualTags.turnaround_url || '').trim() }
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
    for (const row of existingRows) {
      const metadata = parseMetadata(row.metadata_json);
      if (
        metadata.source === CHARACTER_CENTER_ADAPTER_SOURCE
        && !currentUrls.has(String(row.url || ''))
        && row.status !== 'archived'
      ) {
        await db.run('UPDATE media_asset SET status = ? WHERE id = ?', 'archived', row.id);
      }
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
         AND role IN ('video_keyframe', 'last_frame_reference', 'character_reference', 'motion_reference')
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
    const baseUrl = String(comfySettings.base_url || 'http://127.0.0.1:8188').replace(/\/$/, '');
    const transportMode = normalizeReferenceTransportMode(
      process.env.NOVASTORY_COMFY_REFERENCE_TRANSPORT || comfySettings.reference_transport
    );

    let filesystemAvailable = false;
    let filesystemError: Error | null = null;
    if (comfySettings.install_path) {
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
        Number(process.env.NOVASTORY_COMFY_REFERENCE_UPLOAD_TIMEOUT_MS || 15_000)
      );
      const uploaded = await ComfyInputTransport.uploadInput({
        baseUrl,
        filename: stagedFilename,
        buffer: fs.readFileSync(sourcePath),
        mimeType: inferReferenceMimeType(asset, sourcePath),
        subfolder: 'novastory',
        timeoutMs
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

