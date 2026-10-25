import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { z } from 'zod';
import { OpenAIProvider } from './openai_provider';

async function withTextServer(
    respond: (response: http.ServerResponse, body: any) => void,
    run: (provider: OpenAIProvider) => Promise<void>,
    model = 'fake-model'
) {
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        respond(response, JSON.parse(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        assert(address && typeof address !== 'string');
        await run(new OpenAIProvider('test-key', model, `http://127.0.0.1:${address.port}/v1`));
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

function sendChunk(response: http.ServerResponse, content: string, finishReason: string | null = null) {
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`);
}

test('structured output rejects length termination even when the partial body is valid JSON', async () => {
    await withTextServer(response => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'length' }] }));
    }, async provider => {
        await assert.rejects(provider.generateStructured('check', z.object({ ok: z.boolean() })), /finish_reason=length/);
    });
});

test('long text uses streaming and returns only the complete joined body', async () => {
    await withTextServer((response, body) => {
        assert.equal(body.stream, true);
        assert.equal(body.messages[0].content, 'system');
        response.setHeader('content-type', 'text/event-stream');
        sendChunk(response, '雨声');
        sendChunk(response, '贴着窗沿滑落。', 'stop');
        response.end('data: [DONE]\n\n');
    }, async provider => {
        assert.equal(await provider.generateText('rewrite', 'system', { stream: true }), '雨声贴着窗沿滑落。');
    });
});

test('truncated, empty, and unterminated streams reject partial rewrites', async () => {
    for (const [content, reason] of [['partial', 'length'], ['partial', null], ['', 'stop']] as const) {
        await withTextServer(response => {
            response.setHeader('content-type', 'text/event-stream');
            sendChunk(response, content, reason);
            response.end('data: [DONE]\n\n');
        }, async provider => {
            await assert.rejects(provider.generateText('rewrite', undefined, { stream: true }), /未完整结束/);
        });
    }
});

test('a one-field schema accepts the array when the model uses another key', async () => {
    await withTextServer(response => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: '{"resolutions":[{"index":0,"entity_id":"character:18","status":"resolved","visibility":"visible"}]}',
                },
                finish_reason: 'stop',
            }],
        }));
    }, async provider => {
        const schema = z.object({
            bindings: z.array(z.object({
                index: z.number(),
                entity_id: z.string(),
                status: z.string(),
                visibility: z.string(),
            })),
        });
        const result = await provider.generateStructured('bind', schema);
        assert.equal(result.bindings.length, 1);
        assert.equal(result.bindings[0]?.entity_id, 'character:18');
    });
});

test('a one-field items schema accepts an id-keyed object map', async () => {
    await withTextServer(response => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: '{"0":{"status":"preserved","evidence":"hands behind her back"},"1":{"status":"missing","evidence":""}}',
                },
                finish_reason: 'stop',
            }],
        }));
    }, async provider => {
        const schema = z.object({
            facts: z.array(z.object({
                id: z.number().int(),
                status: z.enum(['preserved', 'missing', 'contradicted']),
                evidence: z.string(),
            })),
        });
        const result = await provider.generateStructured('audit', schema);
        assert.deepEqual(result.facts, [
            { id: 0, status: 'preserved', evidence: 'hands behind her back' },
            { id: 1, status: 'missing', evidence: '' },
        ]);
    });
});

test('a one-field items schema accepts an id-to-label map', async () => {
    await withTextServer(response => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: '{"u_1":"visual","u_2":"internal"}',
                },
                finish_reason: 'stop',
            }],
        }));
    }, async provider => {
        const schema = z.object({
            items: z.array(z.object({
                id: z.enum(['u_1', 'u_2']),
                kind: z.enum(['visual', 'audio', 'internal', 'figurative', 'mixed', 'uncertain']),
            })),
        });
        const result = await provider.generateStructured('classify', schema);
        assert.deepEqual(result.items, [
            { id: 'u_1', kind: 'visual' },
            { id: 'u_2', kind: 'internal' },
        ]);
    });
});

test('a one-field enum accepts the value when the model uses another key', async () => {
    await withTextServer(response => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
            choices: [{
                index: 0,
                message: { role: 'assistant', content: '{"label":"one_frame"}' },
                finish_reason: 'stop',
            }],
        }));
    }, async provider => {
        const schema = z.object({ result: z.enum(['one_frame', 'sequence', 'uncertain']) });
        const result = await provider.generateStructured('atomicity', schema);
        assert.equal(result.result, 'one_frame');
    });
    await withTextServer(response => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
            choices: [{
                index: 0,
                message: { role: 'assistant', content: '{"result":"sequential"}' },
                finish_reason: 'stop',
            }],
        }));
    }, async provider => {
        const schema = z.object({ relation: z.enum(['simultaneous', 'sequential', 'uncertain']) });
        const result = await provider.generateStructured('beat_relation', schema);
        assert.equal(result.relation, 'sequential');
    });
});

test('a span list accepts strings when each item has one text field', async () => {
    await withTextServer(response => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
            choices: [{
                index: 0,
                message: { role: 'assistant', content: '{"spans":["视线从南宫雪绯红的脸颊移向","远方裴雨涵所在的方向，"]}' },
                finish_reason: 'stop',
            }],
        }));
    }, async provider => {
        const schema = z.object({ spans: z.array(z.object({ text: z.string().min(1) })).min(1) });
        const result = await provider.generateStructured('split_actions', schema);
        assert.deepEqual(result.spans, [
            { text: '视线从南宫雪绯红的脸颊移向' },
            { text: '远方裴雨涵所在的方向，' },
        ]);
    });
});

test('a spans schema accepts one span object flattened beside kind', async () => {
    await withTextServer(response => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
            choices: [{
                index: 0,
                message: { role: 'assistant', content: '{"span":"春潮的门，","kind":"visual"}' },
                finish_reason: 'stop',
            }],
        }));
    }, async provider => {
        const schema = z.object({
            spans: z.array(z.object({
                text: z.string().min(1),
                kind: z.enum(['visual', 'audio', 'internal', 'figurative']),
            })).min(1),
        });
        const result = await provider.generateStructured('repair_fact', schema);
        assert.deepEqual(result.spans, [{ text: '春潮的门，', kind: 'visual' }]);
    });
});

test('remote gemma streams structured JSON with thinking disabled', async () => {
    let capturedBody: any;
    await withTextServer((response, body) => {
        capturedBody = body;
        response.setHeader('content-type', 'text/event-stream');
        sendChunk(response, '{"ok":');
        sendChunk(response, 'true}', 'stop');
        response.end('data: [DONE]\n\n');
    }, async provider => {
        assert.deepEqual(await provider.generateStructured('check', z.object({ ok: z.boolean() })), { ok: true });
        assert.equal(capturedBody.stream, true);
        assert.equal(capturedBody.reasoning_effort, 'none');
        assert.equal(capturedBody.chat_template_kwargs.enable_thinking, false);
        assert.equal(capturedBody.response_format.type, 'json_object');
    }, 'gemma-4-31b');
});

test('remote gemma text calls stream even when the caller does not ask', async () => {
    await withTextServer((response, body) => {
        assert.equal(body.stream, true);
        assert.equal(body.reasoning_effort, 'none');
        assert.equal(body.chat_template_kwargs.enable_thinking, false);
        response.setHeader('content-type', 'text/event-stream');
        sendChunk(response, '完成', 'stop');
        response.end('data: [DONE]\n\n');
    }, async provider => {
        assert.equal(await provider.generateText('rewrite'), '完成');
    }, 'gemma-4-31b');
});

test('remote qwen text and structured calls stream to prevent proxy 524 timeouts', async () => {
    let capturedBody: any;
    await withTextServer((response, body) => {
        capturedBody = body;
        response.setHeader('content-type', 'text/event-stream');
        sendChunk(response, '{"qwen_ok":');
        sendChunk(response, 'true}', 'stop');
        response.end('data: [DONE]\n\n');
    }, async provider => {
        assert.deepEqual(await provider.generateStructured('check', z.object({ qwen_ok: z.boolean() })), { qwen_ok: true });
        assert.equal(capturedBody.stream, true);
        assert.equal(capturedBody.response_format.type, 'json_object');
    }, 'Qwen3.8-27B');

    await withTextServer((response, body) => {
        assert.equal(body.stream, true);
        response.setHeader('content-type', 'text/event-stream');
        sendChunk(response, '千问回答', 'stop');
        response.end('data: [DONE]\n\n');
    }, async provider => {
        assert.equal(await provider.generateText('rewrite'), '千问回答');
    }, 'qwen3.8-27b');
});

test('524 reports actionable upstream timeout instead of opaque status', async () => {
    await withTextServer(response => {
        response.statusCode = 524;
        response.end();
    }, async provider => {
        await assert.rejects(provider.generateText('rewrite', undefined, { stream: true }), error => {
            assert.equal((error as any).status, 524);
            assert.match((error as Error).message, /模型服务响应超时.*HTTP 524/);
            return true;
        });
    });
});

test('uses Ollama JSON Schema mode for structured responses', async () => {
    let capturedBody: any;
    const server = http.createServer(async (request, response) => {
        let rawBody = '';
        for await (const chunk of request) {
            rawBody += chunk;
        }
        capturedBody = JSON.parse(rawBody);

        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 0,
            model: 'fake-model',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: JSON.stringify({ items: [{ name: '测试' }] })
                },
                finish_reason: 'stop'
            }],
            usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2
            }
        }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
        const address = server.address();
        assert(address && typeof address !== 'string');

        const provider = new OpenAIProvider(
            'ollama',
            'fake-model',
            `http://127.0.0.1:${address.port}/v1`,
            { isOllama: true }
        );
        const schema = z.object({
            items: z.array(z.object({ name: z.string() }))
        });

        const result = await provider.generateStructured('Return one item.', schema);

        assert.deepEqual(result, { items: [{ name: '测试' }] });
        assert.equal(capturedBody.temperature, 0.1);
        assert.equal(capturedBody.reasoning_effort, 'none');
        assert.equal(capturedBody.response_format.type, 'json_schema');
        assert.equal(
            capturedBody.response_format.json_schema.schema.properties.items.type,
            'array'
        );
    }
    finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test('maps the logical portrait canvas to the image provider size', async () => {
    let capturedBody: any;
    const server = http.createServer(async (request, response) => {
        let rawBody = '';
        for await (const chunk of request) rawBody += chunk;
        capturedBody = JSON.parse(rawBody);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
            created: 0,
            data: [{ url: 'https://example.test/generated.png' }]
        }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
        const address = server.address();
        assert(address && typeof address !== 'string');
        const provider = new OpenAIProvider(
            'test-key',
            'fake-model',
            `http://127.0.0.1:${address.port}/v1`
        );
        const result = await provider.generateImage('portrait', {
            width: 768,
            height: 1024,
            aspectRatio: '9:16',
            imageSize: '1K'
        });

        assert.equal(capturedBody.size, '1024x1792');
        assert.equal(result.url, 'https://example.test/generated.png');
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});
