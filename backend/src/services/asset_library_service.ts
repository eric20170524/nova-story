import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, withImmediateTransaction } from '../db/database';
import { LLMService } from './llm';
import { GenerationService } from './generation_service';
import { AssetTaskStore } from './task_store';
import { hashChapterContent } from '../schemas/story_plan';

export const LibraryAssetInput = z.object({
  kind: z.enum(['location', 'prop']),
  name: z.string().trim().min(1).max(120),
  english_name: z.string().trim().max(120).regex(/^[^\u3400-\u9fff]*$/).optional(),
  description: z.string().max(3000).default(''),
  visual_prompt: z.string().max(3000).default(''),
});
export type LibraryAsset = z.infer<typeof LibraryAssetInput> & {
  id: number; project_id: number; revision: number; image_url: string | null;
  status: string; task_id: string | null; source_chapter_ids: string;
};
export class AssetLibraryError extends Error {
  constructor(message: string, public statusCode = 409) { super(message); }
}

const assetNameKey = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/[\s\p{P}]/gu, '');

export function normalizeExtractedAssets(
  rawAssets: Array<{ kind: string; name: string; description?: string; visual_prompt?: string }>,
  existing: Array<Pick<LibraryAsset, 'kind' | 'name'>>,
  characterNames: string[] = [],
): Array<z.infer<typeof LibraryAssetInput>> {
  const characters = new Set(characterNames.map(assetNameKey).filter(Boolean));
  const kindOf = (value: string) => {
    const key = assetNameKey(value);
    if (['location', '场景', '地点', '环境'].map(assetNameKey).includes(key)) return 'location' as const;
    if (['prop', '道具', '物品'].map(assetNameKey).includes(key)) return 'prop' as const;
    return null;
  };
  const normalized: Array<z.infer<typeof LibraryAssetInput>> = [];
  for (const raw of rawAssets) {
    const kind = kindOf(raw.kind);
    const name = String(raw.name || '').replace(/^(?:场景|地点|道具|物品)\s*[：:]\s*/u, '').trim();
    if (!kind || !name || characters.has(assetNameKey(name))) continue;
    const canonical = existing.find((asset) => asset.kind === kind && assetNameKey(asset.name) === assetNameKey(name));
    const data = LibraryAssetInput.parse({
      kind,
      name: canonical?.name || name,
      description: canonical ? '' : String(raw.description || ''),
      visual_prompt: canonical ? '' : String(raw.visual_prompt || ''),
    });
    if (!normalized.some((item) => item.kind === data.kind && assetNameKey(item.name) === assetNameKey(data.name))) normalized.push(data);
  }
  return normalized;
}

