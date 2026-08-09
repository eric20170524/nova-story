import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/database';
import { LLMService } from '../services/llm';
import { WritingService } from '../services/ai/writing_service';

export const creativeRoutes: FastifyPluginAsync = async (app) => {
  app.post('/storyboard-grid', async (request, reply) => {
    const { story_text } = z
      .object({
        story_text: z.string().trim().min(1),
      })
      .parse(request.body);

    try {
      return { prompt: await LLMService.generateStoryboardGrid(story_text) };
    } catch (error: any) {
      return reply.status(500).send({
        detail: `Storyboard grid generation failed: ${error?.message || String(error)}`,
      });
    }
  });

  app.post('/draft', async (request, reply) => {
    const body = z
      .object({
        instructions: z.string().trim().min(1),
        context_chapter_id: z.string().optional().nullable(),
        context_text: z.string().optional().nullable(),
        project_id: z.coerce.number().int().optional().nullable(),
        chapter_id: z.string().optional().nullable(),
        target_word_count: z.coerce.number().int().positive().optional(),
        /**
         * Persist condensed_content. Default false unless apply=true.
         * Never write metadata for unaccepted preview drafts.
         */
        apply_metadata: z.boolean().optional(),
        /** If true, append draft to chapter content in DB and refresh condensed from full chapter */
        apply: z.boolean().optional().default(false),
      })
      .parse(request.body);

    try {
      const chapterId = body.chapter_id || body.context_chapter_id || null;
      let projectId = body.project_id ?? null;

      if (!projectId && chapterId) {
        const ch = await db.get(
          'SELECT project_id FROM chapter WHERE id = ?',
          chapterId
        );
        projectId = ch?.project_id ?? null;
      }

      // Enhanced path: layered memory + negative constraints
      if (projectId && chapterId) {
        const apply = body.apply === true;
        // Only generate/persist metadata when applying, or when explicitly requested with apply
        const wantMetadata = apply || body.apply_metadata === true;

        const result = await WritingService.generateChapterDraft({
          projectId,
          chapterId,
          instructions: body.instructions,
          targetWordCount: body.target_word_count,
          includeExisting: true,
          // Live editor buffer (unsaved) takes priority over DB content
          existingContentOverride:
            body.context_text != null && body.context_text !== undefined
              ? body.context_text
              : null,
          generateMetadata: wantMetadata,
        });

        if (apply) {
          const chapter = await db.get(
            'SELECT content FROM chapter WHERE id = ?',
            chapterId
          );
          const base =
            body.context_text != null
              ? String(body.context_text)
              : chapter?.content
                ? String(chapter.content)
                : '';
          const merged =
            (base ? base + '\n\n' : '') + result.content;
          await db.run(
            'UPDATE chapter SET content = ? WHERE id = ?',
            merged,
            chapterId
          );
          // Condensed must describe full accepted chapter, not only the new fragment
          const condensed =
            await WritingService.regenerateCondensedFromChapter(
              projectId,
              chapterId
            );
          return {
            content: result.content,
            condensed: condensed || result.condensed,
            next_plot: result.nextPlot,
          };
        }

        // Preview path: never write condensed_content unless explicitly forced
        if (body.apply_metadata === true && result.condensed) {
          await WritingService.applyMetadata(chapterId, result.condensed);
        }

        return {
          content: result.content,
          condensed: result.condensed,
          next_plot: result.nextPlot,
        };
      }

      // Legacy simple draft
      let contextText = body.context_text || '';
      if (!contextText && body.context_chapter_id) {
        const chapter = await db.get(
          'SELECT title, summary FROM chapter WHERE id = ?',
          body.context_chapter_id
        );
        if (chapter) {
          contextText = `Previous Chapter: ${chapter.title}\nSummary: ${chapter.summary || 'No summary'}`;
        }
      }

      return {
        content: await LLMService.generateDraft(body.instructions, contextText),
      };
    } catch (error: any) {
      return reply.status(500).send({
        detail: `Draft generation failed: ${error?.message || String(error)}`,
      });
    }
  });

  app.post('/analyze', async (request, reply) => {
    const { content } = z
      .object({
        content: z.string().trim().min(1),
      })
      .parse(request.body);

    try {
      return await LLMService.analyzeContent(content);
    } catch (error: any) {
      return reply.status(500).send({
        detail: `Content analysis failed: ${error?.message || String(error)}`,
      });
    }
  });

  app.post('/consistency', async (request, reply) => {
    const { project_id } = z
      .object({
        project_id: z.coerce.number().int(),
      })
      .parse(request.body);

    try {
      const issues = await WritingService.checkConsistency(project_id);
      return { issues };
    } catch (error: any) {
      return reply.status(500).send({
        detail: `Consistency check failed: ${error?.message || String(error)}`,
      });
    }
  });

  app.post('/impact', async (request, reply) => {
    const body = z
      .object({
        project_id: z.coerce.number().int(),
        chapter_id: z.string().min(1),
        apply: z.boolean().optional().default(true),
      })
      .parse(request.body);

    try {
      const impact = await WritingService.analyzeChapterImpact(
        body.project_id,
        body.chapter_id,
        body.apply !== false
      );
      return impact;
    } catch (error: any) {
      return reply.status(500).send({
        detail: `Impact analysis failed: ${error?.message || String(error)}`,
      });
    }
  });

  app.post('/skill', async (request, reply) => {
    const body = z
      .object({
        project_id: z.coerce.number().int(),
        chapter_id: z.string().min(1),
        skill: z.enum([
          'CINEMATIC_REWRITE',
          'ADD_CONFLICT',
          'REVERSE_PLOT',
        ]),
        technique: z.enum(['montage', 'close_up', 'sensory']).optional(),
        conflictType: z
          .enum(['variable_intrusion', 'extreme_pressure'])
          .optional(),
        intensity: z.enum(['low', 'high']).optional(),
        reversalType: z.enum(['motive_switch', 'character_peel']).optional(),
        targetCharacter: z.string().optional(),
        instructions: z.string().optional().default(''),
        apply: z.boolean().optional().default(false),
      })
      .parse(request.body);

    try {
      let skill: any;
      if (body.skill === 'CINEMATIC_REWRITE') {
        skill = {
          op: 'CINEMATIC_REWRITE',
          technique: body.technique || 'sensory',
          instructions: body.instructions || 'Make it cinematic',
        };
      } else if (body.skill === 'ADD_CONFLICT') {
        skill = {
          op: 'ADD_CONFLICT',
          conflictType: body.conflictType || 'variable_intrusion',
          intensity: body.intensity || 'high',
          instructions: body.instructions,
        };
      } else {
        skill = {
          op: 'REVERSE_PLOT',
          reversalType: body.reversalType || 'motive_switch',
          targetCharacter: body.targetCharacter,
          instructions: body.instructions,
        };
      }

      const content = await WritingService.executeSkill({
        projectId: body.project_id,
        chapterId: body.chapter_id,
        skill,
      });

      if (body.apply) {
        await db.run(
          'UPDATE chapter SET content = ? WHERE id = ?',
          content,
          body.chapter_id
        );
      }

      return { content, applied: Boolean(body.apply) };
    } catch (error: any) {
      return reply.status(500).send({
        detail: `Skill execution failed: ${error?.message || String(error)}`,
      });
    }
  });

  app.get('/context/:chapter_id', async (request, reply) => {
    const { chapter_id } = z
      .object({
        chapter_id: z.string().min(1),
      })
      .parse(request.params);
    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapter_id);
    if (!chapter) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    const [chapters, characters, glossary] = await Promise.all([
      db.all(
        'SELECT id, title, "index", summary, status, condensed_content FROM chapter WHERE project_id = ? ORDER BY "index" ASC',
        chapter.project_id
      ),
      db.all(
        'SELECT id, name, role, description FROM character WHERE project_id = ? ORDER BY id ASC',
        chapter.project_id
      ),
      db.all(
        'SELECT id, term, definition, category FROM glossary WHERE project_id = ? ORDER BY id ASC',
        chapter.project_id
      ),
    ]);

    return {
      project_structure: chapters,
      focus: chapter.summary || 'No summary available',
      characters,
      glossary,
    };
  });
};
