import { z } from 'zod';
import { ContinuityStoryPositionSchema, type ContinuityEntity } from './continuity';

export const CONTINUITY_STATE_SCHEMA_VERSION = 1 as const;
export const CONTINUITY_STATE_POLICY_VERSION = 'continuity-state-1' as const;
/** Attribute-specific extension; existing attributes keep their frozen v1 semantics. */
export function continuityAttributeVersion(attribute:string){return attribute==='holding_hand'?{schema_version:2 as const,policy_version:'continuity-state-2' as const}:{schema_version:1 as const,policy_version:'continuity-state-1' as const};}
const schemaVersion=z.union([z.literal(1),z.literal(2)]),policyVersion=z.enum(['continuity-state-1','continuity-state-2']);
const id = z.string().min(1).max(160).refine(value => value === value.trim(), 'Invalid ID');
const revision = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const physical = ['garment', 'prop', 'object', 'component'] as const;
type AttributeDefinition = {
  type: 'enum' | 'colour' | 'entity'; kinds: readonly ContinuityEntity['kind'][];
  values?: readonly string[]; target_kinds?: readonly ContinuityEntity['kind'][];
  scope: 'story_segment'; operations: readonly ('assign' | 'clear' | 'transfer')[];
};

/** Changing this registry's semantics requires a new schema AND policy version. */
export const CONTINUITY_ATTRIBUTES = Object.freeze({
  color: { type: 'colour', kinds: physical, scope: 'story_segment', operations: ['assign'] },
  wetness: { type: 'enum', values: ['dry', 'wet'], kinds: physical, scope: 'story_segment', operations: ['assign'] },
  integrity: { type: 'enum', values: ['intact', 'damaged', 'broken'], kinds: physical, scope: 'story_segment', operations: ['assign'] },
  wearer: { type: 'entity', kinds: ['garment'], target_kinds: ['character'], scope: 'story_segment', operations: ['assign', 'clear'] },
  holder: { type: 'entity', kinds: physical, target_kinds: ['character'], scope: 'story_segment', operations: ['assign', 'clear', 'transfer'] },
  owner: { type: 'entity', kinds: physical, target_kinds: ['character'], scope: 'story_segment', operations: ['assign', 'clear'] },
  location: { type: 'entity', kinds: ['character', ...physical], target_kinds: ['location'], scope: 'story_segment', operations: ['assign', 'clear'] },
  presence: { type: 'enum', values: ['present', 'absent'], kinds: ['character', ...physical], scope: 'story_segment', operations: ['assign'] },
  open_state: { type: 'enum', values: ['open', 'closed'], kinds: ['prop', 'object', 'component'], scope: 'story_segment', operations: ['assign'] },
  lock_function: { type: 'enum', values: ['working', 'broken'], kinds: ['component'], scope: 'story_segment', operations: ['assign'] },
  power_state: { type: 'enum', values: ['on', 'off'], kinds: ['prop', 'object', 'component'], scope: 'story_segment', operations: ['assign'] },
  holding_hand: { type:'enum', values:['physical_left','physical_right','both','unheld'],kinds:physical,scope:'story_segment',operations:['assign'] },
} satisfies Record<string, AttributeDefinition>);
for (const definition of Object.values(CONTINUITY_ATTRIBUTES)) {
  Object.values(definition).forEach(value => { if (Array.isArray(value)) Object.freeze(value); });
  Object.freeze(definition);
}
export type ContinuityAttributeId = keyof typeof CONTINUITY_ATTRIBUTES;
export const ContinuityAttributeIdSchema = z.enum(Object.keys(CONTINUITY_ATTRIBUTES) as [ContinuityAttributeId, ...ContinuityAttributeId[]]);
export function continuityAttribute(id: string): AttributeDefinition | undefined {
  return Object.hasOwn(CONTINUITY_ATTRIBUTES, id) ? CONTINUITY_ATTRIBUTES[id as ContinuityAttributeId] : undefined;
}

