import { z } from 'zod';
import { ContinuityStoryPositionSchema } from './continuity';
import { ContinuityAttributeIdSchema, ContinuityEvidenceSchema, ContinuityConfirmationSchema, type ContinuityAttributeId } from './continuity_state';

const id = z.string().min(1).max(160).refine(value => value === value.trim());
export const ContinuityVisiblePositionSchema = z.object({
  mode: z.enum(['held', 'airborne', 'on_surface']), anchor_entity_id: id.optional(),
}).strict();
export const ContinuityOverlayProposalSchema = z.object({
  schema_version: z.union([z.literal(1),z.literal(2)]), policy_version: z.enum(['continuity-state-1','continuity-state-2']),
  overlay_id: id, overlay_revision: z.number().int().positive(), binding_revision: z.number().int().positive(),
  story_position: ContinuityStoryPositionSchema, event_change_id: id.nullable(),
  /** Explicit last completed subevent; null means the state immediately before the event. */
  after_change_id: id.nullable(),
  values: z.array(z.object({ entity_id: id, attribute_id: z.union([ContinuityAttributeIdSchema, z.literal('visible_position')]), value: z.unknown() }).strict()).min(1),
  evidence: z.array(ContinuityEvidenceSchema).min(1),
}).strict().superRefine((overlay, context) => {
  const extended=overlay.values.some(v=>v.attribute_id==='holding_hand');if(overlay.schema_version!==(extended?2:1)||overlay.policy_version!==(extended?'continuity-state-2':'continuity-state-1'))context.addIssue({code:'custom',message:'Overlay extension version mismatch'});
  if (overlay.story_position.phase !== 'during') context.addIssue({ code: 'custom', message: 'Overlay requires a during moment' });
  if (overlay.event_change_id === null && (overlay.after_change_id !== null || overlay.story_position.change_order !== 0 || overlay.story_position.beat_id !== null || !overlay.evidence.every(item => item.kind === 'design'))) {
    context.addIssue({ code: 'custom', message: 'A standalone frame design uses the scene entry and cannot claim completed story events' });
  }
  const keys = overlay.values.map(value => JSON.stringify([value.entity_id, value.attribute_id]));
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'Duplicate overlay attribute' });
  overlay.values.forEach((value, index) => { if (value.value === undefined) context.addIssue({ code: 'custom', path: ['values', index, 'value'], message: 'Missing overlay value' }); });
});
export type ContinuityOverlayProposal = Omit<z.infer<typeof ContinuityOverlayProposalSchema>, 'values'> & {
  values: { entity_id: string; attribute_id: ContinuityAttributeId | 'visible_position'; value: unknown }[];
};
export type ContinuityConfirmedOverlay = { proposal: ContinuityOverlayProposal; confirmation: z.infer<typeof ContinuityConfirmationSchema> };

export const ContinuityReadSchema = z.object({
  entity_id: id, attribute_id: z.union([ContinuityAttributeIdSchema, z.literal('visible_position')]),
}).strict();
export type ContinuityRead = { entity_id: string; attribute_id: ContinuityAttributeId | 'visible_position' };
