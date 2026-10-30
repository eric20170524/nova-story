import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { VideoProfile, VideoQAReport } from '../../schemas/video';
import { VideoPostprocessService, VideoProbeInfo } from './video_postprocess_service';
import { LoopAnalyzer } from './loop_analyzer';
import { computeLoopContinuityMeasurements, type LoopContinuityMeasurements, type LoopFrameSample } from './loop_metrics';
import { logger } from '../../core/logging';

const execFileAsync = promisify(execFile);

export interface ProcessVideoOptions {
  taskId: string;
  profile: VideoProfile;
  rawVideoPath: string;
  outputDirectory: string;
  runLoopCloser?: boolean;
  metadata?: Record<string, any>;
  targetWidth?: number;
  targetHeight?: number;
  targetFrames?: number;
}

export interface ProcessVideoResult {
  rawVideoPath: string;
  finalVideoPath: string;
  posterPath: string;
  qaPath: string;
  manifestPath: string;
  qaReport: VideoQAReport;
  probe: VideoProbeInfo;
}

const DELIVERY_FPS = 24;
const DELIVERY_FRAMES = 120;
const LOOP_BLEND_FRAMES = 8;

export class LoopCloser {
  private static async readMetricFrame(filePath: string): Promise<LoopFrameSample> {
    const result = await sharp(filePath)
      .resize(160, 90, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      data: result.data,
      channels: result.info.channels
    };
  }

