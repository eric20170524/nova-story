import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createEmptyScriptDocument } from '../schemas/script';
import {
  CONTINUITY_ATTRIBUTES, CONTINUITY_STATE_SCHEMA_VERSION, CONTINUITY_STATE_POLICY_VERSION,
  ContinuityCellSchema, ContinuityChangeProposalSchema,
  type ContinuityChangeProposal, type ContinuityCell, type ContinuityAttributeId,
} from '../schemas/continuity_state';
import { validateContinuityEntities, buildContinuityStoryOrder, makeContinuityStoryPosition } from './continuity_identity';
import {
  confirmContinuityChange, continuityProposalHash, requireConfirmedContinuityChange, createUnknownContinuityCell,
  applyConfirmedContinuityChange, ContinuityConfirmationError, CONTINUITY_CONFIRMATION_RULES,
  type ContinuityConfirmationContext,
} from './continuity_confirmation';
import { loadContinuityFixtures } from '../test_fixtures/continuity';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function setup(fixtureId = 'F07') {
  const fixture = loadContinuityFixtures().find(input => input.fixture.id === fixtureId)!.fixture;
  const entities = validateContinuityEntities(10, fixture.entities.map(entity => ({
    entity_id: entity.id, project_id: 10, kind: entity.kind, display_name: entity.name, aliases: [],
    ...(entity.character_id ? { character_id: entity.character_id } : {}),
    ...(entity.parent_entity_id ? { parent_entity_id: entity.parent_entity_id } : {}),
  })), { characters: [{ id: 1, project_id: 10 }, { id: 2, project_id: 10 }], assets: [] });
  const document = createEmptyScriptDocument('CT03');
  document.locations = [{ id: 'room', name: '房间', description: '' }];
  document.scenes = [...new Set(fixture.sources.map(source => source.scene_id))].map(id => ({
    id, locationId: 'room', interiorExterior: 'interior' as const, timeOfDay: 'day', characterIds: [], propIds: [],
    eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: [{ id: `${id}:block`, type: 'action' as const, text: fixture.sources.find(source => source.scene_id === id)!.text }],
  }));
  const order = buildContinuityStoryOrder({ project_id: 10, script_id: 30, script_revision: 1, story_segment_id: 'linear-1', document });
  const context: ContinuityConfirmationContext = {
    project_id: 10, entities, order, binding_revision: 1, time_relation: 'confirmed_linear', designs: [],
    sources: fixture.sources.map(source => ({ project_id: 10, source_type: 'novel', source_document_id: source.id, source_revision: 1, text: source.text, bindings: [] })),
  };
  function proposal(entityId: string, attribute: string, value: unknown, sourceId: string, patch: Partial<ContinuityChangeProposal> = {}): ContinuityChangeProposal {
    const source = context.sources.find(source => source.source_document_id === sourceId)!;
    const sourceScene = fixture.sources.find(source => source.id === sourceId)!.scene_id;
    return { schema_version: 1, policy_version: 'continuity-state-1', change_id: `${sourceId}:${entityId}:${attribute}`, change_revision: 1,
      binding_revision: 1, story_position: makeContinuityStoryPosition(order, { script_scene_id: sourceScene, change_order: 0, moment_id: `${sourceId}:after`, phase: 'after' }),
      entity_id: entityId, attribute_id: attribute, operation: 'assign', value, basis: 'story', time_relation: 'confirmed_linear', origin: 'model',
      evidence: [{ kind: 'source', source_type: source.source_type, source_document_id: sourceId, source_revision: 1, source_text_hash: sha(source.text), start: 0, end: source.text.length, evidence_quote: source.text }], ...patch,
    };
  }
  function human(raw: ContinuityChangeProposal, ctx = context) {
    return { ...ctx, authority: { kind: 'human' as const, review_id: 'review-1', review_revision: 1, actor_id: 'reviewer-1', proposal_hash: continuityProposalHash(raw) } };
  }
  function confirmed(raw: ContinuityChangeProposal, ctx = human(raw)) {
    const result = confirmContinuityChange(raw, ctx);
    assert.equal(result.status, 'confirmed', JSON.stringify(result));
    if (result.status !== 'confirmed') throw new Error('Not confirmed');
    return result.change;
  }
  function apply(state: ContinuityCell[], raw: ContinuityChangeProposal, ctx = human(raw)) {
    return applyConfirmedContinuityChange(state, confirmed(raw, ctx), ctx);
  }
  return { fixture, context, proposal, human, confirmed, apply };
}
function pending(raw: unknown, context: ContinuityConfirmationContext, code?: string) {
  const result = confirmContinuityChange(raw, context);
  assert.equal(result.status, 'pending_review');
  if (result.status !== 'pending_review') throw new Error('Unexpected confirmation');
  assert.deepEqual(result.suggestion, raw);
  if (code) assert.equal(result.issues[0]!.code, code);
  return result;
}
function known(state: ContinuityCell[], entityId: string, attributeId: string) {
  const cell = state.find(cell => cell.entity_id === entityId && cell.attribute_id === attributeId);
  assert.equal(cell?.knowledge_status, 'confirmed');
  if (!cell || cell.knowledge_status !== 'confirmed') throw new Error('Missing confirmed cell');
  return cell.value;
}
const errorCode = (code: string) => (error: unknown) => error instanceof ContinuityConfirmationError && error.code === code;

