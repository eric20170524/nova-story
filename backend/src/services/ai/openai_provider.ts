import OpenAI from 'openai';
import { z } from 'zod';
import type { AIProvider } from './base';
import { logger } from '../../core/logging';

function truncateLog(text: string, maxLength = 500): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}... [truncated, total length ${text.length}]`;
}

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

            logger.info(`[OpenAI Prompt Input]: ${truncateLog(prompt)}`);
            const response = await this.openai.chat.completions.create(request);

            const content = response.choices[0]?.message?.content || '';
            logger.info(`[OpenAI Text Output]: ${truncateLog(content)}`);

            return content;
        } catch (error) {
            logger.error(`OpenAI generateText error: ${error}`);
            throw error;
        }
    }

    async generateStructured<T>(
        prompt: string,
        responseSchema: z.ZodSchema<T>,
        systemInstruction?: string,
        options?: { temperature?: number; maxTokens?: number; systemInstruction?: string }
    ): Promise<T> {
        try {
            const sys = options?.systemInstruction ?? systemInstruction;
            const messages: any[] = [];
            if (sys) {
                messages.push({ role: 'system', content: sys });
            }
            messages.push({ role: 'user', content: prompt });

            const schemaRef = z.toJSONSchema(responseSchema) as any;
            const temperature =
                typeof options?.temperature === 'number' ? options.temperature : 0.1;

            const request: any = {
                model: this.model,
                messages,
                temperature,
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

            if (typeof options?.maxTokens === 'number' && options.maxTokens > 0) {
                request.max_tokens = options.maxTokens;
            }

            if (this.isOllama) {
                request.reasoning_effort = 'none';
            }

            logger.info(`[OpenAI Structured Prompt Input]: ${truncateLog(prompt)}`);
            const response = await this.openai.chat.completions.create(request);

            const content = response.choices[0]?.message?.content || '';
            logger.info(`[OpenAI Structured Output Raw]: ${truncateLog(content)}`);

            const withoutThink = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            const codeBlockMatch = withoutThink.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
            let jsonString = (codeBlockMatch && codeBlockMatch[1]) ? codeBlockMatch[1].trim() : withoutThink;

            if (!codeBlockMatch) {
                const objectMatch = jsonString.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
                if (objectMatch && objectMatch[0]) {
                    jsonString = objectMatch[0].trim();
                }
            }

            const parsed = JSON.parse(jsonString);

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

            const url = response.data?.[0]?.url;
            return url ? { url } : { error: 'The image provider returned no image URL.' };
        } catch (error: any) {
            logger.error(`OpenAI Image generation error: ${error}`);
            return { error: error.message };
        }
    }
}
