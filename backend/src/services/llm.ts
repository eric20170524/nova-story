import { z } from 'zod';
import { logger } from '../core/logging';
import { settings as appSettings } from '../core/config';
import { SettingsManager } from '../core/settings_manager';
import { AIProvider } from './ai/base';
import { GeminiProvider } from './ai/gemini_provider';
import { OpenAIProvider } from './ai/openai_provider';
import { Prompts } from './prompts';

import {
    TimelineResponseSchema,
    CharacterProfilesResponseSchema,
    CharacterEvolutionSchema,
    ContentAnalysisSchema
} from '../schemas/llm';

export class LLMService {
    static getProvider(token?: string): AIProvider {
        const sysSettings = SettingsManager.loadSettings();
        const llmConfig = sysSettings.llm || {};
        const providerType = (llmConfig.provider || 'gemini').toLowerCase();
        const apiKey = llmConfig.api_key || appSettings.GEMINI_API_KEY;
        const baseUrl = llmConfig.base_url;
        const model = llmConfig.model || 'gemini-2.5-flash';

        if (['openai', 'custom', 'ollama'].includes(providerType)) {
            const effectiveBaseUrl = baseUrl || (providerType === 'ollama' ? 'http://127.0.0.1:11434/v1' : undefined);
            const effectiveModel = model || (providerType === 'ollama' ? 'qwen2.5-coder:7b' : 'gpt-4o');
            return new OpenAIProvider(apiKey || 'ollama', effectiveModel, effectiveBaseUrl);
        } else {
            return new GeminiProvider(apiKey, model);
        }
    }

    static async generateStructuredWithRetry<T>(prompt: string, schema: z.ZodSchema<T>, token?: string): Promise<T | null> {
        const maxRetries = 3;
        const provider = LLMService.getProvider(token);

        for (let i = 0; i < maxRetries; i++) {
            try {
                return await provider.generateStructured(prompt, schema);
            } catch (error) {
                logger.warn(`LLM parsing failed on attempt ${i+1}: ${error}`);
                if (i === maxRetries - 1) {
                    logger.error('Max retries reached for LLM structured output.');
                    return null;
                }
            }
        }
        return null;
    }

    static validateNineShotCoverage(shots: any[]): boolean {
        if (shots.length !== 9) return false;
        for (const s of shots) {
            if (!s.visual_prompt && !s.shot_type) return false;
        }
        return true;
    }

    static generateNineShotFallback(content: string): any[] {
        const sentences = content.split(/[。！？\n]+/).map(s => s.trim()).filter(s => s);
        const baseSentence = sentences.length > 0 ? sentences[0] : content.substring(0, 100);

        const nineSpecs = [
            ["Extreme Long Shot", "Static", "Eye-level"],
            ["Long Shot", "Static", "Eye-level"],
            ["Medium Long Shot", "Pan", "Eye-level"],
            ["Medium Shot", "Static", "Eye-level"],
            ["Medium Close-Up", "Zoom In", "Eye-level"],
            ["Close-Up", "Static", "Eye-level"],
            ["Extreme Close-Up", "Static", "Eye-level"],
            ["Medium Shot", "Static", "Low Angle"],
            ["Medium Shot", "Static", "High Angle"]
        ];

        return nineSpecs.map((spec, idx) => {
            const sText = sentences.length > 0 ? sentences[idx % sentences.length] : baseSentence;
            const hasDialog = sText.includes('：') || sText.includes(':') || sText.includes('“');
            return {
                id: idx + 1,
                shot_type: spec[0],
                camera_movement: spec[1],
                camera_angle: spec[2],
                visual_prompt: `Cinematic ${spec[0]}: ${sText}, anime masterpiece, highly detailed`,
                audio_prompt: "Cinematic BGM",
                dialogue: hasDialog ? sText : null,
                duration: 3.0,
                negative_prompt: null
            };
        });
    }

