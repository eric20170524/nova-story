import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../../db/database';
import { logger } from '../../core/logging';
import { LLMService } from '../llm';
import type { AIProvider } from './base';
import { formatPrompt, getPrompt } from './prompt_registry';
import { ScriptService, ScriptServiceError } from '../script_service';
import {
  ScriptDocumentSchema,
  ScriptOutlineSchema,
  ScriptSceneSchema,
  validateScriptForConfirmation,
  type ScriptDocument,
  type ScriptOutline,
  type ScriptScene,
  type ScriptBlock,
  type ScriptChangeRow,
  type ScriptSourceSnapshot,
} from '../../schemas/script';

export class ScriptGenerationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 500 | 502 = 502
  ) {
    super(message);
    this.name = 'ScriptGenerationError';
  }
}

/** Zod schemas for LLM structured output parsing */
export const GeneratedOutlineResponseSchema = z.object({
  logline: z.string().min(1, '一句话梗概不能为空'),
  mustKeepEvents: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        sourceParagraphIds: z.array(z.string()).default([]),
      })
    )
    .min(1, '必须包含至少一个核心保留事件'),
  beats: z
    .array(
      z.object({
        id: z.string().min(1),
        purpose: z.string().min(1),
        eventIds: z.array(z.string()).default([]),
      })
    )
    .min(1, '必须包含至少一个戏剧节拍'),
  endingHook: z.string().min(1, '结尾悬念钩子不能为空'),
});

export const GeneratedSceneBlockResponseSchema = z.object({
  id: z.string().optional(),
  type: z.enum(['action', 'dialogue', 'voiceover', 'sound']),
  text: z.string().min(1, '内容文本不能为空'),
  characterName: z.string().optional(),
  delivery: z.string().optional(),
});

export const GeneratedSceneResponseSchema = z.object({
  id: z.string().optional(),
  location: z.object({
    name: z.string().min(1, '地点名称不能为空'),
    description: z.string().default(''),
  }),
  interiorExterior: z.enum(['interior', 'exterior']).default('interior'),
  timeOfDay: z.string().default('day'),
  characterNames: z.array(z.string()).default([]),
  coveredEventIds: z.array(z.string()).default([]),
  blocks: z.array(GeneratedSceneBlockResponseSchema).min(1, '分场必须包含至少一个内容块'),
  estimatedDurationSec: z.number().positive().default(30),
});

export type GeneratedOutlineResponse = z.infer<typeof GeneratedOutlineResponseSchema>;
export type GeneratedSceneResponse = z.infer<typeof GeneratedSceneResponseSchema>;

/**
 * Verify whether dramatic scene blocks provide genuine dramatic coverage of a must-keep event.
 */
