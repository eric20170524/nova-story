import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/database';
import { logger } from '../../core/logging';
import { getGeneratedVideosDirectory, getVideoWorkflowsDirectory } from '../../core/paths';
import {
  MediaAsset,
  MediaAssetStatus,
  VideoCapabilities,
  VideoGenerationRequest,
  VideoPreflightResponse,
  VideoQAReport,
  VideoTaskResponse,
  VideoTaskStage
} from '../../schemas/video';
import { VideoSpecCompiler } from './video_spec_compiler';
import { VideoWorkflowCompiler } from './video_workflow_compiler';
import { MediaAssetService } from './media_asset_service';
import { VideoReferenceIdentityService } from './video_reference_identity_service';
import { GpuLeaseCancelledError, GpuLeaseService, type GpuLease } from '../gpu_lease_service';
import { ComfyH3Provider } from './comfy_h3_provider';
import { VideoPostprocessService } from './video_postprocess_service';
import { LoopCloser, type ProcessVideoResult } from './loop_closer';
import { createProgressPublisher, ProgressPublisher } from '../generation_progress';
import { VramService } from '../vram_service';

type QaDisposition = {
  assetStatus: MediaAssetStatus;
  taskStatus: 'completed' | 'review_required' | 'rejected';
  taskStage: Extract<VideoTaskStage, 'completed' | 'review_required' | 'rejected'>;
};

const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'review_required',
  'rejected',
  'failed',
  'cancelled',
  'interrupted'
]);

const TERMINAL_TASK_STAGES = new Set<VideoTaskStage>([
  'completed',
  'review_required',
  'rejected',
  'failed',
  'cancelled',
  'interrupted'
]);

export class VideoGenerationService {
  private static runningTasks = new Map<string, { abortController?: AbortController; promptId?: string }>();

  static isFeatureEnabled(): boolean {
    return process.env.NOVASTORY_ENABLE_VIDEO === 'true' || process.env.ENABLE_VIDEO_GENERATION === 'true';
  }

  private static resolveQaDisposition(qaReport: VideoQAReport): QaDisposition {
    if (qaReport.quality_grade === 'reject') {
      return { assetStatus: 'rejected', taskStatus: 'rejected', taskStage: 'rejected' };
    }
    if (qaReport.quality_grade === 'manual_review') {
      return {
        assetStatus: 'review_required',
        taskStatus: 'review_required',
        taskStage: 'review_required'
      };
    }
    return { assetStatus: 'draft', taskStatus: 'completed', taskStage: 'completed' };
  }

  private static async resolveCharacterForRequest(request: VideoGenerationRequest, projectId: number): Promise<any | null> {
    for (const assetId of request.character_reference_asset_ids || []) {
      const asset = await MediaAssetService.getAssetById(assetId);
      if (asset?.character_id) {
        const character = await db.get(
          'SELECT * FROM character WHERE id = ? AND project_id = ?',
          asset.character_id,
          projectId
        );
        if (character) return character;
      }
    }

    const characters = await db.all('SELECT * FROM character WHERE project_id = ? ORDER BY id ASC', projectId);
    return characters.length === 1 ? characters[0] : null;
  }

  private static async persistProcessedAssets(options: {
    projectId: number;
    sceneId: number;
    sceneVersion: number;
    rawAsset: MediaAsset;
    profile: VideoGenerationRequest['profile'];
    artifactId: string;
    processRes: ProcessVideoResult;
    metadata?: Record<string, any>;
  }) {
    const { projectId, sceneId, sceneVersion, rawAsset, profile, artifactId, processRes, metadata = {} } = options;
    const disposition = this.resolveQaDisposition(processRes.qaReport);
    const finalRole = profile === 'character_loop' ? 'loop_master' : 'narrative_final';
    const baseUrl = `/static/generated/videos/${projectId}/${sceneId}/${artifactId}`;

    const finalAsset = await MediaAssetService.createAsset({
      project_id: projectId,
      scene_id: sceneId,
      scene_version: sceneVersion,
      parent_asset_id: rawAsset.id,
      media_type: 'video',
      role: finalRole,
      profile,
      status: disposition.assetStatus,
      url: `${baseUrl}/final.mp4`,
      mime_type: 'video/mp4',
      width: processRes.probe.width,
      height: processRes.probe.height,
      fps: processRes.probe.fps,
      frame_count: processRes.probe.frame_count,
      duration_ms: Math.round(processRes.probe.duration_s * 1000),
      sha256: MediaAssetService.computeSha256(processRes.finalVideoPath),
      metadata_json: JSON.stringify({
        qa_report: processRes.qaReport,
        raw_asset_id: rawAsset.id,
        ...metadata
      })
    });

    const posterAsset = await MediaAssetService.createAsset({
      project_id: projectId,
      scene_id: sceneId,
      scene_version: sceneVersion,
      parent_asset_id: finalAsset.id,
      media_type: 'image',
      role: 'poster',
      profile,
      status: 'ready',
      url: `${baseUrl}/poster.jpg`,
      mime_type: 'image/jpeg',
      sha256: MediaAssetService.computeSha256(processRes.posterPath)
    });

    const qaAsset = await MediaAssetService.createAsset({
      project_id: projectId,
      scene_id: sceneId,
      scene_version: sceneVersion,
      parent_asset_id: finalAsset.id,
      media_type: 'json',
      role: 'qa_report',
      profile,
      status: 'ready',
      url: `${baseUrl}/qa.json`,
      mime_type: 'application/json',
      sha256: MediaAssetService.computeSha256(processRes.qaPath),
      metadata_json: JSON.stringify({ qa_report: processRes.qaReport })
    });

    return { disposition, finalAsset, posterAsset, qaAsset };
  }

