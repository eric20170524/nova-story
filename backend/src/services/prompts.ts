import { buildTimelineVisualPromptPolicy } from './image_generation_policy';

/** Shared rule: appearance comes only from visual_tags lock, never invented species. */
export const CHARACTER_VISUAL_LOCK_RULES = `When a character is visible, copy their Visual Lock / Visual Tags string into visual_prompt verbatim.
Do NOT invent species or body-plan tags absent from that lock (never invent kitten, 1girl, 1boy, wolf, fox, dog, human, girl, or housecat paraphrases).
If Visual Lock is empty or missing, omit appearance tags rather than guessing hair/clothing/species.`;

const buildCharacterLockInstruction = (characterProfiles: string): string => {
  if (!characterProfiles?.trim()) return '';
  return `
### Character Visual Consistency (lock only):
${CHARACTER_VISUAL_LOCK_RULES}
${characterProfiles}
`;
};

export class Prompts {
    static buildCinematicGridImagePrompt(scenePrompt: string): string {
        const normalizedPrompt = String(scenePrompt || '').replace(/\s+/g, ' ').trim();
        const positivePrompt = normalizedPrompt.split(' --no ', 1)[0]?.trim() || '';
        if (!positivePrompt) {
            throw new Error('Scene prompt is required for cinematic grid generation');
        }

        return [
            'masterpiece, professional cinematic storyboard sheet',
            'exactly 3 rows and exactly 3 columns',
            'exactly nine equal panels, clean dark panel dividers, no captions, no labels',
            'no panel numbers, no typography, no extra panels',
            `Shared scene for every panel: ${positivePrompt}`,
            'Keep the same characters, facial features, hairstyle, clothing, injuries, props, weapons, environment, weather, time of day, lighting direction, and color palette consistent across all nine panels',
            'Panel 1 top-left: extreme long establishing shot, full environment and spatial context',
            'Panel 2 top-center: long shot, complete character silhouettes and body language',
            'Panel 3 top-right: medium long shot, knees-up composition and character relationships',
            'Panel 4 middle-left: medium shot, the central action clearly readable',
            'Panel 5 center: medium close-up, strongest emotional beat and visual focus',
            'Panel 6 middle-right: close-up, precise facial expression and story tension',
            'Panel 7 bottom-left: extreme close-up of the most important eye, hand, weapon, or symbolic detail',
            'Panel 8 bottom-center: dramatic low-angle view that preserves the same action and environment',
            'Panel 9 bottom-right: high-angle overview showing geography, consequence, and atmosphere',
            'Each panel depicts the same story beat from a different camera position; coherent anatomy, clear subjects, cinematic composition, detailed background, controlled depth of field'
        ].join('. ') + '.';
    }

    static generateDraft(instructions: string, context: string = ''): string {
        return `Context: ${context}\n\nInstructions: ${instructions}\n\nWrite a creative draft based on the above.`;
    }

    static analyzeContent(content: string): string {
        return `Analyze the following text and extract new characters (entities) and key plot updates. Return JSON with keys 'new_entities' (list) and 'updates' (list).\n\nText: ${content}`;
    }

    static generateCinematicGridTimelinePrompt(
        content: string,
        characterProfiles: string = '',
        nsfwEnabled: boolean = false
    ): string {
        const charInstruction = buildCharacterLockInstruction(characterProfiles);
        return `You are a master film director and cinematographer.
Your task is to take a short story beat and expand it into EXACTLY 9 cinematic shots that cover the same action from different angles and compositions.

CRITICAL: Return EXACTLY 9 shots. Not 8, not 10. EXACTLY 9.

### Language Rules:
- 'dialogue': Can be in Chinese or English matching the source story text so it can serve directly as comic subtitles.
- 'narration': A concise comic caption in the source language. Preserve first-person voice when present; summarize only the story information visible or emotionally necessary for this shot.
- 'visual_prompt', 'audio_prompt': MUST remain in detailed English for image generation models.
${buildTimelineVisualPromptPolicy(nsfwEnabled)}
### 9-Shot Grid Structure:
Slot 1: Extreme Long Shot, Eye-level
Slot 2: Long Shot, Eye-level
Slot 3: Medium Long Shot, Pan, Eye-level
Slot 4: Medium Shot, Static, Eye-level
Slot 5: Medium Close-Up, Zoom In, Eye-level
Slot 6: Close-Up, Static, Eye-level
Slot 7: Extreme Close-Up, Static, Eye-level
Slot 8: Medium Shot, Static, Low Angle
Slot 9: Medium Shot, Static, High Angle
${charInstruction}
Story Beat:
${content}`;
    }

