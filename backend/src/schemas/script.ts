import { z } from 'zod';
import crypto from 'node:crypto';
import { ShotSourceReferenceSchema, type ShotSourceReference } from './shot_contract';

/**
 * ScriptDocument Schema & Types
 * Reference: docs/architecture/structured_screenplay_module_2026-09-28.md
 * 
 * Flow: 小说故事 → 改编提纲 → 分场剧本 (ScriptDocument) → 现有导演分镜 (Shot Contract)
 * 
 * Crucial terminology distinction:
 * - scriptScene: 剧本分场 / 戏剧场景 (one dramatic scene in a screenplay)
 * - scene: 分镜镜头 / 视觉镜头 (one camera shot in director timeline)
 */

export const ScriptActionBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal('action'),
  text: z.string().min(1),
});

export const ScriptDialogueBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal('dialogue'),
  characterId: z.number().int(),
  text: z.string().min(1),
  delivery: z.string().optional(),
});

export const ScriptVoiceoverBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal('voiceover'),
  characterId: z.number().int().nullable().default(null),
  text: z.string().min(1),
});

export const ScriptSoundBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal('sound'),
  text: z.string().min(1),
});

export const ScriptBlockSchema = z.discriminatedUnion('type', [
  ScriptActionBlockSchema,
  ScriptDialogueBlockSchema,
  ScriptVoiceoverBlockSchema,
  ScriptSoundBlockSchema,
]);

export const ScriptLocationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
});

export const ScriptPropSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
});

export const ScriptBeatSchema = z.object({
  id: z.string().min(1),
  purpose: z.string().min(1),
  eventIds: z.array(z.string()).default([]),
});

export const ScriptMustKeepEventSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  sourceParagraphIds: z.array(z.string()).default([]),
});

export const ScriptOutlineSchema = z.object({
  logline: z.string().default(''),
  mustKeepEvents: z.array(ScriptMustKeepEventSchema).default([]),
  beats: z.array(ScriptBeatSchema).default([]),
  endingHook: z.string().default(''),
});

export const ScriptSceneSchema = z.object({
  id: z.string().min(1),
  beatIds: z.array(z.string()).default([]),
  eventIds: z.array(z.string()).default([]),
  sourceParagraphIds: z.array(z.string()).default([]),
  locationId: z.string().default(''),
  interiorExterior: z.enum(['interior', 'exterior']).default('interior'),
  timeOfDay: z.string().default('day'),
  characterIds: z.array(z.number().int()).default([]),
  propIds: z.array(z.string()).default([]),
  blocks: z.array(ScriptBlockSchema).default([]),
  estimatedDurationSec: z.number().positive().optional(),
});

export const ScriptDocumentBaseSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  title: z.string().default('短剧剧本'),
  targetDurationSec: z.number().int().min(10).max(1800).default(120),
  outline: ScriptOutlineSchema.default(() => ({
    logline: '',
    mustKeepEvents: [],
    beats: [],
    endingHook: '',
  })),
  locations: z.array(ScriptLocationSchema).default([]),
  props: z.array(ScriptPropSchema).default([]),
  scenes: z.array(ScriptSceneSchema).max(12).default([]),
});

