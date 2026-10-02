import { Buffer } from 'node:buffer';
import { SettingsManager } from '../core/settings_manager';

export interface TtsSettings {
    base_url: string;
    enabled: boolean;
}

export type TtsUrlValidationResult =
    | { ok: true; url: string; origin: string }
    | { ok: false; code: 'TTS_URL_REJECTED'; reason: string };

export const ALLOWED_TIERS = ['light', 'quality', 'clone', 'online'] as const;
export type TtsVoiceTier = typeof ALLOWED_TIERS[number];

export interface PublicTtsVoice {
    id: string;
    name: string;
    gender: string;
    style: string;
    locale: string;
    description: string;
    tier: TtsVoiceTier;
    offline: boolean;
    provider: string;
}

export interface TtsStatusResult {
    ok: boolean;
    enabled: boolean;
    base_url: string;
    voice_count: number;
    default_voice?: string;
    local_models?: {
        light: boolean;
        quality: boolean;
        clone: boolean;
    };
    error?: string;
}

export interface TtsPreviewOptions {
    voice_id: string;
    text?: string;
    baseUrl?: string;
    enabled?: boolean;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
    maxBytes?: number;
}

export interface TtsPreviewResult {
    buffer: Buffer;
    contentType: string;
}

const TIER_ORDER: Record<TtsVoiceTier, number> = {
    light: 0,
    quality: 1,
    clone: 2,
    online: 3
};

/**
 * Pure function to validate TTS base URL.
 * - Rejects malformed URLs
 * - Rejects non-http(s) protocols
 * - Rejects usernames and passwords
 * - Rejects non-empty paths (e.g., /api/v1)
 * - Rejects query parameters and hashes
 * - Rejects non-loopback hosts (127.0.0.1, localhost, ::1) unless TTS_ALLOW_REMOTE=1
 */
export function validateTtsBaseUrl(
    rawUrl?: unknown,
    options?: { allowRemote?: boolean }
): TtsUrlValidationResult {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return {
            ok: false,
            code: 'TTS_URL_REJECTED',
            reason: 'TTS base URL must be a non-empty string'
        };
    }

    const trimmed = rawUrl.trim();
    if (!trimmed) {
        return {
            ok: false,
            code: 'TTS_URL_REJECTED',
            reason: 'TTS base URL cannot be empty'
        };
    }

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return {
            ok: false,
            code: 'TTS_URL_REJECTED',
            reason: 'Invalid TTS base URL format'
        };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
            ok: false,
            code: 'TTS_URL_REJECTED',
            reason: `Protocol must be http or https, got "${parsed.protocol}"`
        };
    }

    if (parsed.username || parsed.password) {
        return {
            ok: false,
            code: 'TTS_URL_REJECTED',
            reason: 'TTS base URL must not contain username or password'
        };
    }

    if (parsed.pathname !== '' && parsed.pathname !== '/') {
        return {
            ok: false,
            code: 'TTS_URL_REJECTED',
            reason: 'TTS base URL must not have a path'
        };
    }

    if (parsed.search || parsed.hash) {
        return {
            ok: false,
            code: 'TTS_URL_REJECTED',
            reason: 'TTS base URL must not contain query parameters or fragments'
        };
    }

    const hostname = parsed.hostname.toLowerCase();
    const isLoopback =
        hostname === '127.0.0.1' ||
        hostname === 'localhost' ||
        hostname === '::1' ||
        hostname === '[::1]';

    const allowRemote =
        options?.allowRemote ??
        (process.env.TTS_ALLOW_REMOTE === '1' || process.env.TTS_ALLOW_REMOTE === 'true');

    if (!isLoopback && !allowRemote) {
        return {
            ok: false,
            code: 'TTS_URL_REJECTED',
            reason: `Host "${hostname}" is not a loopback address and TTS_ALLOW_REMOTE is not set to 1`
        };
    }

    return {
        ok: true,
        url: parsed.origin,
        origin: parsed.origin
    };
}

/** Origin only. Drops userinfo, path, query, and fragment. */
export function redactTtsBaseUrl(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) return '';
    try {
        const parsed = new URL(raw.trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        return parsed.origin;
    } catch {
        return '';
    }
}

export function assertValidTtsBaseUrl(
    rawUrl?: unknown,
    options?: { allowRemote?: boolean }
): string {
    const result = validateTtsBaseUrl(rawUrl, options);
    if ('code' in result) {
        throw new TtsServiceError(result.code, result.reason, 400);
    }
    return result.url;
}

export function normalizeTtsVoice(raw: any): PublicTtsVoice | null {
    if (!raw || typeof raw !== 'object') return null;
    const tier = String(raw.tier || '').trim().toLowerCase();
    if (!ALLOWED_TIERS.includes(tier as TtsVoiceTier)) {
        return null;
    }
    const id = String(raw.id || '').trim();
    if (!id) return null;

    return {
        id,
        name: String(raw.name || '').trim(),
        gender: String(raw.gender || '').trim(),
        style: String(raw.style || '').trim(),
        locale: String(raw.locale || '').trim(),
        description: String(raw.description || '').trim(),
        tier: tier as TtsVoiceTier,
        offline: Boolean(raw.offline),
        provider: String(raw.provider || '').trim()
    };
}

