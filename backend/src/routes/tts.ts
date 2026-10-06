import { FastifyPluginAsync } from 'fastify';
import { TtsService, TtsServiceError } from '../services/tts_service';
import { ScriptAudioService } from '../services/script_audio_service';
import { z } from 'zod';

export const ttsRoutes: FastifyPluginAsync = async (app) => {
    app.post('/render-block', async (request, reply) => {
        const parsed = z.object({ script_id: z.number().int().positive(), expected_revision: z.number().int().positive(), block_id: z.string().min(1), request_key: z.string().min(1).max(200), voice_id: z.string().min(1).optional() }).safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ code: 'INVALID_SPEECH_REQUEST', detail: parsed.error.flatten() });
        try { return await ScriptAudioService.render(parsed.data); }
        catch (error: any) { return reply.status(error.status || 503).send({ code: error.code || 'TTS_UNAVAILABLE', detail: error.message }); }
    });
    app.get('/status', async () => {
        return TtsService.getStatus();
    });

    app.get('/voices', async (request, reply) => {
        try {
            const voices = await TtsService.getVoices();
            return reply.status(200).send(voices);
        } catch (err: any) {
            if (err instanceof TtsServiceError) {
                return reply.status(err.status).send({
                    detail: err.message,
                    code: err.code
                });
            }
            return reply.status(503).send({
                detail: err.message || 'TTS service unavailable',
                code: 'TTS_UNAVAILABLE'
            });
        }
    });

    app.post('/preview', async (request, reply) => {
        try {
            const body = (request.body || {}) as any;
            const result = await TtsService.preview({
                voice_id: body.voice_id,
                text: body.text
            });
            return reply.header('Content-Type', result.contentType).send(result.buffer);
        } catch (err: any) {
            if (err instanceof TtsServiceError) {
                return reply.status(err.status).send({
                    detail: err.message,
                    code: err.code
                });
            }
            return reply.status(503).send({
                detail: err.message || 'TTS service unavailable',
                code: 'TTS_UNAVAILABLE'
            });
        }
    });
};
