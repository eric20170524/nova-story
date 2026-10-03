import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { TtsService, TtsServiceError } from './tts_service';

const catalog = { voices: [{ id: 'K01', tier: 'light' }] };
const unavailable = (err: unknown) =>
    err instanceof TtsServiceError && err.code === 'TTS_UNAVAILABLE' && err.status === 503;

async function listen(server: Server): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}

test('TTS health, catalog and speech requests never follow redirects', async t => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
        targetHits += 1;
        res.end(JSON.stringify(catalog));
    });
    const targetUrl = await listen(target);
    t.after(() => close(target));

    let redirectPath = '';
    let redirectStatus = 302;
    const upstream = createServer((req, res) => {
        if (req.url === redirectPath) {
            res.writeHead(redirectStatus, { location: `${targetUrl}/redirect-target` });
            res.end();
        } else {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(req.url === '/api/health' ? { ok: true } : catalog));
        }
    });
    const baseUrl = await listen(upstream);
    t.after(() => close(upstream));

    for (const status of [301, 302, 303, 307, 308]) {
        redirectStatus = status;
        for (const endpoint of ['/api/health', '/api/voices']) {
            redirectPath = endpoint;
            const result = await TtsService.getStatus({ baseUrl, enabled: true });
            assert.equal(result.ok, false, `${endpoint}: ${status}`);
        }
        redirectPath = '/api/voices';
        await assert.rejects(() => TtsService.getVoices({ baseUrl, enabled: true }), unavailable);
        await assert.rejects(() => TtsService.preview({ baseUrl, enabled: true, voice_id: 'K01' }), unavailable);
        redirectPath = '/v1/audio/speech';
        await assert.rejects(() => TtsService.preview({ baseUrl, enabled: true, voice_id: 'K01' }), unavailable);
    }
    assert.equal(targetHits, 0, 'Redirect destination must receive no GET or POST requests');
});

for (const declaredLength of [undefined, '1', 'invalid']) {
    test(`preview stops reading oversized audio with content-length=${declaredLength}`, async () => {
        let reads = 0;
        let cancelled = false;
        let signal: AbortSignal | undefined;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                reads += 1;
                controller.enqueue(new Uint8Array(3));
                if (reads === 20) controller.close();
            },
            cancel() { cancelled = true; }
        }, { highWaterMark: 0 });
        const fetchFn = (async (url, init) => {
            if (String(url).endsWith('/api/voices')) return Response.json(catalog);
            signal = init?.signal ?? undefined;
            return new Response(stream, { headers: declaredLength ? { 'content-length': declaredLength } : {} });
        }) as typeof fetch;

        await assert.rejects(() => TtsService.preview({
            voice_id: 'K01', baseUrl: 'http://127.0.0.1:8765', enabled: true, fetchFn, maxBytes: 5
        }), unavailable);
        assert.equal(reads, 2, 'Must stop on the first chunk crossing the limit');
        assert.equal(cancelled, true, 'Must cancel the unfinished response body');
        assert.equal(signal?.aborted, true, 'Must abort the upstream request');
        assert.equal(stream.locked, false);
    });
}

test('preview cancels audio before reading when declared size exceeds the limit', async () => {
    let reads = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        pull() { reads += 1; },
        cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    const fetchFn = (async url => String(url).endsWith('/api/voices')
        ? Response.json(catalog)
        : new Response(stream, { headers: { 'content-length': '6' } })) as typeof fetch;
    await assert.rejects(() => TtsService.preview({
        voice_id: 'K01', baseUrl: 'http://127.0.0.1:8765', enabled: true, fetchFn, maxBytes: 5
    }), unavailable);
    assert.equal(reads, 0);
    assert.equal(cancelled, true);
});

test('preview accepts audio exactly at the limit across multiple chunks', async () => {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4, 5]));
            controller.close();
        }
    });
    const fetchFn = (async url => String(url).endsWith('/api/voices')
        ? Response.json(catalog) : new Response(stream)) as typeof fetch;
    const result = await TtsService.preview({
        voice_id: 'K01', baseUrl: 'http://127.0.0.1:8765', enabled: true, fetchFn, maxBytes: 5
    });
    assert.deepEqual(result.buffer, Buffer.from([1, 2, 3, 4, 5]));
    assert.equal(stream.locked, false);
});

test('preview timeout remains active while reading the audio body', async () => {
    const fetchFn = (async (url, init) => {
        if (String(url).endsWith('/api/voices')) return Response.json(catalog);
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1]));
                init?.signal?.addEventListener('abort', () => controller.error(
                    new DOMException('Aborted', 'AbortError')
                ), { once: true });
            }
        });
        return new Response(stream);
    }) as typeof fetch;
    await assert.rejects(() => TtsService.preview({
        voice_id: 'K01', baseUrl: 'http://127.0.0.1:8765', enabled: true, fetchFn, timeoutMs: 20
    }), (err: unknown) => err instanceof TtsServiceError && err.code === 'TTS_TIMEOUT' && err.status === 504);
});
