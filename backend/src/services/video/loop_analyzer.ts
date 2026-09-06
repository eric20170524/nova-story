import { VideoQAReport, VideoProfile } from '../../schemas/video';
import { VideoProbeInfo } from './video_postprocess_service';
import { LoopContinuityMeasurements } from './loop_metrics';

export class LoopAnalyzer {
  static evaluateVideo(options: {
    taskId: string;
    profile: VideoProfile;
    probe: VideoProbeInfo;
    continuity?: LoopContinuityMeasurements;
    analysisError?: string;
  }): VideoQAReport {
    const { taskId, profile, probe, continuity, analysisError } = options;
    const isLoop = profile === 'character_loop';

    const reasons: string[] = [];
    let technicalPass = true;

    // Technical checks
    if (probe.width <= 0 || probe.height <= 0) {
      technicalPass = false;
      reasons.push('Invalid video resolution');
    }
    if (Math.abs(probe.fps - 24) > 0.25) {
      technicalPass = false;
      reasons.push(`FPS mismatch: expected 24, got ${probe.fps}`);
    }
    if (Math.abs(probe.duration_s - 5.0) > 0.12) {
      technicalPass = false;
      reasons.push(`Duration mismatch: expected 5.0s, got ${probe.duration_s.toFixed(3)}s`);
    }
    if (Math.abs(probe.frame_count - 120) > 1) {
      technicalPass = false;
      reasons.push(`Frame-count mismatch: expected 120, got ${probe.frame_count}`);
    }

    const appearanceError = continuity?.appearance_error ?? 10;
    const motionError = continuity?.motion_error ?? 10;
    const flickerError = continuity?.flicker_error ?? 10;
    const seamCost = Math.round(
      (0.4 * appearanceError + 0.35 * motionError + 0.25 * flickerError) * 100
    ) / 100;
    const normalizedScore = Math.max(0, Math.min(100, Math.round((10 - seamCost) * 10)));

    let qualityGrade: VideoQAReport['quality_grade'] = 'pass';
    if (!technicalPass) {
      qualityGrade = 'reject';
    } else if (!continuity) {
      // Never synthesize a good score when visual analysis did not run.
      qualityGrade = 'manual_review';
      reasons.push(`Continuity analysis unavailable${analysisError ? `: ${analysisError}` : ''}`);
    } else if (isLoop && seamCost > 2.2) {
      qualityGrade = 'reject';
      reasons.push(`Seam cost too high for character loop: ${seamCost} > 2.20`);
    } else if (isLoop && seamCost > 1.5) {
      qualityGrade = 'manual_review';
      reasons.push(`Loop seam requires manual review: ${seamCost} > 1.50`);
    }

    return {
      schema_version: 1,
      task_id: taskId,
      profile,
      technical_pass: technicalPass,
      technical_details: {
        codec: probe.codec,
        pixel_format: probe.pixel_format,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        frame_count: probe.frame_count,
        duration_s: probe.duration_s,
        has_audio: probe.has_audio
      },
      continuity_scores: {
        appearance_error: appearanceError,
        motion_error: motionError,
        flicker_error: flickerError,
        seam_cost: seamCost,
        normalized_score: normalizedScore
      },
      quality_grade: qualityGrade,
      reasons,
      evaluated_at: new Date().toISOString()
    };
  }
}
