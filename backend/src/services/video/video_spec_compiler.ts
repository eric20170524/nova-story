import { z } from 'zod';
import {
  VideoPreset,
  VideoSpec,
  VideoGenerationRequest
} from '../../schemas/video';
import { flattenVisualTagMap } from '../reference_generation_policy';
import { containsCjk } from '../english_visual_prompt';
import { LLMService } from '../llm';

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
    dialogue?: string | null;
    narration?: string | null;
    audio_prompt?: string | null;
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
  return { width: 864, height: 480, frames: modelFrames, fps };
};

const compileReferenceInstruction = (request: VideoGenerationRequest, charName: string): string[] => {
  if (request.workflow_id === 'minimax_h3_fl2va_official_12gb') {
    // FL2VA uses keyframe conditioning rather than Ref2VA ordinal tags.
    return [];
  }
  if (request.workflow_id === 'grok_imagine_browser') {
    return [
      'Use the uploaded storyboard keyframe as the first frame; preserve its composition, setting, lighting and object placement.',
      ...(request.character_reference_asset_ids.length
        ? [`The additional uploaded portrait image${request.character_reference_asset_ids.length === 1 ? '' : 's'} depict ${charName}; keep the same face, hairstyle, costume and body proportions throughout this clip.`]
        : []),
    ];
  }

  const instructions: string[] = [];
  const isOfficialRef2va = request.workflow_id === 'minimax_h3_ref2va_official_12gb';
  const isMultiframe = request.workflow_id === 'minimax_h3_multiframe_official_12gb';
  const pictureOffset = (isOfficialRef2va || isMultiframe) ? 2 : 1;
  const pictureTags = (request.character_reference_asset_ids || []).map(
    (_, index) => `<Picture ${index + pictureOffset}>`
  );

  if (isOfficialRef2va || isMultiframe) {
    instructions.push(
      '<Picture 1> is the scene/keyframe reference; preserve its composition, lighting and starting appearance.'
    );
  }

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

  if (isMultiframe && request.guide_frames?.length) {
    for (const guide of request.guide_frames) {
      instructions.push(`Pin the guide reference at frame ${guide.frame_idx} (${(guide.frame_idx / 24).toFixed(2)}s at 24fps); preserve its pose and spatial composition.`);
    }
  } else if (isMultiframe && request.guide_frame_asset_id) {
    const frameIdx = request.guide_frame_idx ?? 60;
    instructions.push(
      `Pin and stabilize the critical action pose, hand gesture, and spatial composition at frame ${frameIdx} (${(frameIdx / 24).toFixed(2)}s at 24fps) matching the guide reference.`
    );
  }
  if (isMultiframe && request.last_frame_asset_id) {
    instructions.push('Anchor the last-frame reference at delivery frame 119 (4.96s at 24fps).');
  }

  return instructions;
};

export interface VideoAppearanceFields {
  name: string;
  hair: string;
  face: string;
  body: string;
  clothing: string;
  accessories: string;
}

export interface VideoMotionMaterials {
  visible_facts: string[];
  appearance: VideoAppearanceFields[];
  still_paragraph: string;
  location: string;
  shot_type: string;
  camera_move: string;
  profile: string;
  primary_action: string;
}

type VideoMotionTranslator = (materials: VideoMotionMaterials) => Promise<string>;
let motionTranslator: VideoMotionTranslator | null = null;

export function setVideoMotionTranslatorForTests(fn: VideoMotionTranslator | null): void {
  motionTranslator = fn;
}

const underNodeTest = () => process.execArgv.includes('--test')
  || process.argv.some(arg => arg.includes('.test.ts') || arg.includes('.test.tsx') || arg.includes('.test.js'));

export async function echoVideoMotion(materials: VideoMotionMaterials): Promise<string> {
  const look = materials.appearance
    .map(person => [person.name, person.hair, person.face, person.body, person.clothing, person.accessories].filter(Boolean).join(', '))
    .filter(Boolean)
    .join('; ');
  const idle = materials.profile === 'character_loop' && !materials.primary_action ? 'Short idle from the appearance fields.' : '';
  const camera = materials.camera_move ? `Camera: ${materials.camera_move}.` : '';
  return [materials.still_paragraph, look, camera, idle].filter(Boolean).join(' ') || 'Motion continues from the still.';
}

