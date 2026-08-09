import type { FastifyPluginAsync } from 'fastify';
import { AgentRequestSchema, AgentResponseSchema } from '../schemas/agent';
import {
  AgentExecuteRequestSchema,
  AgentExecuteResultSchema,
} from '../schemas/agent_os';
import { AgentService } from '../services/ai/agent_service';
import { AgentExecutor } from '../services/ai/agent_executor';

export const assistantRoutes: FastifyPluginAsync = async (app) => {
  const service = new AgentService();

  app.post('/chat', async (request) => {
    const input = AgentRequestSchema.parse(request.body);
    const response = await service.processRequest(input);
    return AgentResponseSchema.parse(response);
  });

  /**
   * Execute a planned Agent OS action list after user confirmation.
   * apply=true (default) writes to DB; apply=false dry-runs validation + LLM read for skills.
   */
  app.post('/execute', async (request) => {
    const input = AgentExecuteRequestSchema.parse(request.body);
    const results = await AgentExecutor.executeAll(input.actions, {
      projectId: input.project_id,
      chapterId: input.chapter_id,
      language: input.language,
      apply: input.apply !== false,
    });
    return AgentExecuteResultSchema.parse({ results });
  });
};
