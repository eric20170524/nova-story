import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { z } from 'zod';
import { OpenAIProvider } from './openai_provider';

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