test('CT03 versioned registry defines all eleven typed attributes, scopes and permitted operations', () => {
  assert.equal(CONTINUITY_STATE_SCHEMA_VERSION, 1);
  assert.equal(CONTINUITY_STATE_POLICY_VERSION, 'continuity-state-1');
  assert.deepEqual(Object.keys(CONTINUITY_ATTRIBUTES).filter(id=>id!=='holding_hand'), ['color', 'wetness', 'integrity', 'wearer', 'holder', 'owner', 'location', 'presence', 'open_state', 'lock_function', 'power_state']);
  assert.ok(Object.isFrozen(CONTINUITY_ATTRIBUTES.holder.target_kinds));
  assert.ok(Object.values(CONTINUITY_ATTRIBUTES).every(attribute => attribute.scope === 'story_segment'));
  assert.deepEqual(CONTINUITY_ATTRIBUTES.holder.operations, ['assign', 'clear', 'transfer']);
  assert.deepEqual(CONTINUITY_ATTRIBUTES.lock_function.kinds, ['component']);
  assert.equal(CONTINUITY_CONFIRMATION_RULES.length, 2);
});

test('CT03 missing cells, explicit unknown and confirmed null remain distinct', () => {
  const { context, proposal, apply } = setup();
  const unknown = createUnknownContinuityCell(context, 'F07:u1', 'holder');
  assert.equal('value' in unknown, false);
  assert.equal(ContinuityCellSchema.safeParse({ ...unknown, value: null }).success, false);
  const clear = proposal('F07:u1', 'holder', null, 'take', { operation: 'clear' });
  const state = apply([unknown], clear);
  assert.equal(known(state, 'F07:u1', 'holder'), null);
  assert.equal(state.find(cell => cell.attribute_id === 'owner'), undefined);
  assert.equal(unknown.knowledge_status, 'unknown');
  const { value: _value, ...missing } = clear;
  assert.equal(ContinuityChangeProposalSchema.safeParse(missing).success, false);
  pending({ ...clear, operation: 'assign' }, context, 'CONTINUITY_VALUE_INVALID');
  pending({ ...clear, operation: 'assign', value: { unknown: true } }, context, 'CONTINUITY_VALUE_INVALID');
});

test('CT03 C01: frozen F02 garments change independently and clear only the scarf wearer', () => {
  const { fixture, context, proposal, apply } = setup('F02');
  let state: ContinuityCell[] = [];
  for (const [entityId, attributes] of Object.entries(fixture.initial_state)) for (const [attribute, value] of Object.entries(attributes)) {
    state = typeof value === 'object' && value !== null ? [...state, createUnknownContinuityCell(context, entityId, attribute as ContinuityAttributeId)]
      : apply(state, proposal(entityId, attribute, value, 'wet', { operation: value === null ? 'clear' : 'assign' }));
  }
  const initial = state;
  for (const change of fixture.cases.find(item => item.id === 'independent-garments')!.expected.changes) {
    state = apply(state, proposal(change.entity_id, change.attribute_id, change.value, change.source_id, { operation: change.operation }));
  }
  assert.equal(known(state, 'F02:coat1', 'wetness'), 'wet');
  assert.equal(known(state, 'F02:coat1', 'color'), 'red');
  assert.equal(known(state, 'F02:coat1', 'wearer'), 'F02:lin');
  assert.equal(known(state, 'F02:coat2', 'wetness'), 'dry');
  assert.equal(known(state, 'F02:coat2', 'color'), 'blue');
  assert.equal(known(state, 'F02:scarf', 'wearer'), null);
  assert.equal(initial.find(cell => cell.entity_id === 'F02:coat1' && cell.attribute_id === 'wetness')!.knowledge_status, 'unknown');
});

