import { z } from 'zod';

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

/**
 * Structured beat / shot contract written to scene.shot_spec.
 * visual_prompt is intentionally NOT required here — compiler fills it.
 */
export const ShotContractFieldsSchema = z.object({
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

  const payload = {
    shot_intent: shot.shot_intent || null,
    location: location || null,
    primary_action: primary_action || null,
    primary_subject: shot.primary_subject ?? null,
    visible_subjects,
    key_props,
    subject_scale: shot.subject_scale || null,
    uniqueness_key: uniqueness_key || null,
    must_not: Array.isArray(shot.must_not) ? shot.must_not : [],
    shot_type: shot.shot_type || null,
  };
  return JSON.stringify(payload);
};

