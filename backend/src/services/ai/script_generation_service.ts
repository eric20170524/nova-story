import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../../db/database';
import { logger } from '../../core/logging';
import { LLMService } from '../llm';
import { SettingsManager } from '../../core/settings_manager';
import type { AIProvider } from './base';
import { formatPrompt, getPrompt } from './prompt_registry';
import { bindEntities, boundText, entityRoster, eventContentCovered, eventRelationConflict, needsBindingReview, proposeBindings, validateBinding, textHash } from '../entity_binding';
import { coversVisibleBeat, extractVisibleBeats, type VisibleBeat } from '../english_visual_prompt';
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
  type ScriptProp,
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
  props: z.array(z.object({
    name: z.string().trim().min(1),
    description: z.string().default(''),
  })).optional(),
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
  return eventContentCovered(eventText, sceneBlocksText);
}

/** Action text is the only coverage that counts for clothing, pose, and contact. */
export function anchorMissingVisibleBeats(
  scenes: ScriptScene[],
  beats: VisibleBeat[],
): string[] {
  const anchored: string[] = [];
  if (!scenes.length) return anchored;
  for (const beat of beats) {
    const text = beat.text.trim();
    if (!text) continue;
    const covered = scenes.some((scene) => coversVisibleBeat(
      text,
      scene.blocks.filter((block) => block.type === 'action').map((block) => block.text).join('\n'),
    ));
    if (covered) continue;
    const paragraphIds = new Set(beat.sourceParagraphIds || []);
    const owner = scenes.find((scene) => scene.sourceParagraphIds.some((id) => paragraphIds.has(id)))
      || scenes[scenes.length - 1]!;
    const blockId = `vis_${beat.id}`;
    const existingIndex = owner.blocks.findIndex((block) => block.id === blockId);
    if (existingIndex >= 0) owner.blocks[existingIndex] = { id: blockId, type: 'action', text };
    else owner.blocks.push({ id: blockId, type: 'action', text });
    anchored.push(beat.id);
  }
  return anchored;
}

function configuredLlmModel(provider?: AIProvider): string | undefined {
  if (provider) return undefined;
  const model = String(SettingsManager.loadSettings().llm?.model || '').trim();
  return model || undefined;
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

function resolveSceneProps(rawProps: GeneratedSceneResponse['props'], props: ScriptProp[]): string[] {
  const ids = new Set<string>();
  const normalize = (name: string) => name.normalize('NFKC').trim().toLowerCase();
  for (const raw of rawProps || []) {
    const name = raw.name.trim();
    if (!name) throw new ScriptGenerationError('分场道具名称不能为空', 502);
    let prop = props.find(item => normalize(item.name) === normalize(name));
    if (!prop) {
      const used = new Set(props.map(item => item.id));
      let index = Math.max(0, ...props.map(item => Number(/^prop_(\d+)$/.exec(item.id)?.[1] || 0))) + 1;
      while (used.has(`prop_${index}`)) index++;
      prop = { id: `prop_${index}`, name, description: (raw.description || '').trim() };
      props.push(prop);
    }
    ids.add(prop.id);
  }
  return [...ids];
}

const NARRATOR_LABELS = new Set([
  '旁白', '画外音', '画外', '叙述', '叙述者', 'narrator', 'voiceover', 'voice-over', 'vo',
]);

/** Narration labels are not project characters. The model often writes them as either voiceover or dialogue. */
export function isNarratorLabel(name: string | null | undefined): boolean {
  const value = String(name || '').normalize('NFKC').trim().toLowerCase().replace(/[\s.。:：·]+/g, '');
  return NARRATOR_LABELS.has(value);
}

export function normalizeLookupName(name: string | null | undefined): string {
  return String(name || '')
    .normalize('NFKC')
    .trim()
    .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, '')
    .replace(/\s*[（(][^）)]*[）)]\s*$/u, '')
    .trim();
}

