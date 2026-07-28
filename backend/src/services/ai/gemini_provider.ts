import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import { AIProvider } from './base';
import { logger } from '../../core/logging';
import { SettingsManager } from '../../core/settings_manager';

export class GeminiProvider implements AIProvider {
    private genAI: GoogleGenerativeAI;
    private model: string;
    private apiKey: string;

    constructor(apiKey: string, model: string = 'gemini-2.5-flash') {
        this.apiKey = apiKey;
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = model;
    }

    async generateText(prompt: string, systemInstruction?: string): Promise<string> {
        const modelSettings: any = { model: this.model };
        if (systemInstruction) {
            modelSettings.systemInstruction = systemInstruction;
        }

        const genModel = this.genAI.getGenerativeModel(modelSettings);
        try {
            const result = await genModel.generateContent(prompt);
            return result.response.text();
        } catch (error) {
            logger.error(`Gemini generateText error: ${error}`);
            throw error;
        }
    }

    async generateStructured<T>(prompt: string, responseSchema: z.ZodSchema<T>, systemInstruction?: string): Promise<T> {
        const schemaRef = z.toJSONSchema(responseSchema) as any;

        // Convert to Gemini compatible schema if needed.
        // For basic properties this often just maps straight over, but we need to ensure type is an enum compatible with Gemini API.
        const modelSettings: any = {
            model: this.model,
            generationConfig: {
                responseMimeType: "application/json",
            }
        };

        if (systemInstruction) {
            modelSettings.systemInstruction = systemInstruction;
        }

        // Notice: @google/generative-ai Node SDK supports responseSchema in generationConfig for models like gemini-1.5-pro
        // We'll pass the JSON schema as a hint in the prompt instead if the SDK complains, but recent SDK versions support it.
        // To be safe for arbitrary schemas and older Node SDKs, we use strict JSON prompting.

        const sysPrompt = systemInstruction ? `${systemInstruction}\n\n` : '';
        const fullPrompt = `${sysPrompt}${prompt}\n\nIMPORTANT: Return ONLY a valid JSON object matching this schema:\n${JSON.stringify(schemaRef, null, 2)}`;

        const genModel = this.genAI.getGenerativeModel(modelSettings);
        try {
            const result = await genModel.generateContent(fullPrompt);
            const text = result.response.text();

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

    async generateImage(prompt: string, size: string = "1024x1024", token?: string): Promise<{ url?: string; b64_json?: string; data?: Buffer; error?: string }> {
        if (!this.apiKey) {
            return { error: 'GEMINI_API_KEY is not configured.' };
        }

        const imageModel = SettingsManager.loadSettings().image_model
            || 'gemini-2.5-flash-image';
        const isImagen = /imagen|veo/i.test(imageModel);
        const operation = isImagen ? 'predict' : 'generateContent';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(imageModel)}:${operation}?key=${encodeURIComponent(this.apiKey)}`;
        const payload = isImagen
            ? {
                instances: [{ prompt }],
                parameters: { sampleCount: 1 }
              }
            : {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    responseModalities: ['TEXT', 'IMAGE']
                }
              };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(120_000)
            });
            if (!response.ok) {
                const detail = await response.text();
                return {
                    error: `Gemini image generation failed (${response.status}): ${detail.substring(0, 500)}`
                };
            }

            const data = await response.json() as Record<string, any>;
            if (isImagen) {
                const encoded = data.predictions?.[0]?.bytesBase64Encoded
                    || data.predictions?.[0]?.image?.bytesBase64Encoded;
                return encoded
                    ? { data: Buffer.from(encoded, 'base64') }
                    : { error: 'Gemini Imagen response contained no image data.' };
            }

            const parts = data.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
                const inlineData = part.inlineData || part.inline_data;
                if (inlineData?.data) {
                    return { data: Buffer.from(inlineData.data, 'base64') };
                }
            }
            return { error: 'Gemini response contained no image data.' };
        } catch (error: any) {
            logger.error(`Gemini image generation error: ${error}`);
            return { error: error?.message || String(error) };
        }
    }
}
