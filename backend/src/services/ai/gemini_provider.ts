import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from '@google/genai';
import { z } from 'zod';
import { setGlobalDispatcher, ProxyAgent } from 'undici';
import { AIProvider, ImageGenerationOptions } from './base';
import { logger } from '../../core/logging';
import { SettingsManager } from '../../core/settings_manager';

try {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
    if (proxyUrl) {
        setGlobalDispatcher(new ProxyAgent(proxyUrl));
    }
} catch (e) {}

const DEFAULT_SAFETY_SETTINGS = [
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE }
];

function truncateLog(text: string, maxLength = 500): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}... [truncated, total length ${text.length}]`;
}

export class GeminiProvider implements AIProvider {
    private ai: GoogleGenAI;
    private model: string;
    private apiKey: string;

    constructor(apiKey: string, model: string = 'gemini-3-flash-preview') {
        this.apiKey = apiKey;
        this.ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 60000, headers: { 'User-Agent': 'aistudio-build' } } });
        this.model = model;
    }

    private async executeWithFallback(
        action: (modelName: string) => Promise<any>
    ): Promise<any> {
        const candidateModels = [
            'gemini-3-flash-preview',
            'gemini-3.5-flash-lite',
            'gemini-3.1-flash-lite',
            'gemini-3.5-flash',
            this.model,
            'gemini-3.8-flash',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite'
        ];
        const uniqueModels = Array.from(new Set(candidateModels));
        let lastError: any = null;

        for (let attempt = 0; attempt < 8; attempt++) {
            for (const model of uniqueModels) {
                try {
                    return await action(model);
                } catch (error: any) {
                    lastError = error;
                    const errMsg = String(error?.message || error);
                    logger.warn(`Gemini model ${model} failed (${errMsg.slice(0, 100)}), trying next candidate...`);
                    if (
                        error?.status === 429 ||
                        error?.status === 503 ||
                        error?.status === 504 ||
                        errMsg.includes('429') ||
                        errMsg.includes('503') ||
                        errMsg.includes('504') ||
                        errMsg.includes('quota') ||
                        errMsg.includes('RESOURCE_EXHAUSTED') ||
                        errMsg.includes('high demand') ||
                        errMsg.includes('Deadline expired') ||
                        errMsg.includes('aborted')
                    ) {
                        continue;
                    }
                    throw error;
                }
            }
            if (attempt < 7) {
                logger.warn(`All Gemini models busy on attempt ${attempt + 1}, waiting 12s before retry loop...`);
                await new Promise(r => setTimeout(r, 12000));
            }
        }
        throw lastError;
    }

    async generateText(prompt: string, systemInstruction?: string): Promise<string> {
        const config: any = {
            safetySettings: DEFAULT_SAFETY_SETTINGS,
        };
        if (systemInstruction) {
            config.systemInstruction = systemInstruction;
        }

        logger.info(`[Gemini Prompt Input]: ${truncateLog(prompt)}`);
        try {
            const result = await this.executeWithFallback(async (modelName) => {
                return await this.ai.models.generateContent({
                    model: modelName,
                    contents: prompt,
                    config
                });
            });
            const text = result.text || '';
            logger.info(`[Gemini Text Output]: ${truncateLog(text)}`);
            return text;
        } catch (error) {
            logger.error(`Gemini generateText error: ${error}`);
            throw error;
        }
    }

    async generateStructured<T>(
        prompt: string,
        responseSchema: z.ZodSchema<T>,
        systemInstruction?: string,
        options?: { temperature?: number; maxTokens?: number; systemInstruction?: string }
    ): Promise<T> {
        const schemaRef = z.toJSONSchema(responseSchema) as any;
        const sys = options?.systemInstruction ?? systemInstruction;

        const config: any = {
            responseMimeType: "application/json",
            responseSchema: schemaRef,
            safetySettings: DEFAULT_SAFETY_SETTINGS,
        };

        if (typeof options?.temperature === 'number') {
            config.temperature = options.temperature;
        }
        if (typeof options?.maxTokens === 'number' && options.maxTokens > 0) {
            config.maxOutputTokens = Math.max(options.maxTokens, 4096);
        }

        if (sys) {
            config.systemInstruction = sys;
        }

        logger.info(`[Gemini Structured Prompt Input]: ${truncateLog(prompt)}`);
        try {
            const result = await this.executeWithFallback(async (modelName) => {
                return await this.ai.models.generateContent({
                    model: modelName,
                    contents: prompt,
                    config
                });
            });
            const text = result.text || '';
            logger.info(`[Gemini Structured Output Raw]: ${truncateLog(text)}`);

            const cleanText = text
                .trim()
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/\s*```$/, '')
                .trim();

            if (!cleanText) {
                logger.warn(`Gemini empty raw response dump: ${JSON.stringify(result)}`);
                const finishReason = result?.candidates?.[0]?.finishReason;
                throw new Error(`Gemini returned empty text (finishReason: ${finishReason})`);
            }

            const parsed = JSON.parse(cleanText);
            return responseSchema.parse(parsed);
        } catch (error) {
            logger.error(`Gemini generateStructured error: ${error}`);
            throw error;
        }
    }

    async generateImage(prompt: string, options?: ImageGenerationOptions, token?: string): Promise<{ url?: string; b64_json?: string; data?: Buffer; error?: string }> {
        if (!this.apiKey) {
            return { error: 'GEMINI_API_KEY is not configured.' };
        }

        const imageModel = SettingsManager.loadSettings().image_model
            || 'gemini-3.1-flash-image';
            
        try {
            const response = await this.ai.models.generateContent({
                model: imageModel,
                contents: prompt,
                config: {
                    imageConfig: {
                        aspectRatio: options?.aspectRatio || "1:1",
                        imageSize: options?.imageSize || "1K"
                    }
                }
            });
            
            const parts = response.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
                if (part.inlineData && part.inlineData.data) {
                    return { data: Buffer.from(part.inlineData.data, 'base64') };
                }
            }
            return { error: 'Gemini response contained no image data.' };
        } catch (error: any) {
            logger.error(`Gemini image generation error: ${error}`);
            return { error: error?.message || String(error) };
        }
    }
}
