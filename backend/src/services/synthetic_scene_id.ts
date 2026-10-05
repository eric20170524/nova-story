const CHARACTER_SCENE_OFFSETS = [999990, 999991, 999992, 90_000_000] as const;
const CHARACTER_SCENE_SPAN = 100_000;

/** Portrait and turnaround jobs use reserved ids. Real director shots must not. */
export function syntheticCharacterId(sceneId: number): number | null {
  if (!Number.isSafeInteger(sceneId)) return null;
  for (const offset of CHARACTER_SCENE_OFFSETS) {
    if (sceneId > offset && sceneId < offset + CHARACTER_SCENE_SPAN) return sceneId - offset;
  }
  return null;
}

export function isSyntheticCharacterSceneId(sceneId: number): boolean {
  return syntheticCharacterId(sceneId) != null;
}

/** Library jobs use ids at 2_000_000_000 and must not be written back onto a scene row. */
export function shouldPersistSceneAsset(sceneId: number): boolean {
  return Number.isSafeInteger(sceneId)
    && sceneId > 0
    && sceneId < 1_000_000_000
    && !isSyntheticCharacterSceneId(sceneId);
}
