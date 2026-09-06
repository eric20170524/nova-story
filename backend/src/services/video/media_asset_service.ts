import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../../db/database';
import { logger } from '../../core/logging';
import { getStaticDirectory, getVideoStagingDirectory, getGeneratedVideosDirectory } from '../../core/paths';
import { MediaAsset, MediaAssetRole, MediaAssetStatus, VideoProfile } from '../../schemas/video';

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
    let cleaned = relativeOrUrl.replace(/^[a-zA-Z0-9]+:\/\/[^/]+\/static\//, '').replace(/^\/?static\//, '');
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

    const stagingDir = comfyInputDir || getVideoStagingDirectory();
    fs.mkdirSync(stagingDir, { recursive: true });
    const targetPath = path.join(stagingDir, stagedFilename);

    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(sourcePath, targetPath);
      logger.info(`Staged asset ${asset.id} to ${targetPath}`);
    }

    // Also mirror to ComfyUI install_path/input if configured
    try {
      const { SettingsManager } = await import('../../core/settings_manager');
      const settings = SettingsManager.loadSettings();
      if (settings.comfyui?.install_path) {
        const comfyInput = path.join(settings.comfyui.install_path, 'input');
        if (fs.existsSync(comfyInput)) {
          const comfyTargetPath = path.join(comfyInput, stagedFilename);
          if (!fs.existsSync(comfyTargetPath)) {
            fs.copyFileSync(sourcePath, comfyTargetPath);
            logger.info(`Mirrored staged asset ${asset.id} to ComfyUI input: ${comfyTargetPath}`);
          }
        }
      }
    } catch {}

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

  static async promoteAsset(assetId: number): Promise<MediaAsset> {
    const asset = await this.getAssetById(assetId);
    if (!asset) {
      throw new Error(`Media asset ${assetId} not found`);
    }
    if (asset.media_type !== 'video' || (asset.role !== 'loop_master' && asset.role !== 'narrative_final')) {
      throw new Error(`Only loop_master or narrative_final video assets can be promoted as active final clip`);
    }

    // Demote any previously ready finals for this scene + version to draft
    if (asset.scene_id) {
      await db.run(
        `UPDATE media_asset SET status = 'draft'
         WHERE scene_id = ? AND scene_version = ? AND id != ? AND role IN ('loop_master', 'narrative_final')`,
        asset.scene_id,
        asset.scene_version || 1,
        asset.id
      );
    }

    await db.run(`UPDATE media_asset SET status = 'ready' WHERE id = ?`, assetId);
    logger.info(`Promoted asset ${assetId} as active final for scene ${asset.scene_id}`);
    return (await this.getAssetById(assetId))!;
  }
}
