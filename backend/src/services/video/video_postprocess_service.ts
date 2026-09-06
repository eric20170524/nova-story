import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../core/logging';

const execFileAsync = promisify(execFile);

export interface VideoProbeInfo {
  codec: string;
  pixel_format: string;
  width: number;
  height: number;
  fps: number;
  frame_count: number;
  duration_s: number;
  has_audio: boolean;
}

export class VideoPostprocessService {
  static async isFfmpegAvailable(): Promise<boolean> {
    try {
      await execFileAsync('ffmpeg', ['-version']);
      return true;
    } catch {
      return false;
    }
  }

  static async isFfprobeAvailable(): Promise<boolean> {
    try {
      await execFileAsync('ffprobe', ['-version']);
      return true;
    } catch {
      return false;
    }
  }

  static async probeVideo(videoPath: string): Promise<VideoProbeInfo> {
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found for ffprobe: ${videoPath}`);
    }

    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=codec_name,pix_fmt,width,height,r_frame_rate,nb_frames:format=duration',
        '-show_streams',
        '-of', 'json',
        videoPath
      ]);

      const data = JSON.parse(stdout);
      const streams = data.streams || [];
      const videoStream = streams.find((s: any) => s.codec_name !== 'aac' && s.codec_name !== 'mp3' && s.width && s.height) || streams[0];
      const audioStream = streams.find((s: any) => s.codec_name === 'aac' || s.codec_name === 'mp3');

      if (!videoStream || !videoStream.width || !videoStream.height) {
        throw new Error(`Invalid video stream in ${videoPath}`);
      }

      let fps = 24;
      if (videoStream.r_frame_rate) {
        const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
        if (num && den) fps = Math.round((num / den) * 100) / 100;
      }

      const duration = Number(data.format?.duration || videoStream.duration || 0);
      const frameCount = Number(videoStream.nb_frames || Math.round(duration * fps) || 0);

      return {
        codec: videoStream.codec_name || 'unknown',
        pixel_format: videoStream.pix_fmt || 'unknown',
        width: Number(videoStream.width || 0),
        height: Number(videoStream.height || 0),
        fps,
        frame_count: frameCount,
        duration_s: duration,
        has_audio: Boolean(audioStream)
      };
    } catch (err: any) {
      logger.error(`ffprobe verification failed for ${videoPath}: ${err?.message || err}`);
      throw new Error(`Video probe failed for ${videoPath}: ${err?.message || err}`);
    }
  }

  static async extractPoster(videoPath: string, outputPath: string): Promise<string> {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      outputPath
    ]);
    return outputPath;
  }

  static async standardizeVideo(
    inputPath: string,
    outputPath: string,
    options: {
      targetWidth?: number;
      targetHeight?: number;
      targetFps?: number;
      targetFrames?: number;
    } = {}
  ): Promise<{ outputPath: string; probe: VideoProbeInfo }> {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const targetFps = options.targetFps || 24;
    const targetFrames = options.targetFrames || 120;
    const duration = targetFrames / targetFps; // 5.0s

    const ffmpegArgs: string[] = [
      '-y',
      '-i', inputPath,
      '-t', String(duration),
      '-r', String(targetFps),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an' // Strip audio
    ];

    if (options.targetWidth && options.targetHeight) {
      ffmpegArgs.push('-vf', `scale=${options.targetWidth}:${options.targetHeight}:force_original_aspect_ratio=decrease,pad=${options.targetWidth}:${options.targetHeight}:(ow-iw)/2:(oh-ih)/2`);
    }

    ffmpegArgs.push(outputPath);

    await execFileAsync('ffmpeg', ffmpegArgs);
    const probe = await this.probeVideo(outputPath);
    return { outputPath, probe };
  }
}