export class AssetLibraryService {
  static async requireProject(projectId: number) {
    if (!await db.get('SELECT id FROM project WHERE id = ?', projectId)) throw new AssetLibraryError('Project not found', 404);
  }
  static async list(projectId: number): Promise<LibraryAsset[]> {
    await this.requireProject(projectId);
    return db.all('SELECT * FROM library_asset WHERE project_id = ? ORDER BY kind, id', projectId);
  }
  static async requireAsset(id: number): Promise<LibraryAsset> {
    const row = await db.get('SELECT * FROM library_asset WHERE id = ?', id);
    if (!row) throw new AssetLibraryError('Asset not found', 404);
    return row;
  }
  static async create(projectId: number, input: unknown) {
    await this.requireProject(projectId);
    const data = LibraryAssetInput.parse(input);
    const result = await db.run('INSERT INTO library_asset (project_id, kind, name, description, visual_prompt, english_name) VALUES (?, ?, ?, ?, ?, ?)',
      projectId, data.kind, data.name, data.description, data.visual_prompt, data.english_name || '');
    return this.requireAsset(Number(result.lastID));
  }
  static async update(id: number, expectedRevision: number, input: unknown) {
    const data = LibraryAssetInput.parse(input);
    const previous = await this.requireAsset(id);
    const appearanceChanged = previous.kind !== data.kind || previous.name !== data.name || previous.description !== data.description || previous.visual_prompt !== data.visual_prompt;
    const result = await db.run(`UPDATE library_asset SET kind = ?, name = ?, description = ?, visual_prompt = ?, english_name = COALESCE(?, english_name),
      image_url = CASE WHEN ? THEN NULL ELSE image_url END,
      status = CASE WHEN ? THEN 'idle' ELSE status END,
      task_id = CASE WHEN ? THEN NULL ELSE task_id END, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ? AND status <> 'generating'`,
      data.kind, data.name, data.description, data.visual_prompt, data.english_name ?? null,
      Number(appearanceChanged), Number(appearanceChanged), Number(appearanceChanged), id, expectedRevision);
    if (!result.changes) throw new AssetLibraryError('Asset changed or is generating; refresh before editing');
    return this.requireAsset(id);
  }
  static async remove(id: number) {
    await withImmediateTransaction(async () => {
      const asset = await this.requireAsset(id);
      if (asset.status === 'generating') throw new AssetLibraryError('Cannot delete a generating asset');
      if (await db.get('SELECT scene_id FROM scene_asset_reference WHERE asset_id = ?', id)) throw new AssetLibraryError('Asset is referenced by a shot; remove its references first');
      await db.run('DELETE FROM library_asset WHERE id = ?', id);
    });
  }
  static async extract(chapterId: string, instructions?: string) {
    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapterId);
    if (!chapter) throw new AssetLibraryError('Chapter not found', 404);
    if (!String(chapter.content || '').trim()) throw new AssetLibraryError('Chapter has no content', 400);
    const schema = z.object({
      assets: z.array(z.object({
        kind: z.string(),
        name: z.string(),
        description: z.string().optional().default(''),
        visual_prompt: z.string().optional().default(''),
      })).min(1).max(40),
    });
    const existingAssets = await this.list(Number(chapter.project_id));
    const characters = await db.all('SELECT name FROM character WHERE project_id = ?', chapter.project_id) as Array<{ name: string }>;
    const canonical = existingAssets.map(({ kind, name, description, visual_prompt }) => ({ kind, name, description, visual_prompt }));
    const result = await LLMService.generateStructuredWithRetry(
      `提取本章中实际出现、可重复使用的场景环境(location)和道具(prop)，不提取人物，不虚构。name 用稳定中文名称。` +
      `description 描述空间布局、材质、色彩及连续性；visual_prompt 用英文描述固定外观。` +
      `已有资产是名称和外观的准绳。同一物件或地点再次出现必须复用已有 kind 和 name，不要改名，也不要为人物建档。kind 只能是 location 或 prop。` +
      `不同实体不能仅因材质、颜色或名称相近就合并；按原文分别管理各自的用途与位置。\n` +
      (instructions?.trim() ? `本次提取补充要求：${instructions.trim()}\n` : '') +
      `已有资产：${JSON.stringify(canonical)}\n返回 JSON {assets:[{kind,name,description,visual_prompt}]}。\n本章正文：\n` + chapter.content,
      schema);
    if (!result) throw new AssetLibraryError('Model returned no assets', 502);
    const accepted = normalizeExtractedAssets(result.assets, existingAssets, characters.map((character) => character.name));
    if (!accepted.length) throw new AssetLibraryError('Model returned no location or prop assets', 502);
    return withImmediateTransaction(async () => {
      const fresh = await db.get('SELECT content FROM chapter WHERE id = ?', chapterId);
      if (!fresh || hashChapterContent(fresh.content) !== hashChapterContent(chapter.content)) throw new AssetLibraryError('Chapter changed during extraction');
      const saved: LibraryAsset[] = [];
      for (const data of accepted) {
        const existing = await db.get('SELECT * FROM library_asset WHERE project_id = ? AND kind = ? AND name = ?', chapter.project_id, data.kind, data.name);
        if (existing) {
          const sources = [...new Set([...JSON.parse(existing.source_chapter_ids), chapterId])];
          // Subsequent appearances must preserve approved appearance and generated images.
          await db.run('UPDATE library_asset SET source_chapter_ids = ? WHERE id = ?', JSON.stringify(sources), existing.id);
          saved.push(await this.requireAsset(existing.id));
        } else {
          const created = await this.create(chapter.project_id, data);
          await db.run('UPDATE library_asset SET source_chapter_ids = ? WHERE id = ?', JSON.stringify([chapterId]), created.id);
          saved.push(await this.requireAsset(created.id));
        }
      }
      return saved;
    });
  }
  static async generate(id: number) {
    const asset = await this.requireAsset(id);
    if (!asset.visual_prompt.trim()) throw new AssetLibraryError('An English visual prompt is required', 400);
    const previousTask = asset.status === 'failed' && asset.task_id ? await AssetTaskStore.get(asset.task_id) : null;
    const resumeJobId = /Codex image job ([0-9a-f-]{36}) timed out/i.exec(String(previousTask?.error || ''))?.[1];
    const taskId = randomUUID();
    const claimed = await db.run(`UPDATE library_asset SET status = 'generating', task_id = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND status <> 'generating'`, taskId, id, asset.revision);
    if (!claimed.changes) throw new AssetLibraryError('Asset is already generating');
    const syntheticId = 2_000_000_000 + id;
    await AssetTaskStore.processing(taskId, syntheticId);
    void (async () => {
      try {
        await GenerationService.generateAssets(taskId, {
          library_asset_id: id, gen_type: asset.kind,
          ...(resumeJobId ? { codex_resume_job_id: resumeJobId } : {}),
          prompt: `${asset.visual_prompt}, ${asset.kind === 'location' ? 'environment concept art, empty location, no people' : 'single prop design, isolated object, no people'}`,
          negative_prompt: 'people, person, portrait, text, watermark',
        }, syntheticId);
        const task = await AssetTaskStore.get(taskId);
        await db.run('UPDATE library_asset SET status = ?, image_url = COALESCE(?, image_url), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND task_id = ?',
          task?.status === 'completed' ? 'completed' : 'failed', task?.image_url || null, id, taskId);
      } catch (error) {
        await AssetTaskStore.failed(taskId, syntheticId, error instanceof Error ? error.message : String(error));
        await db.run("UPDATE library_asset SET status = 'failed' WHERE id = ? AND task_id = ?", id, taskId);
      }
    })();
    return { task_id: taskId, status: 'processing' };
  }
  static async references(sceneId: number) {
    return db.all(`SELECT a.*, r.asset_revision, (a.revision <> r.asset_revision) AS stale
      FROM scene_asset_reference r JOIN library_asset a ON a.id = r.asset_id WHERE r.scene_id = ? ORDER BY a.kind, a.id`, sceneId);
  }
  static async bind(sceneId: number, ids: number[]) {
    return withImmediateTransaction(async () => {
      const scene = await db.get('SELECT c.project_id FROM scene s JOIN chapter c ON c.id = s.chapter_id WHERE s.id = ?', sceneId);
      if (!scene) throw new AssetLibraryError('Scene not found', 404);
      const assets = await Promise.all([...new Set(ids)].map(id => this.requireAsset(id)));
      if (assets.some(a => a.project_id !== scene.project_id)) throw new AssetLibraryError('Cross-project asset reference rejected', 400);
      if (assets.filter(a => a.kind === 'location').length > 1) throw new AssetLibraryError('A shot can reference one location', 400);
      if (assets.some(a => a.status !== 'completed' || !a.image_url)) throw new AssetLibraryError('Generate asset images before binding them');
      await db.run('DELETE FROM scene_asset_reference WHERE scene_id = ?', sceneId);
      for (const asset of assets) await db.run('INSERT INTO scene_asset_reference (scene_id, asset_id, asset_revision) VALUES (?, ?, ?)', sceneId, asset.id, asset.revision);
      return this.references(sceneId);
    });
  }
}