test('CT03 C03: F01 door integrity and lock function are independent component cells', () => {
  const { context, proposal, apply } = setup('F01');
  const state = apply(apply([], proposal('F01:door', 'integrity', 'intact', 'lock')), proposal('F01:lock', 'lock_function', 'broken', 'lock'));
  assert.equal(known(state, 'F01:door', 'integrity'), 'intact');
  assert.equal(known(state, 'F01:lock', 'lock_function'), 'broken');
  pending(proposal('F01:door', 'lock_function', 'working', 'lock'), context, 'CONTINUITY_VALUE_INVALID');
});

test('CT03 attribute types and relationship identities reject invalid values and wrong entity kinds', () => {
  const { context, proposal, human } = setup();
  for (const [entity, attribute, value] of [
    ['F07:coat', 'wetness', 'blue'], ['F07:coat', 'integrity', 'wet'], ['F07:coat', 'color', '蓝色'],
    ['F07:u1', 'wearer', 'F07:chen'], ['F07:coat', 'wearer', 'F07:u1'], ['F07:u1', 'location', 'F07:chen'],
    ['F07:u1', 'holder', '黑伞 U1'], ['F07:u1', 'location', 'in_air'], ['F07:chen', 'color', 'blue'],
  ]) {
    const raw = proposal(entity!, attribute!, value, 'coat');
    pending(raw, human(raw));
  }
  for (const attribute of ['holder', 'wearer', 'owner', 'location']) {
    const raw = proposal('F07:coat', attribute, null, 'coat', { operation: 'clear' });
    assert.equal(confirmContinuityChange(raw, human(raw)).status, 'confirmed');
  }
  pending(proposal('F07:coat', 'color', null, 'coat', { operation: 'clear' }), context, 'CONTINUITY_VALUE_INVALID');
  const foreign = { ...context.entities[0]!, entity_id: 'foreign', project_id: 20 };
  const raw = proposal('F07:u1', 'holder', 'foreign', 'take');
  pending(raw, human(raw, { ...context, entities: [...context.entities, foreign] }));
});

test('CT03 valid values for the full registry can be manually confirmed within the declared entity scope', () => {
  const { proposal, apply } = setup('F01');
  let state: ContinuityCell[] = [];
  for (const [entityId, attribute, value] of [
    ['F01:coat', 'color', 'dark_blue'], ['F01:coat', 'wetness', 'wet'], ['F01:coat', 'integrity', 'damaged'],
    ['F01:coat', 'wearer', 'F01:lin'], ['F01:umbrella', 'holder', 'F01:lin'], ['F01:umbrella', 'owner', 'F01:chen'],
    ['F01:umbrella', 'location', 'F01:room'], ['F01:lin', 'presence', 'absent'], ['F01:door', 'open_state', 'closed'],
    ['F01:lock', 'lock_function', 'working'], ['F01:lock', 'power_state', 'off'],
  ]) state = apply(state, proposal(entityId!, attribute!, value, 'coat'));
  assert.equal(state.length, 11);
  assert.equal(known(state, 'F01:coat', 'integrity'), 'damaged');
  assert.equal(known(state, 'F01:lin', 'presence'), 'absent');
});

