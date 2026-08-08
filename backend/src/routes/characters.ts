import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/database';
import { CharacterCreateSchema, CharacterUpdateSchema } from '../schemas/character';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { LLMService } from '../services/llm';
import { getGeneratedDirectory } from '../core/paths';
import { SettingsManager } from '../core/settings_manager';
import { buildCharacterPromptHeader } from '../services/image_generation_policy';
import {
  activateCharacterVersion,
  annotateCharacterWithVersions,
  annotateCharactersWithVersions,
  createCharacterVersion,
  ensureCharacterVersionBaseline,
  listCharacterVersions,
  syncActiveCharacterVersion
} from '../services/character_versions';

// Dummy implementation of current_user auth
const mockGetCurrentUser = (request: any) => ({
  id: 'local_admin'
});

const serializeCharacter = (row: any) => {
  const serialized = {
    ...row,
    visual_tags: typeof row.visual_tags === 'string' ? JSON.parse(row.visual_tags) : (row.visual_tags || {})
  };
  const assets = serialized.visual_tags?.assets || {};
  return {
    ...serialized,
    avatar_url: assets.avatar_url || null,
    turnaround_url: assets.turnaround_url || null,
    face_url: assets.face_url || null,
    model_type: serialized.visual_tags?.model_type || 'pony'
  };
};

