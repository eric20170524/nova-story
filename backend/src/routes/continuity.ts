import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getContinuityReview,confirmContinuityReview,refreshContinuityShot,undoContinuityReview,reviewContinuityTime } from '../services/continuity_review';
import { ContinuityStoreError } from '../services/continuity_store';
import { ContinuityConfirmationError } from '../services/continuity_confirmation';
import { startContinuitySuggestionTask,getContinuitySuggestionTask,listContinuitySuggestionTasks,cancelContinuitySuggestionTask } from '../services/continuity_suggestion_tasks';
export const continuityRoutes:FastifyPluginAsync=async app=>{
  const handle=(error:unknown,reply:any)=>{
    if(error instanceof ContinuityStoreError||error instanceof ContinuityConfirmationError)return reply.status(error instanceof ContinuityStoreError?error.statusCode:409).send({code:error.code,detail:error.message});
    if(error instanceof z.ZodError)return reply.status(422).send({code:'CONTINUITY_REQUEST_INVALID',detail:error.message});
    app.log.error(error);return reply.status(500).send({detail:error instanceof Error?error.message:'Continuity review failed'});
  };
  app.get('/scripts/:scriptId/continuity',async(request,reply)=>{
    try {const {scriptId}=z.object({scriptId:z.coerce.number().int().positive()}).parse(request.params);const query=z.object({target_scene_id:z.string().min(1).optional()}).parse(request.query);return await getContinuityReview(scriptId,query.target_scene_id);}
    catch(error){return handle(error,reply);}
  });
  app.post('/scripts/:scriptId/continuity/confirm',async(request,reply)=>{
    try {const {scriptId}=z.object({scriptId:z.coerce.number().int().positive()}).parse(request.params);
      // Match the existing local desktop authentication boundary; client-supplied actor/authority is never used.
      return await confirmContinuityReview(scriptId,request.body,'local_admin');}
    catch(error){return handle(error,reply);}
  });
  app.post('/scripts/:scriptId/continuity/refresh-shot',async(request,reply)=>{
    try {const {scriptId}=z.object({scriptId:z.coerce.number().int().positive()}).parse(request.params);return await refreshContinuityShot(scriptId,request.body,'local_admin');}
    catch(error){return handle(error,reply);}
  });
  app.post('/scripts/:scriptId/continuity/preview',async(request,reply)=>{
    try {const {scriptId}=z.object({scriptId:z.coerce.number().int().positive()}).parse(request.params);return await confirmContinuityReview(scriptId,request.body,'local_admin',true);}catch(error){return handle(error,reply);}
  });
  for(const action of ['undo-preview','undo'])app.post(`/scripts/:scriptId/continuity/${action}`,async(request,reply)=>{
    try {const {scriptId}=z.object({scriptId:z.coerce.number().int().positive()}).parse(request.params);return await undoContinuityReview(scriptId,request.body,'local_admin',action==='undo-preview');}catch(error){return handle(error,reply);}
  });
  for(const action of ['time-preview','time-confirm'])app.post(`/scripts/:scriptId/continuity/${action}`,async(request,reply)=>{
    try{const {scriptId}=z.object({scriptId:z.coerce.number().int().positive()}).parse(request.params);return await reviewContinuityTime(scriptId,request.body,'local_admin',action==='time-preview');}catch(error){return handle(error,reply);}
  });
  const taskParams=z.object({scriptId:z.coerce.number().int().positive(),taskId:z.string().min(1)});
  app.post('/scripts/:scriptId/continuity/suggestions',async(request,reply)=>{
    try{const {scriptId}=z.object({scriptId:z.coerce.number().int().positive()}).parse(request.params);return reply.status(202).send(await startContinuitySuggestionTask(scriptId,request.body));}catch(error){return handle(error,reply);}
  });
  app.get('/scripts/:scriptId/continuity/suggestion-tasks',async(request,reply)=>{
    try{const {scriptId}=z.object({scriptId:z.coerce.number().int().positive()}).parse(request.params);return {tasks:await listContinuitySuggestionTasks(scriptId)};}catch(error){return handle(error,reply);}
  });
  app.get('/scripts/:scriptId/continuity/suggestion-tasks/:taskId',async(request,reply)=>{
    try{const {scriptId,taskId}=taskParams.parse(request.params);return await getContinuitySuggestionTask(scriptId,taskId);}catch(error){return handle(error,reply);}
  });
  app.post('/scripts/:scriptId/continuity/suggestion-tasks/:taskId/cancel',async(request,reply)=>{
    try{const {scriptId,taskId}=taskParams.parse(request.params);return await cancelContinuitySuggestionTask(scriptId,taskId);}catch(error){return handle(error,reply);}
  });
};
