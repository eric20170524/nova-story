import { z } from 'zod';
import { db } from '../../db/database';
import { logger } from '../../core/logging';
import { LLMService } from '../llm';
import { SettingsManager } from '../../core/settings_manager';
import type { AIProvider } from './base';
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
} from '../../schemas/shot_contract';
import { buildCharacterLockRefsForChapter } from '../timeline_generation_service';
import { parseProjectSettings } from '../project_settings';
import { coversVisibleBeat, assertEnglishFidelity } from '../english_visual_prompt';
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
import { auditFacts, auditHash, hasAudit, saveAudit, hash, runFactWorkflow, serialWorkflow, shotEvidenceIds, shotSoundText, continuityLiteral, visiblePropEvidence, validateFactPayload, validateFactSources, anchorSpans, stabilizeFactBeats, ExtractionSchema, stateCheckKey, type WorkflowProgress } from '../storyboard_fact_workflow';
import { FACT_POLICY_VERSION } from '../../schemas/storyboard_facts';
import { actionBindingSource, boundText, entityRoster, needsBindingReview, textHash, validateBinding } from '../entity_binding';
import { sceneContextFacts, scopedWardrobeLock } from '../storyboard_fact_workflow';

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
  duration: z.number().positive().optional().default(5.0),
  must_not: z.array(z.string().trim().min(1).max(120)).optional().default([]),
});

export const RawStoryboardResponseSchema = z.object({
  shots: z.array(RawStoryboardShotSchema).min(1, '至少需要生成一个分镜镜头'),
});

export type RawStoryboardShot = z.infer<typeof RawStoryboardShotSchema>;
export type RawStoryboardResponse = z.infer<typeof RawStoryboardResponseSchema>;

function configuredLlmModel(): string | undefined {
  const model = String(SettingsManager.loadSettings().llm?.model || '').trim();
  return model || undefined;
}
const currentModelFingerprint = () => `${configuredLlmModel() || 'configured-provider'}:${hash(SettingsManager.loadSettings().llm || {})}`;

