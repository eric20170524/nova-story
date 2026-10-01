import { FastifyPluginAsync } from 'fastify';
import { ZodError, z } from 'zod';
import { PlanningError } from '../schemas/story_plan';
import { StoryPlanService } from '../services/story_plan_service';
import { StoryPlanningService } from '../services/ai/story_planning_service';

const ProjectIdSchema = z.object({
  id: z.coerce.number().int(),
});

const ChangeParamsSchema = z.object({
  id: z.coerce.number().int(),
  changeId: z.string().min(1),
});

const GenerateSchema = z.object({
  request_key: z.string().min(1).max(200),
  expected_revision: z.number().int().positive(),
  kind: z.enum(['blueprint', 'chapters']),
  mode: z.enum(['initial', 'extend', 'revise']).optional(),
  message: z.string().default(''),
  history: z.array(z.object({
    role: z.string().optional(),
    content: z.string().optional(),
  })).optional(),
  target_plan_ids: z.array(z.string()).optional(),
  batch_size: z.number().int().min(1).max(5).optional(),
});

const ApplySchema = z.object({
  expected_revision: z.number().int().positive(),
  expected_candidate_revision: z.number().int().positive(),
  selected_patch_ids: z.array(z.string()),
});

const EditSchema = z.object({
  expected_candidate_revision: z.number().int().positive(),
  document: z.unknown(),
});

const NextChapterSchema = z.object({
  plan_entry_id: z.string().min(1),
  expected_revision: z.number().int().positive(),
  expected_last_chapter_id: z.string().nullable(),
  request_key: z.string().min(1).max(200),
});

const UpdateSchema = z.object({
  expected_revision: z.number().int().positive(),
  document: z.unknown(),
});

function sendError(reply: { status: (code: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof PlanningError) {
    return reply.status(error.status).send({ code: error.code, detail: error.message });
  }
  if (error instanceof ZodError) {
    return reply.status(422).send({ code: 'MODEL_INVALID_OUTPUT', detail: error.message });
  }
  throw error;
}

export const storyPlanRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/story-plan', async (request, reply) => {
    try {
      const { id } = ProjectIdSchema.parse(request.params);
      return await StoryPlanService.getView(id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/story-plan/bootstrap', async (request, reply) => {
    try {
      const { id } = ProjectIdSchema.parse(request.params);
      return await StoryPlanService.bootstrap(id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/:id/story-plan', async (request, reply) => {
    try {
      const { id } = ProjectIdSchema.parse(request.params);
      const body = UpdateSchema.parse(request.body);
      return await StoryPlanService.updateDocument(id, body.expected_revision, body.document);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id/story-plan/candidates', async (request, reply) => {
    try {
      const { id } = ProjectIdSchema.parse(request.params);
      const query = z.object({ request_key: z.string().optional() }).parse(request.query);
      return await StoryPlanService.listCandidates(id, query.request_key);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/story-plan/candidates', async (request, reply) => {
    try {
      const { id } = ProjectIdSchema.parse(request.params);
      const body = GenerateSchema.parse(request.body || {});
      const shared = {
        projectId: id,
        requestKey: body.request_key,
        expectedRevision: body.expected_revision,
        message: body.message,
        history: body.history,
        targetPlanIds: body.target_plan_ids,
        batchSize: body.batch_size,
      };
      const candidate = body.kind === 'blueprint'
        ? await StoryPlanningService.generateBlueprint(shared)
        : await StoryPlanningService.generateChapters({ ...shared, mode: body.mode || 'extend' });
      return reply.status(201).send(candidate);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/:id/story-plan/candidates/:changeId', async (request, reply) => {
    try {
      const { id, changeId } = ChangeParamsSchema.parse(request.params);
      const body = EditSchema.parse(request.body);
      return await StoryPlanService.editCandidate(id, changeId, body.expected_candidate_revision, body.document);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/story-plan/candidates/:changeId/apply', async (request, reply) => {
    try {
      const { id, changeId } = ChangeParamsSchema.parse(request.params);
      const body = ApplySchema.parse(request.body);
      return await StoryPlanService.applyCandidate(id, changeId, body);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/story-plan/candidates/:changeId/reject', async (request, reply) => {
    try {
      const { id, changeId } = ChangeParamsSchema.parse(request.params);
      return await StoryPlanService.rejectCandidate(id, changeId);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/story-plan/next-chapter', async (request, reply) => {
    try {
      const { id } = ProjectIdSchema.parse(request.params);
      const body = NextChapterSchema.parse(request.body);
      const result = await StoryPlanService.createNextChapter({
        project_id: id,
        plan_entry_id: body.plan_entry_id,
        expected_revision: body.expected_revision,
        expected_last_chapter_id: body.expected_last_chapter_id,
        request_key: body.request_key,
      });
      return reply.status(201).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
