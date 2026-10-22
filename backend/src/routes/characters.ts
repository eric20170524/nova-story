import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/database';
import { CharacterCreateSchema, CharacterUpdateSchema } from '../schemas/character';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { LLMService } from '../services/llm';
import {
  getCharacterAssetPath,
  getUploadAssetPath,
} from '../core/paths';
import { SettingsManager } from '../core/settings_manager';
import {
  buildCharacterPromptHeader,
  CharacterSheetError,
  inferPromptSubjectType,
  ORIENTAL_REALISTIC_FACE_LOCK,
  ORIENTAL_REALISTIC_NEGATIVE,
  readStoredCharacterSheet,
  sealCharacterDesign,
  syncEditableCharacterDesign,
} from '../services/image_generation_policy';
import { PortraitPlateError, readPortraitPlate } from '../services/portrait_plate';
import { resolveTurnaroundStrategy } from '../services/image_output_spec';
import { getProjectImageSettings, parseProjectSettings, resolveEffectiveNsfw } from '../services/project_settings';
import {
  activateCharacterVersion,
  annotateCharacterWithVersions,
  annotateCharactersWithVersions,
  createCharacterVersion,
  ensureCharacterVersionBaseline,
  listCharacterVersions,
  commitCharacterEdits
} from '../services/character_versions';
import { applyTurnaroundPlate } from '../services/character_reference_plates';
import { stripConflictingFaceText } from '../services/turnaround_composite';
import { TtsService, formatVoiceLabel, TtsServiceError } from '../services/tts_service';

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
    voice_id: row.voice_id || null,
    voice_label: row.voice_label || null,
    age: row.age != null && String(row.age).trim() !== '' ? String(row.age).trim() : (serialized.visual_tags?.base_model?.tags?.age || serialized.visual_tags?.age || null)
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

        const visualTags = { ...(profile.visual_tags || {}) };
        const profileAge = (profile.age && String(profile.age).trim()) || (visualTags.age && String(visualTags.age).trim()) || null;
        if (profileAge) visualTags.age = profileAge;
        else delete visualTags.age;
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

          const sealedTags = sealCharacterDesign(existingTags, visualTags, mergedTags);
          await db.run(
            `UPDATE character
             SET role = ?, description = ?, visual_tags = ?, age = COALESCE(?, age)
             WHERE id = ?`,
            profile.role,
            profile.description,
            JSON.stringify(sealedTags),
            profileAge,
            existing.id
          );
          characterId = existing.id;
        } else {
          mergedTags.timeline_map[chapter_id] = 'v1_default';
          const sealedTags = sealCharacterDesign({}, visualTags, mergedTags);
          const result = await db.run(
            `INSERT INTO character (project_id, name, role, description, visual_tags, age)
             VALUES (?, ?, ?, ?, ?, ?)`,
            chapter.project_id,
            profile.name,
            profile.role,
            profile.description,
            JSON.stringify(sealedTags),
            profileAge
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
    if (data.turnaround_url) applyTurnaroundPlate(assets, data.turnaround_url, null);
    if (data.face_url) assets.face_url = data.face_url;
    tags.assets = assets;
    delete tags.model_type;
    delete assets.model_type;

    const ageVal = data.age !== undefined && data.age !== null ? String(data.age).trim() : null;
    if (ageVal) {
      tags.age = ageVal;
      if (tags.base_model?.tags) {
        tags.base_model.tags.age = ageVal;
      }
    }

    const syncedTags = syncEditableCharacterDesign(tags, { description: data.description, age: ageVal });
    const tagsStr = JSON.stringify(syncedTags);

    let voiceId: string | null = null;
    let voiceLabel: string | null = null;

    if (data.voice_id) {
      try {
        const catalog = await TtsService.getVoices();
        const matched = catalog.find((v) => v.id === data.voice_id);
        if (!matched) {
          return reply.status(400).send({
            detail: `Voice "${data.voice_id}" not found in current TTS catalog`,
            code: 'VOICE_NOT_FOUND'
          });
        }
        voiceId = matched.id;
        voiceLabel = formatVoiceLabel(matched);
      } catch (err: any) {
        if (err instanceof TtsServiceError) {
          return reply.status(err.status).send({
            detail: err.message,
            code: err.code
          });
        }
        return reply.status(503).send({
          detail: err.message || 'TTS service unavailable',
          code: 'TTS_UNAVAILABLE'
        });
      }
    }

    const result = await db.run(
      `INSERT INTO character
        (project_id, name, role, description, visual_tags, voice_id, voice_label, english_name, age)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.project_id,
      data.name,
      data.role || null,
      data.description || null,
      tagsStr,
      voiceId,
      voiceLabel,
      data.english_name || '',
      ageVal
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
    await ensureCharacterVersionBaseline(id);
    const previousVisualTags = char.visual_tags;

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
    if (data.english_name !== undefined) {
      updateFields.push('english_name = ?');
      params.push(data.english_name);
    }
    if (data.role !== undefined) {
      updateFields.push('role = ?');
      params.push(data.role);
    }
    if (data.description !== undefined) {
      updateFields.push('description = ?');
      params.push(data.description);
    }
    if (data.personality !== undefined) {
      updateFields.push('personality = ?');
      params.push(data.personality);
    }
    if (data.growth_path !== undefined) {
      updateFields.push('growth_path = ?');
      params.push(data.growth_path);
    }
    if (data.age !== undefined) {
      updateFields.push('age = ?');
      const ageVal = data.age !== null ? String(data.age).trim() : null;
      params.push(ageVal);
    }

    // Voice field validation and handling
    if (data.voice_id !== undefined) {
      if (data.voice_id === null) {
        updateFields.push('voice_id = ?', 'voice_label = ?');
        params.push(null, null);
      } else if (data.voice_id === char.voice_id) {
        // Keep existing voice_id and voice_label without accessing TTS
      } else {
        try {
          const catalog = await TtsService.getVoices();
          const matched = catalog.find((v) => v.id === data.voice_id);
          if (!matched) {
            return reply.status(400).send({
              detail: `Voice "${data.voice_id}" not found in current TTS catalog`,
              code: 'VOICE_NOT_FOUND'
            });
          }
          updateFields.push('voice_id = ?', 'voice_label = ?');
          params.push(matched.id, formatVoiceLabel(matched));
        } catch (err: any) {
          if (err instanceof TtsServiceError) {
            return reply.status(err.status).send({
              detail: err.message,
              code: err.code
            });
          }
          return reply.status(503).send({
            detail: err.message || 'TTS service unavailable',
            code: 'TTS_UNAVAILABLE'
          });
        }
      }
    }

    // Manage visual_tags and embedded properties
    const priorTags = typeof char.visual_tags === 'string' ? JSON.parse(char.visual_tags) : (char.visual_tags || {});
    const priorTurnaroundUrl = priorTags?.assets?.turnaround_url ?? priorTags?.turnaround_url ?? null;
    let tags = priorTags;
    let incomingTags: any = undefined;

    if (data.visual_tags !== undefined) {
      incomingTags = typeof data.visual_tags === 'string' ? JSON.parse(data.visual_tags) : data.visual_tags;
      tags = {
        ...incomingTags,
        assets: {
          ...(priorTags?.assets || {}),
          ...(incomingTags?.assets || {}),
        },
      };
      tags = syncEditableCharacterDesign(
        tags,
        {
          description: data.description !== undefined ? data.description : char.description,
          age: data.age !== undefined ? (data.age !== null ? String(data.age).trim() : null) : char.age,
        },
        { preferFlatEdits: true }
      );
    }

    const assets = tags.assets || {};
    if (data.avatar_url !== undefined) assets.avatar_url = data.avatar_url;
    const nextTurnaroundUrl = data.turnaround_url !== undefined
      ? data.turnaround_url
      : (incomingTags?.assets?.turnaround_front_url === undefined ? incomingTags?.assets?.turnaround_url : undefined);
    if (nextTurnaroundUrl !== undefined) {
      applyTurnaroundPlate(assets, nextTurnaroundUrl, priorTurnaroundUrl);
    }
    if (data.face_url !== undefined) assets.face_url = data.face_url;
    tags.assets = assets;

    delete tags.model_type;
    delete assets.model_type;

    if (data.age !== undefined) {
      const design = tags.design && typeof tags.design === 'object' && !Array.isArray(tags.design)
        ? tags.design
        : null;
      if (data.age !== null && String(data.age).trim()) {
        const ageVal = String(data.age).trim();
        tags.age = ageVal;
        if (tags.base_model?.tags) tags.base_model.tags.age = ageVal;
        if (design) design.age = ageVal;
      } else {
        delete tags.age;
        if (tags.base_model?.tags) delete tags.base_model.tags.age;
        if (design) delete design.age;
      }
    }

    // Always update visual_tags since we merge virtual fields into it
    updateFields.push('visual_tags = ?');
    params.push(JSON.stringify(tags));

    if (updateFields.length > 0) {
      params.push(id);
      await db.run(`UPDATE character SET ${updateFields.join(', ')} WHERE id = ?`, ...params);
      await commitCharacterEdits(id, previousVisualTags);
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
      gen_type: z.string().default('turnaround'),
      custom_description: z.string().optional().nullable(),
      use_ref_portrait: z.boolean().optional(),
      ref_image_url: z.string().optional().nullable(),
      wardrobe_variant: z.string().optional().nullable(),
      turnaround_views: z.array(z.enum(['front'])).optional(),
    });
    const req = bodySchema.parse(request.body);

    const dbChar = await db.get('SELECT * FROM character WHERE id = ?', id);
    if (!dbChar) {
      return reply.status(404).send({ detail: 'Character not found' });
    }

    const tags = typeof dbChar.visual_tags === 'string' ? JSON.parse(dbChar.visual_tags) : (dbChar.visual_tags || {});
    const stored = readStoredCharacterSheet(tags, { description: dbChar.description });
    if (dbChar.age && !stored.appearance.age) {
      stored.appearance.age = String(dbChar.age).trim();
    }
    const assets = tags?.assets || {};
    const storedAvatar = assets?.avatar_url || tags?.avatar_url || dbChar.avatar_url || null;
    const refUrl = req.use_ref_portrait === true ? (req.ref_image_url || storedAvatar || null) : null;
    const systemSettings = SettingsManager.loadSettings();
    const turnaroundStrategy = resolveTurnaroundStrategy({
      imageProvider: systemSettings.image_provider,
      workflowData: req,
    });
    const singleSheetTurnaround = turnaroundStrategy === 'single_sheet';
    const codexImage = systemSettings.image_provider === 'codex';

    const project = await db.get('SELECT settings FROM project WHERE id = ?', dbChar.project_id);
    const projectSettings = parseProjectSettings(project?.settings);
    const nsfwEnabled = resolveEffectiveNsfw({
      systemNsfwEnabled: Boolean(SettingsManager.loadSettings()?.advanced?.nsfw_enabled),
      projectSettings,
    });
    const imageSettings = getProjectImageSettings(projectSettings);
    const effectiveModelType = imageSettings.model;
    const stylePreset = String(imageSettings.style || '').toLowerCase();

    const mustKeepText = Array.isArray(tags?.identity_lock?.must_keep)
      ? tags.identity_lock.must_keep.join(', ')
      : '';
    const subjectContext = [
      dbChar.name,
      dbChar.description,
      stored.appearance.hair,
      stored.appearance.clothing,
      mustKeepText,
    ].filter(Boolean).join(', ');
    const inferredSubject = inferPromptSubjectType(
      subjectContext,
      tags?.subject_type || tags?.species || (stored.gender === 'female' ? 'female_human' : stored.gender === 'male' ? 'male_human' : null)
    );
    const isHumanCharacter = inferredSubject !== 'nonhuman' && inferredSubject !== 'environment';
    // A human full-body plate always follows the approved portrait; use_ref_portrait cannot turn that off.
    const identityRefUrl = req.gen_type === 'turnaround' && isHumanCharacter
      ? (String(req.ref_image_url || storedAvatar || '').trim() || null)
      : refUrl;
    const modelBindsTurnaroundRef =
      effectiveModelType === 'redcraft_krea2'
      || effectiveModelType === 'qwen_image'
      || effectiveModelType === 'pony';
    const identityLocked = req.gen_type === 'turnaround' && Boolean(identityRefUrl) && modelBindsTurnaroundRef;
    const vlmFaceLocked = identityLocked && (effectiveModelType === 'redcraft_krea2' || effectiveModelType === 'qwen_image');
    const effectiveAppearance = vlmFaceLocked
      ? { ...stored.appearance, face: stripConflictingFaceText(stored.appearance.face || '') }
      : stored.appearance;

    let header: { prefix: string; negative: string };
    try {
      header = buildCharacterPromptHeader(
        effectiveModelType,
        nsfwEnabled,
        req.gen_type,
        stored.gender,
        effectiveAppearance,
      );
    } catch (error) {
      if (error instanceof CharacterSheetError) {
        return reply.status(400).send({ detail: error.message });
      }
      throw error;
    }

    let refHint = "";
    if (identityRefUrl && (req.use_ref_portrait === true || req.gen_type === 'turnaround')) {
      refHint = ", matching reference character design, consistent face hair and clothing";
    }
    if (
      (req.gen_type === 'portrait' || req.gen_type === 'turnaround')
      && isHumanCharacter
      && stored.gender === 'unspecified'
    ) {
      return reply.status(400).send({ detail: '角色缺少性别，定妆已停止。请在角色设定中标明男女。' });
    }
    if (req.gen_type === 'turnaround' && isHumanCharacter) {
      try {
        const candidatePortrait = String(req.ref_image_url || storedAvatar || '').trim();
        await readPortraitPlate(candidatePortrait);
      } catch (error) {
        if (error instanceof PortraitPlateError) {
          return reply.status(400).send({ detail: error.message });
        }
        throw error;
      }
    }
    const isWesternStyle = /western_comic/i.test(stylePreset);
    const isOrientalRealistic = /oriental_realistic/i.test(stylePreset) || /oriental_realistic/i.test(projectSettings.style || '') || /oriental_realistic/i.test(projectSettings.image_generation?.style || '');

    let prompt = "";
    let negativePrompt = header.negative;
    if (isHumanCharacter && isWesternStyle) {
      if (!negativePrompt.includes('east asian')) {
        negativePrompt += ', oriental, classical chinese, east asian facial features, anime, cartoon, hanfu';
      }
    } else if (isHumanCharacter && !isWesternStyle && !negativePrompt.includes('caucasian')) {
      negativePrompt += isOrientalRealistic
        ? `, ${ORIENTAL_REALISTIC_NEGATIVE}`
        : ', caucasian, western face, european facial structure, deep-set western eyes, prominent brow ridge, high nose bridge, deep eye sockets, european, western facial features';
    }

    if (req.gen_type === "turnaround") {
      // Simplified turnaround: generates only the canonical orthographic front full-body reference.
      prompt = singleSheetTurnaround
        ? `${header.prefix}. Full-body direct orthographic front view standing character reference, head to toe, neutral standing A-pose, unobstructed silhouette, feet visible, solid pure white opaque studio background, completely opaque, no transparency, no checkerboard, no labels, no letters, no watermark.${identityRefUrl ? ' Match the supplied portrait for identity.' : ''}`
        : `${header.prefix}, full body, direct orthographic front view, neutral standing A-pose, character reference${refHint}`;
    } else {
      prompt = codexImage
        ? `${header.prefix}. Upper-body front portrait, waist-up, front view, eye-level, facing camera, both shoulders visible, detailed face and eyes, neutral expression, clothes visible only at the collar and shoulders, empty hands, plain studio background, no writing, no watermark.`
        : `${header.prefix}${refHint}`;
    }

    if (isHumanCharacter && isWesternStyle) {
      if (!/(western|caucasian)/i.test(prompt)) {
        prompt += ', western comic book style, graphic novel shading';
      }
    } else if (isHumanCharacter && !isWesternStyle) {
      if (isOrientalRealistic) {
        if (!/^oriental realistic style\b/i.test(prompt)) {
          // With a bound portrait the reference owns the face: keep the style, drop the face text.
          prompt = identityLocked
            ? `oriental realistic style, photorealistic, natural porcelain skin texture, subsurface scattering, realistic human anatomy, ${prompt}`
            : `${ORIENTAL_REALISTIC_FACE_LOCK}, ${prompt}`;
        }
      } else if (!identityLocked && !/(east asian|oriental|chinese|asian)/i.test(prompt)) {
        prompt += ', East Asian facial features, delicate classical oriental bone structure, soft East Asian eyelids';
      }
    }

    const activeRefUrl = req.gen_type === 'turnaround' && Boolean(identityRefUrl)
      ? identityRefUrl
      : (req.use_ref_portrait === true ? (identityRefUrl || null) : null);
    return {
      prompt,
      negative_prompt: negativePrompt,
      model_type: effectiveModelType,
      gen_type: req.gen_type,
      nsfw_enabled: nsfwEnabled,
      ref_image_url: activeRefUrl,
      character_ref_url: activeRefUrl,
      turnaround_front_adapter: req.gen_type === 'turnaround' ? Boolean(activeRefUrl) : undefined,
      turnaround_strategy: req.gen_type === 'turnaround' ? turnaroundStrategy : undefined,
      turnaround_pipeline: req.gen_type === 'turnaround'
        ? singleSheetTurnaround ? 'codex_single_sheet' : 'front_full_body'
        : undefined,
      ...(req.gen_type === 'turnaround' && req.turnaround_views?.length
        ? { turnaround_views: req.turnaround_views }
        : {}),
      ...(req.gen_type === 'turnaround' && String(req.wardrobe_variant || '').trim()
        ? { wardrobe_variant: String(req.wardrobe_variant).trim() }
        : {}),
    };
  });

  const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

  app.post('/upload-image', async (request, reply) => {
    const data = await request.file();
    if (!data) {
        return reply.status(400).send({ detail: 'No file uploaded' });
    }

    const ext = (path.extname(data.filename) || '.png').toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
      return reply.status(400).send({ detail: `Invalid file extension '${ext}'. Allowed: .png, .jpg, .jpeg, .webp` });
    }

    const filename = `upload_${crypto.randomUUID().substring(0, 10)}${ext}`;
    const pathResult = getUploadAssetPath(filename);

    const buffer = await data.toBuffer();
    await fs.promises.writeFile(pathResult.filepath, buffer);

    return { url: pathResult.url };
  });

  app.post('/:id/upload-asset', async (request, reply) => {
    const paramsSchema = z.object({ id: z.coerce.number() });
    const { id } = paramsSchema.parse(request.params);

    const dbChar = await db.get('SELECT * FROM character WHERE id = ?', id);
    if (!dbChar) {
      return reply.status(404).send({ detail: 'Character not found' });
    }

    const parts = request.parts();
    let assetType = '';
    let buffer: Buffer | null = null;
    let ext = '.png';

    for await (const part of parts) {
      if (part.type === 'file') {
        ext = (path.extname(part.filename) || '.png').toLowerCase();
        if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
          return reply.status(400).send({ detail: `Invalid file extension '${ext}'. Allowed: .png, .jpg, .jpeg, .webp` });
        }
        buffer = await part.toBuffer();
      } else {
        if (part.fieldname === 'asset_type') {
          assetType = part.value as string;
        }
      }
    }

    if (!buffer || !assetType) {
      return reply.status(400).send({ detail: 'Missing file or asset_type' });
    }

    if (!['avatar', 'turnaround', 'face'].includes(assetType)) {
      return reply.status(400).send({ detail: `Invalid asset_type '${assetType}'. Allowed: avatar, turnaround, face` });
    }

    const filename = `upload_${assetType}_${id}_${crypto.randomUUID().substring(0, 8)}${ext}`;
    const pathResult = getCharacterAssetPath({
      projectId: dbChar.project_id,
      characterId: id,
      version: dbChar.active_version || 1,
      filename
    });
    await fs.promises.writeFile(pathResult.filepath, buffer);

    if (assetType === 'avatar') {
      try {
        await readPortraitPlate(pathResult.url);
      } catch (error) {
        try { await fs.promises.unlink(pathResult.filepath); } catch { /* ignore */ }
        if (error instanceof PortraitPlateError) {
          return reply.status(400).send({ detail: error.message });
        }
        throw error;
      }
    }

    await ensureCharacterVersionBaseline(id);
    const previousVisualTags = dbChar.visual_tags;
    const assetUrl = pathResult.url;
    const tags = typeof dbChar.visual_tags === 'string' ? JSON.parse(dbChar.visual_tags) : (dbChar.visual_tags || {});
    const assets = tags.assets || {};

    if (assetType === 'avatar') {
      assets.avatar_url = assetUrl;
    } else if (assetType === 'turnaround') {
      applyTurnaroundPlate(assets, assetUrl);
    } else if (assetType === 'face') {
      assets.face_url = assetUrl;
    }

    tags.assets = assets;
    await db.run('UPDATE character SET visual_tags = ? WHERE id = ?', JSON.stringify(tags), id);
    await commitCharacterEdits(id, previousVisualTags);

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
