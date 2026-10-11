import { z } from 'zod';
import { ContinuityEntitySchema } from './continuity';
import { ContinuityChangeProposalSchema, ContinuityEvidenceSchema } from './continuity_state';
import { ContinuityOverlayProposalSchema } from './continuity_snapshot';
import { ContinuityTimePlanSchema } from './continuity_time';

export const ContinuityEntryValueSchema = z.object({ entity_id: z.string().min(1), attribute_id: z.string().min(1), knowledge_status: z.enum(['unknown','confirmed']),
  value: z.unknown().optional(), evidence: z.array(ContinuityEvidenceSchema).optional() }).strict().superRefine((cell,context) => {
  if (cell.knowledge_status === 'confirmed' && cell.value === undefined) context.addIssue({ code:'custom',message:'Confirmed value must be explicitly present, including null' });
  if (cell.knowledge_status === 'unknown' && (cell.value !== undefined || cell.evidence !== undefined)) context.addIssue({ code:'custom',message:'Unknown state cannot contain a claimed value or evidence' });
});
export const ConfirmContinuityReviewSchema = z.object({ review_action:z.literal('human_review'),target_scene_id:z.string().min(1),
  expected_script_revision:z.number().int().positive(),expected_continuity_revision:z.number().int().nonnegative(),request_key:z.string().trim().min(1).max(100),reason:z.string().trim().min(1).max(1000),
  replace_all:z.boolean().default(false),time_relation:z.enum(['confirmed_linear','unknown']).default('confirmed_linear'),
  expected_impact_hash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  time_plan:ContinuityTimePlanSchema.optional(),
  entities:z.array(ContinuityEntitySchema).optional(),entry_values:z.array(ContinuityEntryValueSchema).optional(),
  changes:z.array(ContinuityChangeProposalSchema).optional(),during_overlays:z.array(ContinuityOverlayProposalSchema).optional() }).strict();
export type ConfirmContinuityReview = z.infer<typeof ConfirmContinuityReviewSchema>;