export const ScriptDocumentSchema = ScriptDocumentBaseSchema.superRefine((doc, ctx) => {
  // 1. Unique location IDs
  const seenLocs = new Set<string>();
  for (let i = 0; i < doc.locations.length; i++) {
    const loc = doc.locations[i];
    if (!loc) continue;
    if (seenLocs.has(loc.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['locations', i, 'id'],
        message: `地点 ID "${loc.id}" 重复`,
      });
    } else {
      seenLocs.add(loc.id);
    }
  }

  // 2. Unique prop IDs
  const seenProps = new Set<string>();
  for (let i = 0; i < doc.props.length; i++) {
    const p = doc.props[i];
    if (!p) continue;
    if (seenProps.has(p.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['props', i, 'id'],
        message: `道具 ID "${p.id}" 重复`,
      });
    } else {
      seenProps.add(p.id);
    }
  }

  // 3. Unique scenes & block IDs, plus reference validation
  const seenScenes = new Set<string>();
  const seenBlocks = new Set<string>();

  for (let sIdx = 0; sIdx < doc.scenes.length; sIdx++) {
    const scene = doc.scenes[sIdx];
    if (!scene) continue;

    if (seenScenes.has(scene.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scenes', sIdx, 'id'],
        message: `分场 ID "${scene.id}" 重复`,
      });
    } else {
      seenScenes.add(scene.id);
    }

    // Location reference check: if specified, must exist in doc.locations
    if (scene.locationId && scene.locationId.trim()) {
      if (!seenLocs.has(scene.locationId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scenes', sIdx, 'locationId'],
          message: `分场引用的地点 ID "${scene.locationId}" 未在剧本地点列表 (locations) 中声明`,
        });
      }
    }

    // Prop references check
    for (let pIdx = 0; pIdx < scene.propIds.length; pIdx++) {
      const pid = scene.propIds[pIdx];
      if (pid !== undefined && !seenProps.has(pid)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scenes', sIdx, 'propIds', pIdx],
          message: `分场引用的道具 ID "${pid}" 未在剧本道具列表 (props) 中声明`,
        });
      }
    }

    // Cast and dialogue reference check
    const sceneCast = new Set(scene.characterIds);
    for (let bIdx = 0; bIdx < scene.blocks.length; bIdx++) {
      const block = scene.blocks[bIdx];
      if (!block) continue;

      if (seenBlocks.has(block.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scenes', sIdx, 'blocks', bIdx, 'id'],
          message: `内容块 ID "${block.id}" 重复出现`,
        });
      } else {
        seenBlocks.add(block.id);
      }

      if (block.type === 'dialogue') {
        if (!sceneCast.has(block.characterId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['scenes', sIdx, 'blocks', bIdx, 'characterId'],
            message: `对白角色 ID ${block.characterId} 未包含在当前分场出场角色名单 (characterIds) 中`,
          });
        }
      }
    }
  }
});

export type ScriptActionBlock = z.infer<typeof ScriptActionBlockSchema>;
export type ScriptDialogueBlock = z.infer<typeof ScriptDialogueBlockSchema>;
export type ScriptVoiceoverBlock = z.infer<typeof ScriptVoiceoverBlockSchema>;
export type ScriptSoundBlock = z.infer<typeof ScriptSoundBlockSchema>;
export type ScriptBlock = z.infer<typeof ScriptBlockSchema>;
export type ScriptLocation = z.infer<typeof ScriptLocationSchema>;
export type ScriptProp = z.infer<typeof ScriptPropSchema>;
export type ScriptBeat = z.infer<typeof ScriptBeatSchema>;
export type ScriptMustKeepEvent = z.infer<typeof ScriptMustKeepEventSchema>;
export type ScriptOutline = z.infer<typeof ScriptOutlineSchema>;
export type ScriptScene = z.infer<typeof ScriptSceneSchema>;
export type ScriptDocument = z.infer<typeof ScriptDocumentSchema>;

/** Script publication / approval status */
export const ScriptStatusSchema = z.enum(['draft', 'confirmed']);
export type ScriptStatus = z.infer<typeof ScriptStatusSchema>;

/** Change / candidate types for script_change table */
export const ScriptChangeKindSchema = z.enum([
  'outline',
  'script',
  'scene',
  'storyboard',
  'manual',
  'confirm',
  'restore',
]);
export type ScriptChangeKind = z.infer<typeof ScriptChangeKindSchema>;

export const ScriptChangeStateSchema = z.enum(['pending', 'applied', 'discarded']);
export type ScriptChangeState = z.infer<typeof ScriptChangeStateSchema>;

