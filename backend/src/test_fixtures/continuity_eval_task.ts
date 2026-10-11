import { createEmptyScriptDocument } from '../schemas/script';
import type { AIProvider } from '../services/ai/base';
import type { ContinuityCell, ContinuityAttributeId, ContinuityChangeProposal } from '../schemas/continuity_state';
import {continuityAttributeVersion} from '../schemas/continuity_state';
import { buildContinuityStoryOrder, makeContinuityStoryPosition } from '../services/continuity_identity';
import { applyConfirmedContinuityChange, confirmContinuityChange, continuityProposalHash, createUnknownContinuityCell, type ContinuityConfirmationContext } from '../services/continuity_confirmation';
import type { ContinuitySuggestionTask } from '../services/continuity_suggestions';
import { CONTINUITY_EVAL_FIXTURES } from './continuity_eval';

/** Only the frozen INPUT and prior state are read here; expected/optional labels never enter the prompt. */
export function continuityEvaluationTask(fixture: typeof CONTINUITY_EVAL_FIXTURES[number], sourceCase: typeof fixture.cases[number], provider: AIProvider, seed: number): ContinuitySuggestionTask {
  const document = createEmptyScriptDocument(`Evaluation ${fixture.id}`);
  document.locations = [{ id: 'location', name: '场所', description: '' }];
  document.scenes = [{ id: 'scene', locationId: 'location', interiorExterior: 'interior', timeOfDay: 'day', characterIds: [], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: [{ id: 'action', type: 'action', text: sourceCase.source }] }];
  const order = buildContinuityStoryOrder({ project_id: 10, script_id: 30, script_revision: 1, story_segment_id: `${fixture.id}:linear`, document });
  const context: ContinuityConfirmationContext = { project_id: 10, entities: structuredClone(fixture.entities), order, binding_revision: 1, time_relation: 'confirmed_linear', sources: [{ project_id: 10, source_type: 'screenplay', source_document_id: `${fixture.id}:${sourceCase.id}`, source_revision: 1, text: sourceCase.source, bindings: [] }], designs: fixture.entities.map(entity => ({ project_id: 10, design_id: `${entity.entity_id}:entry-design`, design_revision: 1, entity_id: entity.entity_id })) };
  let state: ContinuityCell[] = [];
  for (const cell of fixture.prior) {
    if (cell.knowledge_status === 'unknown') { state.push(createUnknownContinuityCell(context, cell.entity_id, cell.attribute_id as ContinuityAttributeId)); continue; }
    const proposal: ContinuityChangeProposal = { ...continuityAttributeVersion(cell.attribute_id), change_id: `${cell.entity_id}:${cell.attribute_id}:entry`, change_revision: 1, binding_revision: 1, story_position: makeContinuityStoryPosition(order, { script_scene_id: 'scene', change_order: 0, moment_id: 'entry', phase: 'before' }), entity_id: cell.entity_id, attribute_id: cell.attribute_id, operation: cell.value === null ? 'clear' : 'assign', value: cell.value, basis: 'initial_design', time_relation: 'confirmed_linear', origin: 'human_entry', evidence: [{ kind: 'design', design_id: `${cell.entity_id}:entry-design`, design_revision: 1 }] };
    const result = confirmContinuityChange(proposal, { ...context, authority: { kind: 'human', review_id: `${proposal.change_id}:frozen-input-review`, review_revision: 1, actor_id: 'fixture-reviewer', proposal_hash: continuityProposalHash(proposal) } });
    if (result.status !== 'confirmed') throw new Error(JSON.stringify(result));
    state = applyConfirmedContinuityChange(state, result.change, context);
  }
  return { context, target_scene_id: 'scene', related_entity_ids: fixture.entities.map(entity => entity.entity_id), prior_state: state, sources: context.sources.map(source => ({ source_id: source.source_document_id, source_type: source.source_type, source_document_id: source.source_document_id, source_revision: source.source_revision, text: source.text })), preceding_context: sourceCase.prior_context || '', provider, seed };
}
