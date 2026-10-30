import { z } from 'zod';
import { continuityVisualFact, type ContinuityVisualState } from '../continuity_visual_state';
import { factStateLabel } from '../../schemas/storyboard_facts';
import { appendSpeechFacts } from '../fact_state';
import {
  VideoPreset,
  VideoSpec,
  VideoGenerationRequest
} from '../../schemas/video';
import { flattenVisualTagMap } from '../reference_generation_policy';
import { assertEnglishFidelity, containsCjk, FIDELITY_RULE_VERSION } from '../english_visual_prompt';
import { LLMService } from '../llm';
import { InferenceCache, isNodeTest, textModelFingerprint } from '../inference_cache';
import { withLocalTextInference } from '../local_text_inference';

export const VIDEO_PROMPT_RULE_VERSION = `video-motion-v4:${FIDELITY_RULE_VERSION}`;
const motionCache = new InferenceCache<string>('video-motion');

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
  style?: unknown;
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
  const durationSec = preset.endsWith('_8s') ? 8 : 5;
  const delivery_frames = durationSec * fps;
  const modelFrames = alignH3FrameCount(delivery_frames);
  if (preset.startsWith('standard_720p_')) {
    return { width: 1280, height: 720, frames: modelFrames, delivery_frames, fps };
  }
  return { width: 864, height: 480, frames: modelFrames, delivery_frames, fps };
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
    const { delivery_frames, fps } = resolvePresetDimensions(request.preset);
    const lastFrameIdx = delivery_frames - 1;
    const endSeconds = (lastFrameIdx / fps).toFixed(2);
    instructions.push(`Anchor the last-frame reference at delivery frame ${lastFrameIdx} (${endSeconds}s at ${fps}fps).`);
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
  camera_angle?: string;
  continuity_states?: unknown[];
  shot_intent?: string;
  subject_scale?: string;
  style?: unknown;
}

type VideoMotionTranslator = (materials: VideoMotionMaterials) => Promise<string>;
let motionTranslator: VideoMotionTranslator | null = null;

export function setVideoMotionTranslatorForTests(fn: VideoMotionTranslator | null): void {
  motionTranslator = fn;
  motionCache.clearMemory();
}

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

/** The still already names the place. A second location label must not contradict that picture. */
export function motionFidelitySource(facts: readonly string[], location: string, still: string, appearanceLines: readonly string[]): string {
  const parts = [...facts];
  if (!still.trim() && location.trim()) parts.push(location.trim());
  parts.push(...appearanceLines);
  return parts.filter(Boolean).join('，');
}