  private static async measureBoundary(
    videoPath: string,
    outputDirectory: string,
    deliveryFrames: number = DELIVERY_FRAMES
  ): Promise<LoopContinuityMeasurements> {
    const framePattern = path.join(outputDirectory, '.qa_boundary_%02d.png');
    const framePaths = [1, 2, 3, 4].map((index) => path.join(outputDirectory, `.qa_boundary_${String(index).padStart(2, '0')}.png`));
    const lastIdx = deliveryFrames - 1;
    const prevIdx = deliveryFrames - 2;

    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-vf', `select=eq(n\\,0)+eq(n\\,1)+eq(n\\,${prevIdx})+eq(n\\,${lastIdx})`,
        '-fps_mode', 'passthrough',
        '-frames:v', '4',
        framePattern
      ]);

      for (const file of framePaths) {
        if (!fs.existsSync(file)) {
          throw new Error(`Boundary frame extraction did not produce ${path.basename(file)}`);
        }
      }

      const [first, second, penultimate, last] = await Promise.all(
        framePaths.map((file) => this.readMetricFrame(file))
      );
      if (!first || !second || !penultimate || !last) {
        throw new Error('Boundary metric frame set incomplete');
      }

      return computeLoopContinuityMeasurements({ first, second, penultimate, last });
    } finally {
      for (const file of framePaths) {
        try { fs.unlinkSync(file); } catch {}
      }
    }
  }

  private static async closeLoopBoundary(
    inputPath: string,
    outputPath: string,
    deliveryFrames: number = DELIVERY_FRAMES
  ): Promise<void> {
    const bodyFrames = deliveryFrames - LOOP_BLEND_FRAMES;
    const lastBlendFrameIndex = LOOP_BLEND_FRAMES - 1;

    // Keep exact delivery frames (120 for 5s, 192 for 8s). The final 8 frames gradually blend the original
    // tail into a reversed copy of the first 8 frames, ending on frame 0. This
    // gives the player a near-zero-velocity K -> K boundary without shortening
    // the clip. Real seam QA runs after this transform and may still reject it.
    const filter = [
      '[0:v]split=3[bodySrc][tailSrc][headSrc]',
      `[bodySrc]trim=start_frame=0:end_frame=${bodyFrames},setpts=PTS-STARTPTS[body]`,
      `[tailSrc]trim=start_frame=${bodyFrames}:end_frame=${deliveryFrames},setpts=PTS-STARTPTS[tail]`,
      `[headSrc]trim=start_frame=0:end_frame=${LOOP_BLEND_FRAMES},reverse,setpts=PTS-STARTPTS[headrev]`,
      `[tail][headrev]blend=all_expr='A*(1-N/${lastBlendFrameIndex})+B*(N/${lastBlendFrameIndex})'[blend]`,
      '[body][blend]concat=n=2:v=1:a=0[out]'
    ].join(';');

    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-filter_complex', filter,
      '-map', '[out]',
      '-r', String(DELIVERY_FPS),
      '-frames:v', String(deliveryFrames),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an',
      outputPath
    ]);
  }

  static async process(options: ProcessVideoOptions): Promise<ProcessVideoResult> {
    const { taskId, profile, rawVideoPath, outputDirectory, runLoopCloser = true, metadata = {}, targetWidth, targetHeight, targetFrames } = options;
    const deliveryFrames = targetFrames && targetFrames > 0 ? targetFrames : DELIVERY_FRAMES;
    fs.mkdirSync(outputDirectory, { recursive: true });

    const finalVideoPath = path.join(outputDirectory, 'final.mp4');
    const posterPath = path.join(outputDirectory, 'poster.jpg');
    const qaPath = path.join(outputDirectory, 'qa.json');
    const manifestPath = path.join(outputDirectory, 'manifest.json');

    // 0. Verify raw video before postprocessing
    const rawProbe = await VideoPostprocessService.probeVideo(rawVideoPath);
    if (rawProbe.width <= 0 || rawProbe.height <= 0) {
      throw new Error(`Invalid raw video dimensions: ${rawProbe.width}x${rawProbe.height}`);
    }

    // 1. Standardize to the delivery contract first. H3 may generate 124 model
    // frames for 5s or 192 frames for 8s, while NovaStory delivers 120 or 192 frames / 24fps.
    const tempStandardized = path.join(outputDirectory, 'temp_std.mp4');
    const standardizedTarget = profile === 'character_loop' && runLoopCloser
      ? tempStandardized
      : finalVideoPath;

    await VideoPostprocessService.standardizeVideo(rawVideoPath, standardizedTarget, {
      targetFps: DELIVERY_FPS,
      targetFrames: deliveryFrames,
      targetWidth,
      targetHeight,
      preserveAudio: profile === 'narrative_clip'
    });

    if (profile === 'character_loop' && runLoopCloser) {
      try {
        await this.closeLoopBoundary(tempStandardized, finalVideoPath, deliveryFrames);
      } catch (err) {
        // Preserve a valid delivery artifact, but do not fake a passing QA score.
        logger.warn(`Loop boundary blend failed; keeping standardized candidate for measured QA: ${err}`);
        fs.copyFileSync(tempStandardized, finalVideoPath);
      } finally {
        try { fs.unlinkSync(tempStandardized); } catch {}
      }
    }

    const probe = await VideoPostprocessService.probeVideo(finalVideoPath);

    // 2. Extract Poster Frame
    await VideoPostprocessService.extractPoster(finalVideoPath, posterPath);

    // 3. Run real boundary measurements. If analysis fails, LoopAnalyzer returns
    // manual_review rather than manufacturing a good continuity score.
    let continuity: LoopContinuityMeasurements | undefined;
    let analysisError: string | undefined;
    try {
      continuity = await this.measureBoundary(finalVideoPath, outputDirectory, deliveryFrames);
    } catch (err: any) {
      analysisError = String(err?.message || err);
      logger.warn(`Boundary continuity analysis failed for ${taskId}: ${analysisError}`);
    }

    const qaReport = LoopAnalyzer.evaluateVideo({
      taskId,
      profile,
      probe,
      continuity,
      analysisError,
      expectedFrames: deliveryFrames
    });
    fs.writeFileSync(qaPath, JSON.stringify(qaReport, null, 2), 'utf-8');

    // 4. Write manifest.json
    const manifest = {
      task_id: taskId,
      profile,
      processed_at: new Date().toISOString(),
      raw_video_path: rawVideoPath,
      final_video_path: finalVideoPath,
      delivery_contract: {
        fps: DELIVERY_FPS,
        frames: deliveryFrames,
        duration_s: deliveryFrames / DELIVERY_FPS,
        loop_blend_frames: profile === 'character_loop' && runLoopCloser ? LOOP_BLEND_FRAMES : 0
      },
      probe,
      qa: qaReport,
      metadata
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    return {
      rawVideoPath,
      finalVideoPath,
      posterPath,
      qaPath,
      manifestPath,
      qaReport,
      probe
    };
  }
}
