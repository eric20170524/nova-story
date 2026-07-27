import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/database';
import { CharacterCreateSchema, CharacterUpdateSchema } from '../schemas/character';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Dummy implementation of current_user auth
const mockGetCurrentUser = (request: any) => ({
  id: 'local_admin'
});

const serializeCharacter = (row: any) => {
  return {
    ...row,
    visual_tags: typeof row.visual_tags === 'string' ? JSON.parse(row.visual_tags) : (row.visual_tags || {})
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
    return rows.map(serializeCharacter);
  });

  app.get('/:id', async (request, reply) => {
    const paramsSchema = z.object({ id: z.coerce.number() });
    const { id } = paramsSchema.parse(request.params);

    const char = await db.get('SELECT * FROM character WHERE id = ?', id);
    if (!char) {
      return reply.status(404).send({ detail: 'Character not found' });
    }
    return serializeCharacter(char);
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

    // Simulate properties for the frontend that exist in the Pydantic model but not in DB directly
    const charToReturn = serializeCharacter(newChar);
    charToReturn.avatar_url = charToReturn.visual_tags?.assets?.avatar_url;
    charToReturn.turnaround_url = charToReturn.visual_tags?.assets?.turnaround_url;
    charToReturn.face_url = charToReturn.visual_tags?.assets?.face_url;
    charToReturn.model_type = charToReturn.visual_tags?.model_type || 'pony';

    return charToReturn;
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
    }

    const updatedChar = await db.get('SELECT * FROM character WHERE id = ?', id);
    const charToReturn = serializeCharacter(updatedChar);
    charToReturn.avatar_url = charToReturn.visual_tags?.assets?.avatar_url;
    charToReturn.turnaround_url = charToReturn.visual_tags?.assets?.turnaround_url;
    charToReturn.face_url = charToReturn.visual_tags?.assets?.face_url;
    charToReturn.model_type = charToReturn.visual_tags?.model_type || 'pony';

    return charToReturn;
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

    let prompt = "";
    let negativePrompt = "";

    if (req.model_type.toLowerCase() === "pony") {
      if (req.gen_type === "turnaround") {
        prompt = `score_9, score_8_up, score_7_up, character turnaround sheet, full body model sheet, multi-view layout, front view, side view, back view, 3 views, aligned character turnaround, consistent character design, ${genderTag}, simple background, solid white background, ${combinedDesc}${refHintPony}`;
        negativePrompt = "score_4, score_3, score_2, score_1, bad anatomy, low quality, worst quality, cropped head, blurry, extra limbs, mismatched clothing, inconsistent face";
      } else {
        prompt = `score_9, score_8_up, score_7_up, portrait, upper body, front view, ${genderTag}, simple background, white background, masterpiece, detailed face and eyes, ${combinedDesc}`;
        negativePrompt = "score_4, score_3, score_2, score_1, bad anatomy, low quality, worst quality, distorted face";
      }
    } else {
      if (req.gen_type === "turnaround") {
        prompt = `full body character turnaround sheet, split view layout, front view, side view, back view, complete 3-view character model sheet, character reference sheet, consistent character design from all angles, clean studio white background, masterpiece quality, ${genderTag}, ${combinedDesc}${refHintFlux}`;
        negativePrompt = "low quality, distorted face, bad anatomy, extra limbs, cluttered background, inconsistent costume";
      } else {
        prompt = `high quality character portrait, front view, ${genderTag}, detailed face and eyes, clean studio background, ${combinedDesc}`;
        negativePrompt = "low quality, blurry, bad anatomy, distorted face";
      }
    }

    return {
      prompt,
      negative_prompt: negativePrompt,
      model_type: req.model_type,
      gen_type: req.gen_type,
      ref_image_url: req.use_ref_portrait ? refUrl : null
    };
  });

  // Note: /crop-face, /train-lora, /upload-image, /upload-asset implementations involve sharp/jimp for cropping and multipart parsing
  // Setting up placeholders for phase 3, logic can be imported from node libs.
  app.post('/:id/crop-face', async (request, reply) => {
    // Skipping PIL-based image crop logic for now, returning dummy.
    return reply.status(501).send({ detail: 'Not implemented in fastify phase 3 yet' });
  });

  app.post('/:id/train-lora', async (request, reply) => {
    return reply.status(501).send({ detail: 'Not implemented in fastify phase 3 yet' });
  });

  app.post('/upload-image', async (request, reply) => {
    return reply.status(501).send({ detail: 'Not implemented in fastify phase 3 yet (Requires @fastify/multipart)' });
  });

  app.post('/:id/upload-asset', async (request, reply) => {
    return reply.status(501).send({ detail: 'Not implemented in fastify phase 3 yet (Requires @fastify/multipart)' });
  });
};
