import type { FastifyPluginAsync } from 'fastify';
import {
  ScriptService,
  ScriptServiceError,
} from '../services/script_service';
import {
  ScriptGenerationService,
  ScriptGenerationError,
} from '../services/ai/script_generation_service';
import {
  StoryboardGenerationService,
  StoryboardGenerationError,
} from '../services/ai/storyboard_generation_service';
import {
  SaveScriptBodySchema,
  ConfirmScriptBodySchema,
  RestoreScriptBodySchema,
  RefreshSourceBodySchema,
  CreateScriptCandidateBodySchema,
  UpdateScriptCandidateBodySchema,
  ApplyScriptCandidateBodySchema,
  CreateStoryboardCandidateBodySchema,
  ApplyStoryboardCandidateBodySchema,
} from '../schemas/script';

export const scriptRoutes: FastifyPluginAsync = async (app) => {
  // Error handling helper
  const handleError = (error: unknown, reply: any) => {
    if (
      error instanceof ScriptServiceError ||
      error instanceof ScriptGenerationError ||
      error instanceof StoryboardGenerationError
    ) {
      return reply.status(error.statusCode).send({ detail: error.message });
    }
    const message = error instanceof Error ? error.message : String(error);
    app.log.error(error, `Script operation failed: ${message}`);
    return reply.status(500).send({ detail: message || 'Internal server error' });
  };

  /**
   * GET /api/chapters/:chapterId/script
   * Fetch current screenplay for a chapter or explicit null if not yet created.
   */
  app.get<{ Params: { chapterId: string } }>(
    '/chapters/:chapterId/script',
    async (request, reply) => {
      try {
        const { chapterId } = request.params;
        const script = await ScriptService.getScriptByChapterId(chapterId);
        if (!script) {
          return reply.send({ exists: false, script: null });
        }
        return reply.send({ exists: true, script });
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  /**
   * POST /api/chapters/:chapterId/script
   * Idempotently create an empty screenplay for a chapter.
   */
  app.post<{
    Params: { chapterId: string };
    Body: { title?: string };
  }>('/chapters/:chapterId/script', async (request, reply) => {
    try {
      const { chapterId } = request.params;
      const initialTitle = request.body?.title;
      const script = await ScriptService.createOrGetScript(chapterId, initialTitle);
      return reply.status(200).send({ script });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * GET /api/scripts/:scriptId
   * Fetch screenplay by scriptId.
   */
  app.get<{ Params: { scriptId: string } }>(
    '/scripts/:scriptId',
    async (request, reply) => {
      try {
        const scriptId = parseInt(request.params.scriptId, 10);
        if (Number.isNaN(scriptId)) {
          return reply.status(400).send({ detail: 'Invalid scriptId' });
        }
        const script = await ScriptService.getScriptById(scriptId);
        return reply.send({ script });
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  /**
   * PUT /api/scripts/:scriptId
   * Save manual screenplay document edits with expected_revision verification.
   */
  app.put<{
    Params: { scriptId: string };
    Body: unknown;
  }>('/scripts/:scriptId', async (request, reply) => {
    try {
      const scriptId = parseInt(request.params.scriptId, 10);
      if (Number.isNaN(scriptId)) {
        return reply.status(400).send({ detail: 'Invalid scriptId' });
      }

      const parsed = SaveScriptBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          detail: `Invalid request payload: ${parsed.error.message}`,
        });
      }

      const script = await ScriptService.saveManualScript({
        scriptId,
        document: parsed.data.document,
        expectedRevision: parsed.data.expected_revision,
        requestKey: parsed.data.request_key,
      });

      return reply.send({ script });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * POST /api/scripts/:scriptId/confirm
   * Validate completeness & source freshness and confirm script.
   */
  app.post<{
    Params: { scriptId: string };
    Body: unknown;
  }>('/scripts/:scriptId/confirm', async (request, reply) => {
    try {
      const scriptId = parseInt(request.params.scriptId, 10);
      if (Number.isNaN(scriptId)) {
        return reply.status(400).send({ detail: 'Invalid scriptId' });
      }

      const parsed = ConfirmScriptBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          detail: `Invalid request payload: ${parsed.error.message}`,
        });
      }

      const script = await ScriptService.confirmScript({
        scriptId,
        expectedRevision: parsed.data.expected_revision,
        forceSourceRefresh: parsed.data.force_source_refresh,
        requestKey: parsed.data.request_key,
      });

      return reply.send({ script });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * POST /api/scripts/:scriptId/restore
   * Restore the last restorable document version.
   */
  app.post<{
    Params: { scriptId: string };
    Body: unknown;
  }>('/scripts/:scriptId/restore', async (request, reply) => {
    try {
      const scriptId = parseInt(request.params.scriptId, 10);
      if (Number.isNaN(scriptId)) {
        return reply.status(400).send({ detail: 'Invalid scriptId' });
      }

      const parsed = RestoreScriptBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          detail: `Invalid request payload: ${parsed.error.message}`,
        });
      }

      const script = await ScriptService.restoreScript({
        scriptId,
        expectedRevision: parsed.data.expected_revision,
        requestKey: parsed.data.request_key,
      });

      return reply.send({ script });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * POST /api/scripts/:scriptId/refresh-source
   * Explicitly refresh source snapshot without requiring production completeness checks.
   */
  app.post<{
    Params: { scriptId: string };
    Body: unknown;
  }>('/scripts/:scriptId/refresh-source', async (request, reply) => {
    try {
      const scriptId = parseInt(request.params.scriptId, 10);
      if (Number.isNaN(scriptId)) {
        return reply.status(400).send({ detail: 'Invalid scriptId' });
      }

      const parsed = RefreshSourceBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          detail: `Invalid request payload: ${parsed.error.message}`,
        });
      }

      const script = await ScriptService.refreshSourceSnapshot({
        scriptId,
        expectedRevision: parsed.data.expected_revision,
        requestKey: parsed.data.request_key,
      });

      return reply.send({ script });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * POST /api/scripts/:scriptId/candidates
   * Create a pending candidate change.
   */
  app.post<{
    Params: { scriptId: string };
    Body: unknown;
  }>('/scripts/:scriptId/candidates', async (request, reply) => {
    try {
      const scriptId = parseInt(request.params.scriptId, 10);
      if (Number.isNaN(scriptId)) {
        return reply.status(400).send({ detail: 'Invalid scriptId' });
      }

      const parsed = CreateScriptCandidateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          detail: `Invalid candidate payload: ${parsed.error.message}`,
        });
      }

      let candidate;
      if (parsed.data.after_json) {
        candidate = await ScriptService.createPendingCandidate({
          scriptId,
          kind: parsed.data.kind,
          expectedRevision: parsed.data.expected_revision,
          requestKey: parsed.data.request_key,
          afterJson: parsed.data.after_json,
          beforeJson: parsed.data.before_json,
          generationInfo: parsed.data.generation_info,
        });
      } else {
        if (parsed.data.kind === 'outline') {
          candidate = await ScriptGenerationService.generateOutlineCandidate({
            scriptId,
            expectedRevision: parsed.data.expected_revision,
            requestKey: parsed.data.request_key,
            instructions: parsed.data.instructions,
            targetDurationSec: parsed.data.target_duration_sec,
          });
        } else if (parsed.data.kind === 'script') {
          candidate = await ScriptGenerationService.generateFullScriptCandidate({
            scriptId,
            expectedRevision: parsed.data.expected_revision,
            requestKey: parsed.data.request_key,
            instructions: parsed.data.instructions,
            targetDurationSec: parsed.data.target_duration_sec,
          });
        } else if (parsed.data.kind === 'scene') {
          if (!parsed.data.target_scene_id) {
            return reply.status(400).send({
              detail: 'target_scene_id is required for scene rewrite candidate',
            });
          }
          candidate = await ScriptGenerationService.generateSceneRewriteCandidate({
            scriptId,
            targetSceneId: parsed.data.target_scene_id,
            expectedRevision: parsed.data.expected_revision,
            requestKey: parsed.data.request_key,
            instructions: parsed.data.instructions,
          });
        } else {
          return reply.status(400).send({
            detail: `Candidate kind "${parsed.data.kind}" requires after_json`,
          });
        }
      }

      return reply.status(201).send({ candidate });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * PATCH /api/scripts/:scriptId/candidates/:changeId
   * Edit a pending candidate.
   */
  app.patch<{
    Params: { scriptId: string; changeId: string };
    Body: unknown;
  }>('/scripts/:scriptId/candidates/:changeId', async (request, reply) => {
    try {
      const scriptId = parseInt(request.params.scriptId, 10);
      if (Number.isNaN(scriptId)) {
        return reply.status(400).send({ detail: 'Invalid scriptId' });
      }
      const { changeId } = request.params;

      const parsed = UpdateScriptCandidateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          detail: `Invalid candidate payload: ${parsed.error.message}`,
        });
      }

      const candidate = await ScriptService.updatePendingCandidate({
        scriptId,
        changeId,
        expectedRevision: parsed.data.expected_revision,
        expectedCandidateRevision: parsed.data.expected_candidate_revision,
        afterJson: parsed.data.after_json,
      });

      return reply.send({ candidate });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * POST /api/scripts/:scriptId/candidates/:changeId/apply
   * Apply a pending candidate.
   */
  app.post<{
    Params: { scriptId: string; changeId: string };
    Body: unknown;
  }>('/scripts/:scriptId/candidates/:changeId/apply', async (request, reply) => {
    try {
      const scriptId = parseInt(request.params.scriptId, 10);
      if (Number.isNaN(scriptId)) {
        return reply.status(400).send({ detail: 'Invalid scriptId' });
      }
      const { changeId } = request.params;

      const parsed = ApplyScriptCandidateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          detail: `Invalid payload: ${parsed.error.message}`,
        });
      }

      const script = await ScriptService.applyCandidate({
        scriptId,
        changeId,
        expectedRevision: parsed.data.expected_revision,
        expectedCandidateRevision: parsed.data.expected_candidate_revision,
        requestKey: parsed.data.request_key,
      });

      return reply.send({ script });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * POST /api/scripts/:scriptId/candidates/:changeId/discard
   * Discard a pending candidate.
   */
  app.post<{
    Params: { scriptId: string; changeId: string };
  }>('/scripts/:scriptId/candidates/:changeId/discard', async (request, reply) => {
    try {
      const scriptId = parseInt(request.params.scriptId, 10);
      if (Number.isNaN(scriptId)) {
        return reply.status(400).send({ detail: 'Invalid scriptId' });
      }
      const { changeId } = request.params;

      const candidate = await ScriptService.discardCandidate({
        scriptId,
        changeId,
      });

      return reply.send({ candidate });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * GET /api/scripts/:scriptId/export
   * Export screenplay as deterministic Markdown.
   */
  app.get<{
    Params: { scriptId: string };
    Querystring: { format?: string };
  }>('/scripts/:scriptId/export', async (request, reply) => {
    try {
      const scriptId = parseInt(request.params.scriptId, 10);
      if (Number.isNaN(scriptId)) {
        return reply.status(400).send({ detail: 'Invalid scriptId' });
      }

      const markdown = await ScriptService.exportScriptMarkdown(scriptId);

      // Return both raw text if client accepts text/markdown or json
      const accept = request.headers.accept || '';
      if (accept.includes('text/markdown') || accept.includes('text/plain')) {
        return reply
          .header('Content-Type', 'text/markdown; charset=utf-8')
          .send(markdown);
      }

      return reply.send({
        format: 'markdown',
        markdown,
      });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * POST /api/scripts/:scriptId/storyboard-candidates
   * Generate a storyboard candidate from a confirmed screenplay.
   */
  app.post<{
    Params: { scriptId: string };
    Body: unknown;
  }>('/scripts/:scriptId/storyboard-candidates', async (request, reply) => {
    try {
      const scriptId = parseInt(request.params.scriptId, 10);
      if (Number.isNaN(scriptId)) {
        return reply.status(400).send({ detail: 'Invalid scriptId' });
      }

      const parsed = CreateStoryboardCandidateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          detail: `Invalid request payload: ${parsed.error.message}`,
        });
      }

      const candidate = await StoryboardGenerationService.generateStoryboardCandidate({
        scriptId,
        expectedRevision: parsed.data.expected_revision,
        requestKey: parsed.data.request_key,
        instructions: parsed.data.instructions,
      });

      return reply.status(200).send({ candidate });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * POST /api/scripts/:scriptId/storyboard-candidates/:changeId/apply
   * Atomically apply a storyboard candidate to the chapter timeline (empty timeline only).
   */
  app.post<{
    Params: { scriptId: string; changeId: string };
    Body: unknown;
  }>('/scripts/:scriptId/storyboard-candidates/:changeId/apply', async (request, reply) => {
    try {
      const scriptId = parseInt(request.params.scriptId, 10);
      if (Number.isNaN(scriptId)) {
        return reply.status(400).send({ detail: 'Invalid scriptId' });
      }
      const { changeId } = request.params;

      const parsed = ApplyStoryboardCandidateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          detail: `Invalid payload: ${parsed.error.message}`,
        });
      }

      const result = await StoryboardGenerationService.applyStoryboardCandidate({
        scriptId,
        changeId,
        expectedRevision: parsed.data.expected_revision,
        expectedCandidateRevision: parsed.data.expected_candidate_revision,
        requestKey: parsed.data.request_key,
      });

      return reply.status(200).send(result);
    } catch (error) {
      return handleError(error, reply);
    }
  });
};
