import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { AIProvider } from './base';
import { logger } from '../../core/logging';
import { SettingsManager } from '../../core/settings_manager';

export class GeminiProvider implements AIProvider {
    private ai: GoogleGenAI;
    private model: string;
    private apiKey: string;

    constructor(apiKey: string, model: string = 'gemini-3.6-flash') {
        this.apiKey = apiKey;
        this.ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });
        this.model = model;
    }

    async generateText(prompt: string, systemInstruction?: string): Promise<string> {
        const config: any = {};
        if (systemInstruction) {
            config.systemInstruction = systemInstruction;
        }

        try {
            const result = await this.ai.models.generateContent({
                model: this.model,
                contents: prompt,
                config
            });
            return result.text || '';
        } catch (error) {
            logger.error(`Gemini generateText error: ${error}`);
            throw error;
        }
    }

    async generateStructured<T>(prompt: string, responseSchema: z.ZodSchema<T>, systemInstruction?: string): Promise<T> {
        const schemaRef = z.toJSONSchema(responseSchema) as any;

        const config: any = {
            responseMimeType: "application/json",
        };

        if (systemInstruction) {
            config.systemInstruction = systemInstruction;
        }

        const sysPrompt = systemInstruction ? `${systemInstruction}\n\n` : '';
        const fullPrompt = `${sysPrompt}${prompt}\n\nIMPORTANT: Return ONLY a valid JSON object matching this schema:\n${JSON.stringify(schemaRef, null, 2)}`;

        try {
            const result = await this.ai.models.generateContent({
                model: this.model,
                contents: fullPrompt,
                config
            });
            const text = result.text || '';

            // basic json repair
            const cleanText = text
                .trim()
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/\s*```$/, '')
                .trim();

            const parsed = JSON.parse(cleanText);

            // Validate against the original Zod schema
            return responseSchema.parse(parsed);

        } catch (error) {
            logger.error(`Gemini generateStructured error: ${error}`);
            throw error;
        }
    }

    async generateImage(prompt: string, size: string = "1K", token?: string): Promise<{ url?: string; b64_json?: string; data?: Buffer; error?: string }> {
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
                        aspectRatio: "1:1",
                        imageSize: size as any
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
