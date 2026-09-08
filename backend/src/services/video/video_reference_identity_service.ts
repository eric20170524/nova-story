import { db } from '../../db/database';
import type { VideoGenerationRequest } from '../../schemas/video';
import { MediaAssetService } from './media_asset_service';

export type VideoReferenceIdentityValidation = {
  blockers: string[];
  character_id: number | null;
};

/**
 * Validate the identity semantics of H3 character references.
 *
 * H3's current VideoSpec is single-character: one resolved Character drives the
 * identity prompt while up to three images reinforce that same identity. With
 * project-level Character Center MediaAssets now visible in every scene, accepting
 * references from multiple character_ids would silently bind the first character's
 * text identity to another character's image. Fail closed instead.
 *
 * Unbound/manual character_reference assets (character_id = NULL) remain allowed so
 * existing user uploads keep working. They may be mixed with one bound identity, but
 * two distinct non-null character_ids are never accepted in one request.
 */
export class VideoReferenceIdentityService {
  static async validate(request: VideoGenerationRequest): Promise<VideoReferenceIdentityValidation> {
    if (
      request.workflow_id === 'minimax_h3_fl2va_official_12gb'
      || !request.character_reference_asset_ids?.length
    ) {
      return { blockers: [], character_id: null };
    }

    const scene = await db.get(
      `SELECT c.project_id
       FROM scene s
       JOIN chapter c ON c.id = s.chapter_id
       WHERE s.id = ?`,
      request.scene_id
    );
    const projectId = scene?.project_id != null ? Number(scene.project_id) : null;
    if (projectId == null) {
      // Scene existence/project ownership is already a canonical preflight concern.
      return { blockers: [], character_id: null };
    }

    const blockers: string[] = [];
    const boundCharacterIds = new Set<number>();

    for (const assetId of request.character_reference_asset_ids) {
      const asset = await MediaAssetService.getAssetById(assetId);
      if (!asset) continue; // canonical preflight reports missing asset
      if (asset.project_id !== projectId) continue; // canonical preflight reports ownership

      if (asset.role !== 'character_reference') {
        blockers.push(
          `Asset ID ${assetId} cannot be used as a character reference because its role is '${asset.role}'.`
        );
        continue;
      }

      if (asset.character_id != null) {
        boundCharacterIds.add(Number(asset.character_id));
      }
    }

    if (boundCharacterIds.size > 1) {
      blockers.push(
        `Character references span multiple identities (${Array.from(boundCharacterIds).sort((a, b) => a - b).join(', ')}). `
        + 'Select 1–3 references for one character only.'
      );
    }

    return {
      blockers,
      character_id: boundCharacterIds.size === 1 ? Array.from(boundCharacterIds)[0]! : null
    };
  }
}
