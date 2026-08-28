import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { AIProvider, ImageGenerationOptions } from './base';
import { logger } from '../../core/logging';
import { SettingsManager } from '../../core/settings_manager';

function truncateLog(text: string, maxLength = 500): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}... [truncated, total length ${text.length}]`;
}

export class GeminiProvider implements AIProvider {
    private ai: GoogleGenAI;
    private model: string;
    private apiKey: string;

    constructor(apiKey: string, model: string = 'gemini-2.5-flash') {
        this.apiKey = apiKey;
        this.ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });
        this.model = model;
    }

    async generateText(prompt: string, systemInstruction?: string): Promise<string> {
        const config: any = {};
        if (systemInstruction) {
            config.systemInstruction = systemInstruction;
        }

        logger.info(`[Gemini Prompt Input]: ${truncateLog(prompt)}`);
        try {
            const result = await this.ai.models.generateContent({
                model: this.model,
                contents: prompt,
                config
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
        };

        if (typeof options?.temperature === 'number') {
            config.temperature = options.temperature;
        }
        if (typeof options?.maxTokens === 'number' && options.maxTokens > 0) {
            config.maxOutputTokens = options.maxTokens;
        }

        if (sys) {
            config.systemInstruction = sys;
        }

        logger.info(`[Gemini Structured Prompt Input]: ${truncateLog(prompt)}`);
        try {
            const result = await this.ai.models.generateContent({
                model: this.model,
                contents: prompt,
                config
            });
            const text = result.text || '';
            logger.info(`[Gemini Structured Output Raw]: ${truncateLog(text)}`);

            const cleanText = text
                .trim()
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/\s*```$/, '')
                .trim();

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
