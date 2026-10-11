import { createHash } from 'node:crypto';
import {
  CONTINUITY_STATE_SCHEMA_VERSION, CONTINUITY_STATE_POLICY_VERSION, ContinuityConfirmationSchema,
  continuityAttribute, continuityAttributeVersion, type ContinuityAttributeId, type ContinuityCell, type ContinuityConfirmedChange, type ContinuityConfirmation, type ContinuityEvidence,
} from '../schemas/continuity_state';
import { ContinuityOverlayProposalSchema, ContinuityVisiblePositionSchema, ContinuityReadSchema,
  type ContinuityOverlayProposal, type ContinuityConfirmedOverlay, type ContinuityRead } from '../schemas/continuity_snapshot';
import type { ContinuityStoryPosition } from '../schemas/continuity';
import { requireContinuityEntity, validateContinuityStoryPosition, makeContinuityStoryPosition } from './continuity_identity';
import { applyConfirmedContinuityChange, requireConfirmedContinuityChange, requireVerifiedContinuityCells,
  validateContinuityTypedValue, validateContinuityEvidence, ContinuityConfirmationError,
  createUnknownContinuityCell, assertHoldingHandMatchesHolder, holderValueChanged, clearHoldingHand,
  validateContinuitySuggestionProposal,
  type ContinuityConfirmationContext } from './continuity_confirmation';
import { requireContinuityTimePlan } from './continuity_time';

export function canonicalContinuityJson(value: unknown): string {
  const order = (item: unknown): unknown => Array.isArray(item) ? item.map(order) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, order(value)])) : item;
  return JSON.stringify(order(value));
}
export const continuityHash = (value: unknown) => createHash('sha256').update(canonicalContinuityJson(value), 'utf8').digest('hex');
const textHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const fail = (code: string, message: string): never => { throw new ContinuityConfirmationError(code, message); };
const cellKey = (cell: { entity_id: string; attribute_id: string }) => JSON.stringify([cell.entity_id, cell.attribute_id]);
const sortCells = (cells: readonly ContinuityCell[]) => [...cells].sort((a, b) => cellKey(a) < cellKey(b) ? -1 : cellKey(a) > cellKey(b) ? 1 : 0);
const canonicalCompare = (a: unknown, b: unknown) => canonicalContinuityJson(a) < canonicalContinuityJson(b) ? -1 : canonicalContinuityJson(a) > canonicalContinuityJson(b) ? 1 : 0;
const evidenceProjection = (evidence: readonly ContinuityEvidence[]) => [...evidence].sort(canonicalCompare);
function confirmationProjection(confirmation: ContinuityConfirmation) {
  const { proposal_hash: _approvalFingerprint, ...identity } = confirmation;
  return identity;
}
function cellSourceProjection(cell: ContinuityCell) {
  return cell.knowledge_status === 'unknown' ? cell : confirmedCellSourceProjection(cell);
}
function confirmedCellSourceProjection(cell: Extract<ContinuityCell, { knowledge_status: 'confirmed' }>) {
  return { ...cell, provenance: { ...cell.provenance,
    evidence: evidenceProjection(cell.provenance.evidence), confirmation: confirmationProjection(cell.provenance.confirmation) } };
}
function overlaySourceProjection(overlay: ContinuityConfirmedOverlay) {
  return { proposal: { ...overlay.proposal, evidence: evidenceProjection(overlay.proposal.evidence),
    values: [...overlay.proposal.values].sort(canonicalCompare) }, confirmation: confirmationProjection(overlay.confirmation) };
}
const semanticPosition = (position: ContinuityStoryPosition) => ({ story_segment_id: position.story_segment_id, script_scene_id: position.script_scene_id,
  scene_order: position.scene_order, beat_id: position.beat_id, beat_order: position.beat_order, change_order: position.change_order, moment_id: position.moment_id, phase: position.phase,
  ...(position.time_scope?{time_scope:position.time_scope}:{}) });
export function compareContinuityPositions(a: ContinuityStoryPosition, b: ContinuityStoryPosition) {
  return a.scene_order - b.scene_order || (a.beat_order ?? -1) - (b.beat_order ?? -1) || a.change_order - b.change_order;
}
export type ContinuityEntry = { entry_id: string; entry_revision: number; binding_revision: number; story_position: ContinuityStoryPosition;
  state: readonly ContinuityCell[]; confirmation: ContinuityConfirmation };
