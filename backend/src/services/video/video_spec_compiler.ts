import {
  VideoPreset,
  VideoSpec,
  VideoGenerationRequest
} from '../../schemas/video';

export interface CompileVideoSpecOptions {
  request: VideoGenerationRequest;
  scene: {
    id: number | string;
    visual_prompt?: string | null;
    negative_prompt?: string | null;
    shot_type?: string | null;
    camera_movement?: string | null;
    camera_angle?: string | null;
    shot_spec?: string | null;
  };
  character?: {
    id?: number;
    name?: string;
    description?: string | null;
    visual_tags?: any;
  } | null;
}

const PONY_SCORE_REGEX = /score_\d+(_up)?|masterpiece|best quality|high quality|source_anime|very aesthetic|absurdres/gi;

export const cleanPromptForH3 = (rawPrompt?: string | null): string => {
  if (!rawPrompt) return '';
  return rawPrompt
    .replace(PONY_SCORE_REGEX, '')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^,\s*|,\s*$/g, '');
};

/**
 * MiniMax H3 native video frames must lie on the 17k+5 grid.
 * ComfyUI's official H3 node uses the same rule; 5 seconds at 24 fps
 * therefore requests 124 model frames, then delivery post-processing trims
 * to the product contract (120 frames / 5.0 seconds).
 */
export const alignH3FrameCount = (requestedFrames: number): number => {
  let frames = Math.max(5, Math.ceil(requestedFrames));
  while (frames % 17 !== 5) frames += 1;
  return frames;
};

export const resolvePresetDimensions = (preset: VideoPreset) => {
  const fps = 24;
  const modelFrames = alignH3FrameCount(5 * fps);
  if (preset === 'standard_720p_5s') {
    return { width: 1280, height: 720, frames: modelFrames, fps };
  }
  // default preview_480p_5s
  return { width: 864, height: 480, frames: modelFrames, fps };
};

const compileReferenceInstruction = (request: VideoGenerationRequest, charName: string): string[] => {
  const instructions: string[] = [];
  const pictureTags = (request.character_reference_asset_ids || []).map((_, index) => `<Picture ${index + 1}>`);

  if (pictureTags.length > 0) {
    instructions.push(
      `${pictureTags.join(', ')} ${pictureTags.length === 1 ? 'is' : 'are'} identity reference${pictureTags.length === 1 ? '' : 's'} for the same character (${charName}); preserve face, hairstyle, costume and material details from these pictures.`
    );
  }

  if (request.motion_reference_asset_id) {
    instructions.push(
      '<Video 1> is the motion-timing and body-pose reference only; preserve its action timing and pose trajectory without copying identity or appearance from the motion source.'
    );
  }

  return instructions;
};

export const VideoSpecCompiler = {
  compile(options: CompileVideoSpecOptions): VideoSpec {
    const { request, scene, character } = options;
    const isLoop = request.profile === 'character_loop';
    const dimensions = resolvePresetDimensions(request.preset);

    // Extract subject identity
    const charName = character?.name || 'Character';
    const charDesc = character?.description ? cleanPromptForH3(character.description) : '';
    const subjectIdentity = charDesc
      ? `The same character (${charName}), ${charDesc}, face, hairstyle, costume, and lighting remain strictly consistent.`
      : `The same character (${charName}), consistent facial features, costume and lighting.`;

    // Camera motion
    let cameraMotion = 'Locked camera, static frame with no camera movement.';
    if (!isLoop && scene.camera_movement && scene.camera_movement !== 'static' && scene.camera_movement !== 'none') {
      cameraMotion = `Smooth camera movement: ${scene.camera_movement}.`;
    }

    // Action and shot spec
    let primaryAction = cleanPromptForH3(scene.visual_prompt) || 'Subtle character motion, standing still with natural breathing.';
    if (scene.shot_spec) {
      try {
        const parsedSpec = JSON.parse(scene.shot_spec);
        if (parsedSpec.primary_action) {
          primaryAction = parsedSpec.primary_action;
        }
      } catch {
        // use raw visual_prompt fallback
      }
    }

    const environmentMotion = 'Subtle natural cloth and hair breeze.';
    const temporalArc = isLoop
      ? 'Looping cycle: starts at neutral keyframe K, progresses through subtle natural motion, and returns smoothly to the exact same starting pose and near-zero velocity at the boundary.'
      : 'Narrative arc: natural progression of the primary action across 5 seconds.';

    let negativeMotion = 'deformed anatomy, floating limbs, extra fingers, identity shift, sudden lighting flicker, face distortion, blurry artifacts';
    if (isLoop) {
      negativeMotion += ', camera drift, speech, mouth opening, wide hand gestures';
    }

    // Compose Positive Prompt. H3 Ref2VA resolves references by ordinal tags,
    // so make the binding explicit instead of relying on vague "reference" prose.
    const positiveParts: string[] = [
      ...compileReferenceInstruction(request, charName)
    ];
    if (isLoop) {
      positiveParts.push('Locked camera. Preserve the exact motion timing and body pose from <Video 1>.');
    } else {
      positiveParts.push(cameraMotion);
    }
    positiveParts.push(subjectIdentity);
    if (isLoop) {
      positiveParts.push('Natural breathing, one gentle blink, subtle head-and-shoulder micro-motion. Mouth remains gently closed.');
      positiveParts.push('End at the exact same pose and near-zero velocity as the first frame.');
    } else {
      positiveParts.push(`Action: ${primaryAction}.`);
    }
    if (request.prompt_override) {
      positiveParts.push(cleanPromptForH3(request.prompt_override));
    }
    positiveParts.push(environmentMotion);

    // Compose Negative Prompt
    const negativeParts: string[] = [negativeMotion];
    if (scene.negative_prompt) {
      const cleanedNeg = cleanPromptForH3(scene.negative_prompt);
      if (cleanedNeg) negativeParts.push(cleanedNeg);
    }

    return {
      profile: request.profile,
      preset: request.preset,
      subject_identity: subjectIdentity,
      primary_action: isLoop ? 'Natural subtle breathing and posture stabilization' : primaryAction,
      camera_motion: cameraMotion,
      environment_motion: environmentMotion,
      temporal_arc: temporalArc,
      negative_motion: negativeMotion,
      output_contract: {
        width: dimensions.width,
        height: dimensions.height,
        frames: dimensions.frames,
        fps: dimensions.fps,
        is_loop: isLoop
      },
      positive_prompt: positiveParts.join(' '),
      negative_prompt: negativeParts.join(', ')
    };
  }
};
