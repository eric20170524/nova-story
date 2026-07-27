import { GoogleGenerativeAI, Schema } from '@google/generative-ai';
import { z } from 'zod';
import { AIProvider } from './base';
import { logger } from '../../core/logging';
import { settings } from '../../core/config';
import { zodToJsonSchema } from 'zod-to-json-schema';

export class GeminiProvider implements AIProvider {
    private genAI: GoogleGenerativeAI;
    private model: string;

    constructor(apiKey: string, model: string = 'gemini-2.5-flash') {
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
        const jsonSchema = zodToJsonSchema(responseSchema, "ResponseSchema") as any;
        const schemaRef = jsonSchema.definitions?.ResponseSchema || jsonSchema;

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
            let cleanText = text.trim();
            if (cleanText.includes('```json')) {
                cleanText = cleanText.split('```json')[1].split('```')[0].trim();
            } else if (cleanText.includes('```')) {
                cleanText = cleanText.split('```')[1].split('```')[0].trim();
            }

            const parsed = JSON.parse(cleanText);

            // Validate against the original Zod schema
            return responseSchema.parse(parsed);

        } catch (error) {
            logger.error(`Gemini generateStructured error: ${error}`);
            throw error;
        }
    }

    async generateImage(prompt: string, size: string = "1024x1024", token?: string): Promise<{ url?: string; b64_json?: string; data?: Buffer; error?: string }> {
        logger.warn("Gemini Image Generation: Returning placeholder in Fastify migration phase 4.");
        const encodedPrompt = encodeURIComponent(prompt.substring(0, 20));
        const url = `https://placehold.co/1024x1024/1e293b/6366f1.png?text=Gemini+Mock:+${encodedPrompt}`;
        return { url };
    }
}
