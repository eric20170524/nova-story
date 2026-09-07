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
    return {
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
    };
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
    return (rows as any[]).map((row) => ({
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
    }));
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
}
