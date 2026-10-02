import { FastifyPluginAsync } from 'fastify';
import { TtsService, TtsServiceError } from '../services/tts_service';

export const ttsRoutes: FastifyPluginAsync = async (app) => {
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
