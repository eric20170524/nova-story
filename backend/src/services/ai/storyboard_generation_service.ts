import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../../db/database';
import { logger } from '../../core/logging';
import { LLMService } from '../llm';
import type { AIProvider } from './base';
import { formatPrompt, getPrompt } from './prompt_registry';
import { ScriptService, ScriptServiceError, type ScriptWithDetails } from '../script_service';
import {
  StoryboardCandidatePayloadSchema,
  type StoryboardCandidatePayload,
  type StoryboardCandidateShot,
  type ScriptDocument,
  type ScriptScene,
  type ScriptBlock,
  type ScriptChangeRow,
} from '../../schemas/script';
import {
  ShotIntentSchema,
  ShotContractFieldsSchema,
  SubjectScaleSchema,
  packShotSpec,
  type ShotIntent,
  type SubjectScale,
  type ShotSourceReference,
} from '../../schemas/shot_contract';
import {
  buildCharacterLockRefsForChapter,
  buildCharacterProfilesForChapter,
} from '../timeline_generation_service';
import { compilePonyPrompt } from '../pony_prompt_compiler';
import { sanitizeVisualPrompt } from '../visual_prompt_sanitizer';
import { compileNegativePrompt } from '../negative_prompt_compiler';
import {
  assertChapterUniqueness,
  formatUniquenessFailure,
} from '../visual_prompt_uniqueness';
import {
  assertChapterShotQuota,
  formatShotQuotaFailure,
} from '../shot_intent_quota';
import { ensureSceneVersionBaseline } from '../scene_versions';
import { AssetLibraryService } from '../asset_library_service';

export class StoryboardGenerationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 500 | 502 = 502
  ) {
    super(message);
    this.name = 'StoryboardGenerationError';
  }
}

/** Raw LLM output schema for shot contracts generated from script */
export const RawStoryboardShotSchema = z.object({
  script_scene_id: z.string().min(1, '分场 ID 不能为空'),
  block_ids: z.array(z.string()).default([]),
  shot_intent: ShotIntentSchema.optional(),
  shot_type: z.string().default('Medium Shot'),
  location: z.string().trim().min(2, '地点描述不能少于2个字').max(240),
  primary_action: z.string().trim().min(2, '主要动作不能少于2个字').max(240),
  primary_subject: z.string().trim().max(240).optional().nullable(),
  visible_subjects: z
    .array(z.string().trim().min(1).max(120))
    .max(6)
    .optional()
    .default([]),
  key_props: z
    .array(z.string().trim().min(1).max(120))
    .max(2)
    .optional()
    .default([]),
  subject_scale: SubjectScaleSchema.optional(),
  camera_movement: z.string().optional().default('Static'),
  camera_angle: z.string().optional().default('Eye-level'),
  duration: z.number().positive().optional().default(3.0),
  must_not: z.array(z.string().trim().min(1).max(120)).optional().default([]),
});

export const RawStoryboardResponseSchema = z.object({
  shots: z.array(RawStoryboardShotSchema).min(1, '至少需要生成一个分镜镜头'),
});

export type RawStoryboardShot = z.infer<typeof RawStoryboardShotSchema>;
export type RawStoryboardResponse = z.infer<typeof RawStoryboardResponseSchema>;

const stripAssetLabel = (value: string): string => value.replace(/^(?:场景|地点|道具|物品)\s*[：:]\s*/u, '').trim();

