import assert from 'node:assert/strict';
import test from 'node:test';
import { redactTtsBaseUrl, validateTtsBaseUrl, TtsService, TtsServiceError } from './tts_service';
import { SettingsManager } from '../core/settings_manager';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('validateTtsBaseUrl accepts valid loopback URLs with or without trailing slash', () => {
    const cases = [
        ['http://127.0.0.1:8765', 'http://127.0.0.1:8765'],
        ['http://127.0.0.1:8765/', 'http://127.0.0.1:8765'],
        ['http://localhost:8765', 'http://localhost:8765'],
        ['http://localhost:8765/', 'http://localhost:8765'],
        ['http://[::1]:8765', 'http://[::1]:8765'],
        ['http://[::1]:8765/', 'http://[::1]:8765'],
        ['https://127.0.0.1:8765', 'https://127.0.0.1:8765'],
    ];

    for (const [input, expected] of cases) {
        const result = validateTtsBaseUrl(input);
        assert.equal(result.ok, true, `Expected ${input} to be valid`);
        if (result.ok) {
            assert.equal(result.url, expected);
            assert.equal(result.origin, expected);
        }
    }
});

test('validateTtsBaseUrl rejects malformed or empty inputs with TTS_URL_REJECTED', () => {
    const invalidInputs = [
        '',
        '   ',
        null,
        undefined,
        123,
        'not-a-valid-url',
        'http://',
    ];

    for (const input of invalidInputs) {
        const result = validateTtsBaseUrl(input);
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'TTS_URL_REJECTED');
        }
    }
});

test('validateTtsBaseUrl rejects non-http(s) protocols', () => {
    const invalidProtocols = [
        'ftp://127.0.0.1:8765',
        'file:///path/to/something',
        'ws://127.0.0.1:8765',
    ];

    for (const input of invalidProtocols) {
        const result = validateTtsBaseUrl(input);
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'TTS_URL_REJECTED');
        }
    }
});

test('validateTtsBaseUrl rejects username and password credentials', () => {
    const credInputs = [
        'http://user:pass@127.0.0.1:8765',
        'http://admin@127.0.0.1:8765',
        'http://:pass@localhost:8765',
    ];

    for (const input of credInputs) {
        const result = validateTtsBaseUrl(input);
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'TTS_URL_REJECTED');
        }
    }
});

test('validateTtsBaseUrl rejects non-empty paths, query params, and hashes', () => {
    const invalidPaths = [
        'http://127.0.0.1:8765/api',
        'http://127.0.0.1:8765/v1/audio',
        'http://127.0.0.1:8765/subpath',
        'http://127.0.0.1:8765?param=1',
        'http://127.0.0.1:8765#section',
    ];

    for (const input of invalidPaths) {
        const result = validateTtsBaseUrl(input);
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'TTS_URL_REJECTED');
        }
    }
});

test('validateTtsBaseUrl rejects non-loopback hosts unless TTS_ALLOW_REMOTE=1', () => {
    const remoteHosts = [
        'http://192.168.1.100:8765',
        'http://10.0.0.5:8765',
        'http://tts.example.com:8765',
        'http://127.0.0.2:8765',
    ];

    const originalAllowRemote = process.env.TTS_ALLOW_REMOTE;
    try {
        delete process.env.TTS_ALLOW_REMOTE;

        for (const input of remoteHosts) {
            const rejected = validateTtsBaseUrl(input);
            assert.equal(rejected.ok, false);
            if (!rejected.ok) {
                assert.equal(rejected.code, 'TTS_URL_REJECTED');
            }

            // With option allowRemote: true
            const allowedByOption = validateTtsBaseUrl(input, { allowRemote: true });
            assert.equal(allowedByOption.ok, true, `Expected ${input} to be allowed with allowRemote: true`);

            // With env TTS_ALLOW_REMOTE=1
            process.env.TTS_ALLOW_REMOTE = '1';
            const allowedByEnv = validateTtsBaseUrl(input);
            assert.equal(allowedByEnv.ok, true, `Expected ${input} to be allowed with TTS_ALLOW_REMOTE=1`);
            delete process.env.TTS_ALLOW_REMOTE;
        }
    } finally {
        if (originalAllowRemote === undefined) {
            delete process.env.TTS_ALLOW_REMOTE;
        } else {
            process.env.TTS_ALLOW_REMOTE = originalAllowRemote;
        }
    }
});

