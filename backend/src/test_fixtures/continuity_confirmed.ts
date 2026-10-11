/** Adapter for frozen CT01 labels. It creates explicit human-approved entry/design/change tokens. */
import { createHash } from 'node:crypto';
import { createEmptyScriptDocument } from '../schemas/script';
import { validateContinuityEntities, buildContinuityStoryOrder, makeContinuityStoryPosition } from '../services/continuity_identity';
import { confirmContinuityChange, continuityProposalHash, createUnknownContinuityCell, applyConfirmedContinuityChange,
  type ContinuityConfirmationContext } from '../services/continuity_confirmation';
import { confirmContinuityEntry, continuityEntryHash, type ContinuityReplayInput } from '../services/continuity_replay';
import type { ContinuityChangeProposal, ContinuityCell, ContinuityAttributeId } from '../schemas/continuity_state';
import { loadContinuityFixtures } from './continuity';

export function confirmedContinuityFixture(fixtureId: string, caseId: string) {
  const fixture = loadContinuityFixtures().find(input => input.fixture.id === fixtureId)!.fixture;
  const selected = fixture.cases.find(item => item.id === caseId)!;
  const entities = validateContinuityEntities(10, fixture.entities.map(entity => ({ entity_id: entity.id, project_id: 10, kind: entity.kind,
    display_name: entity.name, aliases: [], ...(entity.parent_entity_id ? { parent_entity_id: entity.parent_entity_id } : {}),
    ...(entity.character_id ? { character_id: entity.character_id } : {}),
  })), { characters: [{ id: 1, project_id: 10 }, { id: 2, project_id: 10 }], assets: [] });
  const document = createEmptyScriptDocument(`CT04 ${fixtureId}`);
  document.locations = [{ id: 'room', name: '房间', description: '' }];
  const sceneIds = [...new Set(fixture.sources.map(source => source.scene_id))].sort();
  document.scenes = sceneIds.map(id => ({ id, locationId: 'room', interiorExterior: 'interior' as const, timeOfDay: 'day', characterIds: [],
    propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: [{ id: `${id}:block`, type: 'action' as const, text: fixture.sources.find(source => source.scene_id === id)!.text }] }));
  const order = buildContinuityStoryOrder({ project_id: 10, script_id: 30, script_revision: 1, story_segment_id: `${fixtureId}:linear`, document });
  const context: ContinuityConfirmationContext = { project_id: 10, entities, order, binding_revision: 1, time_relation: 'confirmed_linear',
    sources: fixture.sources.map(source => ({ project_id: 10, source_type: 'novel', source_document_id: source.id, source_revision: 1, text: source.text, bindings: [] })),
    designs: entities.map(entity => ({ project_id: 10, design_id: `${entity.entity_id}:entry-design`, design_revision: 1, entity_id: entity.entity_id })),
  };
  const approve = (proposal: ContinuityChangeProposal) => {
    const approved = { ...context, authority: { kind: 'human' as const, review_id: `${proposal.change_id}:review`, review_revision: proposal.change_revision,
      actor_id: 'fixture-reviewer', proposal_hash: continuityProposalHash(proposal) } };
    const result = confirmContinuityChange(proposal, approved);
    if (result.status !== 'confirmed') throw new Error(JSON.stringify(result.issues));
    return result.change;
  };
  const base: ContinuityChangeProposal = { schema_version: 1, policy_version: 'continuity-state-1', change_id: 'entry', change_revision: 1,
    binding_revision: 1, story_position: makeContinuityStoryPosition(order, { script_scene_id: sceneIds[0]!, change_order: 0, moment_id: `${fixtureId}:entry`, phase: 'before' }),
    entity_id: '', attribute_id: '', operation: 'assign', value: '', basis: 'initial_design', time_relation: 'confirmed_linear', origin: 'human_entry', evidence: [] };
  let state: ContinuityCell[] = [];
  for (const [entityId, attributes] of Object.entries(fixture.initial_state)) for (const [attribute, value] of Object.entries(attributes)) {
    if (value !== null && typeof value === 'object') state.push(createUnknownContinuityCell(context, entityId, attribute as ContinuityAttributeId));
    else state = applyConfirmedContinuityChange(state, approve({ ...base, change_id: `${entityId}:${attribute}:entry`, entity_id: entityId, attribute_id: attribute,
      value, operation: value === null ? 'clear' : 'assign', evidence: [{ kind: 'design', design_id: `${entityId}:entry-design`, design_revision: 1 }] }), context);
  }
  const entryInput = { entry_id: `${fixtureId}:entry`, entry_revision: 1, binding_revision: 1, story_position: base.story_position, state };
  const entry = confirmContinuityEntry(entryInput, { ...context, authority: { kind: 'human', review_id: `${fixtureId}:entry-review`, review_revision: 1,
    actor_id: 'fixture-reviewer', proposal_hash: continuityEntryHash(entryInput) } });
  const changes = selected.expected.changes.map((change, index) => {
    const source = fixture.sources.find(source => source.id === change.source_id)!;
    return approve({ ...base, change_id: `${caseId}:${index}`, entity_id: change.entity_id, attribute_id: change.attribute_id, value: change.value,
      operation: change.operation, basis: 'story',
      ...(change.operation === 'transfer' ? { completion: 'completed', precondition: { knowledge_status: 'confirmed', value: change.from ?? null } } as const : {}),
      story_position: makeContinuityStoryPosition(order, { script_scene_id: source.scene_id, change_order: index, moment_id: `${caseId}:${index}:moment`, phase: 'after' }),
      evidence: [{ kind: 'source', source_type: 'novel', source_document_id: source.id, source_revision: 1,
        source_text_hash: createHash('sha256').update(source.text, 'utf8').digest('hex'), evidence_quote: source.text, start: 0, end: source.text.length }],
    });
  });
  const input: ContinuityReplayInput = { context, entry: selected.entry_confirmed === false ? undefined : entry, changes,
    revisions: { fact_revision: 1, entity_mapping_revision: 1, confirmation_revision: 1, design_revision: 1 } };
  return { fixture, selected, input, approve, state, base };
}
