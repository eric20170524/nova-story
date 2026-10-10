import { z } from 'zod';
import {
  ShotIntentSchema,
  SubjectScaleSchema,
  buildUniquenessKey,
} from './shot_contract';

export const ContentAnalysisSchema = z.object({
  new_entities: z.array(z.string()).describe("List of new characters or entities found in the text"),
  updates: z.array(z.string()).describe("List of key plot updates or events")
});

/** Dedicated chapter character + personality analysis (evidence from body text only). */
export const CharacterTraitSchema = z.object({
  trait: z.string().describe('Personality or behavioral trait'),
  evidence: z.string().describe('Short quote or paraphrase from THIS chapter only'),
  confidence: z.number().min(0).max(1).describe('0-1 confidence'),
});

export const CANONICAL_CHARACTER_ROLES = ['protagonist', 'antagonist', 'supporting', 'extra'] as const;
export type CanonicalCharacterRole = (typeof CANONICAL_CHARACTER_ROLES)[number];

/** Accept a stored enum. main/minor are older stored values, not a guess from free text. */
export function canonicalCharacterRole(
  value?: string | null,
  options?: { allowStoredAlias?: boolean },
): CanonicalCharacterRole | null {
  const role = String(value || '').trim().toLowerCase();
  if ((CANONICAL_CHARACTER_ROLES as readonly string[]).includes(role)) {
    return role as CanonicalCharacterRole;
  }
  if (!options?.allowStoredAlias) return null;
  if (role === 'main') return 'protagonist';
  if (role === 'minor') return 'extra';
  return null;
}

export const ChapterCharacterAnalysisItemSchema = z.object({
  name: z.string(),
  roleInChapter: z.string().describe('Exactly one of protagonist, antagonist, supporting, extra'),
  traits: z.array(CharacterTraitSchema).default([]),
  motivation: z.string().optional().nullable().describe('Motivation shown in this chapter'),
  relationships: z.array(z.string()).optional().default([]),
});

export const ChapterCharacterAnalysisSchema = z.object({
  characters: z.array(ChapterCharacterAnalysisItemSchema).default([]),
});

/**
 * Timeline beat schema.
 * AC (Task 2.1): reject shots missing location + primary_action;
 * visual_prompt may be empty — filled by compiler / contract compile.
 */
export const TimelineShotSchema = z.object({
  id: z.number().int().optional().default(1),
  shot_type: z.string().optional().default("Medium Shot"),
  camera_movement: z.string().optional().default("Static"),
  camera_angle: z.string().optional().default("Eye-level"),
  /** Final Pony tags; may be empty when contract fields are present. */
  visual_prompt: z.string().optional().default(""),
  audio_prompt: z.string().optional().default(""),
  dialogue: z.string().nullable().optional(),
  narration: z.string().nullable().optional(),
  duration: z.number().optional().default(3.0),
  negative_prompt: z.string().nullable().optional(),
  // Shot contract (persisted into scene.shot_spec)
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
}).superRefine((shot, ctx) => {
  if (!String(shot.location || '').trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'location is required',
      path: ['location'],
    });
  }
  if (!String(shot.primary_action || '').trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'primary_action is required',
      path: ['primary_action'],
    });
  }
}).transform((shot) => {
  const key_props = Array.isArray(shot.key_props) ? shot.key_props : [];
  const uniqueness_key =
    String(shot.uniqueness_key || '').trim()
    || buildUniquenessKey({
      location: shot.location,
      primary_action: shot.primary_action,
      key_props,
    });
  return { ...shot, key_props, uniqueness_key };
});

export const TimelineResponseSchema = z.object({
  shots: z.array(TimelineShotSchema).min(1)
});

export const VisualTagsSchema = z.object({
  hair: z.string().optional().default(''),
  face: z.string().optional().default(''),
  face_features: z.string().optional().default(''),
  body: z.string().optional().default(''),
  build: z.string().optional().default(''),
  clothing: z.string().optional().default(''),
  accessories: z.string().optional().default(''),
  gender: z.enum(['female', 'male', 'unspecified']).optional().default('unspecified'),
  undressed: z.boolean().optional().default(false),
});

export const CharacterProfileSchema = z.object({
  name: z.string(),
  role: z.string(),
  description: z.string().optional().default(''),
  visual_tags: VisualTagsSchema.optional().default({
    hair: '',
    face: '',
    face_features: '',
    body: '',
    build: '',
    clothing: '',
    accessories: '',
    gender: 'unspecified',
    undressed: false,
  }),
});

export const CharacterProfilesResponseSchema = z.object({
  profiles: z.array(CharacterProfileSchema)
});

export const NewVariantSchema = z.object({
  name: z.string(),
  tags: z.string()
});

export const CharacterEvolutionSchema = z.object({
  action: z.enum(["new_variant", "keep_current", "scene_modifier"]),
  reason: z.string(),
  new_variant: NewVariantSchema.nullable().optional(),
  modifier_tags: z.string().nullable().optional()
});

// Types
export type ContentAnalysis = z.infer<typeof ContentAnalysisSchema>;
export type ChapterCharacterAnalysis = z.infer<typeof ChapterCharacterAnalysisSchema>;
export type TimelineShot = z.infer<typeof TimelineShotSchema>;
export type TimelineResponse = z.infer<typeof TimelineResponseSchema>;
export type VisualTags = z.infer<typeof VisualTagsSchema>;
export type CharacterProfile = z.infer<typeof CharacterProfileSchema>;
export type CharacterProfilesResponse = z.infer<typeof CharacterProfilesResponseSchema>;
export type NewVariant = z.infer<typeof NewVariantSchema>;
export type CharacterEvolution = z.infer<typeof CharacterEvolutionSchema>;
