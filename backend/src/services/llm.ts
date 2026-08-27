import { z } from 'zod';
import { logger } from '../core/logging';
import { settings as appSettings } from '../core/config';
import { SettingsManager } from '../core/settings_manager';
import type { AIProvider } from './ai/base';
import { GeminiProvider } from './ai/gemini_provider';
import { OpenAIProvider } from './ai/openai_provider';
import { Prompts } from './prompts';

import {
    TimelineResponseSchema,
    CharacterProfilesResponseSchema,
    CharacterEvolutionSchema,
    ContentAnalysisSchema
} from '../schemas/llm';

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
export const DEFAULT_OLLAMA_MODEL = 'novastory-qwen3:8b';

export type LLMProviderConfig = {
    provider?: string;
    api_key?: string;
    base_url?: string;
    model?: string;
};

export class LLMService {
    static getProvider(token?: string, configOverride?: LLMProviderConfig): AIProvider {
        const sysSettings = SettingsManager.loadSettings();
        const llmConfig = configOverride || sysSettings.llm || {};
        const providerType = (llmConfig.provider || 'ollama').toLowerCase();
        const baseUrl = llmConfig.base_url;

        if (['openai', 'custom', 'ollama'].includes(providerType)) {
            const isOllama = providerType === 'ollama';
            const effectiveBaseUrl = baseUrl || (isOllama ? DEFAULT_OLLAMA_BASE_URL : undefined);
            const effectiveModel = llmConfig.model || (isOllama ? DEFAULT_OLLAMA_MODEL : 'gpt-4o');
            const effectiveApiKey = isOllama
                ? 'ollama'
                : (llmConfig.api_key || appSettings.OPENAI_API_KEY);
            return new OpenAIProvider(effectiveApiKey, effectiveModel, effectiveBaseUrl, { isOllama });
        }

        if (providerType === 'grok') {
            return new OpenAIProvider(
                llmConfig.api_key || appSettings.GROK_API_KEY,
                llmConfig.model || 'grok-3',
                baseUrl || 'https://api.x.ai/v1'
            );
        }

        return new GeminiProvider(
            llmConfig.api_key || appSettings.GEMINI_API_KEY,
            llmConfig.model || 'gemini-2.5-flash'
        );
    }

    /** Always use the local Ollama-compatible endpoint, regardless of any cloud
     * provider selected for other writing tasks. */
    static getLocalProvider(): AIProvider {
        const configured = SettingsManager.loadSettings().llm || {};
        const configuredProvider = String(configured.provider || '').toLowerCase();
        const isConfiguredLocal = ['ollama', 'local_llm'].includes(configuredProvider);
        return new OpenAIProvider(
            'ollama',
            isConfiguredLocal && configured.model ? configured.model : DEFAULT_OLLAMA_MODEL,
            isConfiguredLocal && configured.base_url ? configured.base_url : DEFAULT_OLLAMA_BASE_URL,
            { isOllama: true }
        );
    }

