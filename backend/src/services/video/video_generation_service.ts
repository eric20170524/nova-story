import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/database';
import { logger } from '../../core/logging';
import { getGeneratedVideosDirectory, getVideoWorkflowsDirectory } from '../../core/paths';
import {
  VideoCapabilities,
  VideoGenerationRequest,
  VideoPreflightResponse,
  VideoTaskResponse,
  VideoTaskStage
} from '../../schemas/video';
import { VideoSpecCompiler } from './video_spec_compiler';
import { VideoWorkflowCompiler } from './video_workflow_compiler';
import { MediaAssetService } from './media_asset_service';
import { GpuLeaseService } from '../gpu_lease_service';
import { ComfyH3Provider } from './comfy_h3_provider';
import { VideoPostprocessService } from './video_postprocess_service';
import { LoopCloser } from './loop_closer';
import { createProgressPublisher, ProgressPublisher } from '../generation_progress';
import { VramService } from '../vram_service';

export class VideoGenerationService {
  private static runningTasks = new Map<string, { abortController?: AbortController; promptId?: string }>();

  static isFeatureEnabled(): boolean {
    return process.env.NOVASTORY_ENABLE_VIDEO === 'true' || process.env.ENABLE_VIDEO_GENERATION === 'true';
  }

  private static async resolveCharacterForRequest(request: VideoGenerationRequest, projectId: number): Promise<any | null> {
    // Prefer the explicit character binding carried by reference assets. This keeps
    // prompt identity aligned with the images actually sent to H3.
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

    // A single-character project is an unambiguous fallback. For multi-character
    // projects, returning null is safer than injecting the wrong person's identity.
    const characters = await db.all('SELECT * FROM character WHERE project_id = ? ORDER BY id ASC', projectId);
    return characters.length === 1 ? characters[0] : null;
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

    // Gate G0 is an actual execution gate, not just a UI hint.
    const featureEnabled = this.isFeatureEnabled();
    if (!featureEnabled) {
      missingComponents.push('Video generation feature is disabled by default (Gate G0)');
    }

    if (!ffmpegOk) missingComponents.push('ffmpeg binary not available in PATH');
    if (!ffprobeOk) missingComponents.push('ffprobe binary not available in PATH');
    if (!comfyOnline) {
      missingComponents.push('ComfyUI server is offline');
    } else {
      // Validate workflow against ComfyUI object_info, including exact model names.
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

    if (!this.isFeatureEnabled()) {
      blockers.push('Video generation is disabled by Gate G0. Set NOVASTORY_ENABLE_VIDEO=true to enable it.');
    }

    // 1. Check Scene Existence
    const scene = await db.get('SELECT * FROM scene WHERE id = ?', request.scene_id);
    if (!scene) {
      blockers.push(`Scene ID ${request.scene_id} does not exist`);
    }

    const chapter = scene
      ? await db.get('SELECT project_id FROM chapter WHERE id = ?', scene.chapter_id)
      : null;
    const projectId = chapter?.project_id ? Number(chapter.project_id) : null;

    // 2. Check Scene Version
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

    // 3. Check Keyframe Asset
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

    // 4. Check explicit Last Frame. If omitted, character_loop intentionally uses K -> K.
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

    // 5. Check Character References
    if (request.profile === 'character_loop') {
      if (!request.character_reference_asset_ids || request.character_reference_asset_ids.length === 0) {
        blockers.push('character_loop profile requires 1 to 3 character_reference_asset_ids');
      }
    }

    if (request.character_reference_asset_ids && request.character_reference_asset_ids.length > 0) {
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

    // 6. Check Motion Reference
    if (request.profile === 'character_loop') {
      if (!request.motion_reference_asset_id) {
        blockers.push('character_loop profile requires exactly 1 motion_reference_asset_id');
      } else {
        const motionAsset = await MediaAssetService.getAssetById(request.motion_reference_asset_id);
        if (!motionAsset) {
          blockers.push(`Motion reference asset ID ${request.motion_reference_asset_id} does not exist.`);
        } else if (motionAsset.media_type !== 'video') {
          blockers.push(`Motion reference asset ID ${request.motion_reference_asset_id} must be a video.`);
        } else if (projectId && motionAsset.project_id !== projectId) {
          blockers.push(`Motion reference asset ID ${request.motion_reference_asset_id} belongs to a different project.`);
        }
      }
    } else if (request.motion_reference_asset_id) {
      const motionAsset = await MediaAssetService.getAssetById(request.motion_reference_asset_id);
      if (!motionAsset) {
        blockers.push(`Motion reference asset ID ${request.motion_reference_asset_id} does not exist.`);
      } else if (motionAsset.media_type !== 'video') {
        blockers.push(`Motion reference asset ID ${request.motion_reference_asset_id} must be a video.`);
      } else if (projectId && motionAsset.project_id !== projectId) {
        blockers.push(`Motion reference asset ID ${request.motion_reference_asset_id} belongs to a different project.`);
      }
    }

    const character = projectId
      ? await this.resolveCharacterForRequest(request, projectId)
      : null;

    let compiledSpec;
    if (blockers.length === 0 && scene) {
      compiledSpec = VideoSpecCompiler.compile({
        request,
        scene,
        character
      });
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

    const queuePos = GpuLeaseService.getQueuePosition(taskId);

    // Launch worker without waiting
    this.runTaskPipeline(taskId, request).catch((err) => {
      logger.error(`Video generation pipeline error for ${taskId}: ${err}`);
    });

    return { task_id: taskId, queue_position: queuePos };
  }

  static async getTask(taskId: string): Promise<VideoTaskResponse | null> {
    const row = await db.get('SELECT * FROM generation_task WHERE task_id = ?', taskId);
    if (!row) return null;

    let qaReport = null;
    if (row.metadata_json) {
      try {
        const parsed = JSON.parse(row.metadata_json);
        qaReport = parsed.qa_report || null;
      } catch {}
    }

    const queuePos = row.stage === 'queued' ? GpuLeaseService.getQueuePosition(taskId) : 0;

    return {
      task_id: row.task_id,
      scene_id: Number(row.scene_id),
      status: row.status,
      stage: row.stage as VideoTaskStage,
      queue_position: queuePos,
      error: row.error,
      output_url: row.output_url,
      qa_report: qaReport,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  static async cancelTask(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return false;
    }

    const running = this.runningTasks.get(taskId);
    if (running?.promptId) {
      const provider = new ComfyH3Provider();
      await provider.cancelPrompt(running.promptId);
    }
    GpuLeaseService.releaseLease('', taskId);

    const now = new Date().toISOString();
    await db.run(
      `UPDATE generation_task SET status = 'cancelled', stage = 'cancelled', error = 'Cancelled by user', updated_at = ? WHERE task_id = ?`,
      now,
      taskId
    );

    const publisher = createProgressPublisher(taskId, null);
    await publisher('cancelled', { phase: 'cancelled', message: 'Task cancelled by user' });
    this.runningTasks.delete(taskId);
    return true;
  }

  private static async runTaskPipeline(taskId: string, request: VideoGenerationRequest): Promise<void> {
    const rawPublisher: ProgressPublisher = createProgressPublisher(taskId, null);
    let lease = null;
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
      const status = stage === 'completed' ? 'completed'
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

      // 1. Acquire GPU Lease
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
      await db.run(`UPDATE generation_task SET stage = 'preflight', updated_at = ? WHERE task_id = ?`, new Date().toISOString(), taskId);

      // Load DB records
      const scene = await db.get('SELECT * FROM scene WHERE id = ?', request.scene_id);
      const chapter = scene ? await db.get('SELECT project_id FROM chapter WHERE id = ?', scene.chapter_id) : null;
      const projectId = chapter?.project_id || 1;
      const character = await this.resolveCharacterForRequest(request, Number(projectId));

      if (await isCancelled()) {
        stopLeaseHeartbeat();
        if (lease) GpuLeaseService.releaseLease(lease.lease_id, taskId);
        return;
      }

      // 2. VRAM Handoff / Tuning
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

      // 3. Staging References
      await db.run(`UPDATE generation_task SET stage = 'staging_refs', updated_at = ? WHERE task_id = ?`, new Date().toISOString(), taskId);
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

      // 4. Compile Spec & Workflow
      const spec = VideoSpecCompiler.compile({
        request,
        scene,
        character
      });

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

      // 5. Submit to ComfyUI
      await emitEvent('model_loading', {
        message: 'Submitting H3 workflow to ComfyUI...',
        message_zh: '正在提交工作流至 ComfyUI 并加载权重...'
      });
      await db.run(`UPDATE generation_task SET stage = 'generating', updated_at = ? WHERE task_id = ?`, new Date().toISOString(), taskId);

      const comfyProvider = new ComfyH3Provider();
      const executionResult = await comfyProvider.executeWorkflow(compiledWorkflow.workflow, {
        onPromptQueued: async (promptId) => {
          this.runningTasks.set(taskId, { promptId });
          await db.run(
            `UPDATE generation_task SET comfy_prompt_id = ?, updated_at = ? WHERE task_id = ?`,
            promptId,
            new Date().toISOString(),
            taskId
          );
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

      // 6. Collecting raw output
      await emitEvent('collecting', {
        message: 'Collecting raw video output...',
        message_zh: '正在收取原始视频产物...'
      });

      const rawBuffer = executionResult.videos[0]!.buffer;
      const taskAssetDir = path.join(getGeneratedVideosDirectory(), String(projectId), String(request.scene_id), taskId);
      fs.mkdirSync(taskAssetDir, { recursive: true });
      const rawVideoPath = path.join(taskAssetDir, 'raw.mp4');
      fs.writeFileSync(rawVideoPath, rawBuffer);

      // Create Raw Video Media Asset
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

      // Release GPU lease early so next task can start generating
      if (lease) {
        stopLeaseHeartbeat();
        GpuLeaseService.releaseLease(lease.lease_id, taskId);
        lease = null;
      }

      if (await isCancelled()) return;

      // 7. Postprocessing & Loop Closing
      await emitEvent('postprocessing', {
        message: 'Applying video postprocessing & LoopCloser...',
        message_zh: '正在执行视频标准化转码与闭环接缝修复...'
      });
      await db.run(`UPDATE generation_task SET stage = 'postprocessing', updated_at = ? WHERE task_id = ?`, new Date().toISOString(), taskId);

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

      // Create Final Video Media Asset
      const finalRole = request.profile === 'character_loop' ? 'loop_master' : 'narrative_final';
      const finalAsset = await MediaAssetService.createAsset({
        project_id: projectId,
        scene_id: request.scene_id,
        scene_version: request.scene_version,
        parent_asset_id: rawAsset.id,
        media_type: 'video',
        role: finalRole,
        profile: request.profile,
        status: processRes.qaReport.quality_grade === 'reject' ? 'rejected' : 'ready',
        url: `/static/generated/videos/${projectId}/${request.scene_id}/${taskId}/final.mp4`,
        mime_type: 'video/mp4',
        width: processRes.probe.width,
        height: processRes.probe.height,
        fps: processRes.probe.fps,
        frame_count: processRes.probe.frame_count,
        duration_ms: Math.round(processRes.probe.duration_s * 1000),
        sha256: MediaAssetService.computeSha256(processRes.finalVideoPath)
      });

      // Create Poster Asset
      await MediaAssetService.createAsset({
        project_id: projectId,
        scene_id: request.scene_id,
        scene_version: request.scene_version,
        parent_asset_id: finalAsset.id,
        media_type: 'image',
        role: 'poster',
        profile: request.profile,
        status: 'ready',
        url: `/static/generated/videos/${projectId}/${request.scene_id}/${taskId}/poster.jpg`,
        mime_type: 'image/jpeg',
        sha256: MediaAssetService.computeSha256(processRes.posterPath)
      });

      // Create QA Report Asset
      await MediaAssetService.createAsset({
        project_id: projectId,
        scene_id: request.scene_id,
        scene_version: request.scene_version,
        parent_asset_id: finalAsset.id,
        media_type: 'json',
        role: 'qa_report',
        profile: request.profile,
        status: 'ready',
        url: `/static/generated/videos/${projectId}/${request.scene_id}/${taskId}/qa.json`,
        mime_type: 'application/json'
      });

      // 8. Finalize Task Status
      const finalStatus = processRes.qaReport.quality_grade === 'reject' ? 'rejected' : 'completed';
      const finalStage: VideoTaskStage = processRes.qaReport.quality_grade === 'reject' ? 'rejected' : 'completed';

      await db.run(
        `UPDATE generation_task SET
          status = ?,
          stage = ?,
          output_url = ?,
          metadata_json = ?,
          completed_at = ?,
          updated_at = ?
         WHERE task_id = ?`,
        finalStatus,
        finalStage,
        finalAsset.url,
        JSON.stringify({ qa_report: processRes.qaReport, raw_asset_id: rawAsset.id, final_asset_id: finalAsset.id }),
        new Date().toISOString(),
        new Date().toISOString(),
        taskId
      );

      await emitEvent(finalStage, {
        output_url: finalAsset.url,
        qa_report: processRes.qaReport,
        message: finalStatus === 'completed' ? 'Video generation completed successfully' : 'Video generated but failed QA quality gate',
        message_zh: finalStatus === 'completed' ? '视频生成并后处理完成' : '视频已生成，但未达到质量门验收标准'
      });

    } catch (err: any) {
      logger.error(`Task ${taskId} failed: ${err?.message || err}`);
      stopLeaseHeartbeat();
      if (lease) {
        GpuLeaseService.releaseLease(lease.lease_id, taskId);
      }
      await db.run(
        `UPDATE generation_task SET status = 'failed', stage = 'failed', error = ?, updated_at = ? WHERE task_id = ?`,
        String(err?.message || err),
        new Date().toISOString(),
        taskId
      );
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
        const projectId = chapter?.project_id || 1;

        const taskAssetDir = path.join(
          getGeneratedVideosDirectory(),
          String(projectId),
          String(request?.scene_id || 1),
          taskId
        );
        const rawVideoPath = path.join(taskAssetDir, 'raw.mp4');

        // Case 1: If raw.mp4 already exists, resume from postprocessing / QA idempotently
        if (fs.existsSync(rawVideoPath) && request) {
          logger.info(`[Recovery] Resuming postprocessing for task ${taskId} from existing raw.mp4`);
          this.resumePostprocessFromRaw(taskId, request, projectId, rawVideoPath, taskAssetDir).catch((err) => {
            logger.error(`[Recovery] Failed to resume postprocessing for task ${taskId}: ${err}`);
          });
          recoveredCount++;
          continue;
        }

        // Case 2: Generating stage with comfy_prompt_id and ComfyUI is online
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

        // Otherwise, mark interrupted
        logger.warn(`[Recovery] Task ${taskId} cannot be resumed (stage=${stage}, comfyPromptId=${comfyPromptId}); marking interrupted.`);
        await db.run(
          `UPDATE generation_task SET status = 'interrupted', stage = 'interrupted', error = 'Server restarted while task was in progress', updated_at = ? WHERE task_id = ?`,
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
    const publisher: ProgressPublisher = createProgressPublisher(taskId, null);
    await publisher('postprocessing', {
      task_id: taskId,
      stage: 'postprocessing',
      status: 'processing',
      message: 'Recovered task: running postprocessing & LoopCloser...',
      message_zh: '已恢复中断任务：正在执行后处理与闭环接缝修复...'
    });

    const rawSha = MediaAssetService.computeSha256(rawVideoPath);
    let rawAsset = await db.get('SELECT * FROM media_asset WHERE url LIKE ?', `%/videos/${projectId}/${request.scene_id}/${taskId}/raw.mp4`);
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

    const finalRole = request.profile === 'character_loop' ? 'loop_master' : 'narrative_final';
    const finalAsset = await MediaAssetService.createAsset({
      project_id: projectId,
      scene_id: request.scene_id,
      scene_version: request.scene_version,
      parent_asset_id: rawAsset.id,
      media_type: 'video',
      role: finalRole,
      profile: request.profile,
      status: processRes.qaReport.quality_grade === 'reject' ? 'rejected' : 'ready',
      url: `/static/generated/videos/${projectId}/${request.scene_id}/${taskId}/final.mp4`,
      mime_type: 'video/mp4',
      width: processRes.probe.width,
      height: processRes.probe.height,
      fps: processRes.probe.fps,
      frame_count: processRes.probe.frame_count,
      duration_ms: Math.round(processRes.probe.duration_s * 1000),
      sha256: MediaAssetService.computeSha256(processRes.finalVideoPath)
    });

    const finalStatus = processRes.qaReport.quality_grade === 'reject' ? 'rejected' : 'completed';
    await db.run(
      `UPDATE generation_task SET status = ?, stage = ?, output_url = ?, metadata_json = ?, completed_at = ?, updated_at = ? WHERE task_id = ?`,
      finalStatus,
      finalStatus,
      finalAsset.url,
      JSON.stringify({ qa_report: processRes.qaReport, raw_asset_id: rawAsset.id, final_asset_id: finalAsset.id }),
      new Date().toISOString(),
      new Date().toISOString(),
      taskId
    );

    await publisher(finalStatus, {
      task_id: taskId,
      stage: finalStatus,
      status: finalStatus,
      output_url: finalAsset.url,
      qa_report: processRes.qaReport,
      message: 'Video recovered and processed successfully',
      message_zh: '已成功恢复并完成视频处理'
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