test('CT03 UTF-16 exact evidence is separate from normalized wetness and preserves emoji/CRLF', () => {
  const { context, proposal, human } = setup();
  const source = context.sources.find(source => source.source_document_id === 'coat')!;
  source.text = '🌧️\r\n陈月的蓝外套湿透了。\r\n';
  const start = source.text.indexOf('蓝外套');
  const end = source.text.indexOf('。') + 1;
  const raw = proposal('F07:coat', 'wetness', 'wet', 'coat');
  raw.evidence = [{ kind: 'source', source_type: 'novel', source_document_id: 'coat', source_revision: 1,
    source_text_hash: sha(source.text), start, end, evidence_quote: source.text.slice(start, end) }];
  assert.equal(start, 8);
  assert.equal(raw.evidence[0]!.kind === 'source' && raw.evidence[0]!.evidence_quote.includes('wet'), false);
  assert.equal(confirmContinuityChange(raw, human(raw)).status, 'confirmed');
  for (const patch of [{ start: start - 1 }, { end: end - 1 }, { evidence_quote: '外套湿透了' }, { source_revision: 2 }, { source_text_hash: '0'.repeat(64) }, { source_type: 'screenplay' }]) {
    const changed = { ...raw, evidence: [{ ...raw.evidence[0]!, ...patch }] };
    pending(changed, human(raw));
  }
  const split = { ...raw, evidence: [{ ...raw.evidence[0]!, start: 1, end: 2, evidence_quote: source.text.slice(1, 2) }] };
  pending(split, context, 'CONTINUITY_EVIDENCE_INVALID');
});

test('CT03 evidence, binding and story revisions invalidate a prior human approval', () => {
  const { context, proposal, human } = setup();
  const raw = proposal('F07:coat', 'wetness', 'wet', 'coat');
  const approved = human(raw);
  pending({ ...raw, value: 'dry' }, approved, 'CONTINUITY_STALE');
  pending({ ...raw, change_revision: 2 }, approved, 'CONTINUITY_STALE');
  pending(raw, { ...approved, binding_revision: 2 }, 'CONTINUITY_STALE');
  pending(raw, { ...approved, order: { ...approved.order, script_revision: 2, screenplay_order_revision: 2 } }, 'CONTINUITY_STALE');
  pending(raw, { ...approved, sources: approved.sources.map(source => ({ ...source, text: source.text + '\n' })) }, 'CONTINUITY_STALE');
  pending(raw, { ...approved, sources: approved.sources.map(source => ({ ...source, project_id: 20 })) }, 'CONTINUITY_EVIDENCE_INVALID');
});

test('CT03 C10/C11: model, self-audit and legacy fact states cannot certify themselves', () => {
  const { context, proposal, confirmed } = setup();
  const raw = proposal('F07:coat', 'wetness', 'wet', 'coat');
  for (const origin of ['model', 'self_audit', 'legacy_fact_states'] as const) pending({ ...raw, origin }, context, 'CONTINUITY_REVIEW_REQUIRED');
  pending({ ...raw, confirmation: { kind: 'human' }, faithful: true, confirmed: true }, context, 'CONTINUITY_PROPOSAL_INVALID');
  pending({ entity: '陈月', attribute: 'wardrobe', value: '湿透的蓝外套', evidence_quote: '陈月的蓝外套湿透了。' }, context, 'CONTINUITY_PROPOSAL_INVALID');
  const token = confirmed(raw);
  assert.equal(requireConfirmedContinuityChange(token), token);
  assert.ok(Object.isFrozen(token.proposal.evidence));
  assert.throws(() => requireConfirmedContinuityChange(structuredClone(token)), errorCode('CONTINUITY_REVIEW_REQUIRED'));
  assert.throws(() => requireConfirmedContinuityChange(JSON.parse(JSON.stringify(token))), errorCode('CONTINUITY_REVIEW_REQUIRED'));
});

test('CT03 C11 positive: a human review approves an exact correction without adopting a wrong model wearer', () => {
  const { context, proposal, apply } = setup();
  const entry = apply([], proposal('F07:coat', 'wearer', 'F07:chen', 'coat'));
  pending(proposal('F07:coat', 'wearer', 'F07:lin', 'coat'), context, 'CONTINUITY_REVIEW_REQUIRED');
  const result = apply(entry, proposal('F07:coat', 'wetness', 'wet', 'coat', { origin: 'human_entry' }));
  assert.equal(known(result, 'F07:coat', 'wearer'), 'F07:chen');
  assert.equal(known(result, 'F07:coat', 'wetness'), 'wet');
});