    static async generateStructuredLocallyWithRetry<T>(
        prompt: string,
        schema: z.ZodSchema<T>,
        options?: {
            maxRetries?: number;
            temperature?: number;
            maxTokens?: number;
            systemInstruction?: string;
        }
    ): Promise<T | null> {
        const maxRetries = options?.maxRetries ?? 2;
        const provider = LLMService.getLocalProvider();
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await provider.generateStructured(
                    prompt,
                    schema,
                    options?.systemInstruction,
                    {
                        temperature: options?.temperature,
                        maxTokens: options?.maxTokens,
                        systemInstruction: options?.systemInstruction,
                    }
                );
            } catch (error) {
                logger.warn(`Local LLM parsing failed on attempt ${i + 1}: ${error}`);
                if (i === maxRetries - 1) {
                    logger.error('Max retries reached for local structured output.');
                    return null;
                }
            }
        }
        return null;
    }

    static async generateStructuredWithRetry<T>(
        prompt: string,
        schema: z.ZodSchema<T>,
        token?: string,
        options?: {
            maxRetries?: number;
            temperature?: number;
            maxTokens?: number;
            systemInstruction?: string;
        }
    ): Promise<T | null> {
        // Default 2 attempts (first + one retry). Route uses maxRetries: 2 as well.
        const maxRetries = options?.maxRetries ?? 2;
        const provider = LLMService.getProvider(token);

        for (let i = 0; i < maxRetries; i++) {
            try {
                return await provider.generateStructured(prompt, schema, options?.systemInstruction, {
                    temperature: options?.temperature,
                    maxTokens: options?.maxTokens,
                    systemInstruction: options?.systemInstruction,
                });
            } catch (error) {
                logger.warn(`LLM parsing failed on attempt ${i + 1}: ${error}`);
                if (i === maxRetries - 1) {
                    logger.error('Max retries reached for LLM structured output.');
                    return null;
                }
            }
        }
        return null;
    }

    static async generateDraft(instructions: string, context: string = "", token?: string): Promise<string> {
        const provider = LLMService.getProvider(token);
        return provider.generateText(Prompts.generateDraft(instructions, context));
    }

    static async analyzeContent(content: string, token?: string): Promise<z.infer<typeof ContentAnalysisSchema>> {
        const result = await LLMService.generateStructuredWithRetry(
            Prompts.analyzeContent(content),
            ContentAnalysisSchema,
            token
        );
        return result || { new_entities: [], updates: ["Analysis failed"] };
    }

    static async generateStoryboardGrid(storyText: string, token?: string): Promise<string> {
        const provider = LLMService.getProvider(token);
        return provider.generateText(Prompts.generateStoryboardGridPrompt(storyText));
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
        const baseSentence = sentences[0] ?? content.substring(0, 100);

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
            const sText = sentences.length > 0
                ? (sentences[idx % sentences.length] ?? baseSentence)
                : baseSentence;
            const hasDialog = sText.includes('：') || sText.includes(':') || sText.includes('“');
            const intent =
                idx === 0 ? 'establish'
                  : idx === 6 ? 'insert'
                    : idx === 5 ? 'reaction'
                      : idx === 8 ? 'overhead-map'
                        : 'wide-action';
            return {
                id: idx + 1,
                shot_type: spec[0],
                camera_movement: spec[1],
                camera_angle: spec[2],
                shot_intent: intent,
                location: 'shared scene location',
                primary_action: 'same beat action from alternate angle',
                key_props: [],
                subject_scale: idx === 6 ? 'absent' : 'small-15-20',
                visual_prompt: '',
                audio_prompt: "Cinematic BGM",
                dialogue: hasDialog ? sText : null,
                narration: hasDialog ? null : sText,
                duration: 3.0,
                negative_prompt: null
            };
        });
    }

    static async generateTimeline(
        content: string,
        characterProfiles: string = "",
        mode: string = "narrative",
        token?: string,
        options?: { nsfwEnabled?: boolean }
    ): Promise<any[]> {
        const normalizedMode = mode.toLowerCase();
        let targetMode = "narrative";
        if (['cinematic_grid', 'nine_shot_coverage'].includes(normalizedMode)) {
            targetMode = "nine_shot_coverage";
        }

        logger.info(`Generating timeline (raw_mode=${mode}, normalized=${targetMode})...`);

        const nsfwEnabled =
            typeof options?.nsfwEnabled === 'boolean'
                ? options.nsfwEnabled
                : Boolean(SettingsManager.loadSettings()?.advanced?.nsfw_enabled);
        let prompt = "";
        if (targetMode === "nine_shot_coverage") {
            prompt = Prompts.generateCinematicGridTimelinePrompt(content, characterProfiles, nsfwEnabled);
        } else {
            prompt = Prompts.generateTimeline(content, characterProfiles, nsfwEnabled);
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

        // Task 2.4: never stuff Chinese chapter sentences into visual_prompt.
        // Fail closed — timeline_generation_service compiles only from validated contracts.
        logger.error("LLM structured output failed for narrative timeline; refusing Chinese visual_prompt fallback.");
        throw new Error(
          'Timeline LLM failed to return structured shot contracts (location + primary_action). Refusing Chinese visual_prompt fallback.'
        );
    }

    static async generateSceneCoverage(
        sceneData: any,
        characterProfiles: string = "",
        token?: string,
        options?: { nsfwEnabled?: boolean }
    ): Promise<any[]> {
        const rawPrompt = sceneData.visual_prompt || "";
        const dialogue = sceneData.dialogue || "";
        logger.info(`Generating single-scene 9-shot coverage for prompt: ${rawPrompt.substring(0, 40)}...`);

        const nsfwEnabled =
            typeof options?.nsfwEnabled === 'boolean'
                ? options.nsfwEnabled
                : Boolean(SettingsManager.loadSettings()?.advanced?.nsfw_enabled);
        const prompt = Prompts.generateSceneCoveragePrompt(rawPrompt, dialogue, characterProfiles, nsfwEnabled);
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
        return LLMService.buildCoverageFallbackFromSource(sceneData, dialogue);
    }

    /** Nine coverage variants that inherit the source beat contract (fail closed if missing). */
    static buildCoverageFallbackFromSource(sceneData: any, dialogue: string = ''): any[] {
        let spec: any = {};
        try {
            spec = typeof sceneData?.shot_spec === 'string'
                ? JSON.parse(sceneData.shot_spec || '{}')
                : (sceneData?.shot_spec || {});
        } catch {
            spec = {};
        }
        const location = String(spec?.location || sceneData?.location || '').trim();
        const primary_action = String(
            spec?.primary_action || sceneData?.primary_action || ''
        ).trim();
        if (location.length < 2 || primary_action.length < 2) {
            throw new Error(
                'Coverage fallback requires source shot_spec with location + primary_action'
            );
        }
        const key_props = Array.isArray(spec?.key_props)
            ? spec.key_props
            : (Array.isArray(sceneData?.key_props) ? sceneData.key_props : []);
        const primary_subject = spec?.primary_subject ?? sceneData?.primary_subject ?? null;
        const visible_subjects = Array.isArray(spec?.visible_subjects)
            ? spec.visible_subjects
            : (Array.isArray(sceneData?.visible_subjects) ? sceneData.visible_subjects : []);

        const nineSpecs = [
            ["Extreme Long Shot", "Static", "Eye-level", "Establishing environment and spatial context", "establish"],
            ["Long Shot", "Static", "Eye-level", "Full body silhouette and posture", "wide-action"],
            ["Medium Long Shot", "Pan", "Eye-level", "Knees-up composition", "medium-action"],
            ["Medium Shot", "Static", "Eye-level", "Waist-up main action beat", "medium-action"],
            ["Medium Close-Up", "Zoom In", "Eye-level", "Chest-up emotion and reaction", "reaction"],
            ["Close-Up", "Static", "Eye-level", "Tight facial expression", "reaction"],
            ["Extreme Close-Up", "Static", "Eye-level", "Macro detail of eye, hand, or key prop", "insert"],
            ["Medium Shot", "Static", "Low Angle", "Dramatic low-angle view", "medium-action"],
            ["Long Shot", "Static", "High Angle", "High-angle overview of space", "overhead-map"],
        ] as const;

        return nineSpecs.map((row, idx) => ({
            slot: idx + 1,
            shot_type: row[0],
            shot_size: row[0],
            camera_movement: row[1],
            camera_angle: row[2],
            narrative_purpose: row[3],
            shot_intent: row[4],
            location,
            primary_action,
            primary_subject,
            visible_subjects,
            key_props,
            // Empty — server compilePonyPrompt fills final tags.
            visual_prompt: '',
            audio_prompt: sceneData.audio_prompt || 'Cinematic BGM',
            dialogue: dialogue || sceneData.dialogue || null,
            duration: sceneData.duration || 3.0,
            negative_prompt: null,
        }));
    }

    static async extractCharacterProfiles(content: string, token?: string): Promise<any[]> {
        logger.info("Extracting character profiles...");
        const nsfwEnabled = Boolean(SettingsManager.loadSettings()?.advanced?.nsfw_enabled);
        const prompt = Prompts.extractCharacterProfiles(content, nsfwEnabled);
        const result = await LLMService.generateStructuredWithRetry(prompt, CharacterProfilesResponseSchema, token);
        if (result) {
            return result.profiles;
        }
        return [];
    }

    static async analyzeCharacterEvolution(
        characterData: Record<string, any>,
        newText: string,
        token?: string
    ): Promise<z.infer<typeof CharacterEvolutionSchema>> {
        const prompt = Prompts.analyzeCharacterEvolution(
            JSON.stringify(characterData, null, 2),
            newText
        );
        const result = await LLMService.generateStructuredWithRetry(
            prompt,
            CharacterEvolutionSchema,
            token
        );
        return result || {
            action: "keep_current",
            reason: "LLM failed to return a valid character evolution result"
        };
    }
}
