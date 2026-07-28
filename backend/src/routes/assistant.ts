import type { FastifyPluginAsync } from 'fastify';
import { AgentRequestSchema, AgentResponseSchema } from '../schemas/agent';
import { AgentService } from '../services/ai/agent_service';

export const assistantRoutes: FastifyPluginAsync = async (app) => {
  const service = new AgentService();

  app.post('/chat', async (request) => {
    const input = AgentRequestSchema.parse(request.body);
    const response = await service.processRequest(input);
    return AgentResponseSchema.parse(response);
  });
};