const VideoMotionSchema = z.object({ prompt: z.string().min(1) }).strict();

async function composeVideoMotion(materials: VideoMotionMaterials, translator?: VideoMotionTranslator | null): Promise<string> {
  const translate = translator || motionTranslator || (underNodeTest() ? echoVideoMotion : null);
  if (translate) {
    const paragraph = cleanPromptForH3(await translate(materials));
    if (!paragraph) throw new Error('视频运动提示词为空');
    return paragraph;
  }
  const system = [
    'Write one English motion prompt for a 5-second video.',
    'Use the visible facts, appearance fields, the still paragraph, location, shot type, and requested camera move.',
    'The still paragraph is the picture. Do not replace that picture with only primary_action.',
    'Write appearance fields as hair, face, body, clothing, and accessories. Do not write that a costume must remain strictly consistent.',
    'Do not add cloth or hair breeze unless a visible fact says the air moves.',
    'If profile is character_loop and primary_action is empty, write a short idle from the appearance fields.',
    'If primary_action is present, keep that action. Do not replace it with breathing, blinking, or a closed mouth.',
    'English only. Return JSON {"prompt":"<the paragraph>"} only.',
  ].join(' ');
  const result = await LLMService.getLocalProvider().generateStructured(
    JSON.stringify(materials),
    VideoMotionSchema,
    system,
    { temperature: 0.2, maxTokens: 500 },
  );
  const paragraph = cleanPromptForH3(result.prompt);
  if (!paragraph) throw new Error('视频运动提示词为空');
  if (containsCjk(paragraph)) throw new Error('视频运动提示词仍含中文');
  return paragraph;
}

function readShotSpec(raw?: string | null): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function appearanceFromCharacter(character: CompileVideoSpecOptions['character']): VideoAppearanceFields[] {
  if (!character) return [];
  let visualTags = character.visual_tags || {};
  if (typeof visualTags === 'string') {
    try { visualTags = JSON.parse(visualTags); } catch { visualTags = {}; }
  }
  const tags = flattenVisualTagMap(visualTags);
  const text = (value: unknown) => String(value || '').trim();
  return [{
    name: text(character.name),
    hair: text(tags.hair),
    face: text(tags.face || tags.face_features),
    body: text(tags.body || tags.build),
    clothing: text(tags.clothing),
    accessories: text(tags.accessories || tags.distinguishing_mark),
  }];
}

function visibleFacts(spec: Record<string, any>, primaryAction: string): string[] {
  const facts: string[] = [];
  const listed = Array.isArray(spec.visual_facts) ? spec.visual_facts : [];
  for (const fact of listed) {
    const text = typeof fact === 'string' ? fact : fact?.text;
    if (text) facts.push(String(text).trim());
  }
  const states = Array.isArray(spec.continuity_states) ? spec.continuity_states : [];
  for (const state of states) {
    const value = String(state?.value || '').trim();
    if (!value) continue;
    facts.push([state.entity, state.attribute, value].filter(Boolean).join(' '));
  }
  for (const prop of Array.isArray(spec.key_props) ? spec.key_props : []) {
    if (prop) facts.push(String(prop).trim());
  }
  if (primaryAction && !facts.includes(primaryAction)) facts.push(primaryAction);
  return facts.filter(Boolean);
}