  static async getCapabilities(): Promise<VideoCapabilities> {
    const vramStatus = await VramService.getStatus();
    const comfyProvider = new ComfyH3Provider();
    const comfyOnline = await comfyProvider.checkStatus();

    const ffmpegOk = await VideoPostprocessService.isFfmpegAvailable();
    const ffprobeOk = await VideoPostprocessService.isFfprobeAvailable();

    const workflowsDir = getVideoWorkflowsDirectory();
    const manifestPath = path.join(workflowsDir, 'minimax_h3_hongchao_a2a_12gb.manifest.json');
    const apiPath = path.join(workflowsDir, 'minimax_h3_hongchao_a2a_12gb.api.json');
    let h3WorkflowReady = fs.existsSync(manifestPath) && fs.existsSync(apiPath);

    const missingComponents: string[] = [];
    const featureEnabled = this.isFeatureEnabled();
    if (!featureEnabled) {
      missingComponents.push('Video generation feature is disabled by default (Gate G0)');
    }

    if (!ffmpegOk) missingComponents.push('ffmpeg binary not available in PATH');
    if (!ffprobeOk) missingComponents.push('ffprobe binary not available in PATH');
    if (!comfyOnline) {
      missingComponents.push('ComfyUI server is offline');
    } else {
      try {
        const objectInfo = await comfyProvider.getObjectInfo();
        const bundle = VideoWorkflowCompiler.loadWorkflowBundle('minimax_h3_hongchao_a2a_12gb');
        const validation = VideoWorkflowCompiler.validateAgainstComfyObjectInfo(objectInfo, bundle.manifest, bundle.workflow);
        if (!validation.valid) {
          h3WorkflowReady = false;
          if (validation.missingNodes.length > 0) {
            missingComponents.push(`Missing ComfyUI nodes: ${validation.missingNodes.join(', ')}`);
          }
          if (validation.missingSlots.length > 0) {
            missingComponents.push(`Invalid workflow slots: ${validation.missingSlots.join(', ')}`);
          }
          if (validation.missingModels.length > 0) {
            missingComponents.push(`Missing H3 model files: ${validation.missingModels.join(', ')}`);
          }
        }
      } catch (err: any) {
        h3WorkflowReady = false;
        missingComponents.push(`Failed to validate H3 workflow: ${err?.message || err}`);
      }
    }

    if (!fs.existsSync(manifestPath) || !fs.existsSync(apiPath)) {
      missingComponents.push('H3 workflow template JSON or manifest missing on disk');
    }

    return {
      video_generation_enabled: featureEnabled && missingComponents.length === 0,
      ffmpeg_available: ffmpegOk,
      ffprobe_available: ffprobeOk,
      comfyui_online: comfyOnline,
      h3_workflow_ready: h3WorkflowReady,
      gpu_available: vramStatus.level !== 'unknown',
      gpu_name: vramStatus.gpu_name,
      vram_free_bytes: vramStatus.free_bytes,
      supported_presets: ['preview_480p_5s', 'standard_720p_5s'],
      supported_profiles: ['narrative_clip', 'character_loop'],
      missing_components: missingComponents
    };
  }

