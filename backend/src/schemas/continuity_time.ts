import { z } from 'zod';
import { ContinuitySourceEvidenceSchema } from './continuity_state';
const id = z.string().trim().min(1).max(160);
export const ContinuityTimePlanSchema = z.object({
  schema_version: z.literal(1), policy_version: z.literal('continuity-time-1'),
  initial_day_id: id,
  boundaries: z.array(z.object({
    script_scene_id: id, kind: z.enum(['new_day','flashback','return_reality','unknown']),
    day_id: id.optional(), branch_id: id.optional(),
    anchor: z.object({script_scene_id:id, phase:z.enum(['entry','exit'])}).strict().optional(),
    rules: z.array(z.object({entity_id:id,attribute_id:id,action:z.enum(['inherit','unknown'])}).strict()).default([]),
    evidence: ContinuitySourceEvidenceSchema,
  }).strict()).max(100),
}).strict();
export type ContinuityTimePlan = z.infer<typeof ContinuityTimePlanSchema>;
