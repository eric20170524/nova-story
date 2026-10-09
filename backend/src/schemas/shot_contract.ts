import { z } from 'zod';
import { ContinuityStateSchema, VisualFactSchema, type VisualFact } from './storyboard_facts';

export const SHOT_INTENTS = [
  'establish',
  'wide-action',
  'medium-action',
  'insert',
  'reaction',
  'overhead-map',
  'payoff',
] as const;

export type ShotIntent = (typeof SHOT_INTENTS)[number];

export const SUBJECT_SCALES = [
  'absent',
  'small-15-20',
  'medium-20-40',
  'dominant',
] as const;

export type SubjectScale = (typeof SUBJECT_SCALES)[number];

export const ShotIntentSchema = z.enum(SHOT_INTENTS);
export const SubjectScaleSchema = z.enum(SUBJECT_SCALES);

export const ShotSourceReferenceSchema = z.object({
  type: z.enum(['chapter', 'script']),
  script_id: z.number().int().optional().nullable(),
  script_revision: z.number().int().optional().nullable(),
  script_scene_id: z.string().optional().nullable(),
  block_ids: z.array(z.string()).optional().nullable(),
});
export const AudibleBlockSchema = z.object({ id: z.string(), type: z.enum(['dialogue', 'voiceover', 'sound']), text: z.string(), characterId: z.number().int().nullable().optional(), delivery: z.string().optional() });

export type ShotSourceReference = z.infer<typeof ShotSourceReferenceSchema>;

/**
 * Structured beat / shot contract written to scene.shot_spec.
 * visual_prompt is intentionally NOT required here — compiler fills it.
 */
export const ShotContractFieldsSchema = z.object({
  scene_context: z.object({ location_description: z.string(), interior_exterior: z.enum(['interior', 'exterior']), time_of_day: z.string() }).optional(),
  visual_facts: z.array(VisualFactSchema).optional(),
  audible_blocks: z.array(AudibleBlockSchema).optional(),
  continuity_states: z.array(ContinuityStateSchema).optional(),
  shot_intent: ShotIntentSchema.optional(),
  location: z.string().trim().min(2).max(240),
  primary_action: z.string().trim().min(2).max(240),
  primary_subject: z.string().trim().max(240).optional().nullable(),
  visible_subjects: z
    .array(z.string().trim().min(1).max(120))
    .max(6)
    .optional()
    .default([]),
  key_props: z
    .array(z.string().trim().min(1).max(120))
    .max(2)
    .optional()
    .default([]),
  subject_scale: SubjectScaleSchema.optional(),
  uniqueness_key: z.string().trim().min(2).max(240).optional(),
  must_not: z.array(z.string().trim().min(1).max(120)).optional().default([]),
  source: ShotSourceReferenceSchema.optional().nullable(),
});

export type ShotContractFields = z.infer<typeof ShotContractFieldsSchema>;

export const buildUniquenessKey = (input: {
  location: string;
  primary_action: string;
  key_props?: string[] | null;
}): string => {
  const prop = (input.key_props || []).map((p) => p.trim()).filter(Boolean)[0] || 'none';
  return [input.location, input.primary_action, prop]
    .map((part) => String(part || '').trim().toLowerCase().replace(/\s+/g, ' '))
    .join(' | ');
};

/** Pack contract JSON for scene.shot_spec TEXT column. */
export const packShotSpec = (shot: {
  scene_context?: { location_description: string; interior_exterior: 'interior' | 'exterior'; time_of_day: string };
  visual_facts?: VisualFact[];
  audible_blocks?: z.infer<typeof AudibleBlockSchema>[];
  continuity_states?: z.infer<typeof ContinuityStateSchema>[];
  shot_intent?: string | null;
  location?: string | null;
  primary_action?: string | null;
  primary_subject?: string | null;
  visible_subjects?: string[] | null;
  key_props?: string[] | null;
  subject_scale?: string | null;
  uniqueness_key?: string | null;
  must_not?: string[] | null;
  shot_type?: string | null;
  source?: ShotSourceReference | null;
}): string => {
  const location = String(shot.location || '').trim();
  const primary_action = String(shot.primary_action || '').trim();
  const key_props = Array.isArray(shot.key_props)
    ? shot.key_props.map((p) => String(p).trim()).filter(Boolean).slice(0, 2)
    : [];
  const visible_subjects = Array.isArray(shot.visible_subjects)
    ? shot.visible_subjects.map((p) => String(p).trim()).filter(Boolean).slice(0, 6)
    : [];
  const uniqueness_key =
    String(shot.uniqueness_key || '').trim()
    || (location && primary_action
      ? buildUniquenessKey({ location, primary_action, key_props })
      : '');

  const source = shot.source
    ? {
        type: shot.source.type,
        script_id: shot.source.script_id ?? null,
        script_revision: shot.source.script_revision ?? null,
        script_scene_id: shot.source.script_scene_id ?? null,
        block_ids: Array.isArray(shot.source.block_ids) ? shot.source.block_ids : null,
      }
    : null;

  const payload = {
    ...(shot.scene_context ? { scene_context: shot.scene_context } : {}),
    ...(shot.visual_facts ? { visual_facts: shot.visual_facts } : {}),
    ...(shot.audible_blocks ? { audible_blocks: shot.audible_blocks } : {}),
    ...(shot.continuity_states ? { continuity_states: shot.continuity_states } : {}),
    shot_intent: shot.shot_intent || null,
    location: location || null,
    primary_action: primary_action || null,
    primary_subject: shot.primary_subject ?? null,
    visible_subjects,
    key_props,
    subject_scale: shot.subject_scale || null,
    uniqueness_key: uniqueness_key ? uniqueness_key.slice(0, 240) : null,
    must_not: Array.isArray(shot.must_not) ? shot.must_not : [],
    shot_type: shot.shot_type || null,
    source,
  };
  return JSON.stringify(payload);
};