export const characterRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const querySchema = z.object({
      project_id: z.coerce.number().optional()
    });
    const { project_id } = querySchema.parse(request.query);

    let sql = 'SELECT * FROM character';
    let params: any[] = [];
    if (project_id !== undefined) {
      sql += ' WHERE project_id = ?';
      params.push(project_id);
    }

    const rows = await db.all(sql, ...params);
    return annotateCharactersWithVersions(rows || [], serializeCharacter);
  });

  app.post('/extract', async (request, reply) => {
    const bodySchema = z.object({
      chapter_id: z.string().min(1)
    });
    const { chapter_id } = bodySchema.parse(request.body);

    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapter_id);
    if (!chapter) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }
    if (!chapter.content?.trim()) {
      return reply.status(400).send({ detail: 'Chapter has no content' });
    }

    const profiles = await LLMService.extractCharacterProfiles(chapter.content);
    if (!profiles.length) {
      return reply.status(502).send({ detail: 'LLM returned no character profiles' });
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const savedCharacters = [];

      for (const profile of profiles) {
        const existing = await db.get(
          'SELECT * FROM character WHERE project_id = ? AND TRIM(name) = TRIM(?) COLLATE NOCASE LIMIT 1',
          chapter.project_id,
          profile.name
        );

        let existingTags: any = {};
        if (existing?.visual_tags) {
          try {
            existingTags = typeof existing.visual_tags === 'string'
              ? JSON.parse(existing.visual_tags)
              : existing.visual_tags;
          } catch {
            existingTags = {};
          }
        }

        const visualTags = profile.visual_tags || {};
        const mergedTags: any = {
          ...existingTags,
          timeline_map: existingTags.timeline_map || {},
          variants: existingTags.variants || [{
            id: 'v1_default',
            name: 'Default',
            tags: visualTags
          }],
          base_model: {
            ...(existingTags.base_model || {}),
            tags: {
              ...(existingTags.base_model?.tags || {}),
              ...visualTags
            }
          },
          assets: existingTags.assets || {},
          model_type: existingTags.model_type || 'pony'
        };

        let characterId: number;
        if (existing) {
          const evolution = await LLMService.analyzeCharacterEvolution(
            {
              name: existing.name,
              role: existing.role,
              description: existing.description,
              visual_tags: mergedTags
            },
            chapter.content
          );

          if (evolution.action === 'new_variant' && evolution.new_variant) {
            const variantId = `var_${crypto.randomUUID().substring(0, 8)}`;
            mergedTags.variants.push({
              id: variantId,
              name: evolution.new_variant.name,
              tags: evolution.new_variant.tags
            });
            mergedTags.timeline_map[chapter_id] = variantId;
          } else {
            const activeVariantId = mergedTags.timeline_map[chapter_id]
              || mergedTags.variants[mergedTags.variants.length - 1]?.id
              || 'v1_default';
            mergedTags.timeline_map[chapter_id] = activeVariantId;
            if (evolution.action === 'scene_modifier' && evolution.modifier_tags) {
              mergedTags.scene_modifiers = mergedTags.scene_modifiers || {};
              mergedTags.scene_modifiers[chapter_id] = evolution.modifier_tags;
            }
          }

          await db.run(
            `UPDATE character
             SET role = ?, description = ?, visual_tags = ?
             WHERE id = ?`,
            profile.role,
            profile.description,
            JSON.stringify(mergedTags),
            existing.id
          );
          characterId = existing.id;
        } else {
          mergedTags.timeline_map[chapter_id] = 'v1_default';
          const result = await db.run(
            `INSERT INTO character (project_id, name, role, description, visual_tags)
             VALUES (?, ?, ?, ?, ?)`,
            chapter.project_id,
            profile.name,
            profile.role,
            profile.description,
            JSON.stringify(mergedTags)
          );
          characterId = Number(result.lastID);
        }

        const saved = await db.get('SELECT * FROM character WHERE id = ?', characterId);
        savedCharacters.push(serializeCharacter(saved));
      }

      await db.exec('COMMIT');
      return savedCharacters;
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  });

  app.get('/:id', async (request, reply) => {
    const paramsSchema = z.object({ id: z.coerce.number() });
    const { id } = paramsSchema.parse(request.params);

    const char = await db.get('SELECT * FROM character WHERE id = ?', id);
    if (!char) {
      return reply.status(404).send({ detail: 'Character not found' });
    }
    return annotateCharacterWithVersions(char, serializeCharacter);
  });

  app.post('/', async (request, reply) => {
    const data = CharacterCreateSchema.parse(request.body);
    const tags = (typeof data.visual_tags === 'string' ? JSON.parse(data.visual_tags) : data.visual_tags) || {};

    // The SQLite db only has the 'visual_tags' JSON column according to `app/models/character.py`.
    // Additional fields are stored in the JSON in the python implementation.
    const assets = tags.assets || {};
    if (data.avatar_url) assets.avatar_url = data.avatar_url;
    if (data.turnaround_url) assets.turnaround_url = data.turnaround_url;
    if (data.face_url) assets.face_url = data.face_url;
    tags.assets = assets;
    tags.model_type = data.model_type || 'pony';

    const tagsStr = JSON.stringify(tags);

    const result = await db.run(
      `INSERT INTO character
        (project_id, name, role, description, visual_tags)
       VALUES (?, ?, ?, ?, ?)`,
      data.project_id,
      data.name,
      data.role || null,
      data.description || null,
      tagsStr
    );

    const newChar = await db.get('SELECT * FROM character WHERE id = ?', result.lastID);
    if (newChar) {
      await ensureCharacterVersionBaseline(newChar.id);
    }
    return annotateCharacterWithVersions(newChar, serializeCharacter);
  });

  app.put('/:id', async (request, reply) => {
    const paramsSchema = z.object({ id: z.coerce.number() });
    const { id } = paramsSchema.parse(request.params);

    const char = await db.get('SELECT * FROM character WHERE id = ?', id);
    if (!char) {
      return reply.status(404).send({ detail: 'Character not found' });
    }

    const data = CharacterUpdateSchema.parse(request.body);
    const updateFields = [];
    const params = [];

    if (data.project_id !== undefined) {
      updateFields.push('project_id = ?');
      params.push(data.project_id);
    }
    if (data.name !== undefined) {
      updateFields.push('name = ?');
      params.push(data.name);
    }
    if (data.role !== undefined) {
      updateFields.push('role = ?');
      params.push(data.role);
    }
    if (data.description !== undefined) {
      updateFields.push('description = ?');
      params.push(data.description);
    }

    // Manage visual_tags and embedded properties
    let tags = typeof char.visual_tags === 'string' ? JSON.parse(char.visual_tags) : (char.visual_tags || {});

    if (data.visual_tags !== undefined) {
      tags = typeof data.visual_tags === 'string' ? JSON.parse(data.visual_tags) : data.visual_tags;
    }

    const assets = tags.assets || {};
    if (data.avatar_url !== undefined) assets.avatar_url = data.avatar_url;
    if (data.turnaround_url !== undefined) assets.turnaround_url = data.turnaround_url;
    if (data.face_url !== undefined) assets.face_url = data.face_url;
    tags.assets = assets;

    if (data.model_type !== undefined) tags.model_type = data.model_type;

    // Always update visual_tags since we merge virtual fields into it
    updateFields.push('visual_tags = ?');
    params.push(JSON.stringify(tags));

    if (updateFields.length > 0) {
      params.push(id);
      await db.run(`UPDATE character SET ${updateFields.join(', ')} WHERE id = ?`, ...params);
      await syncActiveCharacterVersion(id);
    }

    const updatedChar = await db.get('SELECT * FROM character WHERE id = ?', id);
    return annotateCharacterWithVersions(updatedChar, serializeCharacter);
  });

  app.delete('/:id', async (request, reply) => {
    const paramsSchema = z.object({ id: z.coerce.number() });
    const { id } = paramsSchema.parse(request.params);

    const char = await db.get('SELECT * FROM character WHERE id = ?', id);
    if (!char) {
      return reply.status(404).send({ detail: 'Character not found' });
    }

    await db.run('DELETE FROM character WHERE id = ?', id);
    return serializeCharacter(char);
  });

  app.post('/:id/build-prompt', async (request, reply) => {
    const paramsSchema = z.object({ id: z.coerce.number() });
    const { id } = paramsSchema.parse(request.params);

    const bodySchema = z.object({
      model_type: z.string().default('pony'),
      gen_type: z.string().default('turnaround'),
      custom_description: z.string().optional().nullable(),
      use_ref_portrait: z.boolean().default(true),
      ref_image_url: z.string().optional().nullable()
    });
    const req = bodySchema.parse(request.body);

    const dbChar = await db.get('SELECT * FROM character WHERE id = ?', id);
    if (!dbChar) {
      return reply.status(404).send({ detail: 'Character not found' });
    }

    const desc = req.custom_description || dbChar.description || "";
    const tags = typeof dbChar.visual_tags === 'string' ? JSON.parse(dbChar.visual_tags) : (dbChar.visual_tags || {});
    const baseTags = tags?.base_model?.tags || {};

    let tagStr = "";
    if (typeof baseTags === 'object') {
      tagStr = Object.values(baseTags).filter(v => typeof v === 'string').join(', ');
    }

    const combinedDesc = `${desc}, ${tagStr}`.replace(/,\s*$/, "");

    const assets = tags?.assets || {};
    const refUrl = req.ref_image_url || assets?.avatar_url || tags?.avatar_url || dbChar.avatar_url;

    const checkStr = `${desc} ${tagStr} ${dbChar.name || ''}`.toLowerCase();
    const maleKeywords = ["male", "boy", "man", "1boy", "男", "少年", "青年", "公子", "老者", "男子", "皇帝", "国王"];
    const isMale = maleKeywords.some(kw => checkStr.includes(kw));
    const genderTag = isMale ? "1boy, solo, male" : "1girl, solo, female";

    let refHintPony = "";
    let refHintFlux = "";
    if (req.use_ref_portrait && refUrl) {
      refHintPony = ", (matching reference character design:1.2), consistent facial features, same outfit and hair across all views";
      refHintFlux = ", (consistent character appearance matching reference portrait:1.2), same costume and facial features across all 3 angles";
    }

    const nsfwEnabled = Boolean(SettingsManager.loadSettings()?.advanced?.nsfw_enabled);
    const modelFamily = req.model_type.toLowerCase().includes('flux') ? 'flux' as const : 'pony' as const;
    const header = buildCharacterPromptHeader(modelFamily, nsfwEnabled, req.gen_type);

    let prompt = "";
    let negativePrompt = header.negative;

    if (modelFamily === "pony") {
      if (req.gen_type === "turnaround") {
        // Appearance base only — GenerationService runs 3 full-body panels + stitch
        prompt = `${header.prefix}, ${genderTag}, full body, standing, character reference, ${combinedDesc}${refHintPony}`;
      } else {
        prompt = `${header.prefix}, ${genderTag}, simple background, white background, ${combinedDesc}`;
      }
    } else {
      if (req.gen_type === "turnaround") {
        prompt = `${header.prefix}, ${genderTag}, full body, standing, character reference, ${combinedDesc}${refHintFlux}`;
      } else {
        prompt = `${header.prefix}, ${genderTag}, ${combinedDesc}`;
      }
    }

    return {
      prompt,
      negative_prompt: negativePrompt,
      model_type: req.model_type,
      gen_type: req.gen_type,
      nsfw_enabled: nsfwEnabled,
      ref_image_url: req.use_ref_portrait ? refUrl : null,
      // Document composite pipeline for clients
      turnaround_pipeline: req.gen_type === 'turnaround' ? 'three_views_stitch' : undefined
    };
  });

  app.post('/:id/crop-face', async (request, reply) => {
    const paramsSchema = z.object({ id: z.coerce.number() });
    const { id } = paramsSchema.parse(request.params);

    const dbChar = await db.get('SELECT * FROM character WHERE id = ?', id);
    if (!dbChar) {
      return reply.status(404).send({ detail: 'Character not found' });
    }

    const tags = typeof dbChar.visual_tags === 'string' ? JSON.parse(dbChar.visual_tags) : (dbChar.visual_tags || {});
    const assets = tags.assets || {};
    const srcUrl = assets.turnaround_url || assets.avatar_url;

    if (!srcUrl) {
      return reply.status(400).send({ detail: 'No turnaround or avatar image available for face cropping' });
    }

    const staticDir = getGeneratedDirectory();
    const filename = path.basename(srcUrl);
    const filepath = path.join(staticDir, filename);

    if (!fs.existsSync(filepath)) {
      assets.face_url = srcUrl;
      tags.assets = assets;
      await db.run('UPDATE character SET visual_tags = ? WHERE id = ?', JSON.stringify(tags), id);
      const updatedChar = await db.get('SELECT * FROM character WHERE id = ?', id);
      return serializeCharacter(updatedChar);
    }

    try {
      const sharp = require('sharp');
      const metadata = await sharp(filepath).metadata();
      if (metadata.width && metadata.height) {
        const left = Math.floor(metadata.width * 0.05);
        const top = Math.floor(metadata.height * 0.05);
        const width = Math.floor(metadata.width * 0.40);
        const height = Math.floor(metadata.height * 0.40);

        const faceFilename = `face_${id}_${crypto.randomUUID().substring(0, 8)}.png`;
        const faceFilepath = path.join(staticDir, faceFilename);

        await sharp(filepath)
          .extract({ left, top, width, height })
          .toFile(faceFilepath);

        assets.face_url = `/static/generated/${faceFilename}`;
        tags.assets = assets;
        await db.run('UPDATE character SET visual_tags = ? WHERE id = ?', JSON.stringify(tags), id);
      }
    } catch (e) {
      assets.face_url = srcUrl;
      tags.assets = assets;
      await db.run('UPDATE character SET visual_tags = ? WHERE id = ?', JSON.stringify(tags), id);
    }

    const updatedChar = await db.get('SELECT * FROM character WHERE id = ?', id);
    return serializeCharacter(updatedChar);
  });

  app.post('/:id/train-lora', async (request, reply) => {
    const paramsSchema = z.object({ id: z.coerce.number() });
    const { id } = paramsSchema.parse(request.params);

    const dbChar = await db.get('SELECT * FROM character WHERE id = ?', id);
    if (!dbChar) {
      return reply.status(404).send({ detail: 'Character not found' });
    }

    const tags = typeof dbChar.visual_tags === 'string' ? JSON.parse(dbChar.visual_tags) : (dbChar.visual_tags || {});
    const assets = tags.assets || {};

    const loraFilename = `char_${id}_${dbChar.name.toLowerCase().replace(/ /g, '_')}.safetensors`;

    // Simulate training logic that drops the dummy file in ComfyUI models dir
    // Not actually spinning up Kohya_ss
    assets.lora_path = loraFilename;
    assets.lora_ready = true;
    tags.assets = assets;

    await db.run('UPDATE character SET visual_tags = ? WHERE id = ?', JSON.stringify(tags), id);

    const updatedChar = await db.get('SELECT * FROM character WHERE id = ?', id);
    return serializeCharacter(updatedChar);
  });

  app.post('/upload-image', async (request, reply) => {
    const data = await request.file();
    if (!data) {
        return reply.status(400).send({ detail: 'No file uploaded' });
    }

    const staticDir = getGeneratedDirectory();
    if (!fs.existsSync(staticDir)) {
      fs.mkdirSync(staticDir, { recursive: true });
    }

    const ext = path.extname(data.filename) || '.png';
    const filename = `upload_${crypto.randomUUID().substring(0, 10)}${ext}`;
    const filepath = path.join(staticDir, filename);

    const buffer = await data.toBuffer();
    fs.writeFileSync(filepath, buffer);

    return { url: `/static/generated/${filename}` };
  });

  app.post('/:id/upload-asset', async (request, reply) => {
    const paramsSchema = z.object({ id: z.coerce.number() });
    const { id } = paramsSchema.parse(request.params);

    const dbChar = await db.get('SELECT * FROM character WHERE id = ?', id);
    if (!dbChar) {
      return reply.status(404).send({ detail: 'Character not found' });
    }

    const staticDir = getGeneratedDirectory();
    if (!fs.existsSync(staticDir)) {
      fs.mkdirSync(staticDir, { recursive: true });
    }

    const parts = request.parts();
    let assetType = '';
    let buffer: Buffer | null = null;
    let ext = '.png';

    for await (const part of parts) {
      if (part.type === 'file') {
        buffer = await part.toBuffer();
        ext = path.extname(part.filename) || '.png';
      } else {
        if (part.fieldname === 'asset_type') {
          assetType = part.value as string;
        }
      }
    }

    if (!buffer || !assetType) {
      return reply.status(400).send({ detail: 'Missing file or asset_type' });
    }

    const filename = `upload_${assetType}_${id}_${crypto.randomUUID().substring(0, 8)}${ext}`;
    const filepath = path.join(staticDir, filename);
    fs.writeFileSync(filepath, buffer);

    const assetUrl = `/static/generated/${filename}`;
    const tags = typeof dbChar.visual_tags === 'string' ? JSON.parse(dbChar.visual_tags) : (dbChar.visual_tags || {});
    const assets = tags.assets || {};

    if (assetType === 'avatar') {
      assets.avatar_url = assetUrl;
    } else if (assetType === 'turnaround') {
      assets.turnaround_url = assetUrl;
    } else if (assetType === 'face') {
      assets.face_url = assetUrl;
    }

    tags.assets = assets;
    await db.run('UPDATE character SET visual_tags = ? WHERE id = ?', JSON.stringify(tags), id);
    await syncActiveCharacterVersion(id);

    const updatedChar = await db.get('SELECT * FROM character WHERE id = ?', id);
    return annotateCharacterWithVersions(updatedChar, serializeCharacter);
  });

  // --- Character visual versions (description + tags + assets) ---

  app.get('/:id/versions', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const char = await db.get('SELECT * FROM character WHERE id = ?', id);
    if (!char) return reply.status(404).send({ detail: 'Character not found' });
    const versions = await listCharacterVersions(id);
    return {
      character_id: id,
      active_version: Number(char.active_version || 1),
      versions
    };
  });

  app.post('/:id/versions', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const body = z
      .object({
        from_version: z.coerce.number().optional().nullable(),
        clear_assets: z.boolean().optional().default(true),
        label: z.string().optional().nullable(),
        activate: z.boolean().optional().default(true)
      })
      .parse(request.body || {});

    const char = await db.get('SELECT * FROM character WHERE id = ?', id);
    if (!char) return reply.status(404).send({ detail: 'Character not found' });

    const created = await createCharacterVersion(id, {
      fromVersion: body.from_version,
      clearAssets: body.clear_assets,
      label: body.label,
      activate: body.activate
    });
    if (!created) return reply.status(500).send({ detail: 'Failed to create character version' });

    const annotated = await annotateCharacterWithVersions(
      await db.get('SELECT * FROM character WHERE id = ?', id),
      serializeCharacter
    );
    return {
      character: annotated,
      version: created.version,
      versions: annotated.versions
    };
  });

  app.post('/:id/versions/:version/activate', async (request, reply) => {
    const params = z
      .object({ id: z.coerce.number(), version: z.coerce.number() })
      .parse(request.params);
    const char = await activateCharacterVersion(params.id, params.version);
    if (!char) return reply.status(404).send({ detail: 'Version not found' });
    return annotateCharacterWithVersions(char, serializeCharacter);
  });
};
