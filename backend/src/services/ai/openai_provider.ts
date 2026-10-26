import OpenAI from 'openai';
import { z } from 'zod';
import { extractThinkingConceptionText, type AIProvider, type ImageGenerationOptions, type StructuredGenOptions, type TextGenOptions } from './base';
import { logger } from '../../core/logging';
import { inheritCharacterTraitConfidence } from '../../schemas/llm';

function truncateLog(text: string, maxLength = 500): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}... [truncated, total length ${text.length}]`;
}

export class OpenAIProvider implements AIProvider {
    private openai: OpenAI;
    private model: string;
    private baseUrl: string;
    private imageModel: string;
    private isOllama: boolean;

    constructor(
        apiKey: string,
        model: string = 'gpt-4o',
        baseUrl?: string,
        options: { isOllama?: boolean; timeoutMs?: number } = {}
    ) {
        this.openai = new OpenAI({
            apiKey,
            baseURL: baseUrl,
            timeout: options.timeoutMs ?? (options.isOllama ? 600_000 : 60_000),
            maxRetries: options.isOllama ? 0 : 2,
        });
        this.isOllama = options.isOllama === true;
        this.baseUrl = baseUrl || '';
        this.model = !this.isOllama && /^qwen3\.?8-27b$/i.test(model.trim()) ? 'qwen3.8-27b' : model;
        this.imageModel = 'dall-e-3';
    }

    /** Public Gemma is served through EdgeOne, which answers 524 if a completion stays silent. */
    private isRemoteGemma(): boolean {
        return !this.isOllama && (/gemma/i.test(this.model) || /\/gemma4\b/i.test(this.baseUrl));
    }

    private isRemoteQwen(): boolean {
        return !this.isOllama && (/qwen3\.?8/i.test(this.model) || /\/qwen38\b/i.test(this.baseUrl));
    }

    private isRemoteLab(): boolean {
        return this.isRemoteGemma() || this.isRemoteQwen();
    }

    private applyThinkingConfig(request: any, enableThinking?: boolean): void {
        if (enableThinking === true) {
            request.chat_template_kwargs = {
                ...(request.chat_template_kwargs || {}),
                enable_thinking: true,
            };
            delete request.reasoning_effort;
            return;
        }
        if (this.isOllama || this.isRemoteLab()) {
            request.reasoning_effort = 'none';
            if (this.isRemoteLab() || enableThinking === false) {
                request.chat_template_kwargs = {
                    ...(request.chat_template_kwargs || {}),
                    enable_thinking: false,
                };
            }
        } else if (enableThinking === false) {
            request.chat_template_kwargs = {
                ...(request.chat_template_kwargs || {}),
                enable_thinking: false,
            };
        }
    }

    async generateText(prompt: string, systemInstruction?: string, options?: TextGenOptions): Promise<string> {
        try {
            const messages: any[] = [];
            if (systemInstruction) {
                messages.push({ role: 'system', content: systemInstruction });
            }
            messages.push({ role: 'user', content: prompt });

            const request: any = {
                model: this.model,
                messages,
                temperature: typeof options?.temperature === 'number' ? options.temperature : 0.85,
                top_p: 0.92
            };

            if (typeof options?.maxTokens === 'number' && options.maxTokens > 0) {
                request.max_tokens = options.maxTokens;
            }

            this.applyThinkingConfig(request, options?.enableThinking);
            const requestOptions = options?.signal ? { signal: options.signal } : undefined;

            logger.info(`[OpenAI Prompt Input]: ${truncateLog(prompt)}`);
            if (options?.stream || this.isRemoteLab()) {
                // Receive long rewrites incrementally so the upstream proxy does not
                // have to wait for the entire chapter before receiving a response.
                const stream = (await this.openai.chat.completions.create({ ...request, stream: true }, requestOptions)) as unknown as AsyncIterable<any>;
                let content = '';
                let reasoningContent = '';
                let finishReason: string | null = null;
                for await (const chunk of stream) {
                    const choice = chunk.choices.find((item: any) => item.index === 0);
                    content += choice?.delta?.content || '';
                    reasoningContent += (choice?.delta as any)?.reasoning_content || (choice?.delta as any)?.reasoning || '';
                    if (choice?.finish_reason) finishReason = choice.finish_reason;
                }
                if (!content.trim() && options?.enableThinking && finishReason === 'stop' && reasoningContent.trim()) {
                    content = reasoningContent;
                }
                if (options?.enableThinking && finishReason === 'length' && extractThinkingConceptionText(content)) {
                    logger.info(`[OpenAI Thinking Conception Output (length-capped)]: ${truncateLog(content)}`);
                    return content;
                }
                // A closed connection or token limit must never turn a partial
                // rewrite into a successful replacement of the original chapter.
                if (finishReason !== 'stop' || !content.trim()) {
                    throw new Error(`改写生成未完整结束（${finishReason || '连接中断或空响应'}），未修改章节正文`);
                }
                logger.info(`[OpenAI Text Output]: ${truncateLog(content)}`);
                return content;
            }
            const response = await this.openai.chat.completions.create(request, requestOptions);
            const nonStreamFinishReason = response.choices[0]?.finish_reason;
            let content = response.choices[0]?.message?.content || '';
            if (!content.trim() && options?.enableThinking && nonStreamFinishReason === 'stop') {
                content = (response.choices[0]?.message as any)?.reasoning_content || (response.choices[0]?.message as any)?.reasoning || '';
            }
            if (options?.enableThinking && nonStreamFinishReason === 'length' && extractThinkingConceptionText(content)) {
                logger.info(`[OpenAI Thinking Conception Output (length-capped)]: ${truncateLog(content)}`);
                return content;
            }
            if (nonStreamFinishReason !== 'stop' || !content.trim()) {
                throw new Error(`Text generation incomplete: finish_reason=${nonStreamFinishReason || 'missing'}`);
            }
            logger.info(`[OpenAI Text Output]: ${truncateLog(content)}`);

            return content;
        } catch (error) {
            logger.error(`OpenAI generateText error: ${error}`);
            if ((error as any)?.status === 524) {
                throw Object.assign(new Error('模型服务响应超时（HTTP 524），未生成完整正文。请稍后重试，或检查模型服务与网关超时配置。'), { status: 524, cause: error });
            }
            throw error;
        }
    }

    async generateStructured<T>(
        prompt: string,
        responseSchema: z.ZodSchema<T>,
        systemInstruction?: string,
        options?: StructuredGenOptions
    ): Promise<T> {
        try {
            const sys = options?.systemInstruction ?? systemInstruction;
            const messages: any[] = [];
            if (sys) {
                messages.push({ role: 'system', content: sys });
            }
            messages.push({ role: 'user', content: prompt });

            let schemaRef: any = null;
            try {
                schemaRef = z.toJSONSchema(responseSchema) as any;
            } catch {
                schemaRef = null;
            }
            const temperature =
                typeof options?.temperature === 'number' ? options.temperature : 0.1;

            const request: any = {
                model: this.model,
                messages,
                temperature,
                response_format: (this.isOllama && schemaRef)
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

            this.applyThinkingConfig(request, options?.enableThinking ?? false);
            if(typeof options?.seed==='number')request.seed=options.seed;

            logger.info(`[OpenAI Structured Prompt Input]: ${truncateLog(prompt)}`);
            const inferenceStart=Date.now();
            const requestOptions={signal:options?.signal,...(options?.transportRetries!==undefined?{maxRetries:options.transportRetries}:{})};
            let content='';
            let finishReason:string|null=null;
            try {
                if(this.isRemoteLab()){
                    // EdgeOne's HTTP response timeout treats a silent non-streaming body as failure.
                    const stream = (await this.openai.chat.completions.create({ ...request, stream: true }, requestOptions)) as unknown as AsyncIterable<any>;
                    for await(const chunk of stream){
                        const choice=chunk.choices.find((item: any)=>item.index===0);
                        content+=choice?.delta?.content||'';
                        if(choice?.finish_reason)finishReason=choice.finish_reason;
                    }
                    options?.onInference?.({model:this.model,elapsed_ms:Date.now()-inferenceStart,finish_reason:finishReason});
                }else{
                    const response=await this.openai.chat.completions.create(request,requestOptions);
                    finishReason=response.choices[0]?.finish_reason||null;
                    content=response.choices[0]?.message?.content||'';
                    options?.onInference?.({model:this.model,elapsed_ms:Date.now()-inferenceStart,response,usage:response.usage,finish_reason:finishReason});
                }
            }
            catch(error:any){options?.onInference?.({model:this.model,elapsed_ms:Date.now()-inferenceStart,error:error.message});throw error;}
            if (finishReason !== 'stop') {
                throw new Error(`Structured generation incomplete: finish_reason=${finishReason || 'missing'}`);
            }
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
            } else if (
                onlyField && parsed && typeof parsed === 'object'
                && !Array.isArray((parsed as Record<string, unknown>)[onlyField])
            ) {
                // json_object mode does not enforce the key. Gemma named this array "resolutions",
                // and fact classification came back as {"u_1":"visual"} instead of {items:[...]}.
                const record = parsed as Record<string, unknown>;
                const arrays = Object.values(record).filter(Array.isArray);
                if (arrays.length === 1) targetParsed = { ...record, [onlyField]: arrays[0] };
                else {
                    const itemKeys = Object.keys(schemaRef?.properties?.[onlyField]?.items?.properties || {});
                    const valueKey = itemKeys.length === 2 && itemKeys.includes('id') ? itemKeys.find(key => key !== 'id') : undefined;
                    const entries = Object.entries(record).filter(([key]) => key !== onlyField);
                    const strings = entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string');
                    if (valueKey && entries.length > 0 && strings.length === entries.length) {
                        targetParsed = { [onlyField]: entries.map(([id, value]) => ({ id, [valueKey]: value })) };
                    } else if (strings.length === 1 && typeof record[onlyField] !== 'string') {
                        // {"label":"one_frame"} or {"result":"sequential"} when the schema field has another name.
                        targetParsed = { ...record, [onlyField]: strings[0]![1] };
                    } else if (itemKeys.includes('id')) {
                        // Fidelity audit came back as {"0":{"status":"preserved","evidence":"..."}}
                        // instead of {facts:[{id,status,evidence}]}.
                        const objects = entries.filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value));
                        if (entries.length > 0 && objects.length === entries.length) {
                            const idNode = schemaRef?.properties?.[onlyField]?.items?.properties?.id;
                            const idTypes = [idNode?.type, ...(Array.isArray(idNode?.anyOf) ? idNode.anyOf.map((item: { type?: string }) => item?.type) : [])];
                            const numericId = idTypes.includes('number') || idTypes.includes('integer');
                            targetParsed = {
                                [onlyField]: objects.map(([key, value]) => {
                                    const row = { ...(value as Record<string, unknown>) };
                                    if (row.id === undefined) row.id = numericId && /^\d+$/.test(key) ? Number(key) : key;
                                    else if (numericId && typeof row.id === 'string' && /^\d+$/.test(row.id)) row.id = Number(row.id);
                                    return row;
                                }),
                            };
                        }
                    }
                }
            }
            if (onlyField && targetParsed && typeof targetParsed === 'object' && !Array.isArray(targetParsed)) {
                const record = targetParsed as Record<string, unknown>;
                const rows = record[onlyField];
                const itemKeys = Object.keys(schemaRef?.properties?.[onlyField]?.items?.properties || {});
                // split_actions asked for {text} objects and Gemma returned ["视线从南宫雪绯红的脸颊移向", "远方裴雨涵所在的方向，"].
                if (itemKeys.length === 1 && Array.isArray(rows) && rows.length > 0 && rows.every(row => typeof row === 'string')) {
                    const key = itemKeys[0]!;
                    targetParsed = { ...record, [onlyField]: rows.map(text => ({ [key]: text })) };
                } else if (onlyField === 'spans' && !Array.isArray(rows)) {
                    // repair_fact asked for spans:[{text,kind}] and Gemma returned {"span":"春潮的门，","kind":"visual"}.
                    const text = typeof record.span === 'string' ? record.span : typeof record.text === 'string' ? record.text : undefined;
                    if (text) {
                        const kind = typeof record.kind === 'string' ? record.kind : undefined;
                        targetParsed = { spans: [kind ? { text, kind } : { text }] };
                    }
                }
            }

            return responseSchema.parse(inheritCharacterTraitConfidence(targetParsed));

        } catch (error) {
            logger.error(`OpenAI generateStructured error: ${error}`);
            throw error;
        }
    }

    async generateImage(prompt: string, options?: ImageGenerationOptions, token?: string): Promise<{ url?: string; b64_json?: string; data?: Buffer; error?: string }> {
        try {
            const size = !options || options.aspectRatio === '1:1'
                ? '1024x1024'
                : options.aspectRatio === '16:9' ? '1792x1024' : '1024x1792';
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
