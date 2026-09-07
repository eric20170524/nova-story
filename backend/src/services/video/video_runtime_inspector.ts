import { VideoCapabilities, VideoWorkflowId, DEFAULT_VIDEO_WORKFLOW_ID } from '../../schemas/video';
import { VideoWorkflowCompiler } from './video_workflow_compiler';
import { ComfyH3Provider } from './comfy_h3_provider';
import { VideoPostprocessService } from './video_postprocess_service';
import { VramService } from '../vram_service';

export interface VideoRuntimeInspection extends VideoCapabilities {
  workflow_id: VideoWorkflowId;
  workflow_family: string;
  workflow_stability: string;
  upstream_reference?: string;
}

const isFeatureEnabled = () =>
  process.env.NOVASTORY_ENABLE_VIDEO === 'true'
  || process.env.ENABLE_VIDEO_GENERATION === 'true';

export class VideoRuntimeInspector {
  static async inspect(workflowId: VideoWorkflowId = DEFAULT_VIDEO_WORKFLOW_ID): Promise<VideoRuntimeInspection> {
    const missingComponents: string[] = [];
    const featureEnabled = isFeatureEnabled();

    let bundle: ReturnType<typeof VideoWorkflowCompiler.loadWorkflowBundle> | null = null;
    try {
      bundle = VideoWorkflowCompiler.loadWorkflowBundle(workflowId);
    } catch (error: any) {
      missingComponents.push(error?.message || String(error));
    }

    const [ffmpegOk, ffprobeOk, vramStatus] = await Promise.all([
      VideoPostprocessService.isFfmpegAvailable(),
      VideoPostprocessService.isFfprobeAvailable(),
      VramService.getStatus()
    ]);

    const comfyProvider = new ComfyH3Provider();
    const comfyOnline = await comfyProvider.checkStatus();
    let h3WorkflowReady = Boolean(bundle);

    if (!featureEnabled) {
      missingComponents.push('Video generation feature is disabled by Gate G0');
    }
    if (!ffmpegOk) missingComponents.push('ffmpeg binary not available in PATH');
    if (!ffprobeOk) missingComponents.push('ffprobe binary not available in PATH');
    if (!comfyOnline) {
      missingComponents.push('ComfyUI server is offline');
      h3WorkflowReady = false;
    }

    if (bundle && comfyOnline) {
      try {
        const objectInfo = await comfyProvider.getObjectInfo();
        const validation = VideoWorkflowCompiler.validateAgainstComfyObjectInfo(
          objectInfo,
          bundle.manifest,
          bundle.workflow
        );
        if (!validation.valid) {
          h3WorkflowReady = false;
          if (validation.missingNodes.length) {
            missingComponents.push(`Missing ComfyUI nodes: ${validation.missingNodes.join(', ')}`);
          }
          if (validation.missingSlots.length) {
            missingComponents.push(`Invalid workflow slots: ${validation.missingSlots.join(', ')}`);
          }
          if (validation.missingModels.length) {
            missingComponents.push(`Missing H3 model files: ${validation.missingModels.join(', ')}`);
          }
        }
      } catch (error: any) {
        h3WorkflowReady = false;
        missingComponents.push(`Failed to validate H3 workflow: ${error?.message || error}`);
      }
    }

    return {
      workflow_id: workflowId,
      workflow_family: bundle?.manifest.workflow_family || 'unknown',
      workflow_stability: bundle?.manifest.stability || 'unknown',
      upstream_reference: bundle?.manifest.upstream_reference,
      video_generation_enabled:
        featureEnabled
        && ffmpegOk
        && ffprobeOk
        && comfyOnline
        && h3WorkflowReady
        && missingComponents.length === 0,
      ffmpeg_available: ffmpegOk,
      ffprobe_available: ffprobeOk,
      comfyui_online: comfyOnline,
      h3_workflow_ready: h3WorkflowReady,
      gpu_available: vramStatus.level !== 'unknown',
      gpu_name: vramStatus.gpu_name,
      vram_free_bytes: vramStatus.free_bytes,
      supported_presets: ['preview_480p_5s', 'standard_720p_5s'],
      supported_profiles: ['narrative_clip', 'character_loop'],
      missing_components: [...new Set(missingComponents)]
    };
  }
}