  static async preflight(request: VideoGenerationRequest): Promise<VideoPreflightResponse> {
    const blockers: string[] = [];
    const warnings: string[] = [];
    const usesReferenceControl = request.workflow_id !== 'minimax_h3_fl2va_official_12gb';

    if (!this.isFeatureEnabled()) {
      blockers.push('Video generation is disabled by Gate G0. Set NOVASTORY_ENABLE_VIDEO=true to enable it.');
    }

    const scene = await db.get('SELECT * FROM scene WHERE id = ?', request.scene_id);
    if (!scene) {
      blockers.push(`Scene ID ${request.scene_id} does not exist`);
    }

    const chapter = scene
      ? await db.get('SELECT project_id FROM chapter WHERE id = ?', scene.chapter_id)
      : null;
    const projectId = chapter?.project_id ? Number(chapter.project_id) : null;

    if (scene) {
      const targetVersion = request.scene_version || scene.active_version || 1;
      const versionRow = await db.get(
        'SELECT * FROM scene_version WHERE scene_id = ? AND version = ?',
        request.scene_id,
        targetVersion
      );
      if (!versionRow && targetVersion !== (scene.active_version || 1)) {
        blockers.push(`Scene version ${targetVersion} does not exist for scene ${request.scene_id}`);
      }
    }

    let keyframeAsset = request.keyframe_asset_id ? await MediaAssetService.getAssetById(request.keyframe_asset_id) : null;
    if (!keyframeAsset && scene?.asset_url) {
      const existing = await db.get('SELECT * FROM media_asset WHERE url = ?', scene.asset_url);
      if (existing) {
        keyframeAsset = existing;
        request.keyframe_asset_id = existing.id;
      } else {
        const newAsset = await MediaAssetService.createAsset({
          project_id: projectId || 1,
          scene_id: scene.id,
          scene_version: scene.active_version || 1,
          media_type: 'image',
          role: 'video_keyframe',
          status: 'ready',
          url: scene.asset_url
        });
        keyframeAsset = newAsset;
        request.keyframe_asset_id = newAsset.id!;
      }
    }

    if (!keyframeAsset) {
      blockers.push(`Keyframe asset ID ${request.keyframe_asset_id} does not exist.`);
    } else if (keyframeAsset.media_type !== 'image') {
      blockers.push(`Keyframe asset ID ${request.keyframe_asset_id} must be an image.`);
    } else {
      if (projectId && keyframeAsset.project_id !== projectId) {
        blockers.push(`Keyframe asset ID ${request.keyframe_asset_id} belongs to a different project.`);
      }
      if (keyframeAsset.scene_id != null && Number(keyframeAsset.scene_id) !== Number(request.scene_id)) {
        blockers.push(`Keyframe asset ID ${request.keyframe_asset_id} belongs to a different scene.`);
      }
    }

    if (request.last_frame_asset_id) {
      const lastFrameAsset = await MediaAssetService.getAssetById(request.last_frame_asset_id);
      if (!lastFrameAsset) {
        blockers.push(`Last-frame asset ID ${request.last_frame_asset_id} does not exist.`);
      } else if (lastFrameAsset.media_type !== 'image') {
        blockers.push(`Last-frame asset ID ${request.last_frame_asset_id} must be an image.`);
      } else {
        if (projectId && lastFrameAsset.project_id !== projectId) {
          blockers.push(`Last-frame asset ID ${request.last_frame_asset_id} belongs to a different project.`);
        }
        if (lastFrameAsset.scene_id != null && Number(lastFrameAsset.scene_id) !== Number(request.scene_id)) {
          blockers.push(`Last-frame asset ID ${request.last_frame_asset_id} belongs to a different scene.`);
        }
      }
    }

    // Strategy-required presence constraints are owned by VideoGenerationRequestSchema.
    // The service only validates supplied reference assets, avoiding contradictory
    // rules such as requiring Ref2VA inputs for the FL2VA boundary workflow.
    if (usesReferenceControl && request.character_reference_asset_ids?.length) {
      for (const charAssetId of request.character_reference_asset_ids) {
        const asset = await MediaAssetService.getAssetById(charAssetId);
        if (!asset) {
          blockers.push(`Character reference asset ID ${charAssetId} does not exist.`);
        } else if (asset.media_type !== 'image') {
          blockers.push(`Character reference asset ID ${charAssetId} must be an image.`);
        } else if (projectId && asset.project_id !== projectId) {
          blockers.push(`Character reference asset ID ${charAssetId} belongs to a different project.`);
        }
      }
    }

    if (usesReferenceControl && request.motion_reference_asset_id) {
      const motionAsset = await MediaAssetService.getAssetById(request.motion_reference_asset_id);
      if (!motionAsset) {
        blockers.push(`Motion reference asset ID ${request.motion_reference_asset_id} does not exist.`);
      } else if (motionAsset.media_type !== 'video') {
        blockers.push(`Motion reference asset ID ${request.motion_reference_asset_id} must be a video.`);
      } else if (projectId && motionAsset.project_id !== projectId) {
        blockers.push(`Motion reference asset ID ${request.motion_reference_asset_id} belongs to a different project.`);
      }
    }

    // Identity ownership is a service-level invariant, not an HTTP-route concern.
    // Any future internal caller of preflight/createTask must get the same fail-closed
    // behavior as /api/videos/preflight and /api/videos/generate.
    const identityValidation = await VideoReferenceIdentityService.validate(request);
    blockers.push(...identityValidation.blockers);

    const character = projectId
      ? await this.resolveCharacterForRequest(request, projectId)
      : null;

    let compiledSpec;
    if (blockers.length === 0 && scene) {
      compiledSpec = VideoSpecCompiler.compile({ request, scene, character });
    }

    const estSeconds = request.preset === 'preview_480p_5s' ? 360 : 720;
    return {
      ready: blockers.length === 0,
      profile: request.profile,
      preset: request.preset,
      compiled_spec: compiledSpec,
      blockers,
      warnings,
      estimated_duration_seconds: estSeconds
    };
  }

  static async createTask(request: VideoGenerationRequest): Promise<{ task_id: string; queue_position: number }> {
    const preflightRes = await this.preflight(request);
    if (!preflightRes.ready) {
      throw new Error(`Preflight failed: ${preflightRes.blockers.join('; ')}`);
    }

    const taskId = `vtask_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO generation_task (
        task_id, scene_id, status, kind, stage, request_json, created_at, updated_at
      ) VALUES (?, ?, 'processing', 'video', 'queued', ?, ?, ?)`,
      taskId,
      request.scene_id,
      JSON.stringify(request),
      now,
      now
    );

    // acquireLease mutates the in-process reservation synchronously before returning
    // its Promise. Reserve before the 202 response so queue_position is the actual
    // submission position rather than the old always-zero race with runTaskPipeline.
    void GpuLeaseService.acquireLease(taskId, 'video').catch((err) => {
      if (!(err instanceof GpuLeaseCancelledError)) {
        logger.error(`GPU reservation failed for video task ${taskId}: ${err}`);
      }
    });
    const queuePos = GpuLeaseService.getQueuePosition(taskId);

    this.runTaskPipeline(taskId, request).catch((err) => {
      logger.error(`Video generation pipeline error for ${taskId}: ${err}`);
    });

