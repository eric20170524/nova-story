import { z } from 'zod';
import { EntityBindingSchema, EntityRefSchema } from './entity_binding';

export const FACT_POLICY_VERSION = 'storyboard-facts-3.1';
export const FactKindSchema = z.enum(['visual', 'audio', 'internal', 'figurative', 'mixed', 'uncertain']);
export const FactStateSchema = z.object({ entity: z.string().min(1), attribute: z.string().min(1), value: z.string().min(1), item: z.string().optional(), operation: z.enum(['set', 'remove']).optional() });
export const ContinuityStateSchema = FactStateSchema.extend({ fact_id: z.string() });
export const VisualFactSchema = z.object({
  id: z.string().min(1), scene_id: z.string().min(1), block_id: z.string().min(1),
  start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1),
  kind: FactKindSchema, beat: z.number().int().nonnegative(),
  // Values are source quotes, never inferred continuity.
  states: z.array(FactStateSchema).default([]),
  binding: EntityBindingSchema.optional(),
});
export type VisualFact = z.infer<typeof VisualFactSchema>;
export const StoryboardFactContractSchema = z.object({
  // Read legacy records without silently promoting them to the new policy.
  version: z.union([z.literal(2), z.literal(3)]), policy: z.enum(['storyboard-facts-2', 'storyboard-facts-3', FACT_POLICY_VERSION]),
  source_hash: z.string().min(1), facts: z.array(VisualFactSchema),
  entities: z.array(EntityRefSchema).optional(),
  budgets: z.array(z.object({ scene_id: z.string(), minimum: z.number().int().positive(), duration: z.number().positive() })),
});
export type StoryboardFactContract = z.infer<typeof StoryboardFactContractSchema>;
