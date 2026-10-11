import type { Scene } from '../types';

/** Stream disconnects and failed candidates must not replace or hide the selected image. */
export function nextSceneAfterImageEvent(
  scene: Scene,
  kind: 'disconnect' | 'failed' | 'completed',
  imageUrl?: string | null,
  candidateVersion?: number | null
): Scene {
  if (candidateVersion) return scene;
  if (kind === 'completed' && imageUrl) {
    return { ...scene, asset_status: 'completed', asset_url: imageUrl };
  }
  if ((kind === 'disconnect' || kind === 'failed') && !scene.asset_url) {
    return { ...scene, asset_status: 'failed' };
  }
  return scene;
}

export function formalProductionBlocked(capabilities: Array<{ chain_ready?: boolean; live_verified?: boolean; reason?: string | null }> | undefined): string[] {
  const rows = capabilities || [];
  if (rows.length === 0) return ['status_unavailable'];
  const open = rows.some((row) => row.chain_ready && row.live_verified);
  if (open) return [];
  const reasons = rows.map((row) => row.reason).filter((reason): reason is string => Boolean(reason));
  return reasons.length > 0 ? [...new Set(reasons)] : ['not_live_verified'];
}
