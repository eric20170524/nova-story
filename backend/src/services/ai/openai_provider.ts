import OpenAI from 'openai';
import { z } from 'zod';
import { AIProvider } from './base';
import { logger } from '../../core/logging';
import { zodToJsonSchema } from 'zod-to-json-schema';

export class OpenAIProvider implements AIProvider {
    private openai: OpenAI;
    private model: string;
    private imageModel: string;

    constructor(apiKey: string, model: string = 'gpt-4o', baseUrl?: string) {
        this.openai = new OpenAI({
            apiKey,
            baseURL: baseUrl,
        });
        this.model = model;
        this.imageModel = 'dall-e-3';
    }

    async generateText(prompt: string, systemInstruction?: string): Promise<string> {
        try {
            const messages: any[] = [];
            if (systemInstruction) {
                messages.push({ role: 'system', content: systemInstruction });
            }
            messages.push({ role: 'user', content: prompt });

            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages
            });

            return response.choices[0]?.message?.content || '';
        } catch (error) {
            logger.error(`OpenAI generateText error: ${error}`);
            throw error;
        }
    }

    async generateStructured<T>(prompt: string, responseSchema: z.ZodSchema<T>, systemInstruction?: string): Promise<T> {
        try {
            const messages: any[] = [];
            if (systemInstruction) {
                messages.push({ role: 'system', content: systemInstruction });
            }
            messages.push({ role: 'user', content: prompt });

            const jsonSchema = zodToJsonSchema(responseSchema, "ResponseSchema") as any;
            const schemaRef = jsonSchema.definitions?.ResponseSchema || jsonSchema;

            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages,
                response_format: { type: 'json_object' } // Using simple json_object for compatibility with local ollama/vllm endpoints often passed as OpenAI providers
            });

            const content = response.choices[0]?.message?.content || '';

            let cleanText = content.trim();
            if (cleanText.includes('```json')) {
                cleanText = cleanText.split('```json')[1].split('```')[0].trim();
            } else if (cleanText.includes('```')) {
                cleanText = cleanText.split('```')[1].split('```')[0].trim();
            }

            const parsed = JSON.parse(cleanText);

            // Adjust common array wrapper mismatch from generic json generation
            let targetParsed = parsed;
            const schemaFields = (responseSchema as any)?._def?.shape();
            if (schemaFields) {
               const fieldKeys = Object.keys(schemaFields);
               if (fieldKeys.length === 1 && Array.isArray(parsed)) {
                   targetParsed = { [fieldKeys[0]]: parsed };
               } else if (Array.isArray(parsed) && fieldKeys.includes('shots')) {
                   targetParsed = { shots: parsed };
               } else if (Array.isArray(parsed) && fieldKeys.includes('profiles')) {
                   targetParsed = { profiles: parsed };
               }
            }

            return responseSchema.parse(targetParsed);

        } catch (error) {
            logger.error(`OpenAI generateStructured error: ${error}`);
            throw error;
        }
    }

    async generateImage(prompt: string, size: string = "1024x1024", token?: string): Promise<{ url?: string; b64_json?: string; data?: Buffer; error?: string }> {
        try {
            const response = await this.openai.images.generate({
                model: this.imageModel,
                prompt,
                n: 1,
                size: size as any,
                response_format: 'url',
            });

            return { url: response.data[0]?.url };
        } catch (error: any) {
            logger.error(`OpenAI Image generation error: ${error}`);
            return { error: error.message };
        }
    }
}