    return { task_id: taskId, queue_position: queuePos };
  }

  static async getTask(taskId: string): Promise<VideoTaskResponse | null> {
    const row = await db.get('SELECT * FROM generation_task WHERE task_id = ?', taskId);
    if (!row) return null;

    let qaReport = null;
    let metadata: Record<string, any> = {};
    if (row.metadata_json) {
      try {
        metadata = JSON.parse(row.metadata_json);
        qaReport = metadata.qa_report || null;
      } catch {}
    }

    const queuePos = row.stage === 'queued' ? GpuLeaseService.getQueuePosition(taskId) : 0;
    const rawAsset = metadata.raw_asset_id
      ? await MediaAssetService.getAssetById(Number(metadata.raw_asset_id))
      : null;
    const finalAsset = metadata.final_asset_id
      ? await MediaAssetService.getAssetById(Number(metadata.final_asset_id))
      : null;
    const poster = finalAsset?.id
      ? await db.get('SELECT url FROM media_asset WHERE parent_asset_id = ? AND role = ? ORDER BY id DESC LIMIT 1', finalAsset.id, 'poster')
      : null;
    const qa = finalAsset?.id
      ? await db.get('SELECT url FROM media_asset WHERE parent_asset_id = ? AND role = ? ORDER BY id DESC LIMIT 1', finalAsset.id, 'qa_report')
      : null;

    return {
      task_id: row.task_id,
      scene_id: Number(row.scene_id),
      status: row.status,
      stage: row.stage as VideoTaskStage,
      queue_position: queuePos,
      error: row.error,
      output_url: row.output_url,
      raw_video_url: rawAsset?.url ?? null,
      poster_url: poster?.url ?? null,
      qa_report_url: qa?.url ?? null,
      qa_report: qaReport,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  static async cancelTask(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task || TERMINAL_TASK_STATUSES.has(task.status)) {
      return false;
    }

    // Make the transition itself atomic. A stale pre-check must not allow a cancel
    // request to overwrite a terminal completion that won the race in SQLite.
    const now = new Date().toISOString();
    const cancelUpdate = await db.run(
      `UPDATE generation_task
       SET status = 'cancelled', stage = 'cancelled', error = 'Cancelled by user', updated_at = ?
       WHERE task_id = ? AND status = 'processing'`,
      now,
      taskId
    );
    if ((cancelUpdate?.changes ?? 0) === 0) {
      return false;
    }

    const publisher = createProgressPublisher(taskId, null);
    await publisher('cancelled', { phase: 'cancelled', message: 'Task cancelled by user' });

    if (GpuLeaseService.isQueued(taskId)) {
      GpuLeaseService.cancelQueuedTask(taskId);
    }

    const running = this.runningTasks.get(taskId);
    if (running?.promptId) {
      const provider = new ComfyH3Provider();
      const stopped = await provider.cancelPrompt(running.promptId);
      if (!stopped) {
        logger.warn(
          `Cancellation accepted for ${taskId}, but Comfy prompt ${running.promptId} is still active; GPU guard remains held.`
        );
      } else {
        const currentLease = GpuLeaseService.getCurrentLease();
        if (currentLease?.owner_task_id === taskId) {
          GpuLeaseService.releaseLease(currentLease.lease_id, taskId);
        }
      }
    }

    // Do not release a currently-owned, not-yet-submitted lease here. There is a
    // small but real race between the pipeline's last cancellation checkpoint and
    // Comfy /prompt submission. Keeping ownership until the pipeline observes the DB
    // terminal state prevents a cancelled task from submitting work under the next
    // task's GPU lease.
    return true;
  }

  static async reprocessAsset(assetId: number, runLoopCloser = true) {
    const rawAsset = await MediaAssetService.resolveRawVideoForReprocess(assetId);
    if (!rawAsset.id || rawAsset.scene_id == null) {
      throw new Error(`Raw video asset ${rawAsset.id ?? assetId} is missing scene lineage`);
    }

    const rawVideoPath = MediaAssetService.resolveSafePath(rawAsset.url);
    if (!fs.existsSync(rawVideoPath)) {
      throw new Error(`Raw video file does not exist: ${rawVideoPath}`);
    }

    const artifactId = `reprocess_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const outputDirectory = path.join(
      getGeneratedVideosDirectory(),
      String(rawAsset.project_id),
      String(rawAsset.scene_id),
      artifactId
    );
    const profile = rawAsset.profile || 'character_loop';

    const processRes = await LoopCloser.process({
      taskId: artifactId,
      profile,
      rawVideoPath,
      outputDirectory,
      runLoopCloser,
      metadata: {
        reprocess: true,
        source_asset_id: assetId,
        raw_asset_id: rawAsset.id
      }
    });

    const persisted = await this.persistProcessedAssets({
      projectId: rawAsset.project_id,
      sceneId: rawAsset.scene_id,
      sceneVersion: rawAsset.scene_version || 1,
      rawAsset,
      profile,
      artifactId,
      processRes,
      metadata: {
        reprocessed_from_asset_id: assetId,
        reprocess_id: artifactId
      }
    });

    return {
      ok: true,
      reprocess_id: artifactId,
      raw_asset_id: rawAsset.id,
      final_asset: persisted.finalAsset,
      poster_asset: persisted.posterAsset,
      qa_asset: persisted.qaAsset,
      qa_report: processRes.qaReport,
      status: persisted.disposition.taskStatus
    };
  }

  private static async runTaskPipeline(taskId: string, request: VideoGenerationRequest): Promise<void> {
    const rawPublisher: ProgressPublisher = createProgressPublisher(taskId, null);
    let lease: GpuLease | null = null;
    let leaseHeartbeat: NodeJS.Timeout | null = null;

    const stopLeaseHeartbeat = () => {
      if (leaseHeartbeat) {
        clearInterval(leaseHeartbeat);
        leaseHeartbeat = null;
      }
    };

    const isCancelled = async () => {
      const current = await this.getTask(taskId);
      return !current || current.status === 'cancelled';
    };

    const emitEvent = async (stage: VideoTaskStage, data: Record<string, any> = {}) => {
      // Suppress stale non-terminal progress after any terminal DB transition. This
      // keeps SSE/poll semantics monotonic in the same way as lifecycle writes below.
      if (!TERMINAL_TASK_STAGES.has(stage)) {
        const current = await this.getTask(taskId);
        if (!current || TERMINAL_TASK_STATUSES.has(current.status)) return;
      }

      const status = stage === 'completed' ? 'completed'
        : stage === 'review_required' ? 'review_required'
        : stage === 'rejected' ? 'rejected'
        : stage === 'failed' ? 'failed'
        : stage === 'cancelled' ? 'cancelled'
        : stage === 'interrupted' ? 'interrupted'
        : 'processing';

      await rawPublisher(stage, {
        task_id: taskId,
        stage,
        status,
        phase: stage,
        at: new Date().toISOString(),
        ...data
      });
    };

    try {
      this.runningTasks.set(taskId, {});

      await emitEvent('queued', {
        message: 'Task enqueued waiting for GPU availability...',
        message_zh: '任务已进入队列，等待显卡资源...'
      });

      lease = await GpuLeaseService.acquireLease(taskId, 'video');
      leaseHeartbeat = setInterval(() => {
        if (!lease) return;
        GpuLeaseService.heartbeat(lease.lease_id, taskId);
        void db.run(
          'UPDATE generation_task SET heartbeat_at = ?, updated_at = ? WHERE task_id = ?',
          new Date().toISOString(),
          new Date().toISOString(),
          taskId
        ).catch(() => {});
      }, 20_000);

      if (await isCancelled()) {
        stopLeaseHeartbeat();
        if (lease) GpuLeaseService.releaseLease(lease.lease_id, taskId);
        return;
      }

      await emitEvent('preflight', {
        message: 'Validating inputs and preparing model specs...',
        message_zh: '正在校验输入资产与编译生成规范...'
      });
      await db.run(
        `UPDATE generation_task SET stage = 'preflight', updated_at = ?
         WHERE task_id = ? AND status = 'processing'`,
        new Date().toISOString(),
        taskId
      );

      const scene = await db.get('SELECT * FROM scene WHERE id = ?', request.scene_id);
      const chapter = scene ? await db.get('SELECT project_id FROM chapter WHERE id = ?', scene.chapter_id) : null;
      const projectId = Number(chapter?.project_id || 1);
      const character = await this.resolveCharacterForRequest(request, projectId);

      if (await isCancelled()) {
        stopLeaseHeartbeat();
        if (lease) GpuLeaseService.releaseLease(lease.lease_id, taskId);
        return;
      }

      await emitEvent('vram_tuning', {
        message: 'Freeing resident models for H3 generation...',
        message_zh: '正在调优显存环境以加载 H3 模型...'
      });
      await GpuLeaseService.prepareGpuForTask('video');

      if (await isCancelled()) {
        stopLeaseHeartbeat();
        if (lease) GpuLeaseService.releaseLease(lease.lease_id, taskId);
        return;
      }

      await emitEvent('vram_ready', {
        message: 'GPU ready, staging asset references...',
        message_zh: '显存就绪，正在暂存参考资产...'
      });

      await db.run(
        `UPDATE generation_task SET stage = 'staging_refs', updated_at = ?
         WHERE task_id = ? AND status = 'processing'`,
        new Date().toISOString(),
        taskId
      );
      const keyframeAsset = (await MediaAssetService.getAssetById(request.keyframe_asset_id))!;
      const stagedKf = await MediaAssetService.stageAssetForComfy(keyframeAsset);

      let stagedLastFrameFilename: string | undefined;
      if (request.last_frame_asset_id) {
        const lastFrameAsset = await MediaAssetService.getAssetById(request.last_frame_asset_id);
        if (!lastFrameAsset) {
          throw new Error(`Last-frame asset ${request.last_frame_asset_id} disappeared after preflight`);
        }
        const stagedLast = await MediaAssetService.stageAssetForComfy(lastFrameAsset);
        stagedLastFrameFilename = stagedLast.stagedFilename;
      }

      const stagedCharFiles: string[] = [];
      for (const charAssetId of request.character_reference_asset_ids) {
        const charAsset = await MediaAssetService.getAssetById(charAssetId);
        if (charAsset) {
          const staged = await MediaAssetService.stageAssetForComfy(charAsset);
          stagedCharFiles.push(staged.stagedFilename);
        }
      }

      let stagedMotionFilename: string | undefined;
      if (request.motion_reference_asset_id) {
        const motionAsset = await MediaAssetService.getAssetById(request.motion_reference_asset_id);
        if (motionAsset) {
          const staged = await MediaAssetService.stageAssetForComfy(motionAsset);
          stagedMotionFilename = staged.stagedFilename;
        }
      }

      if (await isCancelled()) {
        stopLeaseHeartbeat();
        if (lease) GpuLeaseService.releaseLease(lease.lease_id, taskId);
        return;
      }

      const spec = VideoSpecCompiler.compile({ request, scene, character });
      const compiledWorkflow = VideoWorkflowCompiler.compile({
        spec,
        stagedFiles: {
          firstFrameFilename: stagedKf.stagedFilename,
          lastFrameFilename: stagedLastFrameFilename,
          characterRefFilenames: stagedCharFiles,
          motionRefFilename: stagedMotionFilename
        },
        seed: request.seed,
        outputPrefix: `H3_${projectId}_${request.scene_id}_${taskId.slice(-6)}`
      });

      await emitEvent('model_loading', {
        message: 'Submitting H3 workflow to ComfyUI...',
        message_zh: '正在提交工作流至 ComfyUI 并加载权重...'
      });
      await db.run(
        `UPDATE generation_task SET stage = 'generating', updated_at = ?
         WHERE task_id = ? AND status = 'processing'`,
        new Date().toISOString(),
        taskId
      );

      if (await isCancelled()) {
        stopLeaseHeartbeat();
        if (lease) GpuLeaseService.releaseLease(lease.lease_id, taskId);
        return;
      }

      const comfyProvider = new ComfyH3Provider();
      const executionResult = await comfyProvider.executeWorkflow(compiledWorkflow.workflow, {
        onPromptQueued: async (promptId) => {
          this.runningTasks.set(taskId, { promptId });
          GpuLeaseService.guardLeaseForPrompt(taskId, promptId);
          await db.run(
            `UPDATE generation_task SET comfy_prompt_id = ?, updated_at = ? WHERE task_id = ?`,
            promptId,
            new Date().toISOString(),
            taskId
          );

          // Cancellation can race the tiny window after the final pre-submit check.
          // Keep this task's lease, guard the accepted prompt, then cancel only after
          // executeWorkflow has returned from this callback and attached its listeners.
          if (await isCancelled()) {
            setTimeout(() => {
              void comfyProvider.cancelPrompt(promptId, 5000).then((stopped) => {
                if (!stopped) {
                  logger.warn(`Late-cancel prompt ${promptId} remains active; GPU guard retained.`);
                }
              });
            }, 0);
          }
        },
        onProgress: async (p) => {
          await emitEvent('generating', {
            current: p.current,
            total: p.total,
            message: p.message || `Generating H3 video frames... (${p.current || 0}/${p.total || 0})`,
            message_zh: p.message || `正在生成 H3 视频画面... (${p.current || 0}/${p.total || 0})`
          });
        }
      });

      if (await isCancelled()) {
        stopLeaseHeartbeat();
        if (lease) GpuLeaseService.releaseLease(lease.lease_id, taskId);
        return;
      }

      if (executionResult.status !== 'completed' || executionResult.videos.length === 0) {
        throw new Error(executionResult.error || 'ComfyUI did not produce video outputs');
      }

      await emitEvent('collecting', {
        message: 'Collecting raw video output...',
        message_zh: '正在收取原始视频产物...'
      });

      const rawBuffer = executionResult.videos[0]!.buffer;
      const taskAssetDir = path.join(getGeneratedVideosDirectory(), String(projectId), String(request.scene_id), taskId);
      fs.mkdirSync(taskAssetDir, { recursive: true });
      const rawVideoPath = path.join(taskAssetDir, 'raw.mp4');
      fs.writeFileSync(rawVideoPath, rawBuffer);

      const rawSha = MediaAssetService.computeBufferSha256(rawBuffer);
      const rawAsset = await MediaAssetService.createAsset({
        project_id: projectId,
        scene_id: request.scene_id,
        scene_version: request.scene_version,
        media_type: 'video',
        role: 'raw_video',
        profile: request.profile,
        status: 'ready',
        url: `/static/generated/videos/${projectId}/${request.scene_id}/${taskId}/raw.mp4`,
        mime_type: 'video/mp4',
        sha256: rawSha
      });

      if (lease) {
        stopLeaseHeartbeat();
        GpuLeaseService.releaseLease(lease.lease_id, taskId);
        lease = null;
      }

      if (await isCancelled()) return;

      await emitEvent('postprocessing', {
        message: 'Applying video postprocessing & LoopCloser...',
        message_zh: '正在执行视频标准化转码与闭环接缝修复...'
      });
      await db.run(
        `UPDATE generation_task SET stage = 'postprocessing', updated_at = ?
         WHERE task_id = ? AND status = 'processing'`,
        new Date().toISOString(),
        taskId
      );

      if (await isCancelled()) return;

      const processRes = await LoopCloser.process({
        taskId,
        profile: request.profile,
        rawVideoPath,
        outputDirectory: taskAssetDir,
        runLoopCloser: request.run_loop_closer,
        metadata: {
          spec,
          request,
          compiled_params: compiledWorkflow.appliedParams
        }
      });

      if (await isCancelled()) return;

      const persisted = await this.persistProcessedAssets({
        projectId,
        sceneId: request.scene_id,
        sceneVersion: request.scene_version,
        rawAsset,
        profile: request.profile,
        artifactId: taskId,
        processRes,
        metadata: {
          task_id: taskId,
          compiled_params: compiledWorkflow.appliedParams
        }
      });

      if (await isCancelled()) return;

      const { disposition, finalAsset } = persisted;
      const finalizeUpdate = await db.run(
        `UPDATE generation_task SET
          status = ?,
          stage = ?,
          output_url = ?,
          metadata_json = ?,
          completed_at = ?,
          updated_at = ?
         WHERE task_id = ? AND status = 'processing'`,
        disposition.taskStatus,
        disposition.taskStage,
        finalAsset.url,
        JSON.stringify({
          qa_report: processRes.qaReport,
          raw_asset_id: rawAsset.id,
          final_asset_id: finalAsset.id,
          poster_asset_id: persisted.posterAsset.id,
          qa_asset_id: persisted.qaAsset.id
        }),
        new Date().toISOString(),
        new Date().toISOString(),
        taskId
      );
      if ((finalizeUpdate?.changes ?? 0) === 0) {
        logger.info(`Task ${taskId} finalization skipped because another terminal transition won.`);
        return;
      }

      const isPass = disposition.taskStatus === 'completed';
      const isReview = disposition.taskStatus === 'review_required';
      await emitEvent(disposition.taskStage, {
        output_url: finalAsset.url,
        qa_report: processRes.qaReport,
        message: isPass
          ? 'Video candidate passed automated QA and is ready for promotion review'
          : isReview
            ? 'Video generated; manual QA review is required before promotion'
            : 'Video generated but failed QA quality gate',
        message_zh: isPass
          ? '视频候选已通过自动 QA，请人工确认后设为成片'
          : isReview
            ? '视频已生成，但需人工复核后才能设为成片'
            : '视频已生成，但未达到质量门验收标准'
      });

    } catch (err: any) {
      stopLeaseHeartbeat();
      const cancelled = err instanceof GpuLeaseCancelledError || await isCancelled();
      if (cancelled) {
        if (lease) GpuLeaseService.releaseLease(lease.lease_id, taskId);
        logger.info(`Task ${taskId} pipeline unwound after cancellation.`);
        return;
      }

      logger.error(`Task ${taskId} failed: ${err?.message || err}`);
      if (lease) {
        GpuLeaseService.releaseLease(lease.lease_id, taskId);
      }
      const failureUpdate = await db.run(
        `UPDATE generation_task
         SET status = 'failed', stage = 'failed', error = ?, updated_at = ?
         WHERE task_id = ? AND status = 'processing'`,
        String(err?.message || err),
        new Date().toISOString(),
        taskId
      );
      if ((failureUpdate?.changes ?? 0) === 0) {
        logger.info(`Task ${taskId} failure transition skipped because another terminal transition won.`);
        return;
      }
      await emitEvent('failed', {
        error: String(err?.message || err),
        message: `Video generation failed: ${err?.message || err}`,
        message_zh: `视频生成失败：${err?.message || err}`
      });
    } finally {
      stopLeaseHeartbeat();
      this.runningTasks.delete(taskId);
    }
  }

  static async recoverTasksOnStartup(): Promise<number> {
    try {
      const rows = await db.all(
        `SELECT * FROM generation_task WHERE kind = 'video' AND status = 'processing'`
      );
      let recoveredCount = 0;
      const comfyProvider = new ComfyH3Provider();
      const isComfyOnline = await comfyProvider.checkStatus();

      for (const row of rows as any[]) {
        const taskId = row.task_id;
        const stage = row.stage as VideoTaskStage;
        const comfyPromptId = row.comfy_prompt_id;
        let request: VideoGenerationRequest | null = null;
        try {
          if (row.request_json) request = JSON.parse(row.request_json);
        } catch {}

        const scene = request?.scene_id ? await db.get('SELECT * FROM scene WHERE id = ?', request.scene_id) : null;
        const chapter = scene ? await db.get('SELECT project_id FROM chapter WHERE id = ?', scene.chapter_id) : null;
        const projectId = Number(chapter?.project_id || 1);

        const taskAssetDir = path.join(
          getGeneratedVideosDirectory(),
          String(projectId),
          String(request?.scene_id || 1),
          taskId
        );
        const rawVideoPath = path.join(taskAssetDir, 'raw.mp4');

        if (fs.existsSync(rawVideoPath) && request) {
          logger.info(`[Recovery] Resuming postprocessing for task ${taskId} from existing raw.mp4`);
          this.resumePostprocessFromRaw(taskId, request, projectId, rawVideoPath, taskAssetDir).catch((err) => {
            logger.error(`[Recovery] Failed to resume postprocessing for task ${taskId}: ${err}`);
          });
          recoveredCount++;
          continue;
        }

        if (stage === 'generating' && comfyPromptId && isComfyOnline && request) {
          const history = await comfyProvider.getHistory(comfyPromptId);
          if (history && history[comfyPromptId]?.outputs) {
            logger.info(`[Recovery] ComfyUI prompt ${comfyPromptId} completed in history. Resuming collecting for task ${taskId}`);
            this.resumeCollectingFromHistory(taskId, request, projectId, comfyPromptId, history[comfyPromptId].outputs, taskAssetDir).catch((err) => {
              logger.error(`[Recovery] Failed to resume collecting for task ${taskId}: ${err}`);
            });
            recoveredCount++;
            continue;
          }
        }

        logger.warn(`[Recovery] Task ${taskId} cannot be resumed (stage=${stage}, comfyPromptId=${comfyPromptId}); marking interrupted.`);
        await db.run(
          `UPDATE generation_task
           SET status = 'interrupted', stage = 'interrupted', error = 'Server restarted while task was in progress', updated_at = ?
           WHERE task_id = ? AND status = 'processing'`,
          new Date().toISOString(),
          taskId
        );
      }
      return recoveredCount;
    } catch (err) {
      logger.error(`Error during video task recovery on startup: ${err}`);
      return 0;
    }
  }

  private static async resumePostprocessFromRaw(
    taskId: string,
    request: VideoGenerationRequest,
    projectId: number,
    rawVideoPath: string,
    taskAssetDir: string
  ): Promise<void> {
    const initialState = await db.get('SELECT status FROM generation_task WHERE task_id = ?', taskId);
    if (initialState?.status !== 'processing') {
      logger.info(`[Recovery] Skipping postprocess for ${taskId}: status=${initialState?.status || 'missing'}.`);
      return;
    }

    const publisher: ProgressPublisher = createProgressPublisher(taskId, null);
    await publisher('postprocessing', {
      task_id: taskId,
      stage: 'postprocessing',
      status: 'processing',
      message: 'Recovered task: running postprocessing & LoopCloser...',
      message_zh: '已恢复中断任务：正在执行后处理与闭环接缝修复...'
    });

    const rawSha = MediaAssetService.computeSha256(rawVideoPath);
    const rawRow = await db.get(
      'SELECT id FROM media_asset WHERE url LIKE ? ORDER BY id DESC LIMIT 1',
      `%/videos/${projectId}/${request.scene_id}/${taskId}/raw.mp4`
    );
    let rawAsset = rawRow?.id
      ? await MediaAssetService.getAssetById(Number(rawRow.id))
      : null;
    if (!rawAsset) {
      rawAsset = await MediaAssetService.createAsset({
        project_id: projectId,
        scene_id: request.scene_id,
        scene_version: request.scene_version,
        media_type: 'video',
        role: 'raw_video',
        profile: request.profile,
        status: 'ready',
        url: `/static/generated/videos/${projectId}/${request.scene_id}/${taskId}/raw.mp4`,
        mime_type: 'video/mp4',
        sha256: rawSha
      });
    }

    const processRes = await LoopCloser.process({
      taskId,
      profile: request.profile,
      rawVideoPath,
      outputDirectory: taskAssetDir,
      runLoopCloser: request.run_loop_closer,
      metadata: { recovered: true, request }
    });

    const stateAfterProcess = await db.get('SELECT status FROM generation_task WHERE task_id = ?', taskId);
    if (stateAfterProcess?.status !== 'processing') {
      logger.info(`[Recovery] Aborting postprocess finalization for ${taskId}: status=${stateAfterProcess?.status || 'missing'}.`);
      return;
    }

    const expectedFinalUrl = `/static/generated/videos/${projectId}/${request.scene_id}/${taskId}/final.mp4`;
    const existingFinalRow = await db.get(
      'SELECT id FROM media_asset WHERE parent_asset_id = ? AND url = ? ORDER BY id DESC LIMIT 1',
      rawAsset.id,
      expectedFinalUrl
    );

    let persisted;
    if (existingFinalRow?.id) {
      const disposition = this.resolveQaDisposition(processRes.qaReport);
      await db.run(
        `UPDATE media_asset SET status = ?, width = ?, height = ?, fps = ?, frame_count = ?,
          duration_ms = ?, sha256 = ?, metadata_json = ? WHERE id = ?`,
        disposition.assetStatus,
        processRes.probe.width,
        processRes.probe.height,
        processRes.probe.fps,
        processRes.probe.frame_count,
        Math.round(processRes.probe.duration_s * 1000),
        MediaAssetService.computeSha256(processRes.finalVideoPath),
        JSON.stringify({ qa_report: processRes.qaReport, raw_asset_id: rawAsset.id, recovered: true }),
        existingFinalRow.id
      );
      const finalAsset = (await MediaAssetService.getAssetById(Number(existingFinalRow.id)))!;
      persisted = {
        disposition,
        finalAsset,
        posterAsset: null,
        qaAsset: null
      };
    } else {
      persisted = await this.persistProcessedAssets({
        projectId,
        sceneId: request.scene_id,
        sceneVersion: request.scene_version,
        rawAsset,
        profile: request.profile,
        artifactId: taskId,
        processRes,
        metadata: { recovered: true, task_id: taskId }
      });
    }

    const recoveryFinalize = await db.run(
      `UPDATE generation_task
       SET status = ?, stage = ?, output_url = ?, metadata_json = ?, completed_at = ?, updated_at = ?
       WHERE task_id = ? AND status = 'processing'`,
      persisted.disposition.taskStatus,
      persisted.disposition.taskStage,
      persisted.finalAsset.url,
      JSON.stringify({
        qa_report: processRes.qaReport,
        raw_asset_id: rawAsset.id,
        final_asset_id: persisted.finalAsset.id
      }),
      new Date().toISOString(),
      new Date().toISOString(),
      taskId
    );
    if ((recoveryFinalize?.changes ?? 0) === 0) {
      logger.info(`[Recovery] Finalization skipped for ${taskId}: another terminal transition won.`);
      return;
    }

    await publisher(persisted.disposition.taskStage, {
      task_id: taskId,
      stage: persisted.disposition.taskStage,
      status: persisted.disposition.taskStatus,
      output_url: persisted.finalAsset.url,
      qa_report: processRes.qaReport,
      message: persisted.disposition.taskStatus === 'review_required'
        ? 'Recovered video requires manual QA review'
        : persisted.disposition.taskStatus === 'completed'
          ? 'Recovered video candidate passed automated QA'
          : 'Recovered video failed QA',
      message_zh: persisted.disposition.taskStatus === 'review_required'
        ? '恢复视频需人工复核'
        : persisted.disposition.taskStatus === 'completed'
          ? '恢复视频候选已通过自动 QA'
          : '恢复视频未通过 QA'
    });
  }

  private static async resumeCollectingFromHistory(
    taskId: string,
    request: VideoGenerationRequest,
    projectId: number,
    promptId: string,
    promptOutputs: Record<string, any>,
    taskAssetDir: string
  ): Promise<void> {
    const comfyProvider = new ComfyH3Provider();
    for (const nodeId of Object.keys(promptOutputs)) {
      const nodeOut = promptOutputs[nodeId];
      const list = nodeOut.videos || nodeOut.gifs || nodeOut.images || [];
      for (const item of list) {
        const buf = await comfyProvider.downloadFile(item.filename, item.subfolder, item.type);
        if (buf) {
          fs.mkdirSync(taskAssetDir, { recursive: true });
          const rawVideoPath = path.join(taskAssetDir, 'raw.mp4');
          fs.writeFileSync(rawVideoPath, buf);
          await this.resumePostprocessFromRaw(taskId, request, projectId, rawVideoPath, taskAssetDir);
          return;
        }
      }
    }
  }

  static async markOrphanedTasks(): Promise<number> {
    return this.recoverTasksOnStartup();
  }
}