export function verifyEventContentCoverage(
  eventText: string,
  sceneBlocksText: string
): boolean {
  const normEvent = eventText.trim().toLowerCase();
  const normScene = sceneBlocksText.trim().toLowerCase();
  if (!normEvent || !normScene) return false;

  // 1. Direct substring inclusion
  if (normScene.includes(normEvent)) return true;

  // 2. Token / keyword matching (split on punctuation and whitespace)
  const cleanTokens = normEvent
    .split(/[\s,，.。!！?？:：;；"“”'‘’()（）《》【】\[\]\-_/\\]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  if (cleanTokens.length > 0) {
    let matchedCount = 0;
    for (const tok of cleanTokens) {
      if (normScene.includes(tok)) {
        matchedCount++;
      }
    }
    if (matchedCount / cleanTokens.length >= 0.6) {
      return true;
    }
  }

  // 3. Sliding 2-gram overlap
  const cleanChars = normEvent.replace(/[\s,，.。!！?？:：;；"“”'‘’()（）《》【】\[\]\-_/\\]+/g, '');
  if (cleanChars.length >= 2) {
    const ngrams: string[] = [];
    for (let i = 0; i <= cleanChars.length - 2; i++) {
      ngrams.push(cleanChars.slice(i, i + 2));
    }
    if (ngrams.length > 0) {
      const matchedNgrams = ngrams.filter((ng) => normScene.includes(ng));
      if (matchedNgrams.length / ngrams.length >= 0.6) {
        return true;
      }
    }
  }

  return false;
}

function allocateLocationId(locations: Array<{ id: string }>): string {
  const used = new Set(locations.map((location) => location.id));
  let max = 0;
  for (const id of used) {
    const match = /^loc_(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let next = max + 1;
  let id = `loc_${next}`;
  while (used.has(id)) {
    next += 1;
    id = `loc_${next}`;
  }
  return id;
}

/** Match a character name against project characters */
export function matchProjectCharacter(
  name: string | undefined | null,
  characters: Array<{ id: number; name: string }>
): { id: number; name: string } | null {
  if (!name || !name.trim()) return null;
  const target = name.trim().toLowerCase();

  // 1. Exact match
  const exact = characters.find((c) => c.name.trim().toLowerCase() === target);
  if (exact) return exact;

  // 2. Substring match
  const matches = characters.filter(
    (c) =>
      c.name.trim().toLowerCase().includes(target) ||
      target.includes(c.name.trim().toLowerCase())
  );
  matches.sort((a, b) => b.name.trim().length - a.name.trim().length);
  const best = matches[0];
  if (best && (!matches[1] || best.name.trim().length > matches[1].name.trim().length)) return best;

  return null;
}

export class ScriptGenerationService {
  /**
   * Phase 1: Generate an adaptation outline candidate for a chapter.
   */
  static async generateOutlineCandidate(params: {
    scriptId: number;
    expectedRevision: number;
    requestKey: string;
    instructions?: string;
    targetDurationSec?: number;
    token?: string;
    provider?: AIProvider;
  }): Promise<ScriptChangeRow> {
    const existing = (await db.get(
      'SELECT * FROM script_change WHERE script_id = ? AND request_key = ?',
      params.scriptId,
      params.requestKey
    )) as ScriptChangeRow | undefined;
    if (existing) {
      return existing;
    }

    const drafted = await this.draftOutline(params);
    return ScriptService.createPendingCandidate({
      scriptId: params.scriptId,
      kind: 'outline',
      expectedRevision: params.expectedRevision,
      requestKey: params.requestKey,
      afterJson: JSON.stringify(drafted.outline),
      sourceSnapshot: drafted.sourceSnapshot,
      generationInfo: {
        instructions: params.instructions,
        targetDurationSec: params.targetDurationSec,
      },
    });
  }

  /**
   * Build an outline in memory. Callers persist it only when the candidate should remain.
   */
  private static async draftOutline(params: {
    scriptId: number;
    expectedRevision: number;
    requestKey: string;
    instructions?: string;
    targetDurationSec?: number;
    token?: string;
    provider?: AIProvider;
  }): Promise<{ outline: ScriptOutline; sourceSnapshot: ScriptSourceSnapshot }> {
    const script = await ScriptService.getScriptById(params.scriptId);
    if (script.revision !== params.expectedRevision) {
      throw new ScriptGenerationError(
        `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${script.revision}`,
        409
      );
    }

    const chapter = (await db.get(
      'SELECT id, title, content FROM chapter WHERE id = ?',
      script.chapterId
    )) as { id: string; title: string; content?: string | null } | undefined;

    if (!chapter) {
      throw new ScriptGenerationError(`Chapter "${script.chapterId}" not found`, 404);
    }

    const chapterContent = (chapter.content || '').trim();
    if (!chapterContent) {
      throw new ScriptGenerationError('当前章节无小说正文内容，无法生成短剧改编提纲', 400);
    }

    if (chapterContent.length > 30000) {
      throw new ScriptGenerationError(
        '小说正文超过单章 30,000 字上限，请先将章节进行合理分卷或拆分',
        400
      );
    }

    const sourceSnapshot = script.sourceSnapshot;

    const paragraphs = chapterContent
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((text, idx) => ({
        id: `p_${idx + 1}`,
        text,
      }));
    const validParagraphIds = new Set(paragraphs.map((p) => p.id));

    const context = await ScriptService.loadSourceContext(script.projectId);
    const bibleSummary = context.bible
      ? `类型: ${context.bible.genre || ''}, 风格: ${context.bible.style || ''}, 主线: ${context.bible.main_plot || ''}`
      : '无特定世界观约束';

    const prompt = formatPrompt(getPrompt('script_outline_gen'), {
      chapterTitle: chapter.title || '第1章',
      content: chapterContent,
      targetDurationSec: params.targetDurationSec || script.document.targetDurationSec || 120,
      instructions: params.instructions || '基于小说正文提取戏剧性核心事件与节拍，突出冲突和反转。',
      creativeConstraints: bibleSummary,
    });

    const provider = params.provider || LLMService.getProvider(params.token);
    let outlineResult: GeneratedOutlineResponse | null = null;

    try {
      outlineResult = await provider.generateStructured(
        prompt,
        GeneratedOutlineResponseSchema,
        '你是一位专业短剧编剧，请严格输出合法的 JSON 格式改编提纲。'
      );
    } catch (err: any) {
      logger.error(`Failed to generate script outline: ${err}`);
      throw new ScriptGenerationError(
        `模型生成改编提纲失败: ${err.message || String(err)}。正式剧本未发生任何更改。`,
        502
      );
    }

    if (!outlineResult) {
      throw new ScriptGenerationError(
        '模型返回空结果或纯思考内容，未能生成有效改编提纲。正式剧本未发生任何更改。',
        502
      );
    }

    // Validate outline completeness and sanitize paragraph IDs
    const validatedOutline: ScriptOutline = {
      logline: outlineResult.logline.trim(),
      mustKeepEvents: outlineResult.mustKeepEvents.map((e, idx) => {
        let validPids = (e.sourceParagraphIds || []).filter((pid) => validParagraphIds.has(pid));
        if (validPids.length === 0 && paragraphs.length > 0) {
          const found = paragraphs.find((p) => p.text.includes(e.text) || e.text.includes(p.text));
          if (found) {
            validPids = [found.id];
          } else {
            const pIdx = Math.min(idx, paragraphs.length - 1);
            validPids = [paragraphs[pIdx]!.id];
          }
        }
        return {
          id: e.id || `ev_${idx + 1}`,
          text: e.text.trim(),
          sourceParagraphIds: validPids,
        };
      }),
      beats: outlineResult.beats.map((b, idx) => ({
        id: b.id || `beat_${idx + 1}`,
        purpose: b.purpose.trim(),
        eventIds: b.eventIds || [],
      })),
      endingHook: outlineResult.endingHook.trim(),
    };

    return { outline: validatedOutline, sourceSnapshot };
  }

  /**
   * Phase 2: Generate full multi-scene screenplay candidate using the pipeline:
   * Outline -> Scene-by-scene generation -> Full document validation.
   */
  static async generateFullScriptCandidate(params: {
    scriptId: number;
    expectedRevision: number;
    requestKey: string;
    instructions?: string;
    targetDurationSec?: number;
    token?: string;
    provider?: AIProvider;
  }): Promise<ScriptChangeRow> {
    // Idempotency: return existing candidate
    const existing = (await db.get(
      'SELECT * FROM script_change WHERE script_id = ? AND request_key = ?',
      params.scriptId,
      params.requestKey
    )) as ScriptChangeRow | undefined;
    if (existing) {
      return existing;
    }

    const script = await ScriptService.getScriptById(params.scriptId);
    if (script.revision !== params.expectedRevision) {
      throw new ScriptGenerationError(
        `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${script.revision}`,
        409
      );
    }

    const chapter = (await db.get(
      'SELECT id, title, content FROM chapter WHERE id = ?',
      script.chapterId
    )) as { id: string; title: string; content?: string | null } | undefined;

    if (!chapter) {
      throw new ScriptGenerationError(`Chapter "${script.chapterId}" not found`, 404);
    }

    const chapterContent = (chapter.content || '').trim();
    if (!chapterContent) {
      throw new ScriptGenerationError('当前章节无小说正文内容，无法生成短剧剧本', 400);
    }

    if (chapterContent.length > 30000) {
      throw new ScriptGenerationError(
        '小说正文超过单章 30,000 字上限，请先将章节进行合理拆分',
        400
      );
    }

    const sourceSnapshot = await ScriptService.createSourceSnapshot(
      script.chapterId,
      chapter.title || '',
      chapterContent,
      script.projectId
    );

    const paragraphs = chapterContent
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((text, idx) => ({
        id: `p_${idx + 1}`,
        text,
      }));
    const validParagraphIds = new Set(paragraphs.map((p) => p.id));

    const provider = params.provider || LLMService.getProvider(params.token);
    const context = await ScriptService.loadSourceContext(script.projectId);
    const projectCharacters = context.characters;

    // Step 1: Resolve outline
    let outline: ScriptOutline;
    if (
      script.document.outline &&
      script.document.outline.logline &&
      script.document.outline.beats.length > 0
    ) {
      outline = {
        ...script.document.outline,
        mustKeepEvents: script.document.outline.mustKeepEvents.map((e, idx) => {
          let validPids = (e.sourceParagraphIds || []).filter((pid) => validParagraphIds.has(pid));
          if (validPids.length === 0 && paragraphs.length > 0) {
            const found = paragraphs.find((p) => p.text.includes(e.text) || e.text.includes(p.text));
            if (found) {
              validPids = [found.id];
            } else {
              const pIdx = Math.min(idx, paragraphs.length - 1);
              validPids = [paragraphs[pIdx]!.id];
            }
          }
          return {
            ...e,
            sourceParagraphIds: validPids,
          };
        }),
      };
    } else {
      const drafted = await this.draftOutline({
        scriptId: params.scriptId,
        expectedRevision: params.expectedRevision,
        requestKey: `${params.requestKey}_auto_outline`,
        instructions: params.instructions,
        targetDurationSec: params.targetDurationSec,
        token: params.token,
        provider,
      });
      outline = drafted.outline;
    }

    // Enforce budget limits
    if (outline.beats.length > 12) {
      throw new ScriptGenerationError(
        '改编提纲戏剧节拍超过 12 场上限，请精简提纲。不能截断丢弃尾部场次。',
        400
      );
    }

    // Generate exactly the adopted beats; never invent extra scenes.
    const totalScenes = outline.beats.length;
    if (totalScenes === 0) {
      throw new ScriptGenerationError('改编提纲至少需要一个戏剧节拍', 400);
    }
    const generatedScenes: ScriptScene[] = [];
    const locations = [...(script.document.locations || [])];

    // Ensure all mustKeepEvents are allocated to beats so none are dropped
    const assignedEventIds = new Set(outline.beats.flatMap((b) => b.eventIds || []));
    const unassignedEvents = outline.mustKeepEvents.filter((e) => !assignedEventIds.has(e.id));
    if (unassignedEvents.length > 0 && outline.beats.length > 0) {
      outline.beats[outline.beats.length - 1]!.eventIds = [
        ...(outline.beats[outline.beats.length - 1]!.eventIds || []),
        ...unassignedEvents.map((e) => e.id),
      ];
    }

    const charactersPrompt =
      projectCharacters.length > 0
        ? projectCharacters.map((c) => `- ${c.name} (${c.role || '角色'})`).join('\n')
        : '当前无预设角色档案';

    // Step 2: Scene-by-scene generation
    for (let sIdx = 0; sIdx < totalScenes; sIdx++) {
      const beat = outline.beats[sIdx] || {
        id: `beat_${sIdx + 1}`,
        purpose: '剧情推进与戏剧冲突',
        eventIds: [],
      };

      const matchedEvents = outline.mustKeepEvents.filter(
        (e) => beat.eventIds?.includes(e.id)
      );
      const eventsSummary =
        matchedEvents.length > 0
          ? matchedEvents.map((e) => e.text).join('；')
          : beat.purpose;

      // Map corresponding novel paragraphs for this scene strictly with valid IDs
      const sceneParagraphIds = new Set<string>();
      for (const ev of matchedEvents) {
        for (const pid of ev.sourceParagraphIds || []) {
          if (validParagraphIds.has(pid)) {
            sceneParagraphIds.add(pid);
          }
        }
      }
      if (sceneParagraphIds.size === 0 && paragraphs.length > 0) {
        for (const ev of matchedEvents) {
          const found = paragraphs.find(
            (p) => p.text.includes(ev.text) || ev.text.includes(p.text)
          );
          if (found) {
            sceneParagraphIds.add(found.id);
          }
        }
        if (sceneParagraphIds.size === 0) {
          const pIndex = Math.min(
            Math.floor((sIdx / totalScenes) * paragraphs.length),
            paragraphs.length - 1
          );
          sceneParagraphIds.add(paragraphs[pIndex]!.id);
        }
      }

      const sceneParagraphsText = Array.from(sceneParagraphIds)
        .map((pid) => {
          const p = paragraphs.find((x) => x.id === pid);
          return p ? `[${p.id}] ${p.text}` : '';
        })
        .filter(Boolean)
        .join('\n\n');

      const previousScene = generatedScenes[sIdx - 1];
      const previousSceneSummary = previousScene
        ? `第 ${sIdx} 场结尾动作/对白：${
            previousScene.blocks[previousScene.blocks.length - 1]?.text || '自然衔接'
          }`
        : '剧集开端第一场，直接切入核心冲突或突发情境';

      const scenePrompt = formatPrompt(getPrompt('script_scene_gen'), {
        chapterTitle: chapter.title || '第1章',
        outlineSummary: `一句话梗概: ${outline.logline}\n结尾钩子: ${outline.endingHook}`,
        sceneIndex: sIdx + 1,
        totalScenes,
        sceneEvents: eventsSummary,
        sourceParagraphs: sceneParagraphsText || '无对应段落',
        characters: charactersPrompt,
        previousSceneSummary,
        instructions: params.instructions || '将小说叙事转化为外部动作表演与高张力台词对白',
      });

      let rawScene: GeneratedSceneResponse | null = null;
      try {
        rawScene = await provider.generateStructured(
          scenePrompt,
          GeneratedSceneResponseSchema,
          '你是一位专业短剧分场编剧，请严格输出合法的 JSON 格式分场戏剧剧本。'
        );
      } catch (err: any) {
        logger.error(`Failed to generate scene ${sIdx + 1}: ${err}`);
        throw new ScriptGenerationError(
          `第 ${sIdx + 1} 场生成失败: ${err.message || String(err)}。已中止整章生成，正式剧本未发生任何更改。`,
          502
        );
      }

      if (!rawScene || !rawScene.blocks || rawScene.blocks.length === 0) {
        throw new ScriptGenerationError(
          `第 ${sIdx + 1} 场模型返回空结果或缺少表演块。已中止整章生成，正式剧本未发生任何更改。`,
          502
        );
      }

      // Resolve location
      const locName = (rawScene.location?.name || '场景地点').trim();
      let locationId = '';
      const existingLoc = locations.find(
        (l) => l.name.trim().toLowerCase() === locName.toLowerCase()
      );
      if (existingLoc) {
        locationId = existingLoc.id;
      } else {
        locationId = allocateLocationId(locations);
        locations.push({
          id: locationId,
          name: locName,
          description: (rawScene.location?.description || '').trim(),
        });
      }

      // Resolve cast and blocks
      const sceneCharacterIds = new Set<number>();
      const sceneBlocks: ScriptBlock[] = [];

      for (let bIdx = 0; bIdx < rawScene.blocks.length; bIdx++) {
        const b = rawScene.blocks[bIdx]!;
        const blockId = `b_${sIdx + 1}_${bIdx + 1}`;

        if (b.type === 'action') {
          sceneBlocks.push({
            id: blockId,
            type: 'action',
            text: b.text.trim(),
          });
        } else if (b.type === 'dialogue') {
          // Strictly resolve character reference
          const charName = (b.characterName || '').trim();
          const matched = matchProjectCharacter(charName, projectCharacters);

          if (!matched) {
            throw new ScriptGenerationError(
              `未知角色: 第 ${sIdx + 1} 场模型对白引用了角色 "${charName}"，但在项目角色库中未找到。请先在角色中心建立该角色档案。`,
              400
            );
          }

          sceneCharacterIds.add(matched.id);
          sceneBlocks.push({
            id: blockId,
            type: 'dialogue',
            characterId: matched.id,
            text: b.text.trim(),
            delivery: b.delivery?.trim() || undefined,
          });
        } else if (b.type === 'voiceover') {
          let charId: number | null = null;
          const charName = (b.characterName || '').trim();
          if (
            charName &&
            charName !== '旁白' &&
            charName.toLowerCase() !== 'narrator'
          ) {
            const matched = matchProjectCharacter(charName, projectCharacters);
            if (!matched) {
              throw new ScriptGenerationError(
                `未知角色: 第 ${sIdx + 1} 场画外音引用了角色 "${charName}"，但在项目角色库中未找到。`,
                400
              );
            }
            charId = matched.id;
            sceneCharacterIds.add(charId);
          }

          sceneBlocks.push({
            id: blockId,
            type: 'voiceover',
            characterId: charId,
            text: b.text.trim(),
          });
        } else if (b.type === 'sound') {
          sceneBlocks.push({
            id: blockId,
            type: 'sound',
            text: b.text.trim(),
          });
        }
      }

      // Add any explicit cast names
      for (const name of rawScene.characterNames || []) {
        const matched = matchProjectCharacter(name, projectCharacters);
        if (matched) sceneCharacterIds.add(matched.id);
      }

      // Verify dramatic event coverage in scene content
      const sceneFullText = sceneBlocks.map((b) => b.text).join(' ');

      const verifiedSceneEventIds = new Set<string>();
      for (const ev of outline.mustKeepEvents) {
        if (verifyEventContentCoverage(ev.text, sceneFullText)) {
          verifiedSceneEventIds.add(ev.id);
        }
      }

      const stableScene: ScriptScene = {
        id: `sc_${sIdx + 1}`,
        beatIds: [beat.id],
        eventIds: Array.from(verifiedSceneEventIds),
        sourceParagraphIds: Array.from(sceneParagraphIds),
        locationId,
        interiorExterior: rawScene.interiorExterior === 'exterior' ? 'exterior' : 'interior',
        timeOfDay: (rawScene.timeOfDay || 'day').trim(),
        characterIds: Array.from(sceneCharacterIds),
        propIds: [],
        blocks: sceneBlocks,
        estimatedDurationSec: rawScene.estimatedDurationSec || 30,
      };

      generatedScenes.push(stableScene);
    }

    // Step 3: Full Document Assembly & Validation
    const fullDocument: ScriptDocument = {
      schemaVersion: 1,
      title: script.document.title || `${chapter.title} 短剧剧本`,
      targetDurationSec: params.targetDurationSec || script.document.targetDurationSec || 120,
      outline,
      locations,
      props: script.document.props || [],
      scenes: generatedScenes,
    };

    // Validate mustKeepEvents coverage across all generated scenes
    const coveredEventIds = new Set(generatedScenes.flatMap((s) => s.eventIds || []));
    const missingEvents = outline.mustKeepEvents.filter((e) => !coveredEventIds.has(e.id));
    if (missingEvents.length > 0) {
      throw new ScriptGenerationError(
        `生成的剧本未能覆盖提纲中的必保关键事件: 缺失 [${missingEvents
          .map((e) => e.text)
          .join(', ')}]。已中止整章生成，正式剧本未发生任何更改。`,
        502
      );
    }

    const validation = validateScriptForConfirmation(fullDocument);
    if (!validation.valid) {
      throw new ScriptGenerationError(
        `生成的剧本未能通过完整性校验: ${validation.errors.join('; ')}。正式剧本未发生任何更改。`,
        502
      );
    }

    return ScriptService.createPendingCandidate({
      scriptId: params.scriptId,
      kind: 'script',
      expectedRevision: params.expectedRevision,
      requestKey: params.requestKey,
      afterJson: JSON.stringify(fullDocument),
      sourceSnapshot,
      generationInfo: {
        instructions: params.instructions,
        targetDurationSec: params.targetDurationSec,
        scenesCount: generatedScenes.length,
      },
    });
  }

  /**
   * Phase 3: Single scene rewrite candidate.
   * Rewrites only the target scene while preserving other scenes and stable IDs.
   */
  static async generateSceneRewriteCandidate(params: {
    scriptId: number;
    targetSceneId: string;
    expectedRevision: number;
    requestKey: string;
    instructions?: string;
    token?: string;
    provider?: AIProvider;
  }): Promise<ScriptChangeRow> {
    // Idempotency: return existing candidate
    const existing = (await db.get(
      'SELECT * FROM script_change WHERE script_id = ? AND request_key = ?',
      params.scriptId,
      params.requestKey
    )) as ScriptChangeRow | undefined;
    if (existing) {
      return existing;
    }

    const script = await ScriptService.getScriptById(params.scriptId);
    if (script.revision !== params.expectedRevision) {
      throw new ScriptGenerationError(
        `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${script.revision}`,
        409
      );
    }

    const targetScene = script.document.scenes.find(
      (s) => s.id === params.targetSceneId
    );
    if (!targetScene) {
      throw new ScriptGenerationError(
        `Target scene "${params.targetSceneId}" not found in current script document`,
        404
      );
    }

    const sourceSnapshot = script.sourceSnapshot;

    const context = await ScriptService.loadSourceContext(script.projectId);
    const projectCharacters = context.characters;

    const charactersPrompt =
      projectCharacters.length > 0
        ? projectCharacters.map((c) => `- ${c.name} (${c.role || '角色'})`).join('\n')
        : '当前无预设角色档案';

    const locationName =
      script.document.locations.find((l) => l.id === targetScene.locationId)?.name ||
      targetScene.locationId ||
      '未指定地点';

    const requiredEvents = script.document.outline.mustKeepEvents.filter((event) =>
      targetScene.eventIds.includes(event.id)
    );
    const originalSceneSummary = [
      `分场ID: ${targetScene.id}`,
      `地点: ${locationName} (${targetScene.interiorExterior}, ${targetScene.timeOfDay})`,
      '内容块:',
      ...targetScene.blocks.map(
        (b) => `[${b.type}] ${b.text}`
      ),
    ].join('\n');

    const prompt = formatPrompt(getPrompt('script_scene_rewrite'), {
      sceneContent: originalSceneSummary,
      instructions: params.instructions || '强化动作与戏剧对白，增强戏剧张力',
      characters: charactersPrompt,
      mustKeepEvents: requiredEvents.length
        ? requiredEvents.map((event) => `- ${event.id}: ${event.text}`).join('\n')
        : '本场没有必须保留的事件',
    });

    const provider = params.provider || LLMService.getProvider(params.token);
    let rawScene: GeneratedSceneResponse | null = null;

    try {
      rawScene = await provider.generateStructured(
        prompt,
        GeneratedSceneResponseSchema,
        '你是一位专业短剧精修编剧，请严格输出合法的 JSON 格式分场剧本。'
      );
    } catch (err: any) {
      logger.error(`Failed to rewrite scene ${params.targetSceneId}: ${err}`);
      throw new ScriptGenerationError(
        `分场改写失败: ${err.message || String(err)}。正式剧本未发生任何更改。`,
        502
      );
    }

    if (!rawScene || !rawScene.blocks || rawScene.blocks.length === 0) {
      throw new ScriptGenerationError(
        '模型返回空结果，未能生成有效的改写分场。正式剧本未发生任何更改。',
        502
      );
    }

    // Resolve cast and blocks
    const sceneCharacterIds = new Set<number>();
    const sceneBlocks: ScriptBlock[] = [];

    for (let bIdx = 0; bIdx < rawScene.blocks.length; bIdx++) {
      const b = rawScene.blocks[bIdx]!;
      const blockId = `b_rw_${bIdx + 1}_${Date.now()}`;

      if (b.type === 'action') {
        sceneBlocks.push({
          id: blockId,
          type: 'action',
          text: b.text.trim(),
        });
      } else if (b.type === 'dialogue') {
        const charName = (b.characterName || '').trim();
        const matched = matchProjectCharacter(charName, projectCharacters);
        if (!matched) {
          throw new ScriptGenerationError(
            `未知角色: 改写分场中模型对白引用了角色 "${charName}"，但在项目角色库中未找到。`,
            400
          );
        }
        sceneCharacterIds.add(matched.id);
        sceneBlocks.push({
          id: blockId,
          type: 'dialogue',
          characterId: matched.id,
          text: b.text.trim(),
          delivery: b.delivery?.trim() || undefined,
        });
      } else if (b.type === 'voiceover') {
        let charId: number | null = null;
        const charName = (b.characterName || '').trim();
        if (
          charName &&
          charName !== '旁白' &&
          charName.toLowerCase() !== 'narrator'
        ) {
          const matched = matchProjectCharacter(charName, projectCharacters);
          if (!matched) {
            throw new ScriptGenerationError(
              `未知角色: 画外音引用了角色 "${charName}"，但在项目角色库中未找到。`,
              400
            );
          }
          charId = matched.id;
          sceneCharacterIds.add(charId);
        }
        sceneBlocks.push({
          id: blockId,
          type: 'voiceover',
          characterId: charId,
          text: b.text.trim(),
        });
      } else if (b.type === 'sound') {
        sceneBlocks.push({
          id: blockId,
          type: 'sound',
          text: b.text.trim(),
        });
      }
    }

    const rewrittenText = sceneBlocks.map((block) => block.text).join(' ');
    const sceneText = (scene: { blocks: Array<{ text: string }> }) =>
      scene.blocks.map((block) => block.text).join(' ');
    const keptEventIds = targetScene.eventIds.filter((eventId) => {
      const event = script.document.outline.mustKeepEvents.find((item) => item.id === eventId);
      return Boolean(event && verifyEventContentCoverage(event.text, rewrittenText));
    });
    const missingEvents = script.document.outline.mustKeepEvents.filter((event) =>
      targetScene.eventIds.includes(event.id) &&
      !keptEventIds.includes(event.id) &&
      !script.document.scenes.some((scene) =>
        scene.id !== targetScene.id &&
        scene.eventIds.includes(event.id) &&
        verifyEventContentCoverage(event.text, sceneText(scene))
      )
    );
    if (missingEvents.length) {
      throw new ScriptGenerationError(`分场改写遗漏必保关键事件: ${missingEvents.map((event) => event.text).join('；')}。正式剧本未发生任何更改。`, 502);
    }

    const rewrittenScene: ScriptScene = {
      id: targetScene.id,
      beatIds: targetScene.beatIds,
      eventIds: keptEventIds,
      sourceParagraphIds: targetScene.sourceParagraphIds,
      locationId: targetScene.locationId,
      interiorExterior: rawScene.interiorExterior === 'exterior' ? 'exterior' : 'interior',
      timeOfDay: (rawScene.timeOfDay || targetScene.timeOfDay).trim(),
      characterIds: Array.from(sceneCharacterIds),
      propIds: targetScene.propIds,
      blocks: sceneBlocks,
      estimatedDurationSec: rawScene.estimatedDurationSec || targetScene.estimatedDurationSec,
    };

    return ScriptService.createPendingCandidate({
      scriptId: params.scriptId,
      kind: 'scene',
      expectedRevision: params.expectedRevision,
      requestKey: params.requestKey,
      afterJson: JSON.stringify(rewrittenScene),
      beforeJson: JSON.stringify(targetScene),
      sourceSnapshot,
      generationInfo: {
        target_scene_id: targetScene.id,
        instructions: params.instructions,
      },
    });
  }
}
