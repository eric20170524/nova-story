import { z } from 'zod';
import { db } from '../db/database';
import { LLMService } from './llm';
import { syncActiveVersionFromScene } from './scene_versions';

const SceneNarrationResponseSchema = z.object({
  scenes: z.array(z.object({
    scene_id: z.coerce.number().int(),
    narration: z.string().trim().min(1).max(240),
  })).min(1),
});

export const buildSceneNarrationPrompt = (chapter: any, scenes: any[]): string => {
  const sourceText = String(chapter.content || '');
  const firstPerson = /(?:^|[。！？\n])\s*我|我的|让我|令我|向我|对我/.test(sourceText);
  const scenePayload = scenes.map((scene) => ({
    scene_id: Number(scene.id),
    index: Number(scene.index),
    shot_type: scene.shot_type || '',
    visual_prompt: scene.visual_prompt || '',
    dialogue: scene.dialogue || '',
  }));

  return `You are a Chinese comic narration editor running locally.
Create concise narration captions that make the storyboard understandable without changing its images.

Rules:
1. Return exactly one item for every supplied scene_id, in the same order.
2. Write narration in the same language and narrative viewpoint as the chapter. Preserve first-person “我” when the source uses it.
3. Each caption should normally be 12-35 Chinese characters and no more than two short sentences.
4. Preserve plot order, emotion, causal links, discoveries, and decisions from the source. Do not invent facts, dialogue, names, or spoilers.
5. Do not repeat adjacent captions. Do not describe camera technique or image quality.
6. Spoken words already present in dialogue remain separate; narration must not prefix speaker names or quotation marks.
7. Output JSON only: {"scenes":[{"scene_id":123,"narration":"caption"}]}.
8. ${firstPerson
    ? 'MANDATORY FIRST-PERSON VOICE: the source is narrated by “我”. Write every caption as the protagonist’s own observation, feeling, memory, or decision. Use “我/我的/让我” naturally; never turn it into an external camera description.'
    : 'Keep the source narrator viewpoint; do not switch into first person unless the source does.'}

Chapter title: ${chapter.title || ''}
Original chapter text:
${sourceText}

Existing storyboard scenes:
${JSON.stringify(scenePayload, null, 2)}`;
};

const normalizeCaption = (value: string): string => {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  return chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : normalized;
};

export const generateSceneNarrationForChapter = async (chapterId: string) => {
  const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapterId);
  if (!chapter) throw new Error('Chapter not found');
  if (!String(chapter.content || '').trim()) throw new Error('Chapter has no content');

  const scenes = await db.all(
    'SELECT * FROM scene WHERE chapter_id = ? ORDER BY "index" ASC',
    chapterId
  );
  if (!scenes.length) throw new Error('Chapter has no storyboard scenes');

  const generated = await LLMService.generateStructuredLocallyWithRetry(
    buildSceneNarrationPrompt(chapter, scenes),
    SceneNarrationResponseSchema,
    { maxRetries: 2, temperature: 0.35, maxTokens: 2400 }
  );
  if (!generated) throw new Error('Local model failed to generate structured narration');

  const expectedIds = scenes.map((scene: any) => Number(scene.id));
  const byId = new Map<number, string>();
  for (const item of generated.scenes) {
    if (byId.has(item.scene_id)) throw new Error(`Local model duplicated scene ${item.scene_id}`);
    byId.set(item.scene_id, normalizeCaption(item.narration));
  }
  const missing = expectedIds.filter((id) => !byId.get(id));
  const unexpected = [...byId.keys()].filter((id) => !expectedIds.includes(id));
  if (missing.length || unexpected.length) {
    throw new Error(
      `Local narration coverage mismatch (missing=${missing.join(',') || 'none'}; unexpected=${unexpected.join(',') || 'none'})`
    );
  }

  await db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    for (const scene of scenes) {
      const narration = byId.get(Number(scene.id))!;
      await db.run('UPDATE scene SET narration = ? WHERE id = ?', narration, scene.id);
      await syncActiveVersionFromScene(Number(scene.id));
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }

  return {
    chapter_id: chapterId,
    generated_count: scenes.length,
    scenes: await db.all(
      'SELECT id, "index", dialogue, narration FROM scene WHERE chapter_id = ? ORDER BY "index" ASC',
      chapterId
    ),
  };
};