test('SettingsManager defaults tts settings and supports TTS_BASE_URL override', () => {
    const originalConfigDir = process.env.NOVASTORY_CONFIG_DIR;
    const originalTtsBaseUrl = process.env.TTS_BASE_URL;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-tts-settings-'));

    try {
        process.env.NOVASTORY_CONFIG_DIR = tempDir;
        delete process.env.TTS_BASE_URL;

        // 1. Default settings
        const initial = SettingsManager.loadSettings();
        assert.equal(initial.tts?.base_url, 'http://127.0.0.1:8765');
        assert.equal(initial.tts?.enabled, true);

        // 2. Env override
        process.env.TTS_BASE_URL = 'http://127.0.0.1:9090';
        const overridden = SettingsManager.loadSettings();
        assert.equal(overridden.tts?.base_url, 'http://127.0.0.1:9090');

        // 3. Save settings updates .env
        delete process.env.TTS_BASE_URL;
        SettingsManager.saveSettings({
            tts: {
                base_url: 'http://localhost:8765',
                enabled: true
            }
        });

        const envContent = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
        assert.match(envContent, /^TTS_BASE_URL=http:\/\/localhost:8765$/m);
    } finally {
        if (originalConfigDir === undefined) delete process.env.NOVASTORY_CONFIG_DIR;
        else process.env.NOVASTORY_CONFIG_DIR = originalConfigDir;

        if (originalTtsBaseUrl === undefined) delete process.env.TTS_BASE_URL;
        else process.env.TTS_BASE_URL = originalTtsBaseUrl;

        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('assertValidTtsBaseUrl and validateTtsBaseUrl reject invalid URLs without making network requests', async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = () => {
        fetchCalled = true;
        throw new Error('fetch should never be called when URL is invalid');
    };

    try {
        const invalidUrls = [
            'http://127.0.0.1:8765/api',
            'http://user:pass@127.0.0.1:8765',
            'http://192.168.1.1:8765',
            'ftp://127.0.0.1:8765',
            'not-a-url',
        ];

        for (const url of invalidUrls) {
            const validation = validateTtsBaseUrl(url, { allowRemote: false });
            assert.equal(validation.ok, false);
            assert.equal(validation.code, 'TTS_URL_REJECTED');
            assert.equal(fetchCalled, false, `Fetch should not be called for ${url}`);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('normalizeTtsVoiceCatalog sanitizes raw fixture, strips absolute paths & internal fields, and sorts tiers', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'tts_voices_sample.json');
    const rawFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.equal(rawFixture.voices.length, 32);

    // Confirm raw fixture contains clone paths and internal fields
    const rawText = JSON.stringify(rawFixture);
    assert.match(rawText, /\/Users\//);
    assert.match(rawText, /"ref_audio"/);
    assert.match(rawText, /"instruct"/);
    assert.match(rawText, /"model"/);
    assert.match(rawText, /"resource"/);

    const { normalizeTtsVoiceCatalog } = require('./tts_service');
    const normalized = normalizeTtsVoiceCatalog(rawFixture.voices);
    assert.equal(normalized.length, 32);

    const normalizedText = JSON.stringify(normalized);
    // AC requirement: Response text must NOT have absolute paths, instruct, model, or engine voice field
    assert.doesNotMatch(normalizedText, /\/Users\//, 'Must not contain /Users/ absolute path');
    assert.doesNotMatch(normalizedText, /"ref_audio"/i, 'Must not contain ref_audio');
    assert.doesNotMatch(normalizedText, /"ref_text"/i, 'Must not contain ref_text');
    assert.doesNotMatch(normalizedText, /"instruct"/i, 'Must not contain instruct');
    assert.doesNotMatch(normalizedText, /"model"/i, 'Must not contain model');
    assert.doesNotMatch(normalizedText, /"voice":/i, 'Must not contain engine field voice');
    assert.doesNotMatch(normalizedText, /"resource"/i, 'Must not contain resource');

    // Each normalized item must have strictly the 9 public keys
    const allowedKeys = ['description', 'gender', 'id', 'locale', 'name', 'offline', 'provider', 'style', 'tier'];
    for (const item of normalized) {
        const itemKeys = Object.keys(item).sort();
        assert.deepEqual(itemKeys, allowedKeys);
    }

    // Tiers order: light (4) -> quality (13) -> clone (2) -> online (13)
    const tiers = normalized.map((item: any) => item.tier);
    const lightItems = normalized.filter((item: any) => item.tier === 'light');
    const qualityItems = normalized.filter((item: any) => item.tier === 'quality');
    const cloneItems = normalized.filter((item: any) => item.tier === 'clone');
    const onlineItems = normalized.filter((item: any) => item.tier === 'online');

    assert.equal(lightItems.length, 4);
    assert.equal(qualityItems.length, 13);
    assert.equal(cloneItems.length, 2);
    assert.equal(onlineItems.length, 13);

    // Verify ordering in output array
    assert.deepEqual(tiers.slice(0, 4), ['light', 'light', 'light', 'light']);
    assert.deepEqual(tiers.slice(4, 17), Array(13).fill('quality'));
    assert.deepEqual(tiers.slice(17, 19), ['clone', 'clone']);
    assert.deepEqual(tiers.slice(19, 32), Array(13).fill('online'));

    // Check stable id sorting within tiers
    for (const group of [lightItems, qualityItems, cloneItems, onlineItems]) {
        const ids = group.map((item: any) => item.id);
        const sortedIds = [...ids].sort((a, b) => a.localeCompare(b));
        assert.deepEqual(ids, sortedIds, `Group IDs should be stably sorted: ${ids.join(', ')}`);
    }

    // Check clone voice Lu Xueqi preserved with correct public info
    const luXueqi = cloneItems.find((item: any) => item.id === 'C_1785664414_d700a8');
    assert.ok(luXueqi);
    assert.equal(luXueqi.name, '陆雪琪');
    assert.equal(luXueqi.tier, 'clone');
});

test('Fastify routes GET /api/tts/status and GET /api/tts/voices handle healthy upstream and unreachable gracefully', async () => {
    const { buildApp } = await import('../server');
    const app = await buildApp({ logger: false });

    const fixturePath = path.join(__dirname, 'fixtures', 'tts_voices_sample.json');
    const rawFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    const originalFetch = globalThis.fetch;
    try {
        await app.ready();

        // 1. Upstream healthy mock
        (globalThis as any).fetch = async (url: string) => {
            if (url.endsWith('/api/health')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        ok: true,
                        service: 'local-chinese-tts',
                        voices: 30, // health says 30, but catalog has 32
                        default_voice: 'QF1',
                        local_models: { light: true, quality: true, clone: true }
                    })
                };
            }
            if (url.endsWith('/api/voices')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => rawFixture
                };
            }
            throw new Error(`Unexpected url: ${url}`);
        };

        // Status endpoint: voice_count should be 32 (from catalog, not 30 from health)
        const statusRes = await app.inject({
            method: 'GET',
            url: '/api/tts/status'
        });
        assert.equal(statusRes.statusCode, 200);
        const statusJson = statusRes.json();
        assert.equal(statusJson.ok, true);
        assert.equal(statusJson.enabled, true);
        assert.equal(statusJson.voice_count, 32);
        assert.equal(statusJson.default_voice, 'QF1');
        assert.deepEqual(statusJson.local_models, { light: true, quality: true, clone: true });

        // Voices endpoint: returns 200 with 32 items, without absolute paths or engine fields
        const voicesRes = await app.inject({
            method: 'GET',
            url: '/api/tts/voices'
        });
        assert.equal(voicesRes.statusCode, 200);
        const voicesJson = voicesRes.json();
        assert.equal(Array.isArray(voicesJson), true);
        assert.equal(voicesJson.length, 32);

        const bodyText = voicesRes.body;
        assert.doesNotMatch(bodyText, /\/Users\//);
        assert.doesNotMatch(bodyText, /"ref_audio"/i);
        assert.doesNotMatch(bodyText, /"model"/i);
        assert.doesNotMatch(bodyText, /"voice":/i);
        assert.doesNotMatch(bodyText, /"instruct"/i);

        // 2. Upstream unreachable mock
        (globalThis as any).fetch = async () => {
            const err: any = new Error('connect ECONNREFUSED 127.0.0.1:8765');
            err.code = 'ECONNREFUSED';
            throw err;
        };

        // Status endpoint returns 200 with ok: false and voice_count: 0
        const unreachableStatusRes = await app.inject({
            method: 'GET',
            url: '/api/tts/status'
        });
        assert.equal(unreachableStatusRes.statusCode, 200);
        const unreachableStatusJson = unreachableStatusRes.json();
        assert.equal(unreachableStatusJson.ok, false);
        assert.equal(unreachableStatusJson.voice_count, 0);
        assert.ok(unreachableStatusJson.error);

        // Voices endpoint returns 503 with TTS_UNAVAILABLE
        const unreachableVoicesRes = await app.inject({
            method: 'GET',
            url: '/api/tts/voices'
        });
        assert.equal(unreachableVoicesRes.statusCode, 503);
        const unreachableVoicesJson = unreachableVoicesRes.json();
        assert.equal(unreachableVoicesJson.code, 'TTS_UNAVAILABLE');
    } finally {
        globalThis.fetch = originalFetch;
        await app.close();
    }
});

test('TtsService.preview validates voice_id and text lengths strictly', async () => {
    // missing voice_id
    await assert.rejects(
        async () => TtsService.preview({ voice_id: '' } as any),
        (err: any) => err instanceof TtsServiceError && err.code === 'INVALID_VOICE_ID' && err.status === 400
    );

    // empty text after trim
    await assert.rejects(
        async () => TtsService.preview({ voice_id: 'QF1', text: '   ' }),
        (err: any) => err instanceof TtsServiceError && err.code === 'INVALID_PREVIEW_TEXT' && err.status === 400
    );

    // text exceeds 80 characters
    const text81 = '字'.repeat(81);
    await assert.rejects(
        async () => TtsService.preview({ voice_id: 'QF1', text: text81 }),
        (err: any) => err instanceof TtsServiceError && err.code === 'INVALID_PREVIEW_TEXT' && err.status === 400
    );
});

test('TtsService.preview verifies voice in catalog, sends correct payload, enforces timeout and size limit', async () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'tts_voices_sample.json');
    const rawFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    let speechPayloadSent: any = null;
    const fakeMp3Buffer = Buffer.from('FAKE_MP3_DATA');

    const mockFetch = async (url: any, init?: any) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/api/voices')) {
            return {
                ok: true,
                status: 200,
                json: async () => rawFixture
            };
        }
        if (urlStr.endsWith('/v1/audio/speech')) {
            speechPayloadSent = JSON.parse(init.body);
            return new Response(fakeMp3Buffer, { headers: { 'content-type': 'audio/mpeg' } });
        }
        throw new Error(`Unexpected url ${urlStr}`);
    };

    // 1. Success with default text
    const resultDefault = await TtsService.preview({
        voice_id: 'QF1',
        fetchFn: mockFetch as any
    });
    assert.deepEqual(speechPayloadSent, {
        model: 'local-chinese-tts',
        input: '这是这个角色的声音。',
        voice: 'QF1',
        speed: 1,
        response_format: 'mp3'
    });
    assert.equal(resultDefault.contentType, 'audio/mpeg');
    assert.equal(resultDefault.buffer.toString(), 'FAKE_MP3_DATA');

    // 2. Success with custom text within 80 chars
    const customText = '你好，世界！这是一段测试台词。';
    await TtsService.preview({
        voice_id: 'QF1',
        text: customText,
        fetchFn: mockFetch as any
    });
    assert.equal(speechPayloadSent.input, customText);

    // 3. Unknown voice_id not in catalog -> 400 VOICE_NOT_FOUND
    await assert.rejects(
        async () => TtsService.preview({
            voice_id: 'NON_EXISTENT_VOICE',
            fetchFn: mockFetch as any
        }),
        (err: any) => err instanceof TtsServiceError && err.code === 'VOICE_NOT_FOUND' && err.status === 400
    );

    // 4. Upstream timeout -> 504 TTS_TIMEOUT
    const timingOutFetch = async (url: any, init?: any) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/api/voices')) {
            return { ok: true, status: 200, json: async () => rawFixture };
        }
        if (urlStr.endsWith('/v1/audio/speech')) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    resolve({
                        ok: true,
                        status: 200,
                        arrayBuffer: async () => fakeMp3Buffer.buffer.slice(fakeMp3Buffer.byteOffset, fakeMp3Buffer.byteOffset + fakeMp3Buffer.byteLength)
                    });
                }, 100);
                init?.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    const abortErr: any = new Error('The operation was aborted');
                    abortErr.name = 'AbortError';
                    reject(abortErr);
                });
            });
        }
        throw new Error(`Unexpected url ${urlStr}`);
    };
    await assert.rejects(
        async () => TtsService.preview({
            voice_id: 'QF1',
            timeoutMs: 10,
            fetchFn: timingOutFetch as any
        }),
        (err: any) => err instanceof TtsServiceError && err.code === 'TTS_TIMEOUT' && err.status === 504
    );

    // 5. Exceeding max bytes -> 503 TTS_UNAVAILABLE
    const hugeBuffer = Buffer.alloc(100);
    const mockHugeFetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/api/voices')) {
            return { ok: true, status: 200, json: async () => rawFixture };
        }
        if (urlStr.endsWith('/v1/audio/speech')) {
            return new Response(hugeBuffer, { headers: { 'content-length': '100' } });
        }
        throw new Error(`Unexpected url ${urlStr}`);
    };
    await assert.rejects(
        async () => TtsService.preview({
            voice_id: 'QF1',
            maxBytes: 50,
            fetchFn: mockHugeFetch as any
        }),
        (err: any) => err instanceof TtsServiceError && err.code === 'TTS_UNAVAILABLE' && err.status === 503
    );

    // 6. Upstream 500 error -> 503 TTS_UNAVAILABLE
    const errorFetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/api/voices')) {
            return { ok: true, status: 200, json: async () => rawFixture };
        }
        if (urlStr.endsWith('/v1/audio/speech')) {
            return { ok: false, status: 500 };
        }
        throw new Error(`Unexpected url ${urlStr}`);
    };
    await assert.rejects(
        async () => TtsService.preview({
            voice_id: 'QF1',
            fetchFn: errorFetch as any
        }),
        (err: any) => err instanceof TtsServiceError && err.code === 'TTS_UNAVAILABLE' && err.status === 503
    );
});

