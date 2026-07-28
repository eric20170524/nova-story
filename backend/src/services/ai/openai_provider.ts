import OpenAI from 'openai';
import { z } from 'zod';
import type { AIProvider } from './base';
import { logger } from '../../core/logging';

export class OpenAIProvider implements AIProvider {
    private openai: OpenAI;
    private model: string;
    private imageModel: string;
    private isOllama: boolean;

    constructor(
        apiKey: string,
        model: string = 'gpt-4o',
        baseUrl?: string,
        options: { isOllama?: boolean } = {}
    ) {
        this.openai = new OpenAI({
            apiKey,
            baseURL: baseUrl,
            timeout: options.isOllama ? 120_000 : 60_000,
        });
        this.model = model;
        this.imageModel = 'dall-e-3';
        this.isOllama = options.isOllama === true;
    }

    async generateText(prompt: string, systemInstruction?: string): Promise<string> {
        try {
            const messages: any[] = [];
            if (systemInstruction) {
                messages.push({ role: 'system', content: systemInstruction });
            }
            messages.push({ role: 'user', content: prompt });

            const request: any = {
                model: this.model,
                messages,
                temperature: 0.85,
                top_p: 0.92
            };

            if (this.isOllama) {
                request.reasoning_effort = 'none';
            }

            const response = await this.openai.chat.completions.create(request);

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

            const schemaRef = z.toJSONSchema(responseSchema) as any;

            const request: any = {
                model: this.model,
                messages,
                temperature: 0.1,
                response_format: this.isOllama
                    ? {
                        type: 'json_schema',
                        json_schema: {
                            name: 'ResponseSchema',
                            strict: true,
                            schema: schemaRef
                        }
                    }
                    : { type: 'json_object' }
            };

            if (this.isOllama) {
                request.reasoning_effort = 'none';
            }

            const response = await this.openai.chat.completions.create(request);

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
            const fieldKeys = Object.keys(schemaRef?.properties || {});
            const onlyField = fieldKeys.length === 1 ? fieldKeys[0] : undefined;
            if (onlyField && Array.isArray(parsed)) {
                targetParsed = { [onlyField]: parsed };
            } else if (Array.isArray(parsed) && fieldKeys.includes('shots')) {
                targetParsed = { shots: parsed };
            } else if (Array.isArray(parsed) && fieldKeys.includes('profiles')) {
                targetParsed = { profiles: parsed };
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