const entries = new WeakSet<object>();
const overlays = new WeakSet<object>();
export function requireVerifiedContinuityEntry(entry: ContinuityEntry) {
  if (!entries.has(entry)) return fail('CONTINUITY_ENTRY_REQUIRED', 'Entry is not server-confirmed');
  return entry;
}
export function requireVerifiedContinuityOverlay(overlay: ContinuityConfirmedOverlay) {
  if (!overlays.has(overlay)) return fail('CONTINUITY_REVIEW_REQUIRED', 'Overlay is not server-confirmed');
  return overlay;
}
export function continuityEntryHash(input: Omit<ContinuityEntry, 'confirmation'>) {
  return continuityHash({ ...input, state: sortCells(input.state) });
}
export function confirmContinuityEntry(input: Omit<ContinuityEntry, 'confirmation'>, context: ContinuityConfirmationContext): ContinuityEntry {
  validateContinuityStoryPosition(input.story_position, context.order);
  if (!input.entry_id.trim() || input.entry_id !== input.entry_id.trim() || input.entry_id.length > 160 || !Number.isInteger(input.entry_revision) || input.entry_revision < 1 || input.binding_revision !== context.binding_revision) return fail('CONTINUITY_STALE', 'Entry identity/revision changed');
  if (input.story_position.scene_order !== 0 || input.story_position.phase !== 'before' || input.story_position.beat_id !== null || input.story_position.change_order !== 0 || context.time_relation !== 'confirmed_linear') return fail('CONTINUITY_ENTRY_REQUIRED', 'Linear entry must explicitly precede the first screenplay scene');
  requireVerifiedContinuityCells(input.state, context);
  for (const cell of input.state) if (cell.knowledge_status === 'confirmed') for (const evidence of cell.provenance.evidence) validateContinuityEvidence(evidence, cell.entity_id, context);
  const authority = context.authority;
  if (authority?.kind !== 'human' || authority.proposal_hash !== continuityEntryHash(input)) return fail('CONTINUITY_REVIEW_REQUIRED', 'Entry requires an exact human review, including unknown cells');
  const entry = freeze({ ...input, state: sortCells(input.state), confirmation: ContinuityConfirmationSchema.parse(authority) });
  entries.add(entry); return entry;
}
export const continuityOverlayHash = (input: ContinuityOverlayProposal) => continuityHash(ContinuityOverlayProposalSchema.parse(input));
export function confirmContinuityOverlay(raw: unknown, context: ContinuityConfirmationContext): ContinuityConfirmedOverlay {
  const proposal = ContinuityOverlayProposalSchema.parse(raw) as ContinuityOverlayProposal;
  validateContinuityStoryPosition(proposal.story_position, context.order);
  if (proposal.binding_revision !== context.binding_revision || context.time_relation !== 'confirmed_linear') return fail('CONTINUITY_STALE', 'Overlay binding/time changed');
  for (const value of proposal.values) {
    requireContinuityEntity(context.project_id, value.entity_id, context.entities);
    if (value.attribute_id === 'visible_position') {
      const visible = ContinuityVisiblePositionSchema.parse(value.value);
      if (visible.anchor_entity_id) requireContinuityEntity(context.project_id, visible.anchor_entity_id, context.entities);
    } else validateContinuityTypedValue(value.entity_id, value.attribute_id, value.value, context);
    if(value.attribute_id==='holding_hand')validateContinuitySuggestionProposal({...continuityAttributeVersion('holding_hand'),change_id:proposal.overlay_id,change_revision:proposal.overlay_revision,binding_revision:proposal.binding_revision,story_position:{...proposal.story_position,phase:'after'},entity_id:value.entity_id,attribute_id:value.attribute_id,operation:'assign',value:value.value,basis:proposal.evidence.every(e=>e.kind==='design')?'initial_design':'story',time_relation:context.time_relation,origin:'human_entry',evidence:proposal.evidence},context);
    const evidence = proposal.evidence.filter(item => item.kind === 'source' || context.designs.some(design => design.design_id === item.design_id && design.entity_id === value.entity_id));
    if (!evidence.length) return fail('CONTINUITY_EVIDENCE_INVALID', 'Each overlay entity requires source or explicit frame design evidence');
    for (const item of evidence) validateContinuityEvidence(item, value.entity_id, context);
  }
  const authority = context.authority;
  if (authority?.kind !== 'human' || authority.proposal_hash !== continuityOverlayHash(proposal)) return fail('CONTINUITY_REVIEW_REQUIRED', 'During overlay requires an exact human review');
  const overlay = freeze({ proposal, confirmation: ContinuityConfirmationSchema.parse(authority) });
  overlays.add(overlay); return overlay;
}
export type ContinuityMoment = { story_position: ContinuityStoryPosition; state: readonly ContinuityCell[];
  during_overlay: ContinuityConfirmedOverlay | null; state_hash: string };