test('CT03 C16: unknown attributes, shared holders and unknown time retain all suggestion data', () => {
  const { context, proposal, human } = setup();
  const unknown = proposal('F07:u1', 'temperature', 37, 'take');
  pending(unknown, human(unknown), 'CONTINUITY_ATTRIBUTE_UNSUPPORTED');
  const shared = proposal('F07:u1', 'holder', ['F07:lin', 'F07:chen'], 'shared');
  const retained = pending(shared, human(shared), 'CONTINUITY_SHARED_HOLDER_UNSUPPORTED');
  assert.deepEqual((retained.suggestion as ContinuityChangeProposal).value, ['F07:lin', 'F07:chen']);
  const collapsed = proposal('F07:u1', 'holder', 'F07:chen', 'shared');
  pending(collapsed, human(collapsed), 'CONTINUITY_SHARED_HOLDER_UNSUPPORTED');
  const time = proposal('F07:u1', 'integrity', 'intact', 'time');
  pending(time, human(time), 'CONTINUITY_TIME_REVIEW_REQUIRED');
  pending({ ...time, time_relation: 'unknown' }, context, 'CONTINUITY_TIME_REVIEW_REQUIRED');
  const linear = proposal('F07:u1', 'integrity', 'intact', 'take');
  pending(linear, human(linear, { ...context, time_relation: 'unknown' }), 'CONTINUITY_TIME_REVIEW_REQUIRED');
});

test('CT03 completed transfer checks the old holder of the same item and atomically changes only that relation', () => {
  const { proposal, apply } = setup('F01');
  let entry = apply([], proposal('F01:umbrella', 'holder', 'F01:lin', 'umbrella'));
  entry = apply(entry, proposal('F01:coat', 'holder', 'F01:lin', 'coat'));
  const change = proposal('F01:umbrella', 'holder', 'F01:chen', 'handover', {
    operation: 'transfer', precondition: { knowledge_status: 'confirmed', value: 'F01:lin' }, completion: 'completed',
  });
  const result = apply(entry, change);
  assert.equal(known(entry, 'F01:umbrella', 'holder'), 'F01:lin');
  assert.equal(known(result, 'F01:umbrella', 'holder'), 'F01:chen');
  assert.equal(known(result, 'F01:coat', 'holder'), 'F01:lin');
  assert.equal(result.filter(cell => cell.entity_id === 'F01:umbrella' && cell.attribute_id === 'holder').length, 1);
});

test('CT03 transfer rejects missing/unknown/wrong prior holder; confirmed nobody can be a precondition', () => {
  const { context, proposal, apply, human, confirmed } = setup();
  const raw = proposal('F07:u1', 'holder', 'F07:chen', 'take', { operation: 'transfer', precondition: { knowledge_status: 'confirmed', value: 'F07:lin' }, completion: 'completed' });
  const approved = human(raw), token = confirmed(raw, approved);
  const unknown = [createUnknownContinuityCell(context, 'F07:u1', 'holder')];
  const wrong = apply([], proposal('F07:u1', 'holder', null, 'take', { operation: 'clear' }));
  for (const state of [[], unknown, wrong]) assert.throws(() => applyConfirmedContinuityChange(state, token, approved), errorCode('CONTINUITY_PRECONDITION_CONFLICT'));
  const fromNobody = { ...raw, precondition: { knowledge_status: 'confirmed' as const, value: null } };
  assert.equal(known(apply(wrong, fromNobody), 'F07:u1', 'holder'), 'F07:chen');
  pending({ ...raw, precondition: undefined }, context, 'CONTINUITY_PROPOSAL_INVALID');
  pending({ ...raw, completion: undefined }, context, 'CONTINUITY_PROPOSAL_INVALID');
  pending({ ...raw, precondition: { knowledge_status: 'unknown' } }, context, 'CONTINUITY_PROPOSAL_INVALID');
});

