import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { z } from 'zod';
import { OpenAIProvider } from './openai_provider';

async function withTextServer(
    respond: (response: http.ServerResponse, body: any) => void,
    run: (provider: OpenAIProvider) => Promise<void>
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
        await run(new OpenAIProvider('test-key', 'fake-model', `http://127.0.0.1:${address.port}/v1`));
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

function sendChunk(response: http.ServerResponse, content: string, finishReason: string | null = null) {
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`);
}

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
            aspectRatio: '3:4',
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