/** Match a character name against project characters */
export function matchProjectCharacter(
  name: string | undefined | null,
  characters: Array<{ id: number; name: string }>
): { id: number; name: string } | null {
  const target = normalizeLookupName(name).toLowerCase();
  if (!target) return null;
  const normalized = characters.map((character) => ({
    character,
    name: normalizeLookupName(character.name).toLowerCase(),
  }));

  // 1. Exact match
  const exact = normalized.find((item) => item.name === target);
  if (exact) return exact.character;

  // 2. Substring match, only when one name is strictly more specific
  const matches = normalized.filter(
    (item) => item.name.includes(target) || target.includes(item.name)
  );
  matches.sort((a, b) => b.name.length - a.name.length);
  const best = matches[0];
  if (best && (!matches[1] || best.name.length > matches[1].name.length)) return best.character;

  // 3. Diminutive 儿: 雪儿 -> the one character whose name ends with 雪
  if (target.endsWith('儿') && target.length > 1) {
    const stem = target.slice(0, -1);
    const ended = normalized.filter((item) => item.name.endsWith(stem));
    if (ended.length === 1) return ended[0]!.character;
  }

  return null;
}

function resolvePerformanceBlocks(
  rawBlocks: GeneratedSceneResponse['blocks'],
  projectCharacters: Array<{ id: number; name: string }>,
  idFor: (index: number) => string,
  convertMissingSpeakerToAction: boolean,
): { blocks: ScriptBlock[]; unresolved: Array<{ name: string; type: 'dialogue' | 'voiceover' }> } {
  const blocks: ScriptBlock[] = [];
  const unresolved: Array<{ name: string; type: 'dialogue' | 'voiceover' }> = [];

  for (const raw of rawBlocks) {
    if (raw.type === 'action' || raw.type === 'sound') {
      blocks.push({ id: idFor(blocks.length), type: raw.type, text: raw.text.trim() });
      continue;
    }
    if (raw.type !== 'dialogue' && raw.type !== 'voiceover') continue;

    const charName = normalizeLookupName(raw.characterName);
    const narrator = raw.type === 'voiceover' || isNarratorLabel(charName);
    if (!charName || isNarratorLabel(charName)) {
      if (!narrator) {
        if (convertMissingSpeakerToAction) {
          blocks.push({ id: idFor(blocks.length), type: 'action', text: raw.text.trim() });
        } else {
          unresolved.push({ name: charName, type: raw.type });
        }
        continue;
      }
      blocks.push({ id: idFor(blocks.length), type: 'voiceover', characterId: null, text: raw.text.trim() });
      continue;
    }

    const matched = matchProjectCharacter(charName, projectCharacters);
    if (!matched) {
      unresolved.push({ name: charName, type: raw.type });
      continue;
    }
    if (narrator) {
      blocks.push({ id: idFor(blocks.length), type: 'voiceover', characterId: matched.id, text: raw.text.trim() });
      continue;
    }
    blocks.push({
      id: idFor(blocks.length),
      type: 'dialogue',
      characterId: matched.id,
      text: raw.text.trim(),
      delivery: raw.delivery?.trim() || undefined,
    });
  }

  return { blocks, unresolved };
}