export function sortTtsVoices(voices: PublicTtsVoice[]): PublicTtsVoice[] {
    return [...voices].sort((a, b) => {
        const orderA = TIER_ORDER[a.tier] ?? 99;
        const orderB = TIER_ORDER[b.tier] ?? 99;
        if (orderA !== orderB) return orderA - orderB;
        return a.id.localeCompare(b.id);
    });
}

export function normalizeTtsVoiceCatalog(rawVoices: any[]): PublicTtsVoice[] {
    if (!Array.isArray(rawVoices)) return [];
    const normalized: PublicTtsVoice[] = [];
    for (const item of rawVoices) {
        const voice = normalizeTtsVoice(item);
        if (voice) {
            normalized.push(voice);
        }
    }
    return sortTtsVoices(normalized);
}

export function formatVoiceLabel(voice: { id: string; name: string; style: string }): string {
    const label = `${voice.id} · ${voice.name} · ${voice.style}`.trim();
    return label.slice(0, 120);
}

export class TtsServiceError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, message: string, status: number = 400) {
        super(message);
        this.name = 'TtsServiceError';
        this.code = code;
        this.status = status;
    }
}

export class TtsService {
    static async getStatus(options?: {
        baseUrl?: string;
        enabled?: boolean;
        timeoutMs?: number;
        fetchFn?: typeof fetch;
    }): Promise<TtsStatusResult> {
        const fetcher = options?.fetchFn || globalThis.fetch;
        const settings = SettingsManager.loadSettings();
        const ttsSettings = settings.tts || { base_url: 'http://127.0.0.1:8765', enabled: true };
        const baseUrl = options?.baseUrl || ttsSettings.base_url || 'http://127.0.0.1:8765';
        const enabled = options?.enabled ?? (ttsSettings.enabled !== false);
        const validation = validateTtsBaseUrl(baseUrl);
        const safeBase = validation.ok ? validation.url : redactTtsBaseUrl(baseUrl);

        if (!enabled) {
            return {
                ok: false,
                enabled: false,
                base_url: safeBase,
                voice_count: 0,
                error: 'TTS is disabled'
            };
        }

        if (validation.ok === false) {
            return {
                ok: false,
                enabled: true,
                base_url: safeBase,
                voice_count: 0,
                error: validation.code
            };
        }

        const timeoutMs = options?.timeoutMs ?? 2000;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const [healthRes, voicesRes] = await Promise.all([
                    fetcher(`${validation.url}/api/health`, { signal: controller.signal }),
                    fetcher(`${validation.url}/api/voices`, { signal: controller.signal })
                ]);

                if (!healthRes.ok || !voicesRes.ok) {
                    const failStatus = !healthRes.ok ? healthRes.status : voicesRes.status;
                    return {
                        ok: false,
                        enabled: true,
                        base_url: validation.url,
                        voice_count: 0,
                        error: `TTS upstream returned status ${failStatus}`
                    };
                }

                const healthData = (await healthRes.json()) as any;
                const voicesData = (await voicesRes.json()) as any;
                const rawVoices = Array.isArray(voicesData) ? voicesData : voicesData?.voices || [];
                const normalizedVoices = normalizeTtsVoiceCatalog(rawVoices);

                return {
                    ok: true,
                    enabled: true,
                    base_url: validation.url,
                    voice_count: normalizedVoices.length,
                    default_voice: healthData.default_voice || 'QF1',
                    local_models: healthData.local_models || { light: false, quality: false, clone: false }
                };
            } finally {
                clearTimeout(timer);
            }
        } catch (err: any) {
            return {
                ok: false,
                enabled: true,
                base_url: validation.url,
                voice_count: 0,
                error: err.message || 'TTS service unreachable'
            };
        }
    }

    static async getVoices(options?: {
        baseUrl?: string;
        enabled?: boolean;
        timeoutMs?: number;
        fetchFn?: typeof fetch;
    }): Promise<PublicTtsVoice[]> {
        const fetcher = options?.fetchFn || globalThis.fetch;
        const settings = SettingsManager.loadSettings();
        const ttsSettings = settings.tts || { base_url: 'http://127.0.0.1:8765', enabled: true };
        const baseUrl = options?.baseUrl || ttsSettings.base_url || 'http://127.0.0.1:8765';
        const enabled = options?.enabled ?? (ttsSettings.enabled !== false);

        if (!enabled) {
            throw new TtsServiceError('TTS_UNAVAILABLE', 'TTS is disabled', 503);
        }

        const validatedUrl = assertValidTtsBaseUrl(baseUrl);

        const timeoutMs = options?.timeoutMs ?? 5000;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetcher(`${validatedUrl}/api/voices`, { signal: controller.signal });
                if (!res.ok) {
                    throw new TtsServiceError('TTS_UNAVAILABLE', `TTS service responded with status ${res.status}`, 503);
                }
                const data = (await res.json()) as any;
                const rawVoices = Array.isArray(data) ? data : data?.voices || [];
                return normalizeTtsVoiceCatalog(rawVoices);
            } finally {
                clearTimeout(timer);
            }
        } catch (err: any) {
            if (err instanceof TtsServiceError) throw err;
            throw new TtsServiceError('TTS_UNAVAILABLE', err.message || 'TTS service unreachable', 503);
        }
    }

    static async preview(options: TtsPreviewOptions): Promise<TtsPreviewResult> {
        if (!options || typeof options !== 'object') {
            throw new TtsServiceError('INVALID_VOICE_ID', 'voice_id is required', 400);
        }
        if (!options.voice_id || typeof options.voice_id !== 'string') {
            throw new TtsServiceError('INVALID_VOICE_ID', 'voice_id is required and must be a string', 400);
        }
        const voiceId = options.voice_id.trim();
        if (!voiceId) {
            throw new TtsServiceError('INVALID_VOICE_ID', 'voice_id cannot be empty', 400);
        }

        const rawText = options.text !== undefined && options.text !== null ? options.text : '这是这个角色的声音。';
        if (typeof rawText !== 'string') {
            throw new TtsServiceError('INVALID_PREVIEW_TEXT', 'text must be a string', 400);
        }
        const trimmedText = rawText.trim();
        if (trimmedText.length === 0) {
            throw new TtsServiceError('INVALID_PREVIEW_TEXT', 'Preview text cannot be empty', 400);
        }
        if ([...trimmedText].length > 80) {
            throw new TtsServiceError('INVALID_PREVIEW_TEXT', 'Preview text exceeds maximum length of 80 characters', 400);
        }

        const settings = SettingsManager.loadSettings();
        const ttsSettings = settings.tts || { base_url: 'http://127.0.0.1:8765', enabled: true };
        const baseUrl = options.baseUrl || ttsSettings.base_url || 'http://127.0.0.1:8765';
        const enabled = options.enabled ?? (ttsSettings.enabled !== false);

        if (!enabled) {
            throw new TtsServiceError('TTS_UNAVAILABLE', 'TTS is disabled', 503);
        }

        const validatedUrl = assertValidTtsBaseUrl(baseUrl);

        const voices = await TtsService.getVoices({
            baseUrl: validatedUrl,
            enabled: true,
            fetchFn: options.fetchFn
        });
        const match = voices.find(v => v.id === voiceId);
        if (!match) {
            throw new TtsServiceError('VOICE_NOT_FOUND', `Voice "${voiceId}" not found in current catalog`, 400);
        }

        const timeoutMs = options.timeoutMs ?? 120000;
        const maxBytes = options.maxBytes ?? (8 * 1024 * 1024);
        const fetcher = options.fetchFn || globalThis.fetch;

        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        try {
            const res = await fetcher(`${validatedUrl}/v1/audio/speech`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'local-chinese-tts',
                    input: trimmedText,
                    voice: voiceId,
                    speed: 1,
                    response_format: 'mp3'
                }),
                signal: controller.signal
            });

            if (timedOut) {
                throw new TtsServiceError('TTS_TIMEOUT', 'TTS preview request timed out', 504);
            }

            if (!res.ok) {
                throw new TtsServiceError('TTS_UNAVAILABLE', `TTS upstream failed with status ${res.status}`, 503);
            }

            const clHeader = res.headers?.get?.('content-length');
            if (clHeader) {
                const cl = parseInt(clHeader, 10);
                if (!isNaN(cl) && cl > maxBytes) {
                    throw new TtsServiceError('TTS_UNAVAILABLE', 'TTS preview audio exceeds 8MiB limit', 503);
                }
            }

            const ab = await res.arrayBuffer();
            if (timedOut) {
                throw new TtsServiceError('TTS_TIMEOUT', 'TTS preview request timed out', 504);
            }
            const buffer = Buffer.from(ab);
            if (buffer.byteLength > maxBytes) {
                throw new TtsServiceError('TTS_UNAVAILABLE', 'TTS preview audio exceeds 8MiB limit', 503);
            }

            return {
                buffer,
                contentType: 'audio/mpeg'
            };
        } catch (err: any) {
            if (timedOut || err.name === 'TimeoutError' || (err.name === 'AbortError' && timedOut)) {
                throw new TtsServiceError('TTS_TIMEOUT', 'TTS preview request timed out', 504);
            }
            if (err instanceof TtsServiceError) throw err;
            throw new TtsServiceError('TTS_UNAVAILABLE', err.message || 'TTS service unreachable', 503);
        } finally {
            clearTimeout(timer);
        }
    }
}