function validateStoryboardCoverage(doc: ScriptDocument, rawShots: Array<Pick<RawStoryboardShot, 'script_scene_id' | 'block_ids'>>) {
    // 8. Coverage and validation gates
    const sceneMap = new Map<string, ScriptScene>();
    for (const sc of doc.scenes) {
      sceneMap.set(sc.id, sc);
    }

    // Verify Scene Coverage: all scenes in doc.scenes must have >=1 shot
    const coveredSceneIdSet = new Set<string>();
    for (const shot of rawShots) {
      coveredSceneIdSet.add(shot.script_scene_id);
    }
    const missingSceneIds = doc.scenes
      .map((s) => s.id)
      .filter((id) => !coveredSceneIdSet.has(id));
    if (missingSceneIds.length > 0) {
      throw new StoryboardGenerationError(
        `分镜候选未覆盖剧本全部场次，遗漏分场: [${missingSceneIds.join(', ')}]`,
        400
      );
    }

    // Verify Audible Block Coverage and strict order preservation
    // Map each block id to its block and scene
    const blockMap = new Map<string, { block: ScriptBlock; sceneId: string; indexInScene: number }>();
    const allAudibleBlockIds = new Set<string>();

    for (const sc of doc.scenes) {
      for (let bIdx = 0; bIdx < sc.blocks.length; bIdx++) {
        const b = sc.blocks[bIdx]!;
        blockMap.set(b.id, { block: b, sceneId: sc.id, indexInScene: bIdx });
        if (b.type === 'dialogue' || b.type === 'voiceover') {
          allAudibleBlockIds.add(b.id);
        }
      }
    }

    const allocatedBlockIds = new Set<string>();
    const duplicateBlockIds: string[] = [];
    const foreignBlockIds: string[] = [];

    for (const shot of rawShots) {
      if (!sceneMap.has(shot.script_scene_id)) {
        throw new StoryboardGenerationError(
          `镜头引用的分场 ID "${shot.script_scene_id}" 不存在于剧本中`,
          400
        );
      }

      for (const blockId of shot.block_ids) {
        const info = blockMap.get(blockId);
        if (!info) {
          throw new StoryboardGenerationError(
            `镜头引用的内容块 ID "${blockId}" 未在剧本中声明`,
            400
          );
        }
        if (info.sceneId !== shot.script_scene_id) {
          foreignBlockIds.push(blockId);
        }
        if (allocatedBlockIds.has(blockId)) {
          duplicateBlockIds.push(blockId);
        } else {
          allocatedBlockIds.add(blockId);
        }
      }
    }

    if (foreignBlockIds.length > 0) {
      throw new StoryboardGenerationError(
        `镜头引用了不属于当前分场的内容块: [${foreignBlockIds.join(', ')}]`,
        400
      );
    }

    if (duplicateBlockIds.length > 0) {
      throw new StoryboardGenerationError(
        `内容块 ID 重复分配: [${duplicateBlockIds.join(', ')}]`,
        400
      );
    }

    // Check all audible blocks are allocated exactly once
    const missingAudibleBlockIds: string[] = [];
    for (const audibleId of allAudibleBlockIds) {
      if (!allocatedBlockIds.has(audibleId)) {
        missingAudibleBlockIds.push(audibleId);
      }
    }
    if (missingAudibleBlockIds.length > 0) {
      throw new StoryboardGenerationError(
        `遗漏对白或画外音内容块: [${missingAudibleBlockIds.join(', ')}]`,
        400
      );
    }

    // Check strict relative order of audible blocks in each scene
    for (const sc of doc.scenes) {
      const sceneShots = rawShots.filter((s) => s.script_scene_id === sc.id);
      let lastBlockIndex = -1;
      for (const s of sceneShots) {
        for (const bId of s.block_ids) {
          const info = blockMap.get(bId);
          if (info && (info.block.type === 'dialogue' || info.block.type === 'voiceover')) {
            if (info.indexInScene < lastBlockIndex) {
              throw new StoryboardGenerationError(
                `分场 "${sc.id}" 内对白或画外音内容块顺序颠倒 (block ${bId})`,
                400
              );
            }
            lastBlockIndex = info.indexInScene;
          }
        }
      }
    }

    return { coveredSceneIdSet, allocatedBlockIds, blockMap, allAudibleBlockIds };
}

