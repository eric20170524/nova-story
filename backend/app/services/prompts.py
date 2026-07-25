class Prompts:
    @staticmethod
    def build_cinematic_grid_image_prompt(scene_prompt: str) -> str:
        """
        Build the final 3x3 image prompt locally.

        This is deliberately deterministic: asset generation must not depend on
        an LLM/Ollama round-trip before ComfyUI can start.
        """
        normalized_prompt = " ".join(str(scene_prompt or "").split())
        positive_prompt = normalized_prompt.split(" --no ", 1)[0].strip()
        if not positive_prompt:
            raise ValueError("Scene prompt is required for cinematic grid generation")

        return (
            "masterpiece, professional cinematic storyboard sheet, "
            "exactly 3 rows and exactly 3 columns, "
            "exactly nine equal panels, clean dark panel dividers, no captions, no labels, "
            "no panel numbers, no typography, no extra panels. "
            f"Shared scene for every panel: {positive_prompt}. "
            "Keep the same characters, facial features, hairstyle, clothing, injuries, props, "
            "weapons, environment, weather, time of day, lighting direction, and color palette "
            "consistent across all nine panels. "
            "Panel 1 top-left: extreme long establishing shot, full environment and spatial context. "
            "Panel 2 top-center: long shot, complete character silhouettes and body language. "
            "Panel 3 top-right: medium long shot, knees-up composition and character relationships. "
            "Panel 4 middle-left: medium shot, the central action clearly readable. "
            "Panel 5 center: medium close-up, strongest emotional beat and visual focus. "
            "Panel 6 middle-right: close-up, precise facial expression and story tension. "
            "Panel 7 bottom-left: extreme close-up of the most important eye, hand, weapon, or symbolic detail. "
            "Panel 8 bottom-center: dramatic low-angle view that preserves the same action and environment. "
            "Panel 9 bottom-right: high-angle overview showing geography, consequence, and atmosphere. "
            "Each panel depicts the same story beat from a different camera position; coherent anatomy, "
            "clear subjects, cinematic composition, detailed background, controlled depth of field."
        )

    @staticmethod
    def generate_draft(instructions: str, context: str) -> str:
        return f"Context: {context}\n\nInstructions: {instructions}\n\nWrite a creative draft based on the above."

    @staticmethod
    def analyze_content(content: str) -> str:
        return f"Analyze the following text and extract new characters (entities) and key plot updates. Return JSON with keys 'new_entities' (list) and 'updates' (list).\n\nText: {content}"

    @staticmethod
    def generate_timeline(content: str, character_profiles: str = "") -> str:
        char_instruction = ""
        if character_profiles:
            char_instruction = (
                "\n### Character Visual Consistency:\n"
                "Use the following character definitions to ensure consistent descriptions in 'visual_prompt'. "
                "Whenever a character appears, describe key identifying traits (hair, clothing, build) based on these profiles:\n"
                f"{character_profiles}\n"
            )

        return (
            "You are a master film director and storyboard artist creating cinematic image prompts.\n"
            "Break down the following story text into a sequence of storyboard shots based on 'Independent Action Units'.\n"
            "\n"
            "### Core Cinematography & Storyboarding Principles:\n"
            "1. **Action-Driven Prompts (CRITICAL)**: Every 'visual_prompt' MUST describe a SPECIFIC physical action, gesture, or posture (e.g., 'gripping a glass tightly', 'standing up abruptly from the leather chair', 'reaching out to touch a holographic interface', 'leaning over the balcony'). NEVER produce static portrait-only descriptions.\n"
            "2. **Props & Environmental Objects (CRITICAL)**: Always include key props, tools, or handheld items used by characters (e.g., 'steaming coffee mug', 'cybernetic weapon', 'cracked neural tablet').\n"
            "3. **Multi-Person Spatial Interaction**: When multiple characters are present, explicitly describe their relative physical positions, distance, posture, and active interaction (e.g., 'Character A standing 2 meters in front of Character B, two-person standoff framing', 'Character A handing a keycard across the table to Character B').\n"
            "4. **Visual Variety & Dynamic Framing**: Alternate between Extreme Long Shots, Full Body Shots, Medium Shots, and Close-Ups. Use dynamic camera angles (Low Angle, Dutch Angle, High Angle) to enhance dramatic rhythm.\n"
            f"{char_instruction}"
            "\n"
            "### Required Output Format (JSON Object):\n"
            "Return a JSON object with a key 'shots' containing a list of shot objects. Example:\n"
            "{\n"
            "  \"shots\": [\n"
            "    {\n"
            "      \"id\": 1,\n"
            "      \"shot_type\": \"Full Body Shot\",\n"
            "      \"camera_movement\": \"Static\",\n"
            "      \"camera_angle\": \"Eye-level\",\n"
            "      \"visual_prompt\": \"Detailed English scene description including [Specific Physical Action & Body Language], [Props/Tools held or near], [Multi-person spatial interaction], [Environment & Cinematic Lighting]\",\n"
            "      \"audio_prompt\": \"Background music and sound effects in English\",\n"
            "      \"dialogue\": \"Speaker: Line\",\n"
            "      \"duration\": 4.0\n"
            "    }\n"
            "  ]\n"
            "}\n\n"
            f"Story Text:\n{content}"
        )

    @staticmethod
    def extract_character_profiles(content: str) -> str:
        return (
            "Analyze the story text and extract a list of characters. "
            "For each character, provide:\n"
            "- 'name': Name\n"
            "- 'role': 'main', 'supporting', or 'minor'\n"
            "- 'description': Brief biography and personality\n"
            "- 'visual_tags': A dictionary of visual traits for AI image generation. "
            "MUST include keys: 'hair', 'eyes', 'skin_tone', 'face_features', 'build', 'clothing', 'accessories' (e.g. glasses, jewelry). "
            "Make descriptions specific (e.g. 'scar on left cheek', 'round wire-rimmed glasses').\n"
            "\n"
            "Return the result as a JSON object with a key 'profiles' containing the list of character objects.\n\n"
            f"Text: {content}"
        )

    @staticmethod
    def analyze_character_evolution(character_json: str, new_text: str) -> str:
        return (
            "You are a Character Consistency Manager for a long-running series. "
            "Compare the existing character data with their appearance in the NEW CHAPTER TEXT.\n"
            "\n"
            f"### Existing Character Data:\n{character_json}\n"
            "\n"
            f"### New Chapter Text:\n{new_text}\n"
            "\n"
            "### Task:\n"
            "Determine if the character's appearance in the new text requires a new 'Variant' (e.g. new outfit, new hairstyle) "
            "or if it's just a temporary state (e.g. wet, dirty, injured) or no change.\n"
            "\n"
            "### Output JSON:\n"
            "{\n"
            "  \"action\": \"new_variant\" | \"keep_current\" | \"scene_modifier\",\n"
            "  \"reason\": \"Explanation of why...\",\n"
            "  \"new_variant\": { \"name\": \"...\", \"tags\": \"...\" } (Only if action is 'new_variant'),\n"
            "  \"modifier_tags\": \"...\" (Only if action is 'scene_modifier', keywords for prompt)\n"
            "}"
        )

    @staticmethod
    def generate_scene_coverage_prompt(scene_prompt: str, dialogue: str = "", character_profiles: str = "") -> str:
        char_instruction = ""
        if character_profiles:
            char_instruction = (
                "\n### Character Visual Consistency:\n"
                "Use the following character definitions to ensure consistent descriptions in 'visual_prompt':\n"
                f"{character_profiles}\n"
            )

        return (
            "You are a professional film cinematographer creating a 9-shot coverage package for a SINGLE SCENE beat.\n"
            "CRITICAL: All 9 candidate shots MUST describe the EXACT SAME moment, action, environment, time of day, weather, lighting, and character state as the input scene. "
            "Do NOT advance the story timeline. Do NOT change character clothing or location.\n"
            "\n"
            "### Mandatory 9-Shot Coverage Slots:\n"
            "Slot 1: Extreme Long Shot (ELS), Eye-level. Establishing environment and subject spatial context.\n"
            "Slot 2: Long Shot (LS), Eye-level. Full body subject silhouette and posture.\n"
            "Slot 3: Medium Long Shot (MLS), Eye-level. Knees-up framing showing character relationships.\n"
            "Slot 4: Medium Shot (MS), Eye-level. Waist-up framing capturing main action beat.\n"
            "Slot 5: Medium Close-Up (MCU), Eye-level. Chest-up framing capturing emotion and reaction.\n"
            "Slot 6: Close-Up (CU), Eye-level. Tight face shot showing emotional tension and clarity.\n"
            "Slot 7: Extreme Close-Up (ECU), Eye-level. Macro detail of eye, hand, weapon, or key object.\n"
            "Slot 8: Medium Shot (MS), Low Angle. Dramatic camera looking up from below.\n"
            "Slot 9: Long Shot (LS), High Angle. Bird's eye overview looking down from above.\n"
            "\n"
            f"{char_instruction}\n"
            "### Output Format (JSON Object):\n"
            "Return a JSON object with a key 'shots' containing a list of EXACTLY 9 objects matching the 9 slots above with fields:\n"
            "- 'id': Slot number (1-9)\n"
            "- 'shot_type': Shot size (Extreme Long Shot, Long Shot, Medium Long Shot, Medium Shot, Medium Close-Up, Close-Up, Extreme Close-Up)\n"
            "- 'camera_angle': Camera angle (Eye-level, Low Angle, High Angle)\n"
            "- 'camera_movement': Movement choice [Static, Pan, Tilt, Zoom In, Zoom Out, Tracking, Handheld]\n"
            "- 'visual_prompt': Detailed English description for image generation\n"
            "- 'audio_prompt': Audio BGM/SFX description in English\n"
            "- 'dialogue': Keep original dialogue if applicable or null\n"
            "- 'duration': 3.0\n"
            "\n"
            f"Source Scene Description:\n{scene_prompt}\n"
            f"Dialogue: {dialogue or 'None'}"
        )

    @staticmethod
    def generate_storyboard_grid_prompt(story_text: str) -> str:
        return (
            "STORY-TO-STORYBOARD META-PROMPT\n"
            "\n"
            "IMPORTANT: Do not create the image, create the detailed prompt for the image.\n"
            "\n"
            "When the user provides a short story synopsis, create a full 3×3 cinematic storyboard grid prompt with 9 distinct shots of the same subject(s) in the same environment.\n"
            "\n"
            f"Input Story:\n{story_text}"
        )