/** Source snapshot capturing source chapter text & semantic context */
export const ScriptSourceSnapshotSchema = z.object({
  chapterId: z.string(),
  chapterTitle: z.string().default(''),
  content: z.string(),
  contentHash: z.string(),
  contextHash: z.string(),
  characterSnapshots: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      role: z.string().optional().nullable(),
    })
  ).default([]),
  glossarySnapshots: z.array(
    z.object({
      term: z.string(),
      definition: z.string().optional().nullable(),
    })
  ).default([]),
  paragraphSnapshots: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    })
  ).optional().default([]),
  capturedAt: z.string().default(() => new Date().toISOString()),
});
export type ScriptSourceSnapshot = z.infer<typeof ScriptSourceSnapshotSchema>;

/** Freshness audit result */
export type SourceFreshnessResult = {
  sourceChanged: boolean;
  contentChanged: boolean;
  contextChanged: boolean;
  currentContentHash: string;
  snapshotContentHash: string;
  currentContextHash: string;
  snapshotContextHash: string;
};

/** Database Row types for future migrations */
export type ChapterScriptRow = {
  id: number;
  chapter_id: string;
  revision: number;
  status: ScriptStatus;
  document_json: string;
  source_snapshot_json: string;
  source_content_hash: string;
  source_context_hash: string;
  created_at: string;
  updated_at: string;
};

export type ScriptChangeRow = {
  id: string;
  script_id: number;
  kind: ScriptChangeKind;
  base_revision: number;
  candidate_revision: number;
  request_key: string;
  state: ScriptChangeState;
  before_json: string | null;
  after_json: string;
  source_snapshot_json: string | null;
  generation_info_json: string | null;
  applied_revision: number | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
};

/** Create an empty draft ScriptDocument */
export function createEmptyScriptDocument(
  title: string = '短剧剧本',
  options?: { targetDurationSec?: number }
): ScriptDocument {
  return {
    schemaVersion: 1,
    title: title || '短剧剧本',
    targetDurationSec: options?.targetDurationSec ?? 120,
    outline: {
      logline: '',
      mustKeepEvents: [],
      beats: [],
      endingHook: '',
    },
    locations: [],
    props: [],
    scenes: [],
  };
}

/**
 * Deterministic SHA-256 hash for source chapter content.
 * Normalizes unicode NFC, strips trailing carriage returns, trims whitespace.
 */
