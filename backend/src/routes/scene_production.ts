import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ContinuityStoreError } from '../services/continuity_store';
import { ContinuityConfirmationError } from '../services/continuity_confirmation';
import { sceneProductionView, createSceneProductionCandidate, previewSceneProductionApply, applySceneProduction } from '../services/scene_production';
import { productionMediaView, bindProductionReferences, productionQueuePlan, reviewProductionImage } from '../services/scene_production_media';
import { continuityHash } from '../services/continuity_replay';
export const sceneProductionRoutes: FastifyPluginAsync = async app => {
  const handle = (error: any, reply: any) => {
    if (error instanceof z.ZodError) return reply.status(422).send({ code: 'PRODUCTION_INPUT_INVALID', detail: error.message });
    if (error instanceof ContinuityStoreError || error instanceof ContinuityConfirmationError) return reply.status(error instanceof ContinuityStoreError ? error.statusCode : 409).send({ code: error.code, detail: error.message });
    app.log.error(error); return reply.status(500).send({ detail: error.message || 'Production operation failed' });
  };
  const params = z.object({ scriptId: z.coerce.number().int().positive(), changeId: z.string().min(1).optional() });
  app.get('/scripts/:scriptId/production', async (request, reply) => { try { return await sceneProductionView(params.parse(request.params).scriptId); } catch (error) { return handle(error, reply); } });
  app.post('/scripts/:scriptId/production/candidates', async (request, reply) => { try { return reply.status(201).send(await createSceneProductionCandidate(params.parse(request.params).scriptId, request.body)); } catch (error) { return handle(error, reply); } });
  app.post('/scripts/:scriptId/storyboard-candidates/:changeId/preview-scene', async (request, reply) => { try { const p = params.parse(request.params); return await previewSceneProductionApply(p.scriptId, p.changeId!, request.body); } catch (error) { return handle(error, reply); } });
  app.post('/scripts/:scriptId/storyboard-candidates/:changeId/apply-scene', async (request, reply) => { try { const p = params.parse(request.params); return await applySceneProduction(p.scriptId, p.changeId!, request.body); } catch (error) { return handle(error, reply); } });
  const frameParams = z.object({ scriptId: z.coerce.number().int().positive(), sceneId: z.coerce.number().int().positive() });
  app.get('/scripts/:scriptId/production/frames/:sceneId', async (request, reply) => { try { const p = frameParams.parse(request.params); return await productionMediaView(p.scriptId, p.sceneId); } catch (error) { return handle(error, reply); } });
  app.post('/scripts/:scriptId/production/frames/:sceneId/references', async (request, reply) => { try { const p = frameParams.parse(request.params); return await bindProductionReferences(p.scriptId, p.sceneId, request.body); } catch (error) { return handle(error, reply); } });
  app.post('/scripts/:scriptId/production/frames/:sceneId/review', async (request, reply) => { try { const p = frameParams.parse(request.params); return await reviewProductionImage(p.scriptId, p.sceneId, request.body); } catch (error) { return handle(error, reply); } });
  const queueBody = z.object({ target_scene_id: z.string().min(1), request_key: z.string().min(1).max(100) }).strict();
  app.post('/scripts/:scriptId/production/queue-preview', async (request, reply) => { try { const scriptId = params.parse(request.params).scriptId, body = queueBody.parse(request.body); return await productionQueuePlan(scriptId, body.target_scene_id); } catch (error) { return handle(error, reply); } });
  app.post('/scripts/:scriptId/production/queue', async (request, reply) => {
    try {
      const scriptId = params.parse(request.params).scriptId, body = queueBody.parse(request.body), plan = await productionQueuePlan(scriptId, body.target_scene_id), results: any[] = [];
      for (const item of plan.eligible) {
        const queued = await app.inject({ method:'POST', url:'/api/assets/generate', payload:{ scene_id:item.scene_id, request_key:`production:${scriptId}:${body.request_key}:${item.scene_id}`, workflow:{ production_guard:{ expected_version:item.scene_version,reference_hash:item.reference_hash,redraw:false } } } });
        results.push({ scene_id:item.scene_id,status_code:queued.statusCode,...queued.json() });
      }
      return { ...plan, results, queued_count:results.filter(result => result.status_code < 300).length };
    } catch (error) { return handle(error, reply); }
  });
  app.post('/scripts/:scriptId/production/frames/:sceneId/redraw', async (request, reply) => {
    try {
      const p = frameParams.parse(request.params), body = z.object({ expected_version:z.number().int().positive(), reference_hash:z.string().regex(/^[a-f0-9]{64}$/),request_key:z.string().min(1).max(100) }).strict().parse(request.body);
      await productionMediaView(p.scriptId,p.sceneId);
      const queued = await app.inject({ method:'POST',url:'/api/assets/generate',payload:{ scene_id:p.sceneId,new_version:true,request_key:`production-redraw:${p.scriptId}:${body.request_key}`,workflow:{ production_guard:{expected_version:body.expected_version,reference_hash:body.reference_hash,redraw:true} } } });
      return reply.status(queued.statusCode).send(queued.json());
    } catch(error) { return handle(error,reply); }
  });
};