export const VideoSpecCompiler = {
  async compile(options: CompileVideoSpecOptions, translator?: VideoMotionTranslator | null): Promise<VideoSpec> {
    const { request, scene, character } = options;
    const isLoop = request.profile === 'character_loop';
    const isFl2va = request.workflow_id === 'minimax_h3_fl2va_official_12gb';
    const dimensions = resolvePresetDimensions(request.preset);
    const spec = readShotSpec(scene.shot_spec);
    const primaryAction = String(spec.primary_action || '').trim();
    const appearance = appearanceFromCharacter(character);
    const look = appearance
      .map(person => [person.name, person.hair, person.face, person.body, person.clothing, person.accessories].filter(Boolean).join(', '))
      .filter(Boolean)
      .join('; ');
    const subjectIdentity = look || String(character?.name || '').trim();
    const requestedMove = String(scene.camera_movement || '').trim();
    const cameraMove = requestedMove && requestedMove !== 'static' && requestedMove !== 'none' ? requestedMove : '';
    const cameraMotion = cameraMove ? `Smooth camera movement: ${cameraMove}.` : 'Locked camera, static frame with no camera movement.';
    const materials: VideoMotionMaterials = {
      visible_facts: visibleFacts(spec, primaryAction),
      appearance,
      still_paragraph: cleanPromptForH3(scene.visual_prompt),
      location: String(spec.location || '').trim(),
      shot_type: String(spec.shot_type || scene.shot_type || '').trim(),
      camera_move: cameraMove,
      profile: request.profile,
      primary_action: primaryAction,
    };
    const motion = await composeVideoMotion(materials, translator);
    const charName = appearance[0]?.name || character?.name || 'Character';
    const temporalArc = primaryAction
      ? 'Narrative motion follows the composed still for 5 seconds.'
      : 'Idle motion from the appearance fields for 5 seconds.';
    let negativeMotion = 'deformed anatomy, floating limbs, extra fingers, identity shift, sudden lighting flicker, face distortion, blurry artifacts';
    if (isLoop && !primaryAction) negativeMotion += ', camera drift, speech, mouth opening, wide hand gestures';

    const positiveParts: string[] = [
      ...compileReferenceInstruction(request, charName)
    ];
    if (isLoop) {
      if (isFl2va) {
        positiveParts.push('Locked camera. Treat the first and last keyframes as hard visual boundary anchors.');
      } else if (request.workflow_id === 'minimax_h3_multiframe_official_12gb') {
        positiveParts.push('Locked camera. Anchor key action frames cleanly and return smoothly to the boundary.');
      } else {
        positiveParts.push('Locked camera. Preserve the exact motion timing and body pose from <Video 1>.');
      }
    }
    positiveParts.push(motion);
    if (!isLoop && request.workflow_id === 'grok_imagine_browser') {
      if (scene.dialogue?.trim()) positiveParts.push(`Spoken dialogue in Mandarin Chinese, verbatim: ${JSON.stringify(scene.dialogue.trim())}. Keep speech synchronized with the speaking character.`);
      if (scene.narration?.trim()) positiveParts.push(`Mandarin Chinese voiceover, verbatim: ${JSON.stringify(scene.narration.trim())}.`);
      if (!scene.dialogue?.trim() && !scene.narration?.trim()) positiveParts.push('Natural ambient sound only; no invented dialogue or narration.');
    }
    if (!isLoop && scene.audio_prompt?.trim()) positiveParts.push(`Sound: ${scene.audio_prompt.trim()}.`);
    if (!isLoop && request.workflow_id !== 'grok_imagine_browser') positiveParts.push('Natural ambient sound and requested sound effects; no invented dialogue or narration.');
    if (request.prompt_override) positiveParts.push(cleanPromptForH3(request.prompt_override));

    const negativeParts: string[] = [negativeMotion];
    if (scene.negative_prompt) {
      const cleanedNeg = cleanPromptForH3(scene.negative_prompt);
      if (cleanedNeg) negativeParts.push(cleanedNeg);
    }

    return {
      profile: request.profile,
      preset: request.preset,
      workflow_id: request.workflow_id,
      subject_identity: subjectIdentity,
      primary_action: primaryAction,
      camera_motion: cameraMotion,
      environment_motion: '',
      temporal_arc: temporalArc,
      negative_motion: negativeMotion,
      output_contract: {
        width: dimensions.width,
        height: dimensions.height,
        frames: dimensions.frames,
        fps: dimensions.fps,
        is_loop: isLoop
      },
      positive_prompt: positiveParts.filter(Boolean).join(' '),
      negative_prompt: negativeParts.join(', ')
    };
  }
};