    static generateTimeline(
        content: string,
        characterProfiles: string = '',
        nsfwEnabled: boolean = false
    ): string {
        const charInstruction = buildCharacterLockInstruction(characterProfiles);

        return `You are a storyboard beat planner. Break the story into Independent Action Units and fill a Shot Contract for each beat.
The server will compile Pony / SDXL tags via compilePonyPrompt — you must NOT author the final visual_prompt prose.

### Contract rules:
1. Every shot MUST include location + primary_action. location = paintable nouns only (no mood words). primary_action = one visible verb.
2. key_props: at most 2 concrete props. Omit rather than invent.
3. shot_intent: establish | wide-action | medium-action | insert | reaction | overhead-map | payoff. Map shot_type accordingly (Insert Shot → insert, Establishing → establish, Wide/Long → wide-action, etc.).
4. subject_scale: absent | small-15-20 | medium-20-40 | dominant. Wide/establish default small-15-20 or absent; insert often absent or paw-only via primary_subject.
5. primary_subject = focus character Name from Character Visual Lock (not a free-form species essay). visible_subjects = all on-screen character Names for this beat.
6. uniqueness_key = location + action + primary prop; adjacent shots must differ.
7. Set visual_prompt to "" always. Never write a Detailed English scene description.
8. Comic text: preserve spoken words in dialogue; write concise narration in the source language when there is no dialogue (Chinese ~12-35 chars). Never invent plot.
9. Sounds/smells/psychology go in audio_prompt or narration — not in location/action/props.
${buildTimelineVisualPromptPolicy(nsfwEnabled)}
${charInstruction}
### Required Output Format (JSON Object):
{
  "shots": [
    {
      "id": 1,
      "shot_type": "Wide Shot",
      "shot_intent": "wide-action",
      "camera_movement": "Static",
      "camera_angle": "Eye-level",
      "location": "european arcade corridor",
      "primary_action": "character walks past a dark metal lamp post",
      "primary_subject": "<Name from Character Visual Lock>",
      "visible_subjects": ["<Name from Character Visual Lock>"],
      "key_props": ["dark metal lamp post"],
      "subject_scale": "small-15-20",
      "uniqueness_key": "arcade corridor | walks past lamp | dark metal lamp post",
      "must_not": [],
      "visual_prompt": "",
      "audio_prompt": "quiet hallway ambience",
      "dialogue": null,
      "narration": "Concise source-language comic caption or null",
      "duration": 4.0
    }
  ]
}

Story Text:
${content}`;
    }