test('POST /api/tts/preview route integration, validation and media_asset isolation', async () => {
    const { buildApp } = await import('../server');
    const { db } = await import('../db/database');
    const app = await buildApp({ logger: false });

    const fixturePath = path.join(__dirname, 'fixtures', 'tts_voices_sample.json');
    const rawFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const originalFetch = globalThis.fetch;

    const fakeMp3 = Buffer.from('ID3_MPEG_AUDIO_STREAM');

    try {
        await app.ready();

        (globalThis as any).fetch = async (url: any) => {
            const urlStr = String(url);
            if (urlStr.endsWith('/api/voices')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => rawFixture
                };
            }
            if (urlStr.endsWith('/v1/audio/speech')) {
                return new Response(fakeMp3, { headers: { 'content-type': 'audio/mpeg' } });
            }
            throw new Error(`Unexpected url: ${urlStr}`);
        };

        const initialMediaAssetsCount = (await db.get('SELECT COUNT(*) as cnt FROM media_asset')) as { cnt: number };

        // 1. Success preview
        const successRes = await app.inject({
            method: 'POST',
            url: '/api/tts/preview',
            payload: {
                voice_id: 'QF1',
                text: '测试试听'
            }
        });
        assert.equal(successRes.statusCode, 200);
        assert.equal(successRes.headers['content-type'], 'audio/mpeg');
        assert.equal(successRes.rawPayload.toString(), 'ID3_MPEG_AUDIO_STREAM');

        // 2. Reject text > 80 characters
        const tooLongRes = await app.inject({
            method: 'POST',
            url: '/api/tts/preview',
            payload: {
                voice_id: 'QF1',
                text: '太长了'.repeat(30)
            }
        });
        assert.equal(tooLongRes.statusCode, 400);
        assert.equal(tooLongRes.json().code, 'INVALID_PREVIEW_TEXT');

        // 3. Reject unknown voice
        const unknownVoiceRes = await app.inject({
            method: 'POST',
            url: '/api/tts/preview',
            payload: {
                voice_id: 'UNKNOWN_123',
                text: '测试'
            }
        });
        assert.equal(unknownVoiceRes.statusCode, 400);
        assert.equal(unknownVoiceRes.json().code, 'VOICE_NOT_FOUND');

        // 4. Assert NO media_asset records created (isolation)
        const finalMediaAssetsCount = (await db.get('SELECT COUNT(*) as cnt FROM media_asset')) as { cnt: number };
        assert.equal(finalMediaAssetsCount.cnt, initialMediaAssetsCount.cnt, 'No media_asset row should be created during preview');
    } finally {
        globalThis.fetch = originalFetch;
        await app.close();
    }
});