/** JavaScript string indices are UTF-16 code units; exact text is never normalized. */
export const ContinuitySourceEvidenceSchema = z.object({
  kind: z.literal('source'), source_type: z.enum(['novel', 'screenplay']), source_document_id: id,
  source_revision: revision, source_text_hash: hash, evidence_quote: z.string().min(1),
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
}).strict().refine(evidence => evidence.end > evidence.start, 'Empty or reversed evidence range');
export const ContinuityDesignEvidenceSchema = z.object({
  kind: z.literal('design'), design_id: id, design_revision: revision,
}).strict();
export const ContinuityEvidenceSchema = z.discriminatedUnion('kind', [ContinuitySourceEvidenceSchema, ContinuityDesignEvidenceSchema]);
export type ContinuitySourceEvidence = z.infer<typeof ContinuitySourceEvidenceSchema>;
export type ContinuityEvidence = z.infer<typeof ContinuityEvidenceSchema>;

/** Suggestions deliberately retain unknown attributes and values for review. */
export const ContinuityChangeProposalSchema = z.object({
  schema_version: schemaVersion, policy_version: policyVersion,
  change_id: id, change_revision: revision, binding_revision: revision,
  story_position: ContinuityStoryPositionSchema, entity_id: id, attribute_id: id,
  operation: z.enum(['assign', 'clear', 'transfer']), value: z.unknown(),
  precondition: z.object({ knowledge_status: z.literal('confirmed'), value: id.nullable() }).strict().optional(),
  completion: z.literal('completed').optional(),
  basis: z.enum(['story', 'initial_design']), time_relation: z.enum(['confirmed_linear', 'unknown']),
  origin: z.enum(['human_entry', 'rule', 'model', 'self_audit', 'legacy_fact_states']),
  evidence: z.array(ContinuityEvidenceSchema).min(1),
}).strict().superRefine((change, context) => {
  const version=continuityAttributeVersion(change.attribute_id);if(change.schema_version!==version.schema_version||change.policy_version!==version.policy_version)context.addIssue({code:'custom',message:'Attribute requires its own schema and policy version'});
  if (change.value === undefined) context.addIssue({ code: 'custom', path: ['value'], message: 'A missing value is not unknown or confirmed null' });
  if (change.operation === 'transfer') {
    if (change.attribute_id !== 'holder' || !change.precondition || change.completion !== 'completed') context.addIssue({ code: 'custom', message: 'Completed transfer requires holder and an explicit confirmed old-holder precondition' });
  } else if (change.precondition !== undefined || change.completion !== undefined) {
    context.addIssue({ code: 'custom', message: 'Only completed transfer has a holder precondition/completion' });
  }
  if (change.operation === 'clear' && change.value !== null) context.addIssue({ code: 'custom', path: ['value'], message: 'Clear writes confirmed null' });
});
export type ContinuityChangeProposal = z.infer<typeof ContinuityChangeProposalSchema>;

export const ContinuityConfirmationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), review_id: id, review_revision: revision, actor_id: id, proposal_hash: hash }).strict(),
  z.object({ kind: z.literal('rule'), rule_id: id, rule_version: revision, proposal_hash: hash }).strict(),
]);
export type ContinuityConfirmation = z.infer<typeof ContinuityConfirmationSchema>;
/** Shape validation alone does not confer trust. The service issues immutable verified tokens. */
export const ContinuityConfirmedChangeSchema = z.object({
  proposal: ContinuityChangeProposalSchema, confirmation: ContinuityConfirmationSchema,
}).strict();
export type ContinuityConfirmedChange = z.infer<typeof ContinuityConfirmedChangeSchema>;

const cellFields = {
  schema_version: schemaVersion, policy_version: policyVersion,
  project_id: revision, story_segment_id: id, entity_id: id, attribute_id: ContinuityAttributeIdSchema,
};
export const ContinuityCellSchema = z.discriminatedUnion('knowledge_status', [
  z.object({ ...cellFields, knowledge_status: z.literal('unknown') }).strict(),
  z.object({ ...cellFields, knowledge_status: z.literal('confirmed'), value: z.string().min(1).nullable(),
    provenance: z.object({ change_id: id, change_revision: revision, confirmation: ContinuityConfirmationSchema,
      evidence: z.array(ContinuityEvidenceSchema).min(1) }).strict(),
  }).strict(),
]).superRefine((cell,context)=>{const version=continuityAttributeVersion(cell.attribute_id);if(cell.schema_version!==version.schema_version||cell.policy_version!==version.policy_version)context.addIssue({code:'custom',message:'Cell attribute version mismatch'});});
export type ContinuityCell = z.infer<typeof ContinuityCellSchema>;
