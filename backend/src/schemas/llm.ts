import { z } from 'zod';

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

export const ChapterCharacterAnalysisItemSchema = z.object({
  name: z.string(),
  roleInChapter: z.string().describe('Role in this chapter, e.g. protagonist / antagonist / witness'),
  traits: z.array(CharacterTraitSchema).default([]),
  motivation: z.string().optional().nullable().describe('Motivation shown in this chapter'),
  relationships: z.array(z.string()).optional().default([]),
});

export const ChapterCharacterAnalysisSchema = z.object({
  characters: z.array(ChapterCharacterAnalysisItemSchema).default([]),
});

export const TimelineShotSchema = z.object({
  id: z.number().int().optional().default(1),
  shot_type: z.string().optional().default("Medium Shot"),
  camera_movement: z.string().optional().default("Static"),
  camera_angle: z.string().optional().default("Eye-level"),
  visual_prompt: z.string().optional().default(""),
  audio_prompt: z.string().optional().default(""),
  dialogue: z.string().nullable().optional(),
  duration: z.number().optional().default(3.0),
  negative_prompt: z.string().nullable().optional()
});

export const TimelineResponseSchema = z.object({
  shots: z.array(TimelineShotSchema)
});

export const VisualTagsSchema = z.object({
  hair: z.string(),
  eyes: z.string(),
  skin_tone: z.string(),
  face_features: z.string(),
  build: z.string(),
  clothing: z.string(),
  accessories: z.string()
});

export const CharacterProfileSchema = z.object({
  name: z.string(),
  role: z.enum(["main", "supporting", "minor"]),
  description: z.string(),
  visual_tags: VisualTagsSchema
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
