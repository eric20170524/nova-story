import { z } from 'zod';
import { db } from '../db/database';

const AssetBundleSchema = z.object({
  assets: z.array(z.object({
    id: z.number().int().positive(), kind: z.enum(['location', 'prop']), name: z.string().trim().min(1).max(120),
    description: z.string().max(3000), visual_prompt: z.string().max(3000), image_url: z.string().nullable(),
    status: z.string(), revision: z.number().int().positive(), source_chapter_ids: z.string(),
  })),
  references: z.array(z.object({ scene_id: z.number().int().positive(), asset_id: z.number().int().positive(), asset_revision: z.number().int().positive() })),
  image_snapshots: z.array(z.object({ scene_id: z.number().int().positive(), image_url: z.string(), references_json: z.string() })),
});

export async function exportAssetLibrary(projectId: number) {
  const exists = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'library_asset'");
  if (!exists) return { assets: [], references: [], image_snapshots: [] };
  const assets = await db.all('SELECT * FROM library_asset WHERE project_id = ?', projectId);
  const references = await db.all(`SELECT r.* FROM scene_asset_reference r JOIN scene s ON s.id = r.scene_id JOIN chapter c ON c.id = s.chapter_id WHERE c.project_id = ?`, projectId);
  const image_snapshots = await db.all(`SELECT r.* FROM scene_asset_image_snapshot r JOIN scene s ON s.id = r.scene_id JOIN chapter c ON c.id = s.chapter_id WHERE c.project_id = ?`, projectId);
  return { assets, references, image_snapshots };
}

/** Caller owns the project-copy/import transaction. IDs never cross project boundaries. */
export async function restoreAssetLibrary(raw: unknown, projectId: number, chapters: Map<string, string>, scenes: Map<string, number>) {
  if (raw == null) return;
  const bundle = AssetBundleSchema.parse(raw);
  const assetIds = new Map<number, number>();
  for (const asset of bundle.assets) {
    if (assetIds.has(asset.id)) throw new Error('Duplicate asset identity in backup');
    const sourceIds = z.array(z.string()).parse(JSON.parse(asset.source_chapter_ids));
    const restored = await db.run(`INSERT INTO library_asset (project_id, kind, name, description, visual_prompt, image_url, status, revision, source_chapter_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, projectId, asset.kind, asset.name, asset.description, asset.visual_prompt, asset.image_url,
      asset.status === 'generating' ? 'failed' : asset.status, asset.revision, JSON.stringify(sourceIds.map(id => chapters.get(id)).filter(Boolean)));
    assetIds.set(asset.id, Number(restored.lastID));
  }
  for (const ref of bundle.references) {
    const sceneId = scenes.get(String(ref.scene_id));
    const assetId = assetIds.get(ref.asset_id);
    if (!sceneId || !assetId) throw new Error('Dangling scene/asset reference in backup');
    await db.run('INSERT INTO scene_asset_reference (scene_id, asset_id, asset_revision) VALUES (?, ?, ?)', sceneId, assetId, ref.asset_revision);
  }
  for (const snap of bundle.image_snapshots) {
    const sceneId = scenes.get(String(snap.scene_id));
    if (!sceneId) throw new Error('Dangling image snapshot in backup');
    const refs = z.array(z.object({ id: z.number().int(), revision: z.number().int().positive() })).parse(JSON.parse(snap.references_json));
    await db.run('INSERT INTO scene_asset_image_snapshot (scene_id, image_url, references_json) VALUES (?, ?, ?)', sceneId, snap.image_url,
      JSON.stringify(refs.map(ref => ({ ...ref, id: assetIds.get(ref.id) ?? -1 }))));
  }
}