function paragraphIndex(id: string): number | null {
  const match = /^p_(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

/**
 * Events the outline model left off every beat still have to be dramatized.
 * Attach each one to the beat whose source paragraphs are nearest, preferring
 * the earlier beat on a tie, instead of pasting them all onto the last scene.
 */
export function assignUnassignedMustKeepEvents(outline: ScriptOutline): ScriptOutline {
  const events = outline.mustKeepEvents;
  const beats = outline.beats.map((beat) => ({ ...beat, eventIds: [...(beat.eventIds || [])] }));
  if (!beats.length) return { ...outline, beats };

  const assigned = new Set(beats.flatMap((beat) => beat.eventIds));
  const unassigned = events.filter((event) => !assigned.has(event.id));
  const anchorOf = (ids: string[]): number | null => {
    const indexes = ids.map(paragraphIndex).filter((index): index is number => index != null);
    return indexes.length ? Math.min(...indexes) : null;
  };
  const ordered = [...unassigned].sort((a, b) => {
    const left = anchorOf(a.sourceParagraphIds || []);
    const right = anchorOf(b.sourceParagraphIds || []);
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    return left - right;
  });

  for (const event of ordered) {
    const eventAnchor = anchorOf(event.sourceParagraphIds || []);
    let chosen = beats[beats.length - 1]!;
    if (eventAnchor != null) {
      let bestDistance = Number.POSITIVE_INFINITY;
      let bestAnchor = Number.POSITIVE_INFINITY;
      for (const beat of beats) {
        const beatParagraphs = beat.eventIds.flatMap((id) =>
          events.find((item) => item.id === id)?.sourceParagraphIds || []
        );
        const beatAnchor = anchorOf(beatParagraphs);
        if (beatAnchor == null) continue;
        const distance = Math.abs(beatAnchor - eventAnchor);
        const earlierTie = distance === bestDistance && beatAnchor <= eventAnchor && beatAnchor < bestAnchor;
        if (distance < bestDistance || earlierTie) {
          bestDistance = distance;
          bestAnchor = beatAnchor;
          chosen = beat;
        }
      }
    }
    chosen.eventIds.push(event.id);
  }

  return { ...outline, beats };
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
        ...(configuredLlmModel(params.provider) ? { model: configuredLlmModel(params.provider) } : {}),
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
    const { loadBibleParts, renderStoryBible } = await import('../story_bible');
    const bibleSummary = [
      context.bible ? `类型: ${context.bible.genre || ''}, 风格: ${context.bible.style || ''}` : '',
      renderStoryBible(await loadBibleParts(script.projectId, chapter.id)),
    ].filter(Boolean).join('\n');

    const prompt = formatPrompt(getPrompt('script_outline_gen'), {
      chapterTitle: chapter.title || '第1章',
      content: paragraphs.map(paragraph => `[${paragraph.id}] ${paragraph.text}`).join('\n\n'),
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
          const found = paragraphs.find((p) => verifyEventContentCoverage(e.text, p.text));
          if (found) {
            validPids = [found.id];
          } else {
            throw new ScriptGenerationError(`提纲事件 ${e.id} 没有可核对的来源段落，不能按序号回填`, 502);
          }
        }
        if (validPids.some(pid => eventRelationConflict(e.text, paragraphs.find(p => p.id === pid)!.text))) throw new ScriptGenerationError(`提纲事件 ${e.id} 的施受关系与原文矛盾`, 502);
        return {
          id: e.id || `ev_${idx + 1}`,
          text: e.text.trim(),
          sourceParagraphIds: validPids,
          binding: bindEntities(e.text.trim(), entityRoster(context.characters)),
        };
      }),
      beats: outlineResult.beats.map((b, idx) => ({
        id: b.id || `beat_${idx + 1}`,
        purpose: b.purpose.trim(),
        eventIds: b.eventIds || [],
      })),
      endingHook: outlineResult.endingHook.trim(),
      visibleBeats: extractVisibleBeats(paragraphs),
    };

    const roster = entityRoster(context.characters);
    for (const event of validatedOutline.mustKeepEvents) {
      event.sourceBindings = [];
      for (const pid of event.sourceParagraphIds) {
        const index = paragraphs.findIndex(p => p.id === pid);
        const paragraph = paragraphs[index]!;
        const preceding = paragraphs.slice(Math.max(0, index - 2), index).map(p => p.text).join('\n');
        let binding = bindEntities(paragraph.text, roster);
        binding.context_hash = textHash(preceding);
        if (needsBindingReview(binding) && preceding.length + paragraph.text.length <= 2200) binding = await proposeBindings(provider, binding, paragraph.text, preceding, roster);
        event.sourceBindings.push({ paragraph_id: pid, text: paragraph.text, binding });
      }
      if (needsBindingReview(event.binding) && event.text.length + event.sourceBindings.map(s => s.text).join('\n').length <= 2200) event.binding = await proposeBindings(provider, event.binding!, event.text, event.sourceBindings.map(s => s.text).join('\n'), roster);
      const sourceConfirmed = event.sourceBindings.every(source => !needsBindingReview(source.binding));
      const grounded = sourceConfirmed && eventContentCovered(event.text, event.sourceBindings.map(source => boundText(source.text, source.binding)).join('\n'));
      if (!grounded && event.binding?.mentions.length) event.binding = { ...event.binding, mentions: event.binding.mentions.map(m => ({ ...m, authority: 'model_proposal', confirmed: false, candidates: roster })) };
    }
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
            const found = paragraphs.find((p) => verifyEventContentCoverage(e.text, p.text));
            if (found) {
              validPids = [found.id];
            } else {
              throw new ScriptGenerationError(`提纲事件 ${e.id} 没有可核对的来源段落`, 400);
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
    if (!outline.visibleBeats?.length) {
      outline = { ...outline, visibleBeats: extractVisibleBeats(paragraphs) };
    }
    const roster = entityRoster(projectCharacters);
    for (const event of outline.mustKeepEvents) {
      event.binding ||= bindEntities(event.text, roster);
      validateBinding(event.binding, event.text, roster);
      event.sourceBindings ||= event.sourceParagraphIds.map(pid => {
        const paragraph = paragraphs.find(p => p.id === pid)!;
        const index = paragraphs.indexOf(paragraph);
        const binding = bindEntities(paragraph.text, roster);
        binding.context_hash = textHash(paragraphs.slice(Math.max(0, index - 2), index).map(p => p.text).join('\n'));
        return { paragraph_id: pid, text: paragraph.text, binding };
      });
      if (event.sourceBindings.length !== event.sourceParagraphIds.length || new Set(event.sourceBindings.map(s => s.paragraph_id)).size !== event.sourceParagraphIds.length) throw new ScriptGenerationError('提纲原文绑定缺少来源段落', 400);
      for (const source of event.sourceBindings) {
        if (!event.sourceParagraphIds.includes(source.paragraph_id) || paragraphs.find(p => p.id === source.paragraph_id)?.text !== source.text) throw new ScriptGenerationError('提纲原文绑定与当前来源版本不符，请重新生成提纲', 409);
        validateBinding(source.binding, source.text, roster);
        const index = paragraphs.findIndex(p => p.id === source.paragraph_id);
        if (source.binding.context_hash !== textHash(paragraphs.slice(Math.max(0, index - 2), index).map(p => p.text).join('\n'))) throw new ScriptGenerationError('提纲人物绑定的前文已变化，请重新核对', 409);
      }
      if (needsBindingReview(event.binding) || event.sourceBindings.some(s => needsBindingReview(s.binding))) throw new ScriptGenerationError(`提纲事件 ${event.id} 的人物绑定待核对，请在提纲中核对原文与改编句后再生成剧本`, 400);
      const explicit = boundText(event.text, event.binding);
      const grounded = eventContentCovered(explicit, event.sourceBindings.map(source => boundText(source.text, source.binding)).join('\n'));
      if (!grounded && event.binding.mentions.length && !event.binding.mentions.every(m => m.authority === 'human' && m.confirmed)) throw new ScriptGenerationError(`提纲事件 ${event.id} 的改编人物关系没有可验证的原文对应，请在提纲中核对并确认`, 400);
      if (event.sourceBindings.some(s => eventRelationConflict(explicit, boundText(s.text, s.binding)))) throw new ScriptGenerationError(`提纲事件 ${event.id} 的施受关系与已核对原文矛盾`, 400);
      // The downstream action is grounded in this outline text version. Originals
      // remain in sourceBindings with their own offsets and hashes.
      event.text = explicit;
      event.binding = bindEntities(explicit, roster);
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
    const anchoredEventIds: string[] = [];
    const claimedVisibleIds = new Set<string>();
    const locations = [...(script.document.locations || [])];
    const props = [...script.document.props];

    outline = assignUnassignedMustKeepEvents(outline);

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
            (p) => verifyEventContentCoverage(ev.text, p.text)
          );
          if (found) {
            sceneParagraphIds.add(found.id);
          }
        }
        if (sceneParagraphIds.size === 0) {
          throw new ScriptGenerationError(`第 ${sIdx + 1} 场缺少可核对的来源段落，不能按场序回填`, 400);
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

      const verbatimEvents = matchedEvents.map((event) => event.text.trim()).filter(Boolean);
      const visibleForScene = (outline.visibleBeats || []).filter((beat) =>
        (beat.sourceParagraphIds || []).some((pid) => sceneParagraphIds.has(pid))
      );
      for (const beat of visibleForScene) claimedVisibleIds.add(beat.id);
      const promptBeats = sIdx === totalScenes - 1
        ? [...visibleForScene, ...(outline.visibleBeats || []).filter((beat) => !claimedVisibleIds.has(beat.id))]
        : visibleForScene;
      const visibleSentences = promptBeats.map((beat) => beat.text.trim()).filter(Boolean);
      const scenePrompt = formatPrompt(getPrompt('script_scene_gen'), {
        chapterTitle: chapter.title || '第1章',
        outlineSummary: `一句话梗概: ${outline.logline}\n结尾钩子: ${outline.endingHook}`,
        sceneIndex: sIdx + 1,
        totalScenes,
        sceneEvents: `本场节拍（含地点、时间和调度）：${beat.purpose}\n本场必保事件：${eventsSummary}`,
        sourceParagraphs: sceneParagraphsText || '无对应段落',
        characters: charactersPrompt,
        previousSceneSummary,
        instructions: params.instructions || '将小说叙事转化为外部动作表演与高张力台词对白',
      }) + (verbatimEvents.length
        ? `\n\n本场至少一个 action.text 必须原样包含下列完整句子，不要改写：\n${verbatimEvents.join('\n')}`
        : '') + (visibleSentences.length
        ? `\n\n本场可见画面必须写入 action.text，对白和画外音不算覆盖。逐句保留服装、姿态和身体接触：\n${visibleSentences.join('\n')}`
        : '');

      let attemptPrompt = scenePrompt;
      let stableScene: ScriptScene | null = null;
      for (let attempt = 0; attempt < 2 && !stableScene; attempt++) {
        let rawScene: GeneratedSceneResponse | null = null;
        try {
          rawScene = await provider.generateStructured(
            attemptPrompt,
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

        const locName = (rawScene.location?.name || '场景地点').trim();
        let locationId = '';
        const existingLoc = locations.find(
          (l) => l.name.trim().toLowerCase() === locName.toLowerCase()
        );
        if (existingLoc) {
          locationId = existingLoc.id;
        } else if (attempt === 1 || matchedEvents.every((event) => verifyEventContentCoverage(event.text, rawScene!.blocks.map((block) => block.text).join(' ')))) {
          locationId = allocateLocationId(locations);
          locations.push({
            id: locationId,
            name: locName,
            description: (rawScene.location?.description || '').trim(),
          });
        }

        const sceneCharacterIds = new Set<number>();
        const performance = resolvePerformanceBlocks(
          rawScene.blocks,
          projectCharacters,
          (index) => `b_${sIdx + 1}_${index + 1}`,
          attempt === 1,
        );
        const sceneBlocks = performance.blocks;

        for (const block of sceneBlocks) {
          if ((block.type === 'dialogue' || block.type === 'voiceover') && block.characterId != null) {
            sceneCharacterIds.add(block.characterId);
          }
        }

        for (const name of rawScene.characterNames || []) {
          const matched = matchProjectCharacter(name, projectCharacters);
          if (matched) sceneCharacterIds.add(matched.id);
        }

        const sceneFullText = sceneBlocks.map((block) => [block.text, 'delivery' in block ? block.delivery : ''].filter(Boolean).join(' ')).join(' ');
        const verifiedSceneEventIds = new Set<string>();
        for (const ev of outline.mustKeepEvents) {
          if (verifyEventContentCoverage(ev.text, sceneFullText)) verifiedSceneEventIds.add(ev.id);
        }
        const missingBeatEvents = matchedEvents.filter((event) => !verifiedSceneEventIds.has(event.id));
        const reversedEvents = matchedEvents.filter(event => eventRelationConflict(event.text, sceneFullText));
        if (reversedEvents.length && attempt === 1) throw new ScriptGenerationError(`第 ${sIdx + 1} 场交换了必保事件的施受关系，不能用追加原句掩盖矛盾`, 502);
        if ((performance.unresolved.length > 0 || missingBeatEvents.length > 0) && attempt === 0) {
          const notes: string[] = [];
          if (missingBeatEvents.length > 0) {
            notes.push(`上次草稿没有原样写入必保事件。请重写，并让 action.text 逐字包含这些完整句子：\n${missingBeatEvents.map((event) => event.text).join('\n')}`);
          }
          if (performance.unresolved.length > 0) {
            const roster = projectCharacters.map((character) => character.name).join('、') || '（当前无角色档案）';
            const shown = performance.unresolved.map((item) => item.name || '（空）').join('、');
            notes.push(`上次草稿的说话人无法对应角色库：${shown}。对白 characterName 只能填写这些姓名：${roster}。不要用昵称或职位。没有明确说话人时不要写 dialogue，把那句改成 action。旁白使用 voiceover，characterName 填“旁白”。`);
          }
          attemptPrompt = `${scenePrompt}\n\n${notes.join('\n\n')}`;
          continue;
        }
        if (performance.unresolved.length > 0) {
          const first = performance.unresolved[0]!;
          const message = `未知角色: 第 ${sIdx + 1} 场模型${first.type === 'voiceover' ? '画外音' : '对白'}引用了角色 "${first.name}"，但在项目角色库中未找到。请先在角色中心建立该角色档案。`;
          logger.error(message);
          throw new ScriptGenerationError(message, 400);
        }
        if (missingBeatEvents.length > 0) {
          for (const event of missingBeatEvents) {
            sceneBlocks.push({
              id: `b_${sIdx + 1}_${sceneBlocks.length + 1}`,
              type: 'action',
              text: event.text.trim(),
            });
            verifiedSceneEventIds.add(event.id);
            anchoredEventIds.push(event.id);
          }
        }
        if (!locationId) {
          locationId = allocateLocationId(locations);
          locations.push({
            id: locationId,
            name: locName,
            description: (rawScene.location?.description || '').trim(),
          });
        }

        for (const block of sceneBlocks) if (block.type === 'action') {
          block.binding = bindEntities(block.text, entityRoster(projectCharacters));
        }
        stableScene = {
          id: `sc_${sIdx + 1}`,
          beatIds: [beat.id],
          eventIds: Array.from(verifiedSceneEventIds),
          sourceParagraphIds: Array.from(sceneParagraphIds),
          locationId,
          interiorExterior: rawScene.interiorExterior === 'exterior' ? 'exterior' : 'interior',
          timeOfDay: (rawScene.timeOfDay || 'day').trim(),
          characterIds: Array.from(sceneCharacterIds),
          propIds: resolveSceneProps(rawScene.props, props),
          blocks: sceneBlocks,
          estimatedDurationSec: rawScene.estimatedDurationSec || 30,
        };
      }

      generatedScenes.push(stableScene!);
    }

    const anchoredVisibleBeatIds = anchorMissingVisibleBeats(generatedScenes, outline.visibleBeats || []);
    for (const scene of generatedScenes) for (const block of scene.blocks) if (block.type === 'action' && !block.binding) block.binding = bindEntities(block.text, entityRoster(projectCharacters));

    // Step 3: Full Document Assembly & Validation
    const fullDocument: ScriptDocument = {
      schemaVersion: 1,
      title: script.document.title || `${chapter.title} 短剧剧本`,
      targetDurationSec: params.targetDurationSec || script.document.targetDurationSec || 120,
      outline,
      locations,
      props,
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

    const validation = validateScriptForConfirmation(fullDocument, { allowPendingBindings: true });
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
        ...(anchoredEventIds.length ? { anchoredEventIds } : {}),
        ...(anchoredVisibleBeatIds.length ? { anchoredVisibleBeatIds } : {}),
        ...(configuredLlmModel(params.provider) ? { model: configuredLlmModel(params.provider) } : {}),
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
      `本场道具: ${targetScene.propIds.map(id => script.document.props.find(prop => prop.id === id)?.name || id).join('、') || '无'}`,
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

    const performance = resolvePerformanceBlocks(
      rawScene.blocks,
      projectCharacters,
      (index) => `b_rw_${index + 1}_${Date.now()}`,
      true,
    );
    if (performance.unresolved.length > 0) {
      const first = performance.unresolved[0]!;
      throw new ScriptGenerationError(
        `未知角色: 改写分场中模型${first.type === 'voiceover' ? '画外音' : '对白'}引用了角色 "${first.name}"，但在项目角色库中未找到。`,
        400,
      );
    }
    const sceneBlocks = performance.blocks;
    for (const block of sceneBlocks) if (block.type === 'action') block.binding = bindEntities(block.text, entityRoster(projectCharacters));
    const sceneCharacterIds = new Set<number>();
    for (const block of sceneBlocks) {
      if ((block.type === 'dialogue' || block.type === 'voiceover') && block.characterId != null) {
        sceneCharacterIds.add(block.characterId);
      }
    }

    const rewrittenText = sceneBlocks.map((block) => block.text).join(' ');
    if (requiredEvents.some(event => eventRelationConflict(event.text, rewrittenText))) throw new ScriptGenerationError('改写分场交换了必保事件的施受关系', 502);
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

    const props = [...script.document.props];
    const propIds = rawScene.props === undefined
      ? targetScene.propIds
      : resolveSceneProps(rawScene.props, props);
    const rewrittenScene: ScriptScene = {
      id: targetScene.id,
      beatIds: targetScene.beatIds,
      eventIds: keptEventIds,
      sourceParagraphIds: targetScene.sourceParagraphIds,
      locationId: targetScene.locationId,
      interiorExterior: rawScene.interiorExterior === 'exterior' ? 'exterior' : 'interior',
      timeOfDay: (rawScene.timeOfDay || targetScene.timeOfDay).trim(),
      characterIds: Array.from(sceneCharacterIds),
      propIds,
      blocks: sceneBlocks,
      estimatedDurationSec: rawScene.estimatedDurationSec || targetScene.estimatedDurationSec,
    };

    return ScriptService.createPendingCandidate({
      scriptId: params.scriptId,
      kind: 'scene',
      expectedRevision: params.expectedRevision,
      requestKey: params.requestKey,
      afterJson: JSON.stringify({ ...rewrittenScene, props: props.filter(prop => !script.document.props.some(existing => existing.id === prop.id)) }),
      beforeJson: JSON.stringify(targetScene),
      sourceSnapshot,
      generationInfo: {
        target_scene_id: targetScene.id,
        instructions: params.instructions,
      },
    });
  }
}