test('CT03 stale evidence or forged state cells cannot mutate an approved transition', () => {
  const { context, proposal, apply, human, confirmed } = setup();
  const state = apply([], proposal('F07:u1', 'holder', null, 'take', { operation: 'clear' }));
  const raw = proposal('F07:u1', 'holder', 'F07:chen', 'take');
  const approval = human(raw), token = confirmed(raw, approval);
  assert.throws(() => applyConfirmedContinuityChange(state, token, { ...approval, binding_revision: 2 }), errorCode('CONTINUITY_STALE'));
  assert.throws(() => applyConfirmedContinuityChange(structuredClone(state), token, approval), errorCode('CONTINUITY_REVIEW_REQUIRED'));
  assert.equal(known(state, 'F07:u1', 'holder'), null);
});

test('CT03 persistent changes cannot promote a during moment into exit state', () => {
  const { proposal, human } = setup();
  const raw = proposal('F07:u1', 'holder', null, 'take', { operation: 'clear' });
  raw.story_position = { ...raw.story_position, phase: 'during' };
  pending(raw, human(raw), 'CONTINUITY_DURING_OVERLAY_REQUIRED');
});

function wetnessRule() {
  const setupResult = setup();
  const { context, proposal } = setupResult;
  const source = context.sources.find(source => source.source_document_id === 'coat')!;
  const start = source.text.indexOf('蓝外套');
  source.bindings = [{ entity_id: 'F07:coat', start, end: start + 3 }];
  const raw = proposal('F07:coat', 'wetness', 'wet', 'coat');
  raw.evidence = [{ ...raw.evidence[0]!, start, end: source.text.length, evidence_quote: source.text.slice(start) } as typeof raw.evidence[0]];
  const rule: ContinuityConfirmationContext = { ...context, authority: { kind: 'rule', rule_id: 'wetness.explicit.zh', rule_version: 1 } };
  return { ...setupResult, source, raw, rule };
}

test('CT03 C10 positive: named wetness rule verifies exact physical binding and normalized wet/dry', () => {
  const { raw, rule, context, proposal } = wetnessRule();
  const result = confirmContinuityChange(raw, rule);
  assert.equal(result.status, 'confirmed');
  if (result.status === 'confirmed') assert.deepEqual(result.change.confirmation, { kind: 'rule', rule_id: 'wetness.explicit.zh', rule_version: 1, proposal_hash: continuityProposalHash(raw) });
  pending({ ...raw, value: 'dry' }, rule, 'CONTINUITY_RULE_UNVERIFIED');
  pending(raw, { ...rule, authority: { kind: 'rule', rule_id: 'model-self-audit', rule_version: 1 } }, 'CONTINUITY_RULE_UNSUPPORTED');
  pending(raw, { ...rule, authority: { kind: 'rule', rule_id: 'wetness.explicit.zh', rule_version: 2 } }, 'CONTINUITY_RULE_UNSUPPORTED');
  context.sources.find(source => source.source_document_id === 'coat')!.text = '蓝外套保持干燥。';
  context.sources.find(source => source.source_document_id === 'coat')!.bindings = [{ entity_id: 'F07:coat', start: 0, end: 3 }];
  assert.equal(confirmContinuityChange(proposal('F07:coat', 'wetness', 'dry', 'coat'), rule).status, 'confirmed');
});

test('CT03 rule cannot use a cropped quote to bypass negation, intention or a conditional context', () => {
  for (const text of ['如果蓝外套湿透了。', '陈月想让蓝外套湿透了。', '并没有发生蓝外套湿透了。', '听说蓝外套湿透了。', '并非蓝外套湿透了。', '他写下蓝外套湿透了。', '蓝外套湿透了的说法被否认。']) {
    const { source, proposal, rule } = wetnessRule();
    source.text = text;
    const start = text.indexOf('蓝外套');
    source.bindings = [{ entity_id: 'F07:coat', start, end: start + 3 }];
    const raw = proposal('F07:coat', 'wetness', 'wet', 'coat');
    const end = start + '蓝外套湿透了'.length;
    raw.evidence = [{ ...raw.evidence[0]!, start, end, evidence_quote: text.slice(start, end) } as typeof raw.evidence[0]];
    pending(raw, rule, 'CONTINUITY_RULE_UNVERIFIED');
  }
});