test('rejected TTS base URL is TTS_URL_REJECTED and status omits credentials and path', async () => {
    let fetchCalled = false;
    const fetchFn = async () => {
        fetchCalled = true;
        throw new Error('network should not be called');
    };
    const raw = 'http://user:secret@127.0.0.1:8765/Users/lm/private';

    const pathResult = validateTtsBaseUrl(raw);
    assert.equal(pathResult.ok, false);
    if (!pathResult.ok) {
        assert.equal(pathResult.code, 'TTS_URL_REJECTED');
        assert.equal(pathResult.reason.includes('/Users/'), false);
        assert.equal(pathResult.reason.includes('secret'), false);
    }
    assert.equal(redactTtsBaseUrl(raw), 'http://127.0.0.1:8765');
    assert.equal(redactTtsBaseUrl('file:///Users/lm/secret'), '');
    assert.equal(redactTtsBaseUrl('not a url :::'), '');

    await assert.rejects(
        () => TtsService.getVoices({ baseUrl: raw, enabled: true, fetchFn: fetchFn as any }),
        (err: any) => err instanceof TtsServiceError && err.code === 'TTS_URL_REJECTED' && err.status === 400
    );
    await assert.rejects(
        () => TtsService.preview({ voice_id: 'K01', baseUrl: raw, enabled: true, fetchFn: fetchFn as any }),
        (err: any) => err instanceof TtsServiceError && err.code === 'TTS_URL_REJECTED' && err.status === 400
    );

    const status = await TtsService.getStatus({ baseUrl: raw, enabled: true, fetchFn: fetchFn as any });
    assert.equal(status.ok, false);
    assert.equal(status.base_url, 'http://127.0.0.1:8765');
    assert.equal(status.error, 'TTS_URL_REJECTED');
    assert.equal(JSON.stringify(status).includes('secret'), false);
    assert.equal(JSON.stringify(status).includes('/Users/'), false);

    const disabled = await TtsService.getStatus({ baseUrl: raw, enabled: false, fetchFn: fetchFn as any });
    assert.equal(disabled.base_url, 'http://127.0.0.1:8765');
    assert.equal(disabled.error, 'TTS is disabled');
    assert.equal(JSON.stringify(disabled).includes('secret'), false);
    assert.equal(JSON.stringify(disabled).includes('/Users/'), false);

    const unparseable = await TtsService.getStatus({ baseUrl: 'not a url :::', enabled: true, fetchFn: fetchFn as any });
    assert.equal(unparseable.base_url, '');
    assert.equal(unparseable.error, 'TTS_URL_REJECTED');
    assert.equal(JSON.stringify(unparseable).includes('not a url'), false);

    assert.equal(fetchCalled, false);
});