    static generateSceneCoveragePrompt(
        scenePrompt: string,
        dialogue: string = '',
        characterProfiles: string = '',
        nsfwEnabled: boolean = false
    ): string {
        const charInstruction = buildCharacterLockInstruction(characterProfiles);

        return `You are a professional film cinematographer creating a 9-shot coverage package for a SINGLE SCENE beat.
CRITICAL: All 9 candidate shots MUST describe the EXACT SAME moment, action, environment, time of day, weather, lighting, and character state as the input scene. Do NOT advance the story timeline. Do NOT change character clothing or location.
${buildTimelineVisualPromptPolicy(nsfwEnabled)}
### Mandatory 9-Shot Coverage Slots:
Slot 1: Extreme Long Shot (ELS), Eye-level. Establishing environment and subject spatial context.
Slot 2: Long Shot (LS), Eye-level. Full body subject silhouette and posture.
Slot 3: Medium Long Shot (MLS), Eye-level. Knees-up framing showing character relationships.
Slot 4: Medium Shot (MS), Eye-level. Waist-up framing capturing main action beat.
Slot 5: Medium Close-Up (MCU), Eye-level. Chest-up framing capturing emotion and reaction.
Slot 6: Close-Up (CU), Eye-level. Tight face shot showing emotional tension and clarity.
Slot 7: Extreme Close-Up (ECU), Eye-level. Macro detail of eye, hand, weapon, or key object.
Slot 8: Medium Shot (MS), Low Angle. Dramatic camera looking up from below.
Slot 9: Long Shot (LS), High Angle. Bird's eye overview looking down from above.
${charInstruction}
### Output Format (JSON Object):
Return a JSON object with a key 'shots' containing a list of EXACTLY 9 objects matching the 9 slots above with fields:
- 'id': Slot number (1-9)
- 'shot_type': Shot size
- 'camera_angle': Camera angle
- 'camera_movement': Movement choice
- 'location': concrete paintable place (required)
- 'primary_action': one visible verb/action (required)
- 'shot_intent': establish | wide-action | medium-action | insert | reaction | overhead-map | payoff
- 'key_props': up to 2 prop strings
- 'visual_prompt': optional; may be "" (server compiles from contract)
- 'audio_prompt': Audio BGM/SFX description in English
- 'dialogue': Keep original dialogue (Chinese or English) if applicable or null
- 'duration': 3.0

Source Scene Description:
${scenePrompt}
Dialogue: ${dialogue || 'None'}`;
    }

    static extractCharacterProfiles(content: string, nsfwEnabled: boolean = false): string {
        const tagLang = nsfwEnabled
            ? `Write ALL visual_tags values in concise English image-model tags (Danbooru-style when possible). Characters are adults. Include distinctive costume colors and body type for consistency.`
            : `Write ALL visual_tags values in concise English image-model tags (Danbooru-style when possible). Keep designs safe-for-work and fully clothed. Include distinctive costume colors and body type for consistency.`;

        return `Analyze the story text and extract a list of characters. For each character, provide:
- 'name': Name
- 'role': 'main', 'supporting', or 'minor'
- 'description': Brief biography and personality
- 'visual_tags': A dictionary of visual traits for AI image generation. MUST include keys: 'hair', 'eyes', 'skin_tone', 'face_features', 'build', 'clothing', 'accessories' (e.g. glasses, jewelry). Make descriptions specific (e.g. 'scar on left cheek', 'round wire-rimmed glasses').
${tagLang}

Return the result as a JSON object with a key 'profiles' containing the list of character objects.

Text: ${content}`;
    }

    static analyzeCharacterEvolution(characterJson: string, newText: string): string {
        return `You are a Character Consistency Manager for a long-running series.
Compare the existing character data with their appearance in the NEW CHAPTER TEXT.

### Existing Character Data:
${characterJson}

### New Chapter Text:
${newText}

Determine whether the appearance requires a new variant, keeps the current variant, or is only a scene modifier.
Return JSON:
{
  "action": "new_variant" | "keep_current" | "scene_modifier",
  "reason": "Explanation",
  "new_variant": { "name": "...", "tags": "..." },
  "modifier_tags": "..."
}`;
    }

    static generateStoryboardGridPrompt(storyText: string): string {
        return `STORY-TO-STORYBOARD META-PROMPT

IMPORTANT: Do not create the image, create the detailed prompt for the image.

When the user provides a short story synopsis, create a full 3x3 cinematic storyboard grid prompt with 9 distinct shots of the same subjects in the same environment.

Input Story:
${storyText}`;
    }
}
