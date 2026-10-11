import { createHash } from 'node:crypto';
import {
  CONTINUITY_STATE_SCHEMA_VERSION, CONTINUITY_STATE_POLICY_VERSION, continuityAttribute,
  continuityAttributeVersion,
  ContinuityChangeProposalSchema, ContinuityConfirmationSchema, ContinuityConfirmedChangeSchema, ContinuityCellSchema,
  type ContinuityChangeProposal, type ContinuityConfirmedChange, type ContinuityCell, type ContinuityAttributeId,
  type ContinuitySourceEvidence, type ContinuityEvidence,
} from '../schemas/continuity_state';
import type { ContinuityEntity, ContinuityStoryOrder } from '../schemas/continuity';
import { requireContinuityEntity, validateContinuityStoryPosition, ContinuityIdentityError } from './continuity_identity';
import type { ConfirmedContinuityTimePlan } from './continuity_time';

type SourceDocument = {
  project_id: number; source_type: 'novel' | 'screenplay'; source_document_id: string; source_revision: number; text: string;
  /** Server-owned, reviewed physical bindings for this exact revision, never model-selected names. */
  bindings: { entity_id: string; start: number; end: number }[];
};
type Design = { project_id: number; design_id: string; design_revision: number; entity_id: string };
export type ContinuityConfirmationContext = {
  project_id: number; entities: ContinuityEntity[]; order: ContinuityStoryOrder; binding_revision: number;
  time_relation: 'confirmed_linear' | 'unknown'; sources: SourceDocument[]; designs: Design[];
  time_plan?: ConfirmedContinuityTimePlan;
  /** CT06 must obtain approval from the authenticated server review, never request/model JSON. */
  authority?: { kind: 'human'; review_id: string; review_revision: number; actor_id: string; proposal_hash: string }
    | { kind: 'rule'; rule_id: string; rule_version: number };
};
export class ContinuityConfirmationError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
type Pending = { status: 'pending_review'; suggestion: unknown; issues: { code: string; message: string }[] };
export type ContinuityConfirmationResult = Pending | { status: 'confirmed'; change: ContinuityConfirmedChange };
const verifiedChanges = new WeakSet<object>();
const verifiedCells = new WeakSet<object>();
const cellApprovals = new WeakMap<object, ContinuityConfirmedChange>();
const fail = (code: string, message: string): never => { throw new ContinuityConfirmationError(code, message); };
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** Approval fingerprint only; CT04 defines separate state/source hash preimages. */
export function continuityProposalHash(raw: unknown) { return sha256(JSON.stringify(canonical(ContinuityChangeProposalSchema.parse(raw)))); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const CONTINUITY_CONFIRMATION_RULES = freeze([
  { rule_id: 'wetness.explicit.zh', rule_version: 1, attribute_id: 'wetness', condition: 'Exactly bound item + 湿透了/保持干燥; no negation, intention or conditional clause' },
  { rule_id: 'holder.received.zh', rule_version: 1, attribute_id: 'holder', condition: 'Exactly bound receiver + 接过/接住/收到了 + item; completed transfer and confirmed prior holder' },
]);

function sourceFor(evidence: ContinuitySourceEvidence, context: ContinuityConfirmationContext) {
  const matches = context.sources.filter(source => source.project_id === context.project_id && source.source_type === evidence.source_type && source.source_document_id === evidence.source_document_id);
  if (matches.length !== 1) return fail('CONTINUITY_EVIDENCE_INVALID', 'Source document is missing or ambiguous in project');
  const source = matches[0]!;
  if (source.source_revision !== evidence.source_revision || sha256(source.text) !== evidence.source_text_hash) return fail('CONTINUITY_STALE', 'Source revision or exact text changed');
  if (evidence.end > source.text.length || source.text.slice(evidence.start, evidence.end) !== evidence.evidence_quote) return fail('CONTINUITY_EVIDENCE_INVALID', 'Quote must equal the UTF-16 [start,end) source range');
  // Reject a range splitting a surrogate pair even if a malformed quote matches it.
  const splitsPair = (offset: number) => offset > 0 && offset < source.text.length && /[\uD800-\uDBFF]/.test(source.text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(source.text[offset]!);
  if (splitsPair(evidence.start) || splitsPair(evidence.end)) return fail('CONTINUITY_EVIDENCE_INVALID', 'Evidence range splits a UTF-16 surrogate pair');
  return source;
}
function evidenceClause(evidence: ContinuitySourceEvidence, source: SourceDocument) {
  const before = source.text.slice(0, evidence.start);
  const start = Math.max(before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'), before.lastIndexOf('\n')) + 1;
  const tail = source.text.slice(evidence.end).search(/[。！？\n]/);
  return source.text.slice(start, tail < 0 ? source.text.length : evidence.end + tail + 1);
}
function validateValue(entity: ContinuityEntity, attributeId: string, operation: string, value: unknown, context: ContinuityConfirmationContext): string | null {
  const attribute = continuityAttribute(attributeId);
  if (!attribute) return fail('CONTINUITY_ATTRIBUTE_UNSUPPORTED', 'Unknown attribute retained for review');
  if (!attribute.kinds.includes(entity.kind) || !attribute.operations.includes(operation as 'assign' | 'clear' | 'transfer')) return fail('CONTINUITY_VALUE_INVALID', 'Attribute or operation does not apply to this physical entity');
  if (attributeId === 'holder' && Array.isArray(value)) return fail('CONTINUITY_SHARED_HOLDER_UNSUPPORTED', 'All proposed holders retained for review');
  if (operation === 'clear') { if (value !== null) return fail('CONTINUITY_VALUE_INVALID', 'Clear requires confirmed null'); return null; }
  if (typeof value !== 'string' || !value || value.trim() !== value) return fail('CONTINUITY_VALUE_INVALID', 'Assignment requires a normalized typed value; unknown is not null');
  if (attribute.type === 'enum' && !attribute.values!.includes(value)) return fail('CONTINUITY_VALUE_INVALID', 'Value is outside the versioned attribute registry');
  if (attribute.type === 'colour' && (!/^[a-z]+(?:_[a-z]+)*$/.test(value) || value.length > 80)) return fail('CONTINUITY_VALUE_INVALID', 'Colour is a lowercase ASCII descriptor separated by underscores');
  if (attribute.type === 'entity') {
    const target = requireContinuityEntity(context.project_id, value, context.entities);
    if (!attribute.target_kinds!.includes(target.kind) || target.entity_id === entity.entity_id) return fail('CONTINUITY_VALUE_INVALID', 'Invalid relation target kind');
  }
  return value;
}
/** Shared by entry and transient overlay validation; neither grants confirmation. */
export function validateContinuityTypedValue(entityId: string, attributeId: string, value: unknown, context: ContinuityConfirmationContext) {
  return validateValue(requireContinuityEntity(context.project_id, entityId, context.entities), attributeId, value === null ? 'clear' : 'assign', value, context);
}
export function validateContinuityEvidence(evidence: ContinuityEvidence, entityId: string, context: ContinuityConfirmationContext) {
  requireContinuityEntity(context.project_id, entityId, context.entities);
  if (evidence.kind === 'source') { sourceFor(evidence, context); return; }
  if (context.designs.filter(design => design.project_id === context.project_id && design.design_id === evidence.design_id && design.design_revision === evidence.design_revision && design.entity_id === entityId).length !== 1) return fail('CONTINUITY_STALE', 'Explicit design revision or physical binding changed');
}
export function requireVerifiedContinuityCells(state: readonly ContinuityCell[], context: ContinuityConfirmationContext) {
  const keys = new Set<string>();
  for (const cell of state) {
    if (!verifiedCells.has(cell)) return fail('CONTINUITY_REVIEW_REQUIRED', 'Unverified or legacy cells cannot supply a trusted fallback');
    const key = JSON.stringify([cell.entity_id, cell.attribute_id]);
    const entity = requireContinuityEntity(context.project_id, cell.entity_id, context.entities);
    if (cell.project_id !== context.project_id || cell.story_segment_id !== context.order.story_segment_id || keys.has(key) || !continuityAttribute(cell.attribute_id)?.kinds.includes(entity.kind)) return fail('CONTINUITY_SCOPE_INVALID', 'State cell scope or uniqueness failed');
    if (cell.knowledge_status === 'confirmed') validateContinuityTypedValue(cell.entity_id, cell.attribute_id, cell.value, context);
    keys.add(key);
  }
}
function validateProposal(proposal: ContinuityChangeProposal, context: ContinuityConfirmationContext) {
  if (context.project_id !== context.order.project_id) return fail('CONTINUITY_SCOPE_INVALID', 'Order belongs to another project');
  validateContinuityStoryPosition(proposal.story_position, context.order);
  if (proposal.story_position.phase === 'during') return fail('CONTINUITY_DURING_OVERLAY_REQUIRED', 'During values require the independent moment overlay contract in CT04');
  if (proposal.binding_revision !== context.binding_revision) return fail('CONTINUITY_STALE', 'Physical binding revision changed');
  if (proposal.time_relation !== 'confirmed_linear' || context.time_relation !== 'confirmed_linear') return fail('CONTINUITY_TIME_REVIEW_REQUIRED', 'Unknown story time retained for review');
  const entity = requireContinuityEntity(context.project_id, proposal.entity_id, context.entities);
  validateValue(entity, proposal.attribute_id, proposal.operation, proposal.value, context);
  if (proposal.operation === 'transfer') {
    if (proposal.precondition!.value === proposal.value) return fail('CONTINUITY_VALUE_INVALID', 'A transfer must change the holder');
    if (proposal.precondition!.value !== null) {
      const previous = requireContinuityEntity(context.project_id, proposal.precondition!.value, context.entities);
      if (previous.kind !== 'character') return fail('CONTINUITY_VALUE_INVALID', 'Previous holder must be a character identity');
    }
  }
  if ((proposal.basis === 'initial_design' && proposal.evidence.some(evidence => evidence.kind !== 'design')) || (proposal.basis === 'story' && proposal.evidence.some(evidence => evidence.kind !== 'source'))) return fail('CONTINUITY_EVIDENCE_INVALID', 'Story evidence and explicit initial design evidence have separate contracts');
  if (proposal.basis === 'initial_design' && proposal.operation === 'transfer') return fail('CONTINUITY_TRANSFER_NOT_COMPLETED', 'Initial design cannot establish a completed story event');
  for (const evidence of proposal.evidence) {
    if (evidence.kind === 'design') {
      if (context.designs.filter(design => design.project_id === context.project_id && design.design_id === evidence.design_id && design.design_revision === evidence.design_revision && design.entity_id === entity.entity_id).length !== 1) return fail('CONTINUITY_STALE', 'Explicit design revision or physical binding changed');
    } else {
      const source = sourceFor(evidence, context);
      const clause = evidenceClause(evidence, source);
      if (/不知过了多久|不确定过了多久|时间不明/.test(clause)) return fail('CONTINUITY_TIME_REVIEW_REQUIRED', 'Unknown time boundary retained for review');
      if (proposal.attribute_id === 'holder' && /共同|一起|同时.{0,12}(?:握|持|拿)/.test(clause)) return fail('CONTINUITY_SHARED_HOLDER_UNSUPPORTED', 'Shared holding evidence retained without selecting one participant');
      if(proposal.attribute_id==='holding_hand'){
        if(/画面|屏幕|镜头|画幅|image|screen/i.test(clause))return fail('CONTINUITY_HAND_REVIEW_REQUIRED','Physical hand must not be inferred from image left/right');
        if(/没有|并未|还没|不曾|想|打算|准备|如果|假如|可能|也许/.test(clause))return fail('CONTINUITY_HAND_REVIEW_REQUIRED','Negation or intention does not establish an actual hand change');
        const marker=proposal.value==='physical_left'?/左手|left hand/i:proposal.value==='physical_right'?/右手|right hand/i:proposal.value==='both'?/双手|两只手|both hands/i:/放下|松开|unheld|put down/i;
        if(!marker.test(clause))return fail('CONTINUITY_HAND_REVIEW_REQUIRED','Hand value requires explicit physical source evidence');
        const targets=[...clause.matchAll(/(?:换到|换成|移到|转到|改用|改为|switch(?:ed)? to|move(?:d)? to)\s*(?:自己的|身体的|his |her |their |the )?(左手|右手|双手|两只手|left hand|right hand|both hands)/gi)].map(match=>match[1]!);
        if(targets.length&&!marker.test(targets.at(-1)!))return fail('CONTINUITY_HAND_REVIEW_REQUIRED','A completed hand switch must use its destination hand');
        if(!targets.length&&proposal.value!=='both'&&/左手|left hand/i.test(clause)&&/右手|right hand/i.test(clause))return fail('CONTINUITY_HAND_REVIEW_REQUIRED','Multiple mentioned hands require an explicit destination');
      }
      if (proposal.operation === 'transfer' && /没有|并未|还没|未(?:把|将|接|收|递|转|给|拿|曾)|没(?:把|将|接|收|递|转|给|拿)|并非|不是|不(?:曾|肯|愿|接|收|递|给|转|把)|拒绝|想|打算|准备|计划|意图|递出|伸出|如果|假如|可能|也许/.test(clause)) return fail('CONTINUITY_TRANSFER_NOT_COMPLETED', 'Offering, intention or negation cannot establish a completed transfer');
    }
  }
  return entity;
}
function verifyRule(proposal: ContinuityChangeProposal, context: ContinuityConfirmationContext, ruleId: string, ruleVersion: number) {
  if (!CONTINUITY_CONFIRMATION_RULES.some(rule => rule.rule_id === ruleId && rule.rule_version === ruleVersion)) return fail('CONTINUITY_RULE_UNSUPPORTED', 'Named rule/version is not allowlisted');
  if (proposal.basis !== 'story' || proposal.evidence.length !== 1 || proposal.evidence[0]!.kind !== 'source') return fail('CONTINUITY_RULE_UNVERIFIED', 'Rule requires one exact source quote');
  const evidence = proposal.evidence[0] as ContinuitySourceEvidence;
  const source = sourceFor(evidence, context);
  if (/没有|并未|还没|未曾|不曾|想|打算|准备|计划|如果|假如|可能|也许|将要|据说|听说/.test(evidenceClause(evidence, source))) return fail('CONTINUITY_RULE_UNVERIFIED', 'Clause does not assert an actual completed state');
  const bindings = source.bindings.filter(binding => binding.start >= evidence.start && binding.end <= evidence.end);
  for (const binding of bindings) {
    if (!Number.isInteger(binding.start) || !Number.isInteger(binding.end) || binding.end <= binding.start || !source.text.slice(binding.start, binding.end)) return fail('CONTINUITY_RULE_UNVERIFIED', 'Invalid reviewed binding span');
    requireContinuityEntity(context.project_id, binding.entity_id, context.entities);
    if (bindings.some(other => other !== binding && other.start < binding.end && other.end > binding.start)) return fail('CONTINUITY_RULE_UNVERIFIED', 'Ambiguous physical binding');
  }
  const item = bindings.filter(binding => binding.entity_id === proposal.entity_id);
  if (item.length !== 1) return fail('CONTINUITY_RULE_UNVERIFIED', 'Rule requires exactly one reviewed item binding inside quote');
  const itemBinding = item[0]!;
  const itemText = source.text.slice(itemBinding.start, itemBinding.end);
  const quote = evidence.evidence_quote.replace(/[。！]$/, '');
  const assertion = evidenceClause(evidence, source).trim().replace(/[。！]$/, '');
  if (ruleId === 'wetness.explicit.zh') {
    const suffix = proposal.value === 'wet' ? '湿透了' : proposal.value === 'dry' ? '保持干燥' : '';
    const prefixes = context.entities.filter(entity => entity.project_id === context.project_id && entity.kind === 'character')
      .flatMap(entity => [entity.display_name, ...entity.aliases]).map(name => `${name}的`);
    if (proposal.attribute_id !== 'wetness' || proposal.operation !== 'assign' || !suffix || bindings.length !== 1 || itemBinding.start !== evidence.start || quote !== `${itemText}${suffix}` || ![quote, ...prefixes.map(prefix => prefix + quote)].includes(assertion)) return fail('CONTINUITY_RULE_UNVERIFIED', 'Wetness rule does not match an asserted bound item and normalized value');
  } else {
    const receivers = bindings.filter(binding => binding.entity_id === proposal.value);
    if (proposal.attribute_id !== 'holder' || proposal.operation !== 'transfer' || bindings.length !== 2 || receivers.length !== 1) return fail('CONTINUITY_RULE_UNVERIFIED', 'Receipt rule requires item and receiver identities');
    const receiver = receivers[0]!;
    const receiverText = source.text.slice(receiver.start, receiver.end);
    const verb = source.text.slice(receiver.end, itemBinding.start);
    if (receiver.start !== evidence.start || !['接过', '接住', '收到了'].includes(verb) || quote !== `${receiverText}${verb}${itemText}` || assertion !== quote) return fail('CONTINUITY_RULE_UNVERIFIED', 'Source does not explicitly establish receipt by this person');
  }
}

/** Type/source validation for proposals conveys no approval authority. */
export function validateContinuitySuggestionProposal(proposal:ContinuityChangeProposal,context:ContinuityConfirmationContext){validateProposal(ContinuityChangeProposalSchema.parse(proposal),context);}
/** Keeps raw suggestions (including model/self-audit/legacy claims) intact on any rejection. */
export function confirmContinuityChange(raw: unknown, context: ContinuityConfirmationContext): ContinuityConfirmationResult {
  try {
    const proposal = ContinuityChangeProposalSchema.parse(raw);
    validateProposal(proposal, context);
    const proposalHash = continuityProposalHash(proposal);
    const authority = context.authority;
    if (!authority) return fail('CONTINUITY_REVIEW_REQUIRED', 'A suggestion has no human approval or verified allowlisted rule');
    if (authority.kind === 'human') {
      if (authority.proposal_hash !== proposalHash) return fail('CONTINUITY_STALE', 'Human review approved a different proposal or revision');
    } else verifyRule(proposal, context, authority.rule_id, authority.rule_version);
    const confirmation = ContinuityConfirmationSchema.parse({ ...authority, proposal_hash: proposalHash });
    const change = freeze(ContinuityConfirmedChangeSchema.parse({ proposal, confirmation }));
    verifiedChanges.add(change);
    return { status: 'confirmed', change };
  } catch (error) {
    const code = error instanceof ContinuityConfirmationError || error instanceof ContinuityIdentityError ? error.code : 'CONTINUITY_PROPOSAL_INVALID';
    return { status: 'pending_review', suggestion: structuredClone(raw), issues: [{ code, message: error instanceof Error ? error.message : 'Invalid suggestion' }] };
  }
}
export function requireConfirmedContinuityChange(change: ContinuityConfirmedChange) {
  if (!verifiedChanges.has(change)) return fail('CONTINUITY_REVIEW_REQUIRED', 'Schema-shaped JSON, model flags and legacy states are not confirmation tokens');
  return change;
}
export function revalidateConfirmedContinuityChange(change: ContinuityConfirmedChange, context: ContinuityConfirmationContext) {
  requireConfirmedContinuityChange(change);
  validateProposal(change.proposal, context);
  if (change.confirmation.kind === 'rule') verifyRule(change.proposal, context, change.confirmation.rule_id, change.confirmation.rule_version);
}
export function continuityCellApproval(cell: ContinuityCell) {
  if (!verifiedCells.has(cell)) return fail('CONTINUITY_REVIEW_REQUIRED', 'Cell has no trusted origin');
  return cellApprovals.get(cell);
}
/** A stored entry cell can be reconstructed only from its independently revalidated approval. */
export function restoreApprovedContinuityCell(raw: unknown, approval: ContinuityConfirmedChange, context: ContinuityConfirmationContext): ContinuityCell {
  revalidateConfirmedContinuityChange(approval, context);
  const cell = ContinuityCellSchema.parse(raw);
  const proposal = approval.proposal;
  if (cell.knowledge_status !== 'confirmed' || cell.project_id !== context.project_id || cell.story_segment_id !== context.order.story_segment_id || cell.entity_id !== proposal.entity_id || cell.attribute_id !== proposal.attribute_id || cell.value !== proposal.value || JSON.stringify(cell.provenance) !== JSON.stringify({ change_id: proposal.change_id, change_revision: proposal.change_revision, confirmation: approval.confirmation, evidence: proposal.evidence })) return fail('CONTINUITY_REVIEW_REQUIRED', 'Stored entry cell does not match its approved change');
  const restored = freeze(cell); verifiedCells.add(restored); cellApprovals.set(restored, approval); return restored;
}
export function createUnknownContinuityCell(context: ContinuityConfirmationContext, entityId: string, attributeId: ContinuityAttributeId): ContinuityCell {
  const entity = requireContinuityEntity(context.project_id, entityId, context.entities);
  if (context.order.project_id !== context.project_id || !continuityAttribute(attributeId)?.kinds.includes(entity.kind)) return fail('CONTINUITY_SCOPE_INVALID', 'Unknown cell is outside the entity/attribute scope');
  const cell = freeze(ContinuityCellSchema.parse({ ...continuityAttributeVersion(attributeId),
    project_id: context.project_id, story_segment_id: context.order.story_segment_id, entity_id: entityId, attribute_id: attributeId, knowledge_status: 'unknown' }));
  verifiedCells.add(cell); return cell;
}
/** One immutable transition, not scene replay. CT04 supplies event ordering and snapshots. */
export function applyConfirmedContinuityChange(state: readonly ContinuityCell[], rawChange: ContinuityConfirmedChange, context: ContinuityConfirmationContext): ContinuityCell[] {
  const change = requireConfirmedContinuityChange(rawChange);
  const proposal = change.proposal;
  const entity = validateProposal(proposal, context); // Recheck current evidence/binding/order before applying.
  if (change.confirmation.kind === 'rule') verifyRule(proposal, context, change.confirmation.rule_id, change.confirmation.rule_version);
  requireVerifiedContinuityCells(state, context);
  const previous = state.find(cell => cell.entity_id === proposal.entity_id && cell.attribute_id === proposal.attribute_id);
  if (proposal.attribute_id === 'holding_hand') assertHoldingHandMatchesHolder(state, proposal.entity_id, proposal.value, proposal.evidence, context);
  if (proposal.operation === 'transfer' && (!previous || previous.knowledge_status !== 'confirmed' || previous.value !== proposal.precondition!.value)) return fail('CONTINUITY_PRECONDITION_CONFLICT', 'Completed transfer requires the confirmed old holder of this same physical object');
  if (proposal.basis === 'initial_design' && previous?.knowledge_status === 'confirmed') return fail('CONTINUITY_DESIGN_OVERRIDE_FORBIDDEN', 'An initial design cannot overwrite confirmed story state');
  const cell = freeze(ContinuityCellSchema.parse({ schema_version: proposal.schema_version, policy_version: proposal.policy_version,
    project_id: context.project_id, story_segment_id: proposal.story_position.story_segment_id, entity_id: entity.entity_id,
    attribute_id: proposal.attribute_id, knowledge_status: 'confirmed', value: proposal.value,
    provenance: { change_id: proposal.change_id, change_revision: proposal.change_revision, confirmation: change.confirmation, evidence: proposal.evidence },
  }));
  verifiedCells.add(cell);
  cellApprovals.set(cell, change);
  let retained = state.filter(item => item !== previous);
  if (proposal.attribute_id === 'holder' && holderValueChanged(previous, proposal.value)) retained = clearHoldingHand(retained, proposal.entity_id, context);
  return [...retained, cell];
}
/** A hand is established only for the holder already confirmed on this object. */
export function assertHoldingHandMatchesHolder(state: readonly ContinuityCell[], entityId: string, handValue: unknown, evidence: readonly ContinuityEvidence[], context: ContinuityConfirmationContext): void {
  const holder = state.find(cell => cell.entity_id === entityId && cell.attribute_id === 'holder');
  if (!holder || holder.knowledge_status !== 'confirmed' || (handValue === 'unheld' ? holder.value !== null : holder.value === null)) return fail('CONTINUITY_HAND_REVIEW_REQUIRED', 'Review the current holder before specifying that person’s physical hand');
  if (holder.value !== null) {
    const quote = evidence.filter(item => item.kind === 'source').map(item => item.kind === 'source' ? item.evidence_quote : '').join('\n');
    const named = context.entities.filter(entity => entity.kind === 'character' && [entity.display_name, ...entity.aliases].some(name => name && quote.includes(name)));
    if (named.length && (!named.some(entity => entity.entity_id === holder.value) || named.some(entity => entity.entity_id !== holder.value))) return fail('CONTINUITY_HAND_REVIEW_REQUIRED', 'The hand evidence must identify the current holder without conflicting named actors');
  }
}
export function holderValueChanged(previous: ContinuityCell | undefined, nextValue: unknown): boolean {
  return previous?.knowledge_status !== 'confirmed' || previous.value !== nextValue;
}
export function clearHoldingHand(state: readonly ContinuityCell[], entityId: string, context: ContinuityConfirmationContext): ContinuityCell[] {
  return state.map(item => item.entity_id === entityId && item.attribute_id === 'holding_hand' ? createUnknownContinuityCell(context, entityId, 'holding_hand') : item);
}