export class StoryboardGenerationService {
  private static validatePayload(payload: StoryboardCandidatePayload, script: ScriptWithDetails) {
    if (payload.shots.length > 20) {
      throw new StoryboardGenerationError('候选分镜超过 20 镜预算上限', 400);
    }
    if (payload.scriptId !== script.id || payload.scriptRevision !== script.revision || payload.chapterId !== script.chapterId) {
      throw new StoryboardGenerationError('候选分镜的剧本来源版本或章节不匹配', 409);
    }
    const { blockMap } = validateStoryboardCoverage(script.document, payload.shots);
    const contracts = payload.shots.map((shot) => {
      let spec;
      try {
        const packed = JSON.parse(shot.shot_spec);
        // packShotSpec encodes absent optional enum fields as null.
        spec = ShotContractFieldsSchema.parse({ ...packed, shot_intent: packed.shot_intent ?? undefined, subject_scale: packed.subject_scale ?? undefined });
      }
      catch { throw new StoryboardGenerationError('候选分镜包含非法镜头契约', 400); }
      for (const source of [spec.source, ...(shot.source ? [shot.source] : [])]) {
        if (!source || source.type !== 'script' || source.script_id !== script.id ||
            source.script_revision !== script.revision || source.script_scene_id !== shot.script_scene_id ||
            JSON.stringify(source.block_ids) !== JSON.stringify(shot.block_ids)) {
          throw new StoryboardGenerationError('镜头契约来源与候选分镜不一致', 400);
        }
      }
      const blocks = shot.block_ids.map((id) => blockMap.get(id)!.block);
      const text = (type: ScriptBlock['type'], separator: string) => blocks.filter((block) => block.type === type).map((block) => block.text.trim()).join(separator);
      if (shot.dialogue !== text('dialogue', '\n') || shot.narration !== text('voiceover', '\n') || shot.audio_prompt !== text('sound', '; ')) {
        throw new StoryboardGenerationError('镜头对白、旁白或音效与剧本内容块不一致', 400);
      }
      return { ...shot, shot_intent: spec.shot_intent, key_props: spec.key_props };
    });
    for (let index = 1; index < contracts.length; index++) {
      const previousPrompt = String(contracts[index - 1]!.visual_prompt || '').trim().replace(/\s+/g, ' ');
      const currentPrompt = String(contracts[index]!.visual_prompt || '').trim().replace(/\s+/g, ' ');
      if (previousPrompt && previousPrompt === currentPrompt) {
        throw new StoryboardGenerationError(`相邻镜头 ${index} 与 ${index + 1} 的视觉提示完全相同`, 400);
      }
    }
    // Reused sets and character locks dominate the compiled visual prompt. Compare
    // the changing shot contract instead, while retaining the explicit identity key.
    const uniqueness = assertChapterUniqueness(contracts.map(shot => ({
      visual_prompt: [shot.shot_intent, JSON.parse(shot.shot_spec).primary_action,
        ...shot.key_props].filter(Boolean).join(', '),
      uniqueness_key: JSON.parse(shot.shot_spec).uniqueness_key,
    })));
    if (uniqueness.ok === false) throw new StoryboardGenerationError(formatUniquenessFailure(uniqueness.violation), 400);
    const quota = assertChapterShotQuota(contracts, { hasKeyProps: script.document.props.length > 0 || contracts.some((shot) => shot.key_props.length > 0) });
    if (quota.ok === false) throw new StoryboardGenerationError(formatShotQuotaFailure(quota.violation), 400);
  }
  /**
   * Phase 1: Generate storyboard candidate from confirmed screenplay.
   * Compiles contracts, sanitizes, uniqueness check, quota check, block coverage.
   * Persists as kind='storyboard' candidate in script_change table.
   */
  static async generateStoryboardCandidate(params: {
    scriptId: number;
    expectedRevision: number;
    requestKey: string;
    instructions?: string;
    token?: string;
    provider?: AIProvider;
  }): Promise<ScriptChangeRow> {
    // 1. Idempotency check by script_id + request_key
    const existing = (await db.get(
      'SELECT * FROM script_change WHERE script_id = ? AND request_key = ?',
      params.scriptId,
      params.requestKey
    )) as ScriptChangeRow | undefined;
    if (existing) {
      return existing;
    }

    // 2. Fetch script and verify confirmed status & revision
    const script = await ScriptService.getScriptById(params.scriptId);
    if (script.revision !== params.expectedRevision) {
      throw new StoryboardGenerationError(
        `Revision conflict: expected revision ${params.expectedRevision}, but current revision is ${script.revision}`,
        409
      );
    }

    if (script.status !== 'confirmed') {
      throw new StoryboardGenerationError(
        '只有已确认（confirmed）的剧本才能生成分镜候选',
        400
      );
    }

    // 3. Verify freshness of source snapshot
    const freshness = script.freshness;
    if (freshness.sourceChanged) {
      throw new StoryboardGenerationError(
        '剧本来源已过期，请核对更新剧本后再生成分镜候选',
        409
      );
    }

    const doc: ScriptDocument = script.document;
    if (!doc.scenes || doc.scenes.length === 0) {
      throw new StoryboardGenerationError(
        '剧本不包含任何有效戏剧分场，无法生成分镜',
        400
      );
    }

    // 4. Load character profiles & locks
    const characterProfiles = await buildCharacterProfilesForChapter(
      script.projectId,
      script.chapterId
    );
    const characterLocks = await buildCharacterLockRefsForChapter(
      script.projectId,
      script.chapterId
    );

    // 5. Build prompt
    const locationNames = new Map(doc.locations.map(location => [location.id, location.name]));
    const propNames = new Map(doc.props.map(prop => [prop.id, prop.name]));
    const libraryAssets = await AssetLibraryService.list(script.projectId);
    const assetCatalog = libraryAssets.length
      ? `场景名称：${libraryAssets.filter(asset => asset.kind === 'location').map(asset => asset.name).join('、')}\n道具名称：${libraryAssets.filter(asset => asset.kind === 'prop').map(asset => asset.name).join('、')}`
      : '尚未建立资产库，请沿用剧本中声明的地点和道具名称。';
    const scriptScenesSummary = doc.scenes.map((s, idx) => {
      const blocksDesc = s.blocks
        .map((b) => {
          if (b.type === 'action') return `    [${b.id}] 动作: ${b.text}`;
          if (b.type === 'dialogue') {
            return `    [${b.id}] 对白 (角色ID=${b.characterId}${b.delivery ? `，情绪=${b.delivery}` : ''}): ${b.text}`;
          }
          if (b.type === 'voiceover') {
            return `    [${b.id}] 画外音 (角色ID=${b.characterId ?? '旁白'}): ${b.text}`;
          }
          if (b.type === 'sound') return `    [${b.id}] 音效: ${b.text}`;
          return '';
        })
        .join('\n');

      return `分场 ${idx + 1} (id: ${s.id}):
  地点ID: ${s.locationId}, 地点名称: ${locationNames.get(s.locationId) || ''}, 景别: ${s.interiorExterior === 'exterior' ? '外景' : '内景'}, 时间: ${s.timeOfDay}
  道具名称: ${s.propIds.map(id => propNames.get(id) || id).join('、') || '无'}
  出场角色ID: [${s.characterIds.join(', ')}]
  内容块:
${blocksDesc}`;
    }).join('\n\n');

    const prompt = formatPrompt(getPrompt('script_storyboard_gen'), {
      chapterTitle: script.sourceSnapshot?.chapterTitle || `第 ${script.chapterId} 章`,
      targetDurationSec: doc.targetDurationSec || 120,
      characterProfiles: characterProfiles || '(无特定锁定标签)',
      assetCatalog,
      directorInstructions: params.instructions?.trim() || '遵循剧本，不增加无关地点和道具。',
      scriptContent: scriptScenesSummary,
    });

    // 6. Call Provider / LLM
    const provider = params.provider || LLMService.getProvider(params.token);
    let rawResult: RawStoryboardResponse | null = null;
    try {
      rawResult = await provider.generateStructured(
        prompt,
        RawStoryboardResponseSchema,
        '你是一位专业影视导演和分镜师，请严格按要求输出 JSON 格式分镜镜头列表。'
      );
    } catch (err: any) {
      logger.error(`Failed to generate storyboard: ${err}`);
      throw new StoryboardGenerationError(
        `模型生成分镜候选失败: ${err.message || String(err)}。正式时间线未发生任何更改。`,
        502
      );
    }

    if (!rawResult || !rawResult.shots || rawResult.shots.length === 0) {
      throw new StoryboardGenerationError(
        '模型返回空结果，未能生成有效分镜镜头契约。',
        502
      );
    }

    const rawShots = rawResult.shots.map(shot => ({
      ...shot,
      location: stripAssetLabel(shot.location),
      key_props: shot.key_props.map(stripAssetLabel),
    }));

    // 7. Hard cap gate: Max 20 shots budget (fail closed, do NOT slice)
    if (rawShots.length > 20) {
      throw new StoryboardGenerationError(
        `镜头数量 (${rawShots.length} 镜) 超过 20 镜上限，请精简剧本分场或缩短内容`,
        400
      );
    }

    const { coveredSceneIdSet, allocatedBlockIds, blockMap, allAudibleBlockIds } = validateStoryboardCoverage(doc, rawShots);

    // 9. Deterministic assembly of dialogue, narration, audio_prompt & compilation
    const preparedCandidateShots: StoryboardCandidateShot[] = [];

    for (let i = 0; i < rawShots.length; i++) {
      const shot = rawShots[i]!;
      const location = shot.location.trim();
      const primary_action = shot.primary_action.trim();
      const key_props = shot.key_props || [];
      const shot_intent = shot.shot_intent || null;
      const subject_scale = shot.subject_scale || null;
      const primary_subject = shot.primary_subject || null;
      const visible_subjects = shot.visible_subjects || [];

      // Assemble dialogue, narration, audio_prompt deterministically from referenced blocks
      const dialogueTexts: string[] = [];
      const narrationTexts: string[] = [];
      const soundTexts: string[] = [];

      for (const bId of shot.block_ids) {
        const info = blockMap.get(bId);
        if (!info) continue;
        if (info.block.type === 'dialogue') {
          dialogueTexts.push(info.block.text.trim());
        } else if (info.block.type === 'voiceover') {
          narrationTexts.push(info.block.text.trim());
        } else if (info.block.type === 'sound') {
          soundTexts.push(info.block.text.trim());
        }
      }

      const dialogue = dialogueTexts.join('\n');
      const narration = narrationTexts.join('\n');
      const audio_prompt = soundTexts.join('; ');

      // Compile visual prompt from contract fields
      const compiled = compilePonyPrompt(
        {
          shot_intent,
          shot_type: shot.shot_type,
          location,
          primary_action,
          primary_subject,
          visible_subjects,
          key_props,
          subject_scale,
          must_not: shot.must_not || [],
        },
        characterLocks
      );

      const sanitized = sanitizeVisualPrompt(compiled.visual_prompt);
      const compiledNegative = compileNegativePrompt({
        shot_type: shot.shot_type,
        shot_intent: compiled.shot_intent || shot_intent,
        visual_prompt: sanitized.visual_prompt,
        location,
        key_props,
        character_lock: characterLocks.map((ref) => ref.lock).join(', '),
        identity_mode: 'auto',
      });

      const negative_prompt = [
        compiledNegative,
        ...compiled.negative_extras,
        ...sanitized.negative_extras,
      ]
        .filter(Boolean)
        .join(', ');

      const sourceRef: ShotSourceReference = {
        type: 'script',
        script_id: script.id,
        script_revision: script.revision,
        script_scene_id: shot.script_scene_id,
        block_ids: shot.block_ids,
      };

      const shot_spec = packShotSpec({
        shot_intent: compiled.shot_intent || shot_intent,
        location,
        primary_action,
        primary_subject,
        visible_subjects,
        key_props,
        subject_scale,
        must_not: shot.must_not || [],
        shot_type: shot.shot_type,
        source: sourceRef,
      });

      preparedCandidateShots.push({
        index: i + 1,
        script_scene_id: shot.script_scene_id,
        block_ids: shot.block_ids,
        visual_prompt: sanitized.visual_prompt,
        audio_prompt,
        dialogue,
        narration,
        duration: shot.duration || 3.0,
        shot_type: shot.shot_type || 'Medium Shot',
        camera_movement: shot.camera_movement || 'Static',
        camera_angle: shot.camera_angle || 'Eye-level',
        negative_prompt: negative_prompt || null,
        shot_spec,
        source: sourceRef,
      });
    }

    // 10. Run compiler uniqueness & quota gates
    const uniqueness = assertChapterUniqueness(preparedCandidateShots.map(s => {
      const spec = JSON.parse(s.shot_spec);
      return {
        visual_prompt: [spec.shot_intent, spec.primary_action,
          ...spec.key_props].filter(Boolean).join(', '),
        uniqueness_key: spec.uniqueness_key,
      };
    }));
    if (uniqueness.ok === false) {
      throw new StoryboardGenerationError(
        formatUniquenessFailure(uniqueness.violation),
        502
      );
    }

    const hasKeyProps =
      (doc.props && doc.props.length > 0) ||
      rawShots.some((s) => s.key_props && s.key_props.length > 0);

    const quota = assertChapterShotQuota(
      preparedCandidateShots.map((s) => ({
        shot_type: s.shot_type,
        shot_intent: JSON.parse(s.shot_spec).shot_intent,
        visual_prompt: s.visual_prompt,
      })),
      { hasKeyProps }
    );
    if (quota.ok === false) {
      throw new StoryboardGenerationError(
        formatShotQuotaFailure(quota.violation),
        502
      );
    }

    // 11. Build payload & coverage report
    const totalDuration = preparedCandidateShots.reduce(
      (sum, s) => sum + s.duration,
      0
    );
    const estimatedScriptDuration = doc.scenes.reduce(
      (sum, s) => sum + (s.estimatedDurationSec || 0),
      0
    );

    const coveredMustKeepEventIds = (doc.outline?.mustKeepEvents || [])
      .filter((ev) => {
        // Must-keep event covered if any covered scene contains it
        return doc.scenes.some(
          (sc) => coveredSceneIdSet.has(sc.id) && sc.eventIds?.includes(ev.id)
        );
      })
      .map((ev) => ev.id);

    const payload: StoryboardCandidatePayload = {
      schemaVersion: 1,
      scriptId: script.id,
      scriptRevision: script.revision,
      chapterId: script.chapterId,
      totalDuration,
      estimatedScriptDuration,
      coverageReport: {
        coveredSceneIds: Array.from(coveredSceneIdSet),
        totalScenes: doc.scenes.length,
        coveredBlockIds: Array.from(allocatedBlockIds),
        totalAudibleBlocks: allAudibleBlockIds.size,
        coveredMustKeepEventIds,
        totalMustKeepEvents: doc.outline?.mustKeepEvents?.length || 0,
      },
      shots: preparedCandidateShots,
    };

    // 12. Save pending candidate in script_change
    return ScriptService.createPendingCandidate({
      scriptId: script.id,
      kind: 'storyboard',
      expectedRevision: params.expectedRevision,
      requestKey: params.requestKey,
      afterJson: JSON.stringify(payload),
      sourceSnapshot: script.sourceSnapshot,
      generationInfo: {
        total_shots: preparedCandidateShots.length,
        total_duration: totalDuration,
        instructions: params.instructions,
      },
    });
  }