    static async generateTimeline(content: string, characterProfiles: string = "", mode: string = "narrative", token?: string): Promise<any[]> {
        const normalizedMode = mode.toLowerCase();
        let targetMode = "narrative";
        if (['cinematic_grid', 'nine_shot_coverage'].includes(normalizedMode)) {
            targetMode = "nine_shot_coverage";
        }

        logger.info(`Generating timeline (raw_mode=${mode}, normalized=${targetMode})...`);

        let prompt = "";
        if (targetMode === "nine_shot_coverage") {
            // Note: Since Prompts class porting is needed, let's assume we have it
            prompt = Prompts.generateCinematicGridTimelinePrompt(content, characterProfiles);
        } else {
            prompt = Prompts.generateTimeline(content, characterProfiles);
        }

        const result = await LLMService.generateStructuredWithRetry(prompt, TimelineResponseSchema, token);

        if (result && result.shots) {
            if (targetMode === "nine_shot_coverage") {
                if (LLMService.validateNineShotCoverage(result.shots)) {
                    return result.shots;
                } else {
                    logger.warn("LLM response for nine_shot_coverage did not pass strict 9-shot validation. Retrying or using 9-shot fallback.");
                    const retryPrompt = prompt + "\n\nCRITICAL MANDATORY REQUIREMENT: You MUST return EXACTLY 9 shots covering the 9 shot types specified above!";
                    const retryResult = await LLMService.generateStructuredWithRetry(retryPrompt, TimelineResponseSchema, token);
                    if (retryResult && retryResult.shots && LLMService.validateNineShotCoverage(retryResult.shots)) {
                        return retryResult.shots;
                    }
                    return LLMService.generateNineShotFallback(content);
                }
            } else {
                return result.shots.slice(0, 20);
            }
        }

        if (targetMode === "nine_shot_coverage") {
            logger.warn("LLM structured output failed for nine_shot_coverage, using dedicated 9-shot fallback.");
            return LLMService.generateNineShotFallback(content);
        }

        logger.warn("LLM structured output failed for narrative timeline, generating fallback scenes from chapter content.");
        const sentences = content.split(/[。！？\n]+/).map(s => s.trim()).filter(s => s);
        const fallbackSentences = sentences.length > 0 ? sentences : [content.substring(0, 100)];

        const shotTypes = ["Medium Shot", "Close-Up", "Long Shot", "Medium Shot"];
        const movements = ["Static", "Pan", "Tracking", "Zoom In"];
        const angles = ["Eye-level", "Low Angle", "High Angle", "Eye-level"];

        return fallbackSentences.slice(0, 10).map((sentence, idx) => {
            const hasDialog = sentence.includes('：') || sentence.includes(':') || sentence.includes('“');
            return {
                id: idx + 1,
                shot_type: shotTypes[idx % shotTypes.length],
                camera_movement: movements[idx % movements.length],
                camera_angle: angles[idx % angles.length],
                visual_prompt: `Cinematic shot: ${sentence}, anime masterpiece, highly detailed`,
                audio_prompt: "Cinematic BGM",
                dialogue: hasDialog ? sentence : null,
                duration: 3.0,
                negative_prompt: null
            };
        });
    }

    static async generateSceneCoverage(sceneData: any, characterProfiles: string = "", token?: string): Promise<any[]> {
        const rawPrompt = sceneData.visual_prompt || "";
        const dialogue = sceneData.dialogue || "";
        logger.info(`Generating single-scene 9-shot coverage for prompt: ${rawPrompt.substring(0, 40)}...`);

        const prompt = Prompts.generateSceneCoveragePrompt(rawPrompt, dialogue, characterProfiles);
        const result = await LLMService.generateStructuredWithRetry(prompt, TimelineResponseSchema, token);

        if (result && result.shots && LLMService.validateNineShotCoverage(result.shots)) {
            return result.shots.map((s, i) => {
                const asAny: any = s;
                asAny.slot = i + 1;
                asAny.shot_size = asAny.shot_type || "Medium Shot";
                return asAny;
            });
        }

        logger.warn("LLM structured output for single-scene coverage failed or incomplete. Generating dedicated 9-candidate fallback.");
        const nineSpecs = [
            ["Extreme Long Shot", "Static", "Eye-level", "Establishing environment and spatial context"],
            ["Long Shot", "Static", "Eye-level", "Full body silhouette and posture"],
            ["Medium Long Shot", "Pan", "Eye-level", "Knees-up composition"],
            ["Medium Shot", "Static", "Eye-level", "Waist-up main action beat"],
            ["Medium Close-Up", "Zoom In", "Eye-level", "Chest-up emotion and reaction"],
            ["Close-Up", "Static", "Eye-level", "Tight facial expression"],
            ["Extreme Close-Up", "Static", "Eye-level", "Macro detail of eye, hand, or key prop"],
            ["Medium Shot", "Static", "Low Angle", "Dramatic low-angle view"],
            ["Long Shot", "Static", "High Angle", "High-angle overview of space"]
        ];

        return nineSpecs.map((spec, idx) => ({
            slot: idx + 1,
            shot_type: spec[0],
            shot_size: spec[0],
            camera_movement: spec[1],
            camera_angle: spec[2],
            narrative_purpose: spec[3],
            visual_prompt: `(${spec[0]}, ${spec[2]}), ${rawPrompt}`,
            audio_prompt: sceneData.audio_prompt || "Cinematic BGM",
            dialogue: dialogue,
            duration: sceneData.duration || 3.0,
            negative_prompt: sceneData.negative_prompt || null
        }));
    }

    static async extractCharacterProfiles(content: string, token?: string): Promise<any[]> {
        logger.info("Extracting character profiles...");
        const prompt = Prompts.extractCharacterProfiles(content);
        const result = await LLMService.generateStructuredWithRetry(prompt, CharacterProfilesResponseSchema, token);
        if (result) {
            return result.profiles;
        }
        return [];
    }
}