export function validateStoryboardCoverage(doc: ScriptDocument, rawShots: Array<Pick<RawStoryboardShot, 'script_scene_id' | 'block_ids'>>, factVersion = false) {
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
        if (allocatedBlockIds.has(blockId) && !(factVersion && info.block.type === 'action')) {
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

    const missingSoundBlockIds = doc.scenes.flatMap(scene => scene.blocks)
      .filter(block => block.type === 'sound' && !allocatedBlockIds.has(block.id))
      .map(block => block.id);
    if (missingSoundBlockIds.length) {
      throw new StoryboardGenerationError(`遗漏音效内容块: [${missingSoundBlockIds.join(', ')}]`, 400);
    }

    const missingVisibleIds = doc.scenes.flatMap(scene => scene.blocks)
      .filter(block => block.type === 'action' && block.id.startsWith('vis_') && !allocatedBlockIds.has(block.id))
      .map(block => block.id);
    if (!factVersion && missingVisibleIds.length) {
      throw new StoryboardGenerationError(`遗漏可见动作内容块: [${missingVisibleIds.join(', ')}]`, 400);
    }
    for (const beat of factVersion ? [] : doc.outline.visibleBeats || []) {
      const covered = rawShots.some(shot => {
        const scene = sceneMap.get(shot.script_scene_id)!;
        const action = shot.block_ids.map(id => scene.blocks.find(block => block.id === id))
          .filter(block => block?.type === 'action').map(block => block!.text).join('；');
        return coversVisibleBeat(beat.text, action);
      });
      if (!covered) throw new StoryboardGenerationError(`分镜遗漏可见事实: ${beat.id}`, 400);
    }

    // Check strict relative order of audible blocks in each scene
    for (const sc of doc.scenes) {
      const sceneShots = rawShots.filter((s) => s.script_scene_id === sc.id);
      let lastBlockIndex = -1;
      for (const s of sceneShots) {
        for (const bId of s.block_ids) {
          const info = blockMap.get(bId);
          if (info && (info.block.type === 'dialogue' || info.block.type === 'voiceover' || info.block.type === 'sound')) {
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
  static taskId(scriptId: number, requestKey: string) { return `storyboard_${hash([scriptId, requestKey])}`; }

  static async getTask(scriptId: number, taskId: string) {
    const task = await db.get("SELECT * FROM generation_task WHERE task_id=? AND kind='storyboard'", taskId);
    if (!task || Number(task.scene_id) !== -scriptId) throw new StoryboardGenerationError('分镜任务不存在', 404);
    return { task_id: taskId, status: task.status, progress: JSON.parse(task.progress_json || '{}'), error: task.error, updated_at: task.updated_at };
  }

  static async listTasks(scriptId: number) {
    await ScriptService.getScriptById(scriptId);
    const rows = await db.all("SELECT task_id FROM generation_task WHERE kind='storyboard' AND scene_id=? ORDER BY created_at DESC LIMIT 10", -scriptId);
    return Promise.all(rows.map(row => this.getTask(scriptId, row.task_id)));
  }

  static async reviewTaskFacts(scriptId: number, taskId: string, body: unknown) {
    const input = z.object({ expected_input_hash: z.string(), spans: z.array(ExtractionSchema.shape.spans.element.extend({ scene_id: z.string(), block_id: z.string() })) }).parse(body);
    const task = await this.getTask(scriptId, taskId);
    const previousProgressJson = JSON.stringify(task.progress);
    if (!['failed', 'interrupted'].includes(task.status) || task.progress.input_hash !== input.expected_input_hash || task.progress.candidate_id) throw new StoryboardGenerationError('任务已变化，不能修改事实', 409);
    const script = await ScriptService.getScriptById(scriptId);
    if (task.progress.request?.expected_revision !== script.revision) throw new StoryboardGenerationError('剧本版本已变化', 409);
    const normalized = input.spans.map(span => ({ ...span, states: span.states.map(state => ({ ...state })) }));
    stabilizeFactBeats(normalized);
    const facts = script.document.scenes.flatMap(scene => scene.blocks.filter(b => b.type === 'action').flatMap(block => {
      const spans = normalized.filter(s => s.scene_id === scene.id && s.block_id === block.id);
      // Establish offsets first; verify submitted states after server-side binding validation.
      return anchorSpans(scene.id, block.id, block.text, { spans: spans.map(span => ({ ...span, states: [] })) })
        .map((fact, index) => ({ ...fact, states: spans[index]!.states }));
    }));
    if (input.spans.length !== facts.length) throw new StoryboardGenerationError('含跨场或未知来源片段', 400);
    const roster = entityRoster(await db.all('SELECT id,name FROM character WHERE project_id=? ORDER BY id', script.projectId));
    for (const fact of facts) {
      if (!fact.binding) continue;
      const original = (task.progress.facts || []).find((old: any) => old.scene_id === fact.scene_id && old.block_id === fact.block_id && old.start === fact.start && old.end === fact.end);
      if (!original?.binding || fact.binding.text_hash !== textHash(fact.text) || fact.binding.context_hash !== original.binding.context_hash || fact.binding.mentions.length !== original.binding.mentions.length) throw new StoryboardGenerationError('核对人物绑定的来源版本已变化', 409);
      if (fact.binding.context_hash !== actionBindingSource(script.document, fact.scene_id, fact.block_id, roster, fact.start, fact.end).automatic.context_hash) throw new StoryboardGenerationError('核对人物绑定的前文版本已变化', 409);
      for (const [index, mention] of fact.binding.mentions.entries()) {
        const old = original.binding.mentions[index];
        if (mention.start !== old.start || mention.end !== old.end || mention.text !== old.text) throw new StoryboardGenerationError('不能修改人物提及的原文位置', 400);
        if (mention.confirmed && hash([mention.entity, mention.status, mention.visibility, mention.confirmed]) !== hash([old.entity, old.status, old.visibility, old.confirmed])) mention.authority = 'human';
      }
      validateBinding(fact.binding, fact.text, roster);
    }
    validateFactSources(script.document, facts);
    const progress = task.progress as WorkflowProgress;
    // Keep original complete-source batch boundaries so resume never re-extracts reviewed facts.
    const original = Object.values(progress.extracted).flat();
    if (facts.some(f => !original.some(old => old.scene_id === f.scene_id && old.block_id === f.block_id && f.start >= old.start && f.end <= old.end))) throw new StoryboardGenerationError('核对时可拆分来源片段，不能跨越已有来源边界', 400);
    progress.extracted = Object.fromEntries(Object.entries(progress.extracted).map(([key, old]) => [key, facts.filter(f => old.some(o => o.scene_id === f.scene_id && o.block_id === f.block_id && f.start >= o.start && f.end <= o.end))]));
    progress.facts = facts; progress.phase = 'reviewed'; delete progress.error;
    // A person confirmation does not certify states that have never been extracted.
    const checks: Record<string, boolean> = {};
    for (const fact of facts.filter(f => f.kind === 'visual')) {
      const old = original.find(o => o.id === fact.id);
      const key = stateCheckKey(fact);
      const statesReviewed = old && (hash(old.states) !== hash(fact.states) || progress.state_review_pending?.includes(old.id));
      if (!needsBindingReview(fact.binding) && (progress.state_checks?.[key] || statesReviewed)) checks[key] = true;
    }
    progress.state_checks = checks;
    progress.state_review_pending = (progress.state_review_pending || []).filter(id => !facts.some(f => f.id === id && checks[stateCheckKey(f)]));
    const updated = await db.run("UPDATE generation_task SET progress_json=?, error=NULL WHERE task_id=? AND status=? AND progress_json=?", JSON.stringify(progress), taskId, task.status, previousProgressJson);
    if (updated.changes !== 1) throw new StoryboardGenerationError('任务在核对期间变化，请刷新', 409);
    return this.getTask(scriptId, taskId);
  }

  /** Durable reservation precedes inference; matching retries resume failed scene/shot checkpoints. */
  static async generateStoryboardCandidate(params: {
    scriptId: number; expectedRevision: number; requestKey: string; instructions?: string; token?: string; provider?: AIProvider; onReserved?: (attempt?: number) => void;
  }): Promise<ScriptChangeRow> {
    const script = await ScriptService.getScriptById(params.scriptId);
    if (script.revision !== params.expectedRevision) throw new StoryboardGenerationError('剧本版本冲突，请刷新后重试', 409);
    if (script.status !== 'confirmed' || !script.document.scenes.length) throw new StoryboardGenerationError('只有已确认且包含分场的剧本才能生成分镜', 400);
    if (script.freshness.sourceChanged) throw new StoryboardGenerationError('剧本来源已过期，请先核对更新', 409);
    const taskId = this.taskId(script.id, params.requestKey);
    const project = await db.get('SELECT settings FROM project WHERE id=?', script.projectId);
    const settings = parseProjectSettings(project?.settings);
    const assets = await AssetLibraryService.list(script.projectId);
    const locks = await buildCharacterLockRefsForChapter(script.projectId, script.chapterId);
    const characterNames = await db.all('SELECT id,name,english_name FROM character WHERE project_id=? ORDER BY id', script.projectId) as Array<{id: number; name: string; english_name: string}>;
    const model = `${currentModelFingerprint()}:${hash([assets, locks, characterNames])}`;
    const instructions = params.instructions?.trim() || '';
    const glossary = Object.fromEntries([...assets, ...characterNames].filter(asset => asset.english_name).map(asset => [asset.name, asset.english_name!])) as Record<string, string>;
    const inputHash = hash([script.id, script.revision, script.document, assets, locks, characterNames, settings, model, SettingsManager.loadSettings().llm, FACT_POLICY_VERSION, instructions]);
    const initial: WorkflowProgress = { input_hash: inputHash, attempt: 1, phase: 'queued', extracted: {}, plans: {}, shots: {}, metrics: [], request: { request_key: params.requestKey, expected_revision: script.revision, instructions } };
    await db.run("INSERT OR IGNORE INTO generation_task(task_id,scene_id,kind,status,progress_json) VALUES(?,?,'storyboard','queued',?)", taskId, -script.id, JSON.stringify(initial));
    let reserved = await this.getTask(script.id, taskId);
    if (reserved.progress.input_hash !== inputHash) throw new StoryboardGenerationError('同一请求键对应不同剧本、资产、模型或指令，请使用新的请求键', 409);
    if (['failed', 'interrupted', 'cancelled'].includes(reserved.status) && !reserved.progress.candidate_id) {
      const next = { ...reserved.progress, attempt: (reserved.progress.attempt || 0) + 1, phase: 'queued' };
      delete next.error;
      const requeued = await db.run("UPDATE generation_task SET status='queued', error=NULL, progress_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id=? AND status=? AND progress_json=?",
        JSON.stringify(next), taskId, reserved.status, JSON.stringify(reserved.progress));
      reserved = await this.getTask(script.id, taskId);
      if (!requeued.changes && !['queued', 'processing', 'completed'].includes(reserved.status)) throw new StoryboardGenerationError('任务在恢复期间变化，请刷新后重试', 409);
    }
    // The acknowledged attempt is durably queued BEFORE clients can poll it.
    params.onReserved?.(reserved.progress.attempt);
    return serialWorkflow(`${taskId}:${reserved.progress.attempt || 0}`, async () => {
      const stored = await this.getTask(script.id, taskId);
      if (stored.progress.candidate_id) {
        const candidate = await db.get('SELECT * FROM script_change WHERE id=? AND script_id=?', stored.progress.candidate_id, script.id);
        if (candidate) return candidate as ScriptChangeRow;
      }
      // Covers a crash between saving the candidate and committing task completion.
      const candidate = await db.get("SELECT * FROM script_change WHERE script_id=? AND request_key=? AND kind='storyboard'", script.id, params.requestKey);
      if (candidate) {
        stored.progress.phase = 'completed'; stored.progress.candidate_id = candidate.id;
        await db.run("UPDATE generation_task SET status='completed', error=NULL, progress_json=? WHERE task_id=?", JSON.stringify(stored.progress), taskId);
        return candidate as ScriptChangeRow;
      }
      const progress = stored.progress as WorkflowProgress;
      const persist = async () => { await db.run("UPDATE generation_task SET progress_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id=?", JSON.stringify(progress), taskId); };
      await db.run("UPDATE generation_task SET status='processing', error=NULL, updated_at=CURRENT_TIMESTAMP WHERE task_id=?", taskId);
      try {
        const provider = params.provider || LLMService.getLocalProvider();
        const result = await runFactWorkflow({ doc: script.document, scriptId: script.id, revision: script.revision, provider, model, locks, glossary, characters: characterNames, instructions, progress, persist });
        const coverage = validateStoryboardCoverage(script.document, result.shots, true);
        const payload: StoryboardCandidatePayload = {
          schemaVersion: 3, fact_contract: result.contract, scriptId: script.id, scriptRevision: script.revision, chapterId: script.chapterId,
          totalDuration: result.shots.reduce((n, s) => n + s.duration, 0), estimatedScriptDuration: result.contract.budgets.reduce((n, b) => n + b.duration, 0),
          coverageReport: { coveredSceneIds: [...coverage.coveredSceneIdSet], totalScenes: script.document.scenes.length,
            coveredBlockIds: [...coverage.allocatedBlockIds], totalAudibleBlocks: coverage.allAudibleBlockIds.size,
            coveredMustKeepEventIds: script.document.outline.mustKeepEvents.filter(e => script.document.scenes.some(s => s.eventIds.includes(e.id))).map(e => e.id),
            totalMustKeepEvents: script.document.outline.mustKeepEvents.length }, shots: result.shots,
        };
        this.validatePayload(payload, script);
        await saveAudit(`contract_${hash(result.contract)}`);
        const latest = await ScriptService.getScriptById(script.id);
        const latestAssets = await AssetLibraryService.list(script.projectId);
        const latestLocks = await buildCharacterLockRefsForChapter(script.projectId, script.chapterId);
        const latestNames = await db.all('SELECT id,name,english_name FROM character WHERE project_id=? ORDER BY id', script.projectId);
        const latestProject = await db.get('SELECT settings FROM project WHERE id=?', script.projectId);
        if (latest.revision !== script.revision || latest.status !== 'confirmed' || latest.freshness.sourceChanged ||
            !model.startsWith(`${currentModelFingerprint()}:`) || hash([latestAssets, latestLocks, latestNames, parseProjectSettings(latestProject?.settings)]) !== hash([assets, locks, characterNames, settings])) throw new StoryboardGenerationError('生成期间剧本、资产或模型变化，候选未保存', 409);
        const saved = await ScriptService.createPendingCandidate({ scriptId: script.id, kind: 'storyboard', expectedRevision: script.revision, requestKey: params.requestKey,
          afterJson: JSON.stringify(payload), sourceSnapshot: script.sourceSnapshot,
          generationInfo: { model, fact_policy_version: FACT_POLICY_VERSION, task_id: taskId, input_hash: inputHash, metrics: progress.metrics } });
        progress.phase = 'completed'; progress.candidate_id = saved.id;
        await persist();
        await db.run("UPDATE generation_task SET status='completed', error=NULL WHERE task_id=?", taskId);
        return saved;
      } catch (error: any) {
        progress.error = error?.message || String(error);
        if (progress.phase !== 'needs_review') progress.phase = 'failed';
        await persist();
        await db.run("UPDATE generation_task SET status='failed', error=? WHERE task_id=?", progress.error, taskId);
        if (error instanceof StoryboardGenerationError) throw error;
        throw new StoryboardGenerationError(progress.error || '分镜生成失败', error?.statusCode || 502);
      }
    });
  }

  static async auditPayload(payload: StoryboardCandidatePayload, script: ScriptWithDetails) {
    if (payload.schemaVersion < 3) throw new StoryboardGenerationError('旧候选缺少新版人物绑定，请重新生成分镜候选', 400);
    this.validatePayload(payload, script);
    const assets = await AssetLibraryService.list(script.projectId);
    const locks = await buildCharacterLockRefsForChapter(script.projectId, script.chapterId);
    const characterNames = await db.all('SELECT id,name,english_name FROM character WHERE project_id=? ORDER BY id', script.projectId);
    const glossary = Object.fromEntries([...assets, ...characterNames].filter(a => a.english_name).map(a => [a.name, a.english_name]));
    const model = `${currentModelFingerprint()}:${hash([assets, locks, characterNames])}`;
    for (const shot of payload.shots) {
      const spec = JSON.parse(shot.shot_spec);
      if (payload.schemaVersion >= 2 && payload.fact_contract) {
        if (!await hasAudit(`contract_${hash(payload.fact_contract)}`)) throw new StoryboardGenerationError('事实分类契约未经过服务器工作流确认，请重新生成或核对任务', 400);
        // Only server-side records can authorize reuse. Client fields are never trusted.
        const key = auditHash(shot, payload.fact_contract, model);
        const generationAudit = await hasAudit(key);
        if (generationAudit) continue;
        if (!String(shot.visual_prompt || '').trim()) {
          throw new StoryboardGenerationError('镜头没有已审核的画面译文，请重新生成分镜候选', 400);
        }
        const selected = payload.fact_contract.facts.filter(f => shotEvidenceIds(shot).includes(f.id));
        const facts = selected.map(f => ({ id: f.id, text: boundText(f.text, f.binding) }));
        facts.push(...continuityLiteral(spec.continuity_states || []));
        facts.push({ id: 'location', text: spec.location });
        facts.push(...sceneContextFacts(spec.scene_context));
        const permittedLocks = locks.filter(l => spec.visible_subjects.includes(l.name)).map(l => ({ ...l, lock: scopedWardrobeLock(l.name!, l.lock, selected, spec.continuity_states || []) }));
        await serialWorkflow(`audit_${key}`, async () => {
          if (await hasAudit(key)) return;
          await auditFacts(LLMService.getLocalProvider(), facts, shot.visual_prompt, { visible_names: spec.visible_subjects, bindings: selected.map(f => f.binding), original_facts: selected.map(f => ({ id: f.id, text: f.text })), locks: permittedLocks, glossary });
          await saveAudit(key);
        });
      } else {
        const originalActions = script.document.scenes.find(scene => scene.id === shot.script_scene_id)!.blocks.filter(block => block.type === 'action' && shot.block_ids.includes(block.id)).map(block => block.text);
        await serialWorkflow(`legacy_audit_${hash([shot, originalActions])}`, () => assertEnglishFidelity([...(originalActions.length ? originalActions : [spec.primary_action]), spec.location, ...spec.key_props].join('，'), shot.visual_prompt));
      }
    }
  }

  static validatePayload(payload: StoryboardCandidatePayload, script: ScriptWithDetails) {
    if (payload.shots.length > 20) {
      throw new StoryboardGenerationError('候选分镜超过 20 镜预算上限', 400);
    }
    if (payload.scriptId !== script.id || payload.scriptRevision !== script.revision || payload.chapterId !== script.chapterId) {
      throw new StoryboardGenerationError('候选分镜的剧本来源版本或章节不匹配', 409);
    }
    if (payload.schemaVersion >= 2) validateFactPayload(script.document, payload);
    const { blockMap } = validateStoryboardCoverage(script.document, payload.shots, payload.schemaVersion >= 2);
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
      for (const block of payload.schemaVersion >= 2 ? [] : blocks.filter(block => block.type === 'action')) {
        if ((block.id.startsWith('vis_') || (script.document.outline.visibleBeats || []).some(beat => coversVisibleBeat(beat.text, block.text)))
          && !coversVisibleBeat(block.text, spec.primary_action)) {
          throw new StoryboardGenerationError(`镜头动作遗漏已分配的可见事实: ${block.id}`, 400);
        }
      }
      const text = (type: ScriptBlock['type'], separator: string) => blocks.filter((block) => block.type === type).map((block) => block.text.trim()).join(separator);
      const sound = payload.schemaVersion >= 2 && payload.fact_contract ? shotSoundText(script.document, shot, payload.fact_contract) : text('sound', '; ');
      if (shot.dialogue !== text('dialogue', '\n') || shot.narration !== text('voiceover', '\n') || shot.audio_prompt !== sound) {
        throw new StoryboardGenerationError('镜头对白、旁白或音效与剧本内容块不一致', 400);
      }
      return { ...shot, shot_intent: spec.shot_intent, key_props: spec.key_props };
    });
    for (const beat of payload.schemaVersion >= 2 ? [] : script.document.outline.visibleBeats || []) {
      if (!payload.shots.some(shot => coversVisibleBeat(beat.text, JSON.parse(shot.shot_spec).primary_action))) {
        throw new StoryboardGenerationError(`镜头契约遗漏可见事实: ${beat.id}`, 400);
      }
    }
    for (let index = 1; payload.schemaVersion < 2 && index < contracts.length; index++) {
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
    if (payload.schemaVersion < 2 && uniqueness.ok === false) throw new StoryboardGenerationError(formatUniquenessFailure(uniqueness.violation), 400);
    const visibleProps = payload.schemaVersion >= 2 && payload.fact_contract ? visiblePropEvidence(script.document, payload.fact_contract.facts) : [];
    const hasKeyProps = payload.schemaVersion >= 2 ? visibleProps.length > 0 : script.document.scenes.some(s => s.propIds.length) || contracts.some(shot => shot.key_props.length > 0);
    const quota = assertChapterShotQuota(contracts, { hasKeyProps });
    if (quota.ok === false) {
      const detail = quota.violation.reason === 'missing_insert' && visibleProps.length ? `；可见道具: ${visibleProps.map(prop => `${prop.scene_id}/${prop.name}`).join('；')}` : '';
      throw new StoryboardGenerationError(formatShotQuotaFailure(quota.violation) + detail, 400);
    }
  }
  /**
   * Phase 2: Apply a pending storyboard candidate to the chapter timeline.
   * Safety rules:
   * - Must verify script exists, confirmed, revision matches
   * - Must verify freshness (!sourceChanged)
   * - Must verify candidate state is pending and base_revision matches
   * - Existing timelines require an explicit replacement and exact scene list
   * - Preserve old timeline snapshots and refuse accepted videos or active tasks
   * - Must verify no in-flight tasks
   * - Atomic transaction: inserts scenes + scene_version baselines + updates candidate to applied
   */
  static async applyStoryboardCandidate(params: {
    scriptId: number;
    changeId: string;
    expectedRevision: number;
    expectedCandidateRevision?: number;
    requestKey?: string;
    replaceExisting?: boolean;
    expectedSceneIds?: number[];
  }): Promise<{
    success: boolean;
    count: number;
    scene_ids: number[];
    already_applied?: boolean;
    replaced_scene_ids?: number[];
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

    // 3. Default protection remains; reviewed replacements require the exact current IDs.
    const existingScenes = await db.all(
      'SELECT * FROM scene WHERE chapter_id = ? ORDER BY "index", id',
      script.chapterId
    );
    const verifyReplacement = (scenes: any[]) => {
      if (!scenes.length) return;
      if (!params.replaceExisting) {
        throw new StoryboardGenerationError('当前章节已有分镜镜头，为保护制作资产，需核对镜头列表并显式选择带快照替换。', 409);
      }
      if (JSON.stringify(scenes.map(scene => scene.id)) !== JSON.stringify(params.expectedSceneIds)) {
        throw new StoryboardGenerationError('Timeline changed; review the current scene IDs before replacing it', 409);
      }
    };
    verifyReplacement(existingScenes);


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

    try { await this.auditPayload(payload, script); }
    catch (error: any) { throw new StoryboardGenerationError(`候选核验失败：${error?.message || String(error)}`, error?.statusCode || 502); }

    // 6. Atomic application in a short transaction
    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      // Re-read all mutable gates after acquiring the write transaction.
      const lockedScript = await ScriptService.getScriptById(params.scriptId);
      const lockedCandidate = await db.get('SELECT * FROM script_change WHERE id = ? AND script_id = ?', params.changeId, params.scriptId);
      if (lockedScript.revision !== params.expectedRevision || lockedScript.status !== 'confirmed' || lockedScript.freshness.sourceChanged ||
          !lockedCandidate || lockedCandidate.state !== 'pending' || lockedCandidate.base_revision !== lockedScript.revision ||
          lockedCandidate.candidate_revision !== candidate.candidate_revision || lockedCandidate.after_json !== candidate.after_json) {
        throw new StoryboardGenerationError('Revision conflict: script or candidate changed before submission', 409);
      }
      this.validatePayload(payload, lockedScript);
      // Recheck the timeline and production gates after acquiring the write lock.
      const lockedScenes = await db.all(
        'SELECT * FROM scene WHERE chapter_id = ? ORDER BY "index", id',
        script.chapterId
      );
      const idFloor = await db.get('SELECT MAX(value) AS maximum FROM (SELECT COALESCE(MAX(id),0) AS value FROM scene UNION ALL SELECT COALESCE(MAX(scene_id),0) AS value FROM media_asset)');
      let nextSceneId = Number(idFloor?.maximum || 0) + 1;
      verifyReplacement(lockedScenes);
      const lockedTasks = await db.get(`SELECT COUNT(*) AS count FROM generation_task gt INNER JOIN scene s ON s.id=gt.scene_id WHERE s.chapter_id=? AND gt.status='processing'`, script.chapterId);
      if (Number(lockedTasks?.count)) throw new StoryboardGenerationError('当前章节存在正在执行的制作任务，无法提交分镜', 409);
      const accepted = await db.get(`SELECT COUNT(*) AS count FROM media_asset m INNER JOIN scene s ON s.id=m.scene_id WHERE s.chapter_id=? AND m.role='narrative_final' AND m.status='ready'`, script.chapterId);
      if (lockedScenes.length && Number(accepted?.count)) throw new StoryboardGenerationError('已验收的视频禁止由分镜替换覆盖，请先保留制作版本', 409);
      let previousTimeline;
      if (lockedScenes.length) {
        // Retain a portable snapshot in the candidate history. Generated files,
        // media records and completed tasks remain available under their old IDs.
        const related = (table: string) => db.all(`SELECT * FROM ${table} WHERE scene_id IN (SELECT id FROM scene WHERE chapter_id=?)`, script.chapterId);
        const coverageGroups = await db.all('SELECT * FROM coverage_group WHERE source_scene_id IN (SELECT id FROM scene WHERE chapter_id=?)', script.chapterId);
        const coverageShots = await db.all('SELECT * FROM coverage_shot WHERE coverage_group_id IN (SELECT id FROM coverage_group WHERE source_scene_id IN (SELECT id FROM scene WHERE chapter_id=?))', script.chapterId);
        previousTimeline = { scenes: lockedScenes, versions: await related('scene_version'), references: await related('scene_asset_reference'), image_snapshots: await related('scene_asset_image_snapshot'), media_assets: await related('media_asset'), coverage_groups: coverageGroups, coverage_shots: coverageShots };
        await db.run('DELETE FROM coverage_shot WHERE coverage_group_id IN (SELECT id FROM coverage_group WHERE source_scene_id IN (SELECT id FROM scene WHERE chapter_id=?))', script.chapterId);
        await db.run('DELETE FROM coverage_group WHERE source_scene_id IN (SELECT id FROM scene WHERE chapter_id=?)', script.chapterId);
        await db.run('DELETE FROM scene_version WHERE scene_id IN (SELECT id FROM scene WHERE chapter_id=?)', script.chapterId);
        await db.run('DELETE FROM scene_asset_reference WHERE scene_id IN (SELECT id FROM scene WHERE chapter_id=?)', script.chapterId);
        await db.run('DELETE FROM scene_asset_image_snapshot WHERE scene_id IN (SELECT id FROM scene WHERE chapter_id=?)', script.chapterId);
        await db.run('DELETE FROM scene WHERE chapter_id=?', script.chapterId);
      }

      const insertedSceneIds: number[] = [];

      for (let i = 0; i < payload.shots.length; i++) {
        const shot = payload.shots[i]!;
        const result = await db.run(
          `INSERT INTO scene (
             id, chapter_id, "index", visual_prompt, audio_prompt, dialogue, narration, duration,
             shot_type, camera_movement, camera_angle, negative_prompt, shot_spec, asset_status, active_version
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', 1)`,
          nextSceneId++,
          script.chapterId,
          i + 1,
          shot.visual_prompt || '',
          shot.audio_prompt || '',
          shot.dialogue || '',
          shot.narration || '',
          shot.duration || 5.0,
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
        JSON.stringify({ scene_ids: insertedSceneIds, ...(previousTimeline ? { previous_timeline: previousTimeline } : {}) }),
        candidate.id
      );

      await db.exec('COMMIT');

      return {
        success: true,
        count: insertedSceneIds.length,
        scene_ids: insertedSceneIds,
        ...(previousTimeline ? { replaced_scene_ids: lockedScenes.map(scene => scene.id) } : {}),
      };
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }
}