  /**
   * Phase 2: Apply a pending storyboard candidate to the chapter timeline.
   * Safety rules:
   * - Must verify script exists, confirmed, revision matches
   * - Must verify freshness (!sourceChanged)
   * - Must verify candidate state is pending and base_revision matches
   * - Must verify Timeline is EMPTY (scene count = 0)
   * - Must verify no in-flight tasks
   * - Atomic transaction: inserts scenes + scene_version baselines + updates candidate to applied
   */
  static async applyStoryboardCandidate(params: {
    scriptId: number;
    changeId: string;
    expectedRevision: number;
    expectedCandidateRevision?: number;
    requestKey?: string;
  }): Promise<{
    success: boolean;
    count: number;
    scene_ids: number[];
    already_applied?: boolean;
  }> {
    // 1. Fetch script and verify
    const script = await ScriptService.getScriptById(params.scriptId);
    if (script.revision !== params.expectedRevision) {
      throw new StoryboardGenerationError(
        `Revision conflict: expected script revision ${params.expectedRevision}, but current revision is ${script.revision}`,
        409
      );
    }

    if (script.status !== 'confirmed') {
      throw new StoryboardGenerationError(
        '只有已确认（confirmed）的剧本才能提交分镜到时间线',
        400
      );
    }

    const freshness = script.freshness;
    if (freshness.sourceChanged) {
      throw new StoryboardGenerationError(
        '剧本来源已过期，请核对更新剧本后重新生成分镜候选',
        409
      );
    }

    // 2. Fetch candidate
    const candidate = (await db.get(
      'SELECT * FROM script_change WHERE id = ? AND script_id = ?',
      params.changeId,
      params.scriptId
    )) as ScriptChangeRow | undefined;

    if (!candidate) {
      throw new StoryboardGenerationError(
        `Candidate "${params.changeId}" not found`,
        404
      );
    }

    if (candidate.kind !== 'storyboard') {
      throw new StoryboardGenerationError(
        `Candidate kind "${candidate.kind}" is not a storyboard candidate`,
        400
      );
    }

    // Idempotent retry: if already applied, return previously created scene IDs
    if (candidate.state === 'applied') {
      let sceneIds: number[] = [];
      try {
        const result = JSON.parse(candidate.result_json || '{}');
        sceneIds = result.scene_ids || [];
      } catch {}
      return {
        success: true,
        count: sceneIds.length,
        scene_ids: sceneIds,
        already_applied: true,
      };
    }

    if (candidate.state !== 'pending') {
      throw new StoryboardGenerationError(
        `Candidate is in "${candidate.state}" state and cannot be applied`,
        409
      );
    }

    if (candidate.base_revision !== params.expectedRevision) {
      throw new StoryboardGenerationError(
        `Candidate base revision (${candidate.base_revision}) does not match current script revision (${params.expectedRevision})`,
        409
      );
    }

    if (
      params.expectedCandidateRevision !== undefined &&
      candidate.candidate_revision !== params.expectedCandidateRevision
    ) {
      throw new StoryboardGenerationError(
        `Revision conflict: candidate revision is ${candidate.candidate_revision}, but expected ${params.expectedCandidateRevision}`,
        409
      );
    }

    // 3. Empty Timeline check (SC09, SC10): first phase only permits applying to empty timeline!
    const existingSceneRow = (await db.get(
      'SELECT COUNT(*) as count FROM scene WHERE chapter_id = ?',
      script.chapterId
    )) as { count: number } | undefined;

    if (existingSceneRow && Number(existingSceneRow.count) > 0) {
      throw new StoryboardGenerationError(
        '当前章节已有分镜镜头，为保护现有制作资产，首期仅允许向空时间线提交。',
        409
      );
    }

    // 4. In-flight task check
    const inFlightRow = (await db.get(
      `SELECT COUNT(*) as count FROM generation_task gt
       INNER JOIN scene s ON s.id = gt.scene_id
       WHERE s.chapter_id = ? AND gt.status = 'processing'`,
      script.chapterId
    )) as { count: number } | undefined;

    if (inFlightRow && Number(inFlightRow.count) > 0) {
      throw new StoryboardGenerationError(
        '当前章节存在正在执行的制作任务，无法提交分镜',
        409
      );
    }

    // 5. Parse candidate payload
    let payload: StoryboardCandidatePayload;
    try {
      payload = StoryboardCandidatePayloadSchema.parse(
        JSON.parse(candidate.after_json)
      );
    } catch (err: any) {
      throw new StoryboardGenerationError(
        `候选分镜载荷损坏或格式非法: ${err.message}`,
        400
      );
    }

    // 6. Atomic application in a short transaction
    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      // Re-read all mutable gates after acquiring the write transaction.
      const lockedScript = await ScriptService.getScriptById(params.scriptId);
      const lockedCandidate = await db.get('SELECT * FROM script_change WHERE id = ? AND script_id = ?', params.changeId, params.scriptId);
      if (lockedScript.revision !== params.expectedRevision || lockedScript.status !== 'confirmed' || lockedScript.freshness.sourceChanged ||
          !lockedCandidate || lockedCandidate.state !== 'pending' || lockedCandidate.base_revision !== lockedScript.revision ||
          lockedCandidate.candidate_revision !== candidate.candidate_revision) {
        throw new StoryboardGenerationError('Revision conflict: script or candidate changed before submission', 409);
      }
      this.validatePayload(payload, lockedScript);
      // Re-verify empty timeline inside transaction for concurrent safety
      const innerSceneRow = (await db.get(
        'SELECT COUNT(*) as count FROM scene WHERE chapter_id = ?',
        script.chapterId
      )) as { count: number } | undefined;

      if (innerSceneRow && Number(innerSceneRow.count) > 0) {
        throw new StoryboardGenerationError(
          '当前章节已有分镜镜头，为保护现有制作资产，首期仅允许向空时间线提交。',
          409
        );
      }

      const insertedSceneIds: number[] = [];

      for (let i = 0; i < payload.shots.length; i++) {
        const shot = payload.shots[i]!;
        const result = await db.run(
          `INSERT INTO scene (
             chapter_id, "index", visual_prompt, audio_prompt, dialogue, narration, duration,
             shot_type, camera_movement, camera_angle, negative_prompt, shot_spec, asset_status, active_version
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', 1)`,
          script.chapterId,
          i + 1,
          shot.visual_prompt || '',
          shot.audio_prompt || '',
          shot.dialogue || '',
          shot.narration || '',
          shot.duration || 3.0,
          shot.shot_type || '',
          shot.camera_movement || '',
          shot.camera_angle || '',
          shot.negative_prompt || null,
          shot.shot_spec || null
        );

        const newSceneId = Number(result.lastID);
        if (!newSceneId) {
          throw new StoryboardGenerationError('Failed to retrieve inserted scene ID', 500);
        }
        insertedSceneIds.push(newSceneId);

        // Create scene_version baseline
        await ensureSceneVersionBaseline(newSceneId);
      }

      // Mark candidate as applied and record result
      await db.run(
        `UPDATE script_change
         SET state = 'applied',
             applied_revision = ?,
             result_json = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        script.revision,
        JSON.stringify({ scene_ids: insertedSceneIds }),
        candidate.id
      );

      await db.exec('COMMIT');

      return {
        success: true,
        count: insertedSceneIds.length,
        scene_ids: insertedSceneIds,
      };
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }
}