export function computeSourceContentHash(content: string): string {
  const normalized = (content || '').normalize('NFC').replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Deterministic SHA-256 hash for semantic writing context.
 * Only includes semantic text properties (characters names/roles, glossary, bible genre/style/main_plot).
 * Updates to character images or unrelated system settings do NOT invalidate screenplay source.
 */
export function computeSourceContextHash(context: {
  characters?: Array<{ id?: number; name: string; role?: string | null }>;
  glossary?: Array<{ term: string; definition?: string | null }>;
  bible?: { genre?: string; style?: string; main_plot?: string };
}): string {
  const chars = (context.characters || [])
    .map((c) => ({
      name: (c.name || '').trim().toLowerCase(),
      role: (c.role || '').trim().toLowerCase(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const terms = (context.glossary || [])
    .map((g) => ({
      term: (g.term || '').trim().toLowerCase(),
      definition: (g.definition || '').trim(),
    }))
    .sort((a, b) => a.term.localeCompare(b.term));

  const bible = {
    genre: (context.bible?.genre || '').trim(),
    style: (context.bible?.style || '').trim(),
    main_plot: (context.bible?.main_plot || '').trim(),
  };

  const payload = JSON.stringify({ chars, terms, bible });
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Validate a ScriptDocument for confirmation or director handover.
 * Rules:
 * 1. scenes must not be empty (outline-only documents cannot be confirmed)
 * 2. Every scene must have at least one non-empty action, dialogue, or voiceover block
 * 3. Sound blocks cannot be the sole block in a scene
 * 4. Scene IDs must be unique
 * 5. Block IDs must be unique across all scenes
 */
export function validateScriptForConfirmation(
  doc: ScriptDocument,
  options?: {
    validProjectCharacterIds?: Set<number> | number[];
  }
): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!doc.scenes || doc.scenes.length === 0) {
    errors.push('剧本正文至少需要包含一场戏，仅有改编提纲无法确认剧本或交由导演制作');
    return { valid: false, errors };
  }

  const projectCharsSet = options?.validProjectCharacterIds
    ? (options.validProjectCharacterIds instanceof Set
        ? options.validProjectCharacterIds
        : new Set(options.validProjectCharacterIds))
    : null;

  const validLocations = new Set(doc.locations.map((l) => l.id));
  const validProps = new Set(doc.props.map((p) => p.id));
  const seenSceneIds = new Set<string>();
  const seenBlockIds = new Set<string>();

  for (let sIdx = 0; sIdx < doc.scenes.length; sIdx++) {
    const scene = doc.scenes[sIdx];
    if (!scene) continue;
    const sceneLabel = `第 ${sIdx + 1} 场 (id=${scene.id})`;

    if (!scene.id || !scene.id.trim()) {
      errors.push(`${sceneLabel} 缺少稳定分场 ID`);
    } else if (seenSceneIds.has(scene.id)) {
      errors.push(`${sceneLabel} 的分场 ID "${scene.id}" 重复出现`);
    } else {
      seenSceneIds.add(scene.id);
    }

    // Location reference check for confirmation
    if (!scene.locationId || !scene.locationId.trim()) {
      errors.push(`${sceneLabel} 缺少地点引用 (locationId)`);
    } else if (!validLocations.has(scene.locationId)) {
      errors.push(`${sceneLabel} 引用的地点 ID "${scene.locationId}" 未在剧本地点列表 (locations) 中声明`);
    }

    // Prop references check
    for (const propId of scene.propIds) {
      if (!validProps.has(propId)) {
        errors.push(`${sceneLabel} 引用的道具 ID "${propId}" 未在剧本道具列表 (props) 中声明`);
      }
    }

    // Scene cast project character check
    const sceneCast = new Set(scene.characterIds);
    if (projectCharsSet) {
      for (const charId of scene.characterIds) {
        if (!projectCharsSet.has(charId)) {
          errors.push(`${sceneLabel} 出场角色 ID ${charId} 不属于当前项目角色中心`);
        }
      }
    }

    if (!scene.blocks || scene.blocks.length === 0) {
      errors.push(`${sceneLabel} 不包含任何动作、对白或表演块`);
      continue;
    }

    let hasPerformableBlock = false;
    let onlySound = true;

    for (const block of scene.blocks) {
      if (!block.id || !block.id.trim()) {
        errors.push(`${sceneLabel} 中存在缺少 ID 的内容块`);
      } else if (seenBlockIds.has(block.id)) {
        errors.push(`${sceneLabel} 中内容块 ID "${block.id}" 重复出现`);
      } else {
        seenBlockIds.add(block.id);
      }

      if (block.type === 'action' || block.type === 'dialogue' || block.type === 'voiceover') {
        if (block.text && block.text.trim()) {
          hasPerformableBlock = true;
        }
        onlySound = false;
      }

      if (block.type === 'dialogue') {
        if (!sceneCast.has(block.characterId)) {
          errors.push(`${sceneLabel} 对白角色 ID ${block.characterId} 未包含在当前场出场角色名单 (characterIds) 中`);
        }
        if (projectCharsSet && !projectCharsSet.has(block.characterId)) {
          errors.push(`${sceneLabel} 对白角色 ID ${block.characterId} 不属于当前项目角色中心`);
        }
      }

      if (block.type === 'voiceover' && block.characterId !== null && block.characterId !== undefined) {
        if (projectCharsSet && !projectCharsSet.has(block.characterId)) {
          errors.push(`${sceneLabel} 画外音角色 ID ${block.characterId} 不属于当前项目角色中心`);
        }
      }
    }

    if (!hasPerformableBlock) {
      errors.push(`${sceneLabel} 必须包含至少一个非空的动作 (action)、对白 (dialogue) 或画外音 (voiceover)`);
    }

    if (onlySound) {
      errors.push(`${sceneLabel} 不能单独由音效 (sound) 充当整场戏`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Deterministic Markdown serializer for readable screenplay view and export.
 * Formats scenes, locations, characters, actions, dialogues, and voiceovers.
 * Does not overwrite or store a separate markdown document (single source of truth).
 */
export function serializeScriptToMarkdown(
  doc: ScriptDocument,
  options?: {
    status?: ScriptStatus;
    sourceChanged?: boolean;
    chapterTitle?: string;
    characterNameMap?: Map<number, string>;
  }
): string {
  const lines: string[] = [];
  const statusLabel = options?.status === 'confirmed' ? '已确认' : '草稿';

  lines.push(`# ${doc.title || '短剧剧本'}`);
  lines.push('');
  lines.push(`- **状态**：${statusLabel}`);
  lines.push(`- **目标时长**：约 ${doc.targetDurationSec} 秒`);
  lines.push(`- **分场数量**：${doc.scenes.length} 场`);
  if (options?.chapterTitle) {
    lines.push(`- **所属故事章节**：${options.chapterTitle}`);
  }

  if (options?.sourceChanged) {
    lines.push('');
    lines.push('> ⚠️ **来源状态已变化**：小说正文或世界观设定已被修改，当前剧本内容需核对更新。');
  }

  // Outline section
  if (doc.outline && (doc.outline.logline || doc.outline.beats.length || doc.outline.endingHook)) {
    lines.push('');
    lines.push('---');
    lines.push('## 改编提纲');
    if (doc.outline.logline) {
      lines.push('');
      lines.push(`**一句话梗概**：${doc.outline.logline}`);
    }
    if (doc.outline.mustKeepEvents.length) {
      lines.push('');
      lines.push('**核心必须保留事件**：');
      for (const ev of doc.outline.mustKeepEvents) {
        lines.push(`- [${ev.id}] ${ev.text}`);
      }
    }
    if (doc.outline.beats.length) {
      lines.push('');
      lines.push('**戏剧节拍 (Beats)**：');
      for (let i = 0; i < doc.outline.beats.length; i++) {
        const b = doc.outline.beats[i];
        if (!b) continue;
        lines.push(`${i + 1}. **${b.purpose}** (id=${b.id})`);
      }
    }
    if (doc.outline.endingHook) {
      lines.push('');
      lines.push(`**结尾钩子 (Ending Hook)**：${doc.outline.endingHook}`);
    }
  }

  // Scenes section
  if (doc.scenes.length) {
    lines.push('');
    lines.push('---');
    lines.push('## 分场正文');

    const locationMap = new Map<string, string>();
    for (const loc of doc.locations) {
      locationMap.set(loc.id, loc.name);
    }

    for (let i = 0; i < doc.scenes.length; i++) {
      const sc = doc.scenes[i];
      if (!sc) continue;
      const locName = locationMap.get(sc.locationId) || sc.locationId || '未指定地点';
      const inExt = sc.interiorExterior === 'exterior' ? '外景' : '内景';
      const timeStr = sc.timeOfDay || '日';

      lines.push('');
      lines.push(`### 第 ${i + 1} 场：${locName} · ${inExt} · ${timeStr}`);
      if (sc.estimatedDurationSec) {
        lines.push(`*预计时长：约 ${sc.estimatedDurationSec} 秒*`);
      }

      for (const block of sc.blocks) {
        lines.push('');
        if (block.type === 'action') {
          lines.push(`【动作】${block.text}`);
        } else if (block.type === 'dialogue') {
          const charName =
            options?.characterNameMap?.get(block.characterId) ||
            `角色#${block.characterId}`;
          const deliveryNote = block.delivery ? `（${block.delivery}）` : '';
          lines.push(`**${charName}**${deliveryNote}：${block.text}`);
        } else if (block.type === 'voiceover') {
          const charName =
            block.characterId != null
              ? options?.characterNameMap?.get(block.characterId) || `角色#${block.characterId}`
              : '旁白';
          lines.push(`【画外音·${charName}】${block.text}`);
        } else if (block.type === 'sound') {
          lines.push(`【音效】${block.text}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/** API request schemas */
export const SaveScriptBodySchema = z.object({
  document: ScriptDocumentSchema,
  expected_revision: z.number().int().min(1),
  request_key: z.string().optional(),
});
export type SaveScriptBody = z.infer<typeof SaveScriptBodySchema>;

export const ConfirmScriptBodySchema = z.object({
  expected_revision: z.number().int().min(1),
  force_source_refresh: z.boolean().optional().default(false),
  request_key: z.string().optional(),
});
export type ConfirmScriptBody = z.infer<typeof ConfirmScriptBodySchema>;

export const RestoreScriptBodySchema = z.object({
  expected_revision: z.number().int().min(1),
  request_key: z.string().optional(),
});
export type RestoreScriptBody = z.infer<typeof RestoreScriptBodySchema>;

export const RefreshSourceBodySchema = z.object({
  expected_revision: z.number().int().min(1),
  request_key: z.string().optional(),
});
export type RefreshSourceBody = z.infer<typeof RefreshSourceBodySchema>;

export const CreateScriptCandidateBodySchema = z.object({
  kind: ScriptChangeKindSchema,
  expected_revision: z.number().int().min(1),
  request_key: z.string().min(1),
  after_json: z.string().min(1).optional(),
  before_json: z.string().optional(),
  generation_info: z.record(z.string(), z.any()).optional(),
  instructions: z.string().optional(),
  target_duration_sec: z.number().positive().optional(),
  target_scene_id: z.string().optional(),
});
export type CreateScriptCandidateBody = z.infer<typeof CreateScriptCandidateBodySchema>;

export const UpdateScriptCandidateBodySchema = z.object({
  expected_revision: z.number().int().min(1),
  expected_candidate_revision: z.number().int().min(1).optional(),
  after_json: z.string().min(1),
});
export type UpdateScriptCandidateBody = z.infer<typeof UpdateScriptCandidateBodySchema>;

export const ApplyScriptCandidateBodySchema = z.object({
  expected_revision: z.number().int().min(1),
  expected_candidate_revision: z.number().int().min(1).optional(),
  request_key: z.string().optional(),
});
export type ApplyScriptCandidateBody = z.infer<typeof ApplyScriptCandidateBodySchema>;

export const StoryboardCandidateShotSchema = z.object({
  index: z.number().int().min(1),
  script_scene_id: z.string().min(1),
  block_ids: z.array(z.string()).default([]),
  visual_prompt: z.string().default(''),
  audio_prompt: z.string().default(''),
  dialogue: z.string().default(''),
  narration: z.string().default(''),
  duration: z.number().positive().default(3.0),
  shot_type: z.string().default(''),
  camera_movement: z.string().default(''),
  camera_angle: z.string().default(''),
  negative_prompt: z.string().nullable().default(null),
  shot_spec: z.string(),
  source: ShotSourceReferenceSchema.optional().nullable(),
});
export type StoryboardCandidateShot = z.infer<typeof StoryboardCandidateShotSchema>;

export const StoryboardCandidatePayloadSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  scriptId: z.number().int(),
  scriptRevision: z.number().int(),
  chapterId: z.string(),
  totalDuration: z.number().positive().default(0),
  estimatedScriptDuration: z.number().nonnegative().default(0),
  coverageReport: z.object({
    coveredSceneIds: z.array(z.string()),
    totalScenes: z.number().int(),
    coveredBlockIds: z.array(z.string()),
    totalAudibleBlocks: z.number().int(),
    coveredMustKeepEventIds: z.array(z.string()),
    totalMustKeepEvents: z.number().int(),
  }),
  shots: z.array(StoryboardCandidateShotSchema).min(1).max(20),
});
export type StoryboardCandidatePayload = z.infer<typeof StoryboardCandidatePayloadSchema>;

export const CreateStoryboardCandidateBodySchema = z.object({
  expected_revision: z.number().int().min(1),
  request_key: z.string().min(1),
  instructions: z.string().optional(),
});
export type CreateStoryboardCandidateBody = z.infer<typeof CreateStoryboardCandidateBodySchema>;

export const ApplyStoryboardCandidateBodySchema = z.object({
  expected_revision: z.number().int().min(1),
  expected_candidate_revision: z.number().int().min(1).optional(),
  request_key: z.string().optional(),
  replace_existing: z.boolean().optional().default(false),
  expected_scene_ids: z.array(z.number().int().positive()).optional(),
}).refine(body => !body.replace_existing || Boolean(body.expected_scene_ids?.length), {
  message: 'Replacing a timeline requires its expected scene IDs',
  path: ['expected_scene_ids'],
});
export type ApplyStoryboardCandidateBody = z.infer<typeof ApplyStoryboardCandidateBodySchema>;

/**
 * Remap character IDs in a ScriptDocument object across scenes and dialogue blocks.
 * Supports both camelCase and snake_case properties for maximum resilience.
 */
export function remapScriptDocumentCharacters<T = unknown>(
  doc: T,
  charMap: Map<number, number>
): T {
  if (!doc || typeof doc !== 'object') return doc;
  const cloned = JSON.parse(JSON.stringify(doc));

  const scenes = Array.isArray(cloned.scenes) ? cloned.scenes
    : (Array.isArray(cloned.blocks) ? [cloned] : []);
  for (const scene of scenes) {
    if (Array.isArray(scene.characterIds)) {
      scene.characterIds = scene.characterIds.map((id: number) => charMap.get(id) ?? id);
    }
    if (Array.isArray(scene.character_ids)) {
      scene.character_ids = scene.character_ids.map((id: number) => charMap.get(id) ?? id);
    }
    if (Array.isArray(scene.blocks)) {
      for (const block of scene.blocks) {
        if (block && typeof block === 'object') {
          if (typeof block.characterId === 'number' && charMap.has(block.characterId)) {
            block.characterId = charMap.get(block.characterId)!;
          }
          if (typeof block.character_id === 'number' && charMap.has(block.character_id)) {
            block.character_id = charMap.get(block.character_id)!;
          }
        }
      }
    }
  }
  return cloned;
}

/** Preserve historical content/hashes while rebinding snapshot identities. */
export function remapScriptSourceSnapshot<T>(snapshot: T, chapterId: string, charMap: Map<number, number>): T {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const cloned = JSON.parse(JSON.stringify(snapshot));
  cloned.chapterId = chapterId;
  if (Array.isArray(cloned.characterSnapshots)) {
    for (const character of cloned.characterSnapshots) {
      character.id = charMap.get(character.id) ?? character.id;
    }
  }
  return cloned;
}

/**
 * Remap source.script_id in a shot_spec JSON string or object if present.
 */
export function remapShotSpecScriptId(
  shotSpecRaw: string | Record<string, any> | null | undefined,
  scriptIdMap: Map<number, number>
): string | null {
  if (!shotSpecRaw) return null;
  try {
    const spec = typeof shotSpecRaw === 'string' ? JSON.parse(shotSpecRaw) : JSON.parse(JSON.stringify(shotSpecRaw));
    if (
      spec &&
      spec.source &&
      spec.source.type === 'script' &&
      typeof spec.source.script_id === 'number'
    ) {
      const newScriptId = scriptIdMap.get(spec.source.script_id);
      if (newScriptId !== undefined) {
        spec.source.script_id = newScriptId;
      }
    }
    return JSON.stringify(spec);
  } catch {
    return typeof shotSpecRaw === 'string' ? shotSpecRaw : null;
  }
}