async function composeVideoMotion(materials: VideoMotionMaterials, translator?: VideoMotionTranslator | null): Promise<string> {
  const translate = translator || motionTranslator || (isNodeTest() ? echoVideoMotion : null);
  const system = [
    'Write one English motion prompt for a 5-second video.',
    'Use the visible facts, appearance fields, the still paragraph, location, shot type, and requested camera move.',
    'Preserve continuity_states and use camera_angle, shot_intent, subject_scale and style for the framing and lighting.',
    'The still paragraph is the picture. Do not replace that picture with only primary_action. Keep the still\'s place name.',
    'A fact labeled 姿势 is posture. Appearance body is build only. When a posture fact is present, describe that posture and do not turn build wording into standing, sitting, or kneeling.',
    'Speech facts are spoken. Do not paint them as clothing, a held object, or only a facial expression.',
    'Write appearance fields as hair, face, body, clothing, and accessories. Do not write that a costume must remain strictly consistent.',
    'Do not add cloth or hair breeze unless a visible fact says the air moves.',
    'If profile is character_loop and primary_action is empty, write a short idle from the appearance fields.',
    'If primary_action is present, keep that action. Do not replace it with breathing, blinking, or a closed mouth.',
    'English only. Return JSON {"prompt":"<the paragraph>"} only.',
  ].join(' ');
  const hasShotWardrobe = materials.visible_facts.some(f => /衣|袍|裙|衫|裳|服|解|褪|披|裸/.test(f));
  const stillLower = String(materials.still_paragraph || '').toLowerCase();
  const effectiveMaterials: VideoMotionMaterials = !translate && hasShotWardrobe
    ? {
      ...materials,
      appearance: materials.appearance.map(p => ({ ...p, clothing: '', accessories: '' })),
    }
    : materials;
  const generate = async () => {
    const result = await LLMService.getLocalProvider().generateStructured(
      JSON.stringify(effectiveMaterials),
      VideoMotionSchema,
      system,
      { temperature: 0.2, maxTokens: 500 },
    );
    return result.prompt;
  };
  let paragraph = cleanPromptForH3(translate ? await translate(materials) : await generate());
  if (!paragraph) throw new Error('视频运动提示词为空');
  if (containsCjk(paragraph) && translate !== echoVideoMotion) throw new Error('视频运动提示词仍含中文');
  if (!translate) {
    const appearanceLines = effectiveMaterials.appearance.flatMap(person => ([['hair', '头发'], ['face', '五官'], ['body', '体型'], ['clothing', '服装'], ['accessories', '配饰']] as const).map(([field, label]) => {
      const key = field as keyof VideoAppearanceFields;
      const val = person[key];
      if (!val) return '';
      if ((field === 'clothing' || field === 'accessories') && (hasShotWardrobe || (stillLower && !val.toLowerCase().split(/[,\s_()]+/).filter(w => w.length >= 4).some(w => stillLower.includes(w))))) return '';
      return `${person.name}的${label}：${val}`;
    }));
    const source = motionFidelitySource(effectiveMaterials.visible_facts, effectiveMaterials.location, effectiveMaterials.still_paragraph, appearanceLines);
    try {
      await assertEnglishFidelity(source, paragraph);
    } catch (firstError) {
      const repairSystem = `${system} The previous output missed or contradicted some visual facts: ${firstError instanceof Error ? firstError.message : String(firstError)}. Ensure all stated visible actions, subjects, character appearance and accessories are fully preserved.`;
      const repaired = await LLMService.getLocalProvider().generateStructured(
        JSON.stringify(effectiveMaterials),
        VideoMotionSchema,
        repairSystem,
        { temperature: 0.1, maxTokens: 500 },
      );
      paragraph = cleanPromptForH3(repaired.prompt);
      if (!paragraph || containsCjk(paragraph)) throw firstError;
      await assertEnglishFidelity(source, paragraph);
    }
  }
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

export function continuityPromptLines(states: unknown[]): string[] {
  return states.flatMap(state => {
    if (!state || typeof state !== 'object') return [];
    const row = state as Record<string, unknown>;
    const attribute = String(row.attribute || row.attribute_id || '');
    if (row.entity_id && attribute && Object.hasOwn(row, 'canonical_value')) {
      return [continuityVisualFact(row as ContinuityVisualState)];
    }
    if (attribute === 'holding_hand') {
      const canonical = row.canonical_value ?? row.value;
      return [continuityVisualFact({
        entity: String(row.entity || row.entity_id || 'object'),
        entity_id: String(row.entity_id || row.entity || 'object'),
        entity_kind: (row.entity_kind as ContinuityVisualState['entity_kind']) || 'prop',
        attribute: 'holding_hand',
        value: String(canonical ?? ''),
        canonical_value: canonical,
        fact_id: String(row.fact_id || 'video:holding_hand'),
      })];
    }
    const value = String(row.value || '').trim();
    if (!value) return [];
    if (attribute === 'holding' && row.entity && value.includes(String(row.entity))) return [];
    return [`${row.entity} ${factStateLabel(attribute)}：${value}`];
  }).filter(Boolean);
}

function extractEntityPoseFromFact(text: string, entity: string): string | null {
  if (!text || !entity) return null;
  const entityIdx = text.indexOf(entity);
  if (entityIdx === -1) return null;
  const windowText = text.slice(entityIdx + entity.length, entityIdx + entity.length + 20);
  const standMatch = windowText.match(/立于|立在|屹立|矗立|站立|站着|站起|起身|挺立/);
  if (standMatch) return standMatch[0];
  const sitMatch = windowText.match(/端坐|盘坐|静坐|坐在|坐于|坐着|落座/);
  if (sitMatch) return sitMatch[0];
  const walkMatch = windowText.match(/行走|前行|走动|漫步|穿梭|奔跑|踱步/);
  if (walkMatch) return walkMatch[0];
  const lieMatch = windowText.match(/卧于|躺在|平躺|伏在|趴在|斜倚/);
  if (lieMatch) return lieMatch[0];
  const kneelMatch = windowText.match(/下跪|跪坐|跪倒|跪在/);
  if (kneelMatch) return kneelMatch[0];
  return null;
}

function poseConflictsWithNew(storedPose: string, newPose: string): boolean {
  const isSit = (s: string) => /坐/.test(s);
  const isStand = (s: string) => /立|站/.test(s);
  const isMove = (s: string) => /走|行|奔|跑|跃/.test(s);
  const isLie = (s: string) => /卧|躺/.test(s);
  if (isSit(storedPose) && (isStand(newPose) || isMove(newPose))) return true;
  if (isStand(storedPose) && (isSit(newPose) || isLie(newPose))) return true;
  if (isMove(storedPose) && (isSit(newPose) || isLie(newPose))) return true;
  return false;
}

export function filterConflictingContinuityStates(states: unknown[], facts: string[]): unknown[] {
  if (!Array.isArray(states) || !states.length || !facts.length) return states;
  const allFactsText = facts.join('，');
  return states.filter(state => {
    if (!state || typeof state !== 'object') return true;
    const row = state as Record<string, unknown>;
    const attribute = String(row.attribute || row.attribute_id || '');
    if (attribute !== 'pose') return true;
    const entity = String(row.entity || '').trim();
    const storedPose = String(row.value || row.canonical_value || '').trim();
    if (!entity || !storedPose) return true;
    const newPose = extractEntityPoseFromFact(allFactsText, entity);
    if (newPose && poseConflictsWithNew(storedPose, newPose)) {
      return false;
    }
    return true;
  });
}

export function visibleFacts(spec: Record<string, any>, primaryAction: string): string[] {
  const facts: string[] = [];
  const listed = Array.isArray(spec.visual_facts) ? spec.visual_facts : [];
  for (const fact of listed) {
    const text = typeof fact === 'string' ? fact : fact?.text;
    if (text) facts.push(String(text).trim());
  }
  const rawStates = Array.isArray(spec.continuity_states) ? spec.continuity_states : [];
  const filteredStates = filterConflictingContinuityStates(rawStates, facts);
  facts.push(...continuityPromptLines(filteredStates));
  for (const prop of Array.isArray(spec.key_props) ? spec.key_props : []) {
    if (prop) facts.push(String(prop).trim());
  }
  if (primaryAction && !facts.includes(primaryAction)) facts.push(primaryAction);
  return appendSpeechFacts(facts.filter(Boolean), spec.speech_facts);
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
    const cameraMove = requestedMove && !['static', 'none'].includes(requestedMove.toLowerCase()) ? requestedMove : '';
    const cameraMotion = cameraMove ? `Smooth camera movement: ${cameraMove}.` : 'Locked camera, static frame with no camera movement.';
    const factTexts = Array.isArray(spec.visual_facts) ? spec.visual_facts.map((f: any) => typeof f === 'string' ? f : f?.text || '').filter(Boolean) : [];
    const filteredContinuityStates = filterConflictingContinuityStates(
      Array.isArray(spec.continuity_states) ? spec.continuity_states : [],
      factTexts
    );
    const materials: VideoMotionMaterials = {
      visible_facts: visibleFacts(spec, primaryAction),
      appearance,
      still_paragraph: cleanPromptForH3(scene.visual_prompt || spec.english_visual_prompt),
      location: String(spec.location || '').trim(),
      shot_type: String(spec.shot_type || scene.shot_type || '').trim(),
      camera_move: cameraMove,
      profile: request.profile,
      primary_action: primaryAction,
      camera_angle: String(scene.camera_angle || spec.camera_angle || '').trim(),
      continuity_states: continuityPromptLines(filteredContinuityStates),
      shot_intent: String(spec.shot_intent || ''),
      subject_scale: String(spec.subject_scale || ''),
      style: options.style || null,
    };
    const compose = () => composeVideoMotion(materials, translator);
    const motion = await motionCache.run({ materials, model: textModelFingerprint() }, VIDEO_PROMPT_RULE_VERSION,
      () => translator || motionTranslator || isNodeTest() ? compose() : withLocalTextInference(compose),
      { variant: request.inference_variant });
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
