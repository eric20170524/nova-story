import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VideoProfile, VideoQAReport } from '../../schemas/video';
import { VideoPostprocessService, VideoProbeInfo } from './video_postprocess_service';
import { LoopAnalyzer } from './loop_analyzer';
import { logger } from '../../core/logging';

const execFileAsync = promisify(execFile);

export interface ProcessVideoOptions {
  taskId: string;
  profile: VideoProfile;
  rawVideoPath: string;
  outputDirectory: string;
  runLoopCloser?: boolean;
  metadata?: Record<string, any>;
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

export class LoopCloser {
  static async process(options: ProcessVideoOptions): Promise<ProcessVideoResult> {
    const { taskId, profile, rawVideoPath, outputDirectory, runLoopCloser = true, metadata = {} } = options;
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

    // 1. Standardize and/or Loop Close
    let probe: VideoProbeInfo;
    if (profile === 'character_loop' && runLoopCloser) {
      // Loop repair filter: standardize and crossfade boundary
      const tempStandardized = path.join(outputDirectory, 'temp_std.mp4');
      await VideoPostprocessService.standardizeVideo(rawVideoPath, tempStandardized, {
        targetFps: 24,
        targetFrames: 120
      });

      // Apply loop blend (crossfade ending into beginning)
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', tempStandardized,
          '-filter_complex',
          '[0:v]split[v1][v2];[v1]trim=start=0:end=4.5,setpts=PTS-STARTPTS[body];[v2]trim=start=4.5:end=5.0,setpts=PTS-STARTPTS[tail];[tail][body]xfade=transition=fade:duration=0.5:offset=0,trim=start=0:end=5.0,setpts=PTS-STARTPTS[out]',
          '-map', '[out]',
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-an',
          finalVideoPath
        ]);
      } catch (err) {
        logger.warn(`FFmpeg filter loop crossfade fallback to direct standardize: ${err}`);
        fs.copyFileSync(tempStandardized, finalVideoPath);
      }
      try { fs.unlinkSync(tempStandardized); } catch {}
      probe = await VideoPostprocessService.probeVideo(finalVideoPath);
    } else {
      // Direct standardization for narrative clips
      const stdResult = await VideoPostprocessService.standardizeVideo(rawVideoPath, finalVideoPath, {
        targetFps: 24,
        targetFrames: 120
      });
      probe = stdResult.probe;
    }

    // 2. Extract Poster Frame
    await VideoPostprocessService.extractPoster(finalVideoPath, posterPath);

    // 3. Run QA evaluation
    const qaReport = LoopAnalyzer.evaluateVideo({
      taskId,
      profile,
      probe
    });
    fs.writeFileSync(qaPath, JSON.stringify(qaReport, null, 2), 'utf-8');

    // 4. Write manifest.json
    const manifest = {
      task_id: taskId,
      profile,
      processed_at: new Date().toISOString(),
      raw_video_path: rawVideoPath,
      final_video_path: finalVideoPath,
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
