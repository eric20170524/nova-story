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

    static generateCinematicGridTimelinePrompt(content: string, characterProfiles: string = ""): string {
        let charInstruction = "";
        if (characterProfiles) {
            charInstruction = `
### Character Visual Consistency:
Use the following character definitions to ensure consistent descriptions in 'visual_prompt':
${characterProfiles}
`;
        }
        return `You are a master film director and cinematographer.
Your task is to take a short story beat and expand it into a EXACTLY 9 cinematic shots that cover the same action from different angles and compositions.

CRITICAL: Return EXACTLY 9 shots. Not 8, not 10. EXACTLY 9.

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

    static generateTimeline(content: string, characterProfiles: string = ""): string {
        let charInstruction = "";
        if (characterProfiles) {
            charInstruction = `
### Character Visual Consistency:
Use the following character definitions to ensure consistent descriptions in 'visual_prompt'.
Whenever a character appears, describe key identifying traits (hair, clothing, build) based on these profiles:
${characterProfiles}
`;
        }

        return `You are a master film director and storyboard artist creating cinematic image prompts.
Break down the following story text into a sequence of storyboard shots based on 'Independent Action Units'.

### Core Cinematography & Storyboarding Principles:
1. **Action-Driven Prompts (CRITICAL)**: Every 'visual_prompt' MUST describe a SPECIFIC physical action, gesture, or posture.
2. **Props & Environmental Objects (CRITICAL)**: Always include key props, tools, or handheld items.
3. **Multi-Person Spatial Interaction**: Explicitly describe their relative physical positions.
4. **Visual Variety & Dynamic Framing**: Alternate between Shot Sizes.
${charInstruction}
### Required Output Format (JSON Object):
Return a JSON object with a key 'shots' containing a list of shot objects. Example:
{
  "shots": [
    {
      "id": 1,
      "shot_type": "Full Body Shot",
      "camera_movement": "Static",
      "camera_angle": "Eye-level",
      "visual_prompt": "Detailed English scene description including [Specific Physical Action & Body Language]",
      "audio_prompt": "Background music and sound effects in English",
      "dialogue": "Speaker: Line",
      "duration": 4.0
    }
  ]
}

Story Text:
${content}`;
    }

    static generateSceneCoveragePrompt(scenePrompt: string, dialogue: string = "", characterProfiles: string = ""): string {
        let charInstruction = "";
        if (characterProfiles) {
            charInstruction = `
### Character Visual Consistency:
Use the following character definitions to ensure consistent descriptions in 'visual_prompt':
${characterProfiles}
`;
        }

        return `You are a professional film cinematographer creating a 9-shot coverage package for a SINGLE SCENE beat.
CRITICAL: All 9 candidate shots MUST describe the EXACT SAME moment, action, environment, time of day, weather, lighting, and character state as the input scene. Do NOT advance the story timeline. Do NOT change character clothing or location.

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
- 'visual_prompt': Detailed English description for image generation
- 'audio_prompt': Audio BGM/SFX description in English
- 'dialogue': Keep original dialogue if applicable or null
- 'duration': 3.0

Source Scene Description:
${scenePrompt}
Dialogue: ${dialogue || 'None'}`;
    }

    static extractCharacterProfiles(content: string): string {
        return `Analyze the story text and extract a list of characters. For each character, provide:
- 'name': Name
- 'role': 'main', 'supporting', or 'minor'
- 'description': Brief biography and personality
- 'visual_tags': A dictionary of visual traits for AI image generation. MUST include keys: 'hair', 'eyes', 'skin_tone', 'face_features', 'build', 'clothing', 'accessories' (e.g. glasses, jewelry). Make descriptions specific (e.g. 'scar on left cheek', 'round wire-rimmed glasses').

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