test('CT03 rules reject ambiguous/missing bindings and mismatched physical identities', () => {
  const { source, raw, rule } = wetnessRule();
  source.bindings = [];
  pending(raw, rule, 'CONTINUITY_RULE_UNVERIFIED');
  source.bindings = [{ entity_id: 'F07:coat', start: 3, end: 6 }, { entity_id: 'F07:u1', start: 3, end: 6 }];
  pending(raw, rule, 'CONTINUITY_RULE_UNVERIFIED');
  source.bindings = [{ entity_id: 'F07:u1', start: 3, end: 6 }];
  pending(raw, rule, 'CONTINUITY_RULE_UNVERIFIED');
});

test('CT03 named receipt rule verifies a completed transfer with both item and receiver bindings', () => {
  const { context, proposal, apply } = setup();
  const source = context.sources.find(source => source.source_document_id === 'take')!;
  source.text = '陈月接过黑伞 U1。';
  source.bindings = [{ entity_id: 'F07:chen', start: 0, end: 2 }, { entity_id: 'F07:u1', start: 4, end: 9 }];
  const raw = proposal('F07:u1', 'holder', 'F07:chen', 'take', { operation: 'transfer', precondition: { knowledge_status: 'confirmed', value: 'F07:lin' }, completion: 'completed' });
  const rule: ContinuityConfirmationContext = { ...context, authority: { kind: 'rule', rule_id: 'holder.received.zh', rule_version: 1 } };
  const state = apply([], proposal('F07:u1', 'holder', 'F07:lin', 'take'));
  const result = confirmContinuityChange(raw, rule);
  assert.equal(result.status, 'confirmed');
  if (result.status === 'confirmed') assert.equal(known(applyConfirmedContinuityChange(state, result.change, rule), 'F07:u1', 'holder'), 'F07:chen');
  source.bindings[0]!.entity_id = 'F07:lin';
  pending(raw, rule, 'CONTINUITY_RULE_UNVERIFIED');
  if (result.status === 'confirmed') assert.throws(() => applyConfirmedContinuityChange(state, result.change, rule), errorCode('CONTINUITY_RULE_UNVERIFIED'));
});

test('CT03 offering, negated receipt and intended transfer cannot be marked completed even with a human claim', () => {
  const { context, proposal, human } = setup('F01');
  for (const text of ['林岚向陈月递出黑伞，陈月没有接住。', '林岚想把黑伞递给陈月。', '林岚没有把黑伞递给陈月。', '林岚未把黑伞递给陈月。', '陈月不肯接过林岚的黑伞。']) {
    context.sources.find(source => source.source_document_id === 'handover')!.text = text;
    const raw = proposal('F01:umbrella', 'holder', 'F01:chen', 'handover', { operation: 'transfer', precondition: { knowledge_status: 'confirmed', value: 'F01:lin' }, completion: 'completed' });
    pending(raw, human(raw), 'CONTINUITY_TRANSFER_NOT_COMPLETED');
  }
});

test('CT03 explicit versioned design is separate from source quotes and cannot replace confirmed story state', () => {
  const { context, proposal, human, confirmed, apply } = setup();
  context.designs = [{ project_id: 10, design_id: 'blue-coat', design_revision: 1, entity_id: 'F07:coat' }];
  const raw = proposal('F07:coat', 'color', 'blue', 'coat', { basis: 'initial_design', evidence: [{ kind: 'design', design_id: 'blue-coat', design_revision: 1 }] });
  const result = apply([], raw);
  assert.equal(known(result, 'F07:coat', 'color'), 'blue');
  pending(raw, context, 'CONTINUITY_REVIEW_REQUIRED');
  pending(raw, human(raw, { ...context, designs: [{ ...context.designs[0]!, project_id: 20 }] }), 'CONTINUITY_STALE');
  pending(raw, human(raw, { ...context, designs: [{ ...context.designs[0]!, design_revision: 2 }] }), 'CONTINUITY_STALE');
  pending({ ...raw, evidence: [{ ...raw.evidence[0]!, evidence_quote: '蓝外套' }] }, context, 'CONTINUITY_PROPOSAL_INVALID');
  const story = apply([], proposal('F07:coat', 'color', 'red', 'coat'));
  assert.throws(() => applyConfirmedContinuityChange(story, confirmed(raw), human(raw)), errorCode('CONTINUITY_DESIGN_OVERRIDE_FORBIDDEN'));
  assert.equal(known(story, 'F07:coat', 'color'), 'red');
});