export type ContinuitySnapshot = {
  schema_version: 1; policy_version: 'continuity-state-1'; project_id: number; script_id: number; script_revision: number;
  screenplay_order_revision: number; story_segment_id: string; script_scene_id: string;
  entry_state: readonly ContinuityCell[]; confirmed_changes: readonly ContinuityConfirmedChange[]; exit_state: readonly ContinuityCell[];
  entity_references: readonly { entity_id: string; kind: string; parent_entity_id?: string; character_id?: number; asset_id?: number; asset_revision?: number }[];
  moments: readonly ContinuityMoment[]; state_hash: string; source_hash: string; entry_state_hash: string;
};
export type ContinuityReplayInput = { context: ContinuityConfirmationContext; entry?: ContinuityEntry;
  changes: readonly ContinuityConfirmedChange[]; during_overlays?: readonly ContinuityConfirmedOverlay[];
  revisions: { fact_revision: number; entity_mapping_revision: number; confirmation_revision: number; design_revision: number } };
export type ContinuityReplayResult = { status: 'ready'; snapshot: ContinuitySnapshot } | { status: 'pending_review' | 'conflict'; issues: { code: string; message: string }[]; target_scene_id: string };
const snapshots = new WeakSet<object>();

function stateHash(state: readonly ContinuityCell[], position: ContinuityStoryPosition, context: ContinuityConfirmationContext, overlay: ContinuityConfirmedOverlay | null = null) {
  const references = state.flatMap(cell => cell.knowledge_status === 'confirmed' && continuityAttribute(cell.attribute_id)?.type === 'entity' && cell.value !== null ? [cell.value] : []);
  const overlayReferences = overlay?.proposal.values.flatMap(value => value.attribute_id === 'visible_position' ? [ContinuityVisiblePositionSchema.parse(value.value).anchor_entity_id].filter((id): id is string => Boolean(id)) : []) ?? [];
  const ids = [...new Set([...state.map(cell => cell.entity_id), ...references, ...overlayReferences, ...(overlay?.proposal.values.map(value => value.entity_id) ?? [])])].sort();
  const entities = ids.map(id => {
    const entity = requireContinuityEntity(context.project_id, id, context.entities);
    return { entity_id: id, kind: entity.kind, parent_entity_id: entity.parent_entity_id ?? null, character_id: entity.character_id ?? null };
  });
  return continuityHash({ schema_version: CONTINUITY_STATE_SCHEMA_VERSION, policy_version: CONTINUITY_STATE_POLICY_VERSION,
    story_position: semanticPosition(position), entities,
    cells: sortCells(state).map(cell => ({ entity_id: cell.entity_id, attribute_id: cell.attribute_id, knowledge_status: cell.knowledge_status,
      ...(cell.knowledge_status === 'confirmed' ? { value: cell.value } : {}) })),
    during_overlay: overlay ? [...overlay.proposal.values].sort((a, b) => cellKey(a) < cellKey(b) ? -1 : 1) : null });
}
function moment(state: readonly ContinuityCell[], position: ContinuityStoryPosition, context: ContinuityConfirmationContext, overlay: ContinuityConfirmedOverlay | null = null): ContinuityMoment {
  let view = sortCells(state);
  if (overlay) {
    const values = overlay.proposal.values.filter((value): value is { entity_id: string; attribute_id: ContinuityAttributeId; value: unknown } => value.attribute_id !== 'visible_position')
      .sort((a, b) => Number(a.attribute_id === 'holding_hand') - Number(b.attribute_id === 'holding_hand'));
    for (const value of values) {
      const previous = view.find(cell => cellKey(cell) === cellKey(value));
      // Restating the same holder must not restamp provenance; the existing hand still belongs to that person.
      if (value.attribute_id === 'holder' && !holderValueChanged(previous, value.value)) continue;
      if (value.attribute_id === 'holding_hand') assertHoldingHandMatchesHolder(view, value.entity_id, value.value, overlay.proposal.evidence, context);
      let retained = view.filter(cell => cellKey(cell) !== cellKey(value));
      if (value.attribute_id === 'holder' && holderValueChanged(previous, value.value)) retained = clearHoldingHand(retained, value.entity_id, context);
      view = [...retained, {
        ...continuityAttributeVersion(value.attribute_id), project_id: context.project_id, story_segment_id: position.story_segment_id,
        entity_id: value.entity_id, attribute_id: value.attribute_id, knowledge_status: 'confirmed' as const, value: value.value as string | null,
        provenance: { change_id: overlay.proposal.overlay_id, change_revision: overlay.proposal.overlay_revision, confirmation: overlay.confirmation, evidence: overlay.proposal.evidence },
      }];
    }
  }
  return freeze({ story_position: position, state: sortCells(view), during_overlay: overlay, state_hash: stateHash(view, position, context, overlay) });
}
/** Replays only through the requested screenplay scene. No write, provider call or asset default. */
export function replayContinuityScene(input: ContinuityReplayInput, targetSceneId: string): ContinuityReplayResult {
  try {
    const { context, entry } = input;
    if (context.time_relation !== 'confirmed_linear') return fail('CONTINUITY_TIME_REVIEW_REQUIRED', 'Unknown segment time needs review');
    for (const revision of [input.revisions.fact_revision, input.revisions.entity_mapping_revision, input.revisions.confirmation_revision, input.revisions.design_revision]) if (!Number.isInteger(revision) || revision < 0) return fail('CONTINUITY_SCOPE_INVALID', 'Invalid source revision');
    const scene = context.order.scenes.find(scene => scene.script_scene_id === targetSceneId);
    if (!scene) return fail('CONTINUITY_SCOPE_INVALID', 'Target is not a screenplay scene');
    if (!entry || !entries.has(entry)) return fail('CONTINUITY_ENTRY_REQUIRED', 'Explicit confirmed entry is required; legacy/default state is not an entry');
    validateContinuityStoryPosition(entry.story_position, context.order);
    if (entry.binding_revision !== context.binding_revision) return fail('CONTINUITY_STALE', 'Entry binding changed');
    requireVerifiedContinuityCells(entry.state, context);
    for (const cell of entry.state) if (cell.knowledge_status === 'confirmed') for (const evidence of cell.provenance.evidence) validateContinuityEvidence(evidence, cell.entity_id, context);
    const changes = [...input.changes].map(requireConfirmedContinuityChange).sort((a, b) => compareContinuityPositions(a.proposal.story_position, b.proposal.story_position));
    const changeIds = new Set<string>();
    changes.forEach((change, index) => {
      validateContinuityStoryPosition(change.proposal.story_position, context.order);
      if (changeIds.has(change.proposal.change_id) || index > 0 && compareContinuityPositions(changes[index - 1]!.proposal.story_position, change.proposal.story_position) === 0) return fail('CONTINUITY_SCOPE_INVALID', 'Duplicate change identity or ambiguous story position');
      changeIds.add(change.proposal.change_id);
    });
    let state = [...entry.state];
    const before = new Map<string, ContinuityCell[]>(), after = new Map<string, ContinuityCell[]>();
    let entryState: ContinuityCell[] | undefined;
    const moments: ContinuityMoment[] = [];
    const applied: ContinuityConfirmedChange[] = [];
    const plan=context.time_plan?requireContinuityTimePlan(context.time_plan,context).proposal:undefined;
    let scope=plan?{version:1 as const,day_id:plan.initial_day_id,branch_id:'reality'}:undefined;
    let reality:{state:ContinuityCell[];scope:NonNullable<typeof scope>}|undefined;
    const history=new Map<string,{entry:ContinuityCell[];exit:ContinuityCell[];scope:typeof scope}>();
    for(const storyScene of context.order.scenes){
      if(storyScene.scene_order>scene.scene_order)break;
      const boundary=plan?.boundaries.find(b=>b.script_scene_id===storyScene.script_scene_id);
      if(boundary){
        if(boundary.kind==='unknown')return fail('CONTINUITY_TIME_REVIEW_REQUIRED','Time relation is unresolved at this boundary');
        if(boundary.kind==='return_reality'){
          if(!reality||scope?.branch_id!==boundary.branch_id)return fail('CONTINUITY_TIME_REVIEW_REQUIRED','No saved reality for this return');
          state=[...reality.state];scope=reality.scope;reality=undefined;
        }else{
          if(boundary.kind==='flashback'){
            const anchor=history.get(boundary.anchor!.script_scene_id);
            if(!anchor||anchor.scope?.branch_id!=='reality'||anchor.scope.day_id!==boundary.day_id)return fail('CONTINUITY_TIME_PLAN_INVALID','Flashback anchor day/branch is unavailable');
            reality={state:[...state],scope:scope!};state=[...anchor[boundary.anchor!.phase]];
            scope={version:1,day_id:boundary.day_id!,branch_id:boundary.branch_id!};
          }else scope={version:1,day_id:boundary.day_id!,branch_id:'reality'};
          const decisions=new Map(boundary.rules.map(r=>[cellKey(r),r]));
          if(state.some(cell=>!decisions.has(cellKey(cell)))||boundary.rules.some(rule=>!state.some(cell=>cellKey(rule)===cellKey(cell))))return fail('CONTINUITY_TIME_PLAN_INVALID','Review inheritance or unknown separately for every state property at this boundary');
          state=state.map(cell=>decisions.get(cellKey(cell))!.action==='unknown'?createUnknownContinuityCell(context,cell.entity_id,cell.attribute_id):cell);
        }
      }
      const sceneEntry=[...state];
      if(storyScene.script_scene_id===targetSceneId)entryState=sceneEntry;
      for(const change of changes.filter(c=>c.proposal.story_position.script_scene_id===storyScene.script_scene_id)){
        const position={...change.proposal.story_position,...(scope?{time_scope:scope}:{})};
        before.set(change.proposal.change_id,[...state]);
        if(position.script_scene_id===targetSceneId)moments.push(moment(state,{...position,phase:'before'},context));
        state=applyConfirmedContinuityChange(state,change,context);
        after.set(change.proposal.change_id,[...state]);applied.push(change);
        if(position.script_scene_id===targetSceneId)moments.push(moment(state,{...position,phase:'after'},context));
      }
      history.set(storyScene.script_scene_id,{entry:sceneEntry,exit:[...state],scope});
    }
    entryState ??= [...state];
    const usedOverlays: ContinuityConfirmedOverlay[] = [];
    for (const overlay of input.during_overlays ?? []) {
      if (!overlays.has(overlay)) return fail('CONTINUITY_REVIEW_REQUIRED', 'Unverified during overlay');
      const proposal = overlay.proposal;
      if (proposal.story_position.script_scene_id !== targetSceneId) continue;
      validateContinuityStoryPosition(proposal.story_position, context.order);
      // Recheck current evidence and binding without trusting a serialized confirmation object.
      confirmContinuityOverlay(proposal, { ...context, authority: overlay.confirmation.kind === 'human' ? overlay.confirmation : undefined });
      const event = changes.find(change => change.proposal.change_id === proposal.event_change_id);
      if (proposal.event_change_id !== null && (!event || compareContinuityPositions(event.proposal.story_position, proposal.story_position) !== 0 || event.proposal.story_position.script_scene_id !== targetSceneId)) return fail('CONTINUITY_SCOPE_INVALID', 'Overlay does not belong to this event position');
      let base = proposal.event_change_id === null ? entryState : before.get(proposal.event_change_id);
      if (proposal.after_change_id !== null) {
        const completed = changes.find(change => change.proposal.change_id === proposal.after_change_id);
        if (!event || !completed || completed.proposal.story_position.script_scene_id !== targetSceneId || compareContinuityPositions(completed.proposal.story_position, event.proposal.story_position) >= 0) return fail('CONTINUITY_SCOPE_INVALID', 'Overlay cannot read an uncompleted or later event');
        base = after.get(proposal.after_change_id);
      }
      if (!base) return fail('CONTINUITY_SCOPE_INVALID', 'Overlay base state is unavailable');
      if (moments.some(value => value.story_position.moment_id === proposal.story_position.moment_id && value.story_position.phase === 'during')) return fail('CONTINUITY_SCOPE_INVALID', 'Duplicate during moment');
      moments.push(moment(base, {...proposal.story_position,...(scope?{time_scope:scope}:{})}, context, overlay)); usedOverlays.push(overlay);
    }
    const entryPosition = {...makeContinuityStoryPosition(context.order, { script_scene_id: targetSceneId, change_order: 0, moment_id: `${targetSceneId}:entry`, phase: 'before' }),...(scope?{time_scope:scope}:{})};
    const exitPosition = {...makeContinuityStoryPosition(context.order, { script_scene_id: targetSceneId, change_order: 0, moment_id: `${targetSceneId}:exit`, phase: 'after' }),...(scope?{time_scope:scope}:{})};
    moments.push(moment(entryState, entryPosition, context), moment(state, exitPosition, context));
    const targetChanges = applied.filter(change => change.proposal.story_position.script_scene_id === targetSceneId);
    const sourceHash = continuityHash({ schema_version: 1, policy_version: CONTINUITY_STATE_POLICY_VERSION,
      order: context.order, revisions: { fact_revision: input.revisions.fact_revision, entity_mapping_revision: input.revisions.entity_mapping_revision,
        confirmation_revision: input.revisions.confirmation_revision, design_revision: input.revisions.design_revision, binding_revision: context.binding_revision },
      sources: context.sources.filter(source => source.project_id === context.project_id).map(source => ({ source_type: source.source_type, source_document_id: source.source_document_id,
        source_revision: source.source_revision, source_text_hash: textHash(source.text), bindings: [...source.bindings].sort((a, b) => a.start - b.start || a.end - b.end || (a.entity_id < b.entity_id ? -1 : 1)) })).sort(canonicalCompare),
      entities: [...context.entities].filter(entity => entity.project_id === context.project_id).map(entity => ({ ...entity, aliases: [...entity.aliases].sort() })).sort((a, b) => a.entity_id < b.entity_id ? -1 : 1),
      designs: [...context.designs].filter(design => design.project_id === context.project_id).sort((a, b) => canonicalContinuityJson(a) < canonicalContinuityJson(b) ? -1 : 1),
      entry: { entry_id: entry.entry_id, entry_revision: entry.entry_revision, confirmation: confirmationProjection(entry.confirmation), cells: sortCells(entry.state).map(cellSourceProjection) },
      changes: applied.map(change => ({ proposal: { ...change.proposal, evidence: evidenceProjection(change.proposal.evidence) }, confirmation: confirmationProjection(change.confirmation) })),
      during_overlays: usedOverlays.sort((a, b) => compareContinuityPositions(a.proposal.story_position, b.proposal.story_position) || (a.proposal.overlay_id < b.proposal.overlay_id ? -1 : 1)).map(overlaySourceProjection),
      ...(plan?{time_plan:plan}:{}),input_state_hash: stateHash(entryState, entryPosition, context) });
    const snapshot: ContinuitySnapshot = freeze({ schema_version: 1, policy_version: CONTINUITY_STATE_POLICY_VERSION, project_id: context.project_id,
      script_id: context.order.script_id, script_revision: context.order.script_revision, screenplay_order_revision: context.order.screenplay_order_revision,
      story_segment_id: context.order.story_segment_id, script_scene_id: targetSceneId, entry_state: sortCells(entryState), confirmed_changes: targetChanges,
      exit_state: sortCells(state), entity_references: context.entities.filter(entity => entity.project_id === context.project_id)
        .map(({ entity_id, kind, parent_entity_id, character_id, asset_id, asset_revision }) => ({ entity_id, kind, parent_entity_id, character_id, asset_id, asset_revision })).sort((a, b) => a.entity_id < b.entity_id ? -1 : 1),
      moments: moments.sort((a, b) => a.story_position.moment_id === entryPosition.moment_id ? -1 : b.story_position.moment_id === entryPosition.moment_id ? 1
        : a.story_position.moment_id === exitPosition.moment_id ? 1 : b.story_position.moment_id === exitPosition.moment_id ? -1
        : compareContinuityPositions(a.story_position, b.story_position) || ['before', 'during', 'after'].indexOf(a.story_position.phase) - ['before', 'during', 'after'].indexOf(b.story_position.phase) || canonicalCompare(a.story_position.moment_id, b.story_position.moment_id)),
      state_hash: stateHash(state, exitPosition, context), source_hash: sourceHash, entry_state_hash: stateHash(entryState, entryPosition, context) });
    snapshots.add(snapshot);
    return { status: 'ready', snapshot };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'CONTINUITY_REVIEW_REQUIRED';
    return { status: code === 'CONTINUITY_PRECONDITION_CONFLICT' ? 'conflict' : 'pending_review', target_scene_id: targetSceneId,
      issues: [{ code, message: error instanceof Error ? error.message : 'Continuity needs review' }] };
  }
}
/** A shot reads only its declared attributes at one moment; missing/unknown dependencies block it. */
export function readContinuityMoment(snapshot: ContinuitySnapshot, momentId: string, phase: ContinuityStoryPosition['phase'], rawReads: readonly ContinuityRead[]) {
  if (!snapshots.has(snapshot)) return fail('CONTINUITY_REVIEW_REQUIRED', 'Shot reads require a verified replay, not schema-shaped snapshot JSON');
  const selected = snapshot.moments.find(moment => moment.story_position.moment_id === momentId && moment.story_position.phase === phase);
  if (!selected) return fail('CONTINUITY_REVIEW_REQUIRED', 'Selected moment needs source or frame-design confirmation');
  const reads = rawReads.map(read => ContinuityReadSchema.parse(read) as ContinuityRead);
  for(const read of [...reads])if(read.attribute_id==='holding_hand'){
    const hand=selected.state.find(c=>c.entity_id===read.entity_id&&c.attribute_id==='holding_hand'),holder=selected.state.find(c=>c.entity_id===read.entity_id&&c.attribute_id==='holder');
    if(!hand||hand.knowledge_status!=='confirmed'||!holder||holder.knowledge_status!=='confirmed'||(hand.value==='unheld'?holder.value!==null:holder.value===null))return fail('CONTINUITY_HAND_REVIEW_REQUIRED','Physical hand requires the same object’s confirmed current holder');
    if(selected.during_overlay){
      const overlay=selected.during_overlay;
      const wroteHolder=overlay.proposal.values.some(value=>value.entity_id===read.entity_id&&value.attribute_id==='holder');
      const wroteHand=overlay.proposal.values.some(value=>value.entity_id===read.entity_id&&value.attribute_id==='holding_hand');
      if(wroteHolder&&!wroteHand&&holder.provenance.change_id===overlay.proposal.overlay_id&&hand.provenance.change_id!==overlay.proposal.overlay_id)return fail('CONTINUITY_HAND_REVIEW_REQUIRED','Physical hand belongs to the previous holder');
    }
    if(!reads.some(r=>r.entity_id===read.entity_id&&r.attribute_id==='holder'))reads.push({entity_id:read.entity_id,attribute_id:'holder'});
  }
  if (new Set(reads.map(cellKey)).size !== reads.length) return fail('CONTINUITY_SCOPE_INVALID', 'Duplicate shot read');
  const values = reads.map(read => {
    if (read.attribute_id === 'visible_position') {
      const overlay = selected.during_overlay;
      const value = overlay?.proposal.values.find(value => cellKey(value) === cellKey(read));
      if (!value) return fail('CONTINUITY_REVIEW_REQUIRED', 'Visible position is not confirmed for this moment');
      return { ...read, knowledge_status: 'confirmed', value: value.value, provenance: overlaySourceProjection(overlay!) };
    }
    const cell = selected.state.find(cell => cellKey(cell) === cellKey(read));
    if (!cell || cell.knowledge_status !== 'confirmed') return fail('CONTINUITY_REVIEW_REQUIRED', 'Required state is missing or unknown');
    return confirmedCellSourceProjection(cell);
  }).sort((a, b) => cellKey(a) < cellKey(b) ? -1 : 1);
  return { story_position: selected.story_position, values, state_hash: selected.state_hash, source_hash: snapshot.source_hash,
    dependency_hash: continuityHash({ story_position: semanticPosition(selected.story_position), values,
      entity_references: snapshot.entity_references.filter(entity => values.some(value => value.entity_id === entity.entity_id || value.value === entity.entity_id)) }) };
}
