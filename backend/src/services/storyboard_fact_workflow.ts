import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/database';
import type { AIProvider } from './ai/base';
import { STORYBOARD_CANDIDATE_SHOT_LIMIT, type ScriptDocument, type StoryboardCandidatePayload, type StoryboardCandidateShot } from '../schemas/script';
import { FACT_POLICY_VERSION, FACT_STATE_ATTRIBUTES, FactKindSchema, FactStateSchema, factStateLabel, type VisualFact, type StoryboardFactContract } from '../schemas/storyboard_facts';
import { isFactStateAttribute, positionApplies, reviewExtractedStates, stateCategoryConflict } from './fact_state';

export const FACT_CLASSIFY_INSTRUCTION = [
  'Classify each unchanged ID only.',
  'visual = observable appearance, action, object, number, position, location, gesture, posture, or expression.',
  'audio = sound, silence, or a speech act (说、问、答、应). A speech act is not visual.',
  'internal = thought, bodily sensation, energy surge, memory, or invisible intention.',
  'figurative = metaphor.',
  'mixed = a sentence that contains both a visible action and speech, or both a visible action and an internal thought, separated by punctuation or by 然后、随后、接着、之后、继而、并. A single clause with no such split is never mixed; classify it by its primary trait.',
  'uncertain = cannot decide. An empty scene is visual. Return items with id and kind only.',
].join(' ');
import { EntityBindingSchema } from '../schemas/entity_binding';
import { actionBindingSource, boundVisibleEntities, boundText, entityRoster, needsBindingReview, proposeBindings, textHash, validateBinding, transferTranslationProblem, transferRelations, englishReferenceProblem, bodyOwnerTerms } from './entity_binding';
import { type CharacterLockRef } from './pony_prompt_compiler';
import { packShotSpec } from '../schemas/shot_contract';
import { findChapterShotQuotaViolation } from './shot_intent_quota';
import { containsCjk } from './english_visual_prompt';
import { compileNegativePrompt } from './negative_prompt_compiler';
import { InferenceCache, textModelFingerprint, type InferenceReuseOptions } from './inference_cache';
import { withLocalTextInference } from './local_text_inference';
import { continuityReadForFacts, type ContinuityWorkflowScope } from './continuity_workflow_scope';
import { newWorkflowInferenceBudget, workflowBudgetProvider, WorkflowTransportError, type WorkflowInferenceBudget } from './workflow_inference_budget';
import { continuityVisualFact, type ContinuityVisualState } from './continuity_visual_state';

const stepCache = new InferenceCache<unknown>('storyboard-steps');

const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hash = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export class FactWorkflowError extends Error {
  constructor(message: string, public statusCode: 400 | 409 | 502 = 400) { super(message); }
}
const punctuationOnly = (value: string) => !value.replace(/[\s\p{P}]/gu, '');

export const TRANSITION_FILLERS_REGEX = /^(?:[\s\p{P}]*(?:只见|只见得|只见那|这时|此时|这时刻|这一刻|下一刻|下一秒|紧接着|随后|接着|然后|突然|忽地|旋即|同时|与此同时|便见|却见|但见|便|就|方才|刚才|片刻后|半晌|转瞬间|一时间|只见是|正见|忽听得|只听得|且|而|又|及|须臾|倏忽|未几|少顷|良久|清晨|正午|傍晚|深夜)+[\s\p{P}]*)+$/u;

export function isPunctuationOrFiller(segment: string): boolean {
  if (punctuationOnly(segment)) return true;
  const cleanSeg = segment.replace(/[\s\p{P}]/gu, '');
  if (!cleanSeg) return true;
  if (TRANSITION_FILLERS_REGEX.test(cleanSeg)) return true;
  if (cleanSeg.length <= 2 && /^[且而又有便就与及则向从在被把到来去之得了着过]+$/u.test(cleanSeg)) return true;
  return false;
}

export function locateSpanInSource(source: string, spanText: string, cursor: number): { start: number; end: number; resolvedText: string } | null {
  // 1. Direct exact substring match at or after cursor
  const exactIdx = source.indexOf(spanText, cursor);
  if (exactIdx >= 0) {
    return { start: exactIdx, end: exactIdx + spanText.length, resolvedText: spanText };
  }

  // 2. Trimmed exact substring match
  const trimmed = spanText.trim();
  if (trimmed) {
    const trimmedIdx = source.indexOf(trimmed, cursor);
    if (trimmedIdx >= 0) {
      return { start: trimmedIdx, end: trimmedIdx + trimmed.length, resolvedText: source.slice(trimmedIdx, trimmedIdx + trimmed.length) };
    }
  }

  // 3. Punctuation and whitespace insensitive match (Clean Match)
  const cleanChar = (ch: string) => !/[\s\p{P}]/gu.test(ch);
  const cleanStr = (s: string) => s.replace(/[\s\p{P}]/gu, '');
  const cleanSpan = cleanStr(spanText);
  if (cleanSpan.length > 0) {
    const sourceCleanIndices: number[] = [];
    let cleanSourceSlice = '';
    for (let i = cursor; i < source.length; i++) {
      if (cleanChar(source[i]!)) {
        sourceCleanIndices.push(i);
        cleanSourceSlice += source[i]!;
      }
    }

    const cleanMatchIdx = cleanSourceSlice.indexOf(cleanSpan);
    if (cleanMatchIdx >= 0) {
      const matchStart = sourceCleanIndices[cleanMatchIdx]!;
      const matchEnd = sourceCleanIndices[cleanMatchIdx + cleanSpan.length - 1]! + 1;
      return { start: matchStart, end: matchEnd, resolvedText: source.slice(matchStart, matchEnd) };
    }
  }

  return null;
}

export const ExtractionSchema = z.object({ spans: z.array(z.object({
  text: z.string().min(1), kind: FactKindSchema, beat: z.number().int().nonnegative(),
  states: z.array(FactStateSchema).default([]),
  binding: EntityBindingSchema.optional(),
})).min(1) });

/** Ordered partition of the block with tolerance for narrative transition words and punctuation. */
export function anchorSpans(sceneId: string, blockId: string, source: string, output: { spans: Array<{ text: string; kind: z.infer<typeof FactKindSchema>; beat: number; states?: z.infer<typeof FactStateSchema>[]; binding?: z.infer<typeof EntityBindingSchema> }> }, baseOffset = 0): VisualFact[] {
  let cursor = 0;
  let lastBeat = -1;
  const facts = output.spans.map((span) => {
    const states = span.states ?? [];
    const located = locateSpanInSource(source, span.text, cursor);
    if (!located) {
      throw new FactWorkflowError(`来源片段遗漏或无法定位: ${blockId}@${cursor}`);
    }
    const { start, end, resolvedText } = located;
    const gap = source.slice(cursor, start);
    const isGapAllowed = isPunctuationOrFiller(gap);
    if (!isGapAllowed) throw new FactWorkflowError(`来源片段遗漏或无法定位: ${blockId}@${cursor}`);
    if (span.beat < lastBeat) throw new FactWorkflowError(`事实节拍乱序: ${blockId}`);
    if (span.kind !== 'visual' && states.length) throw new FactWorkflowError(`非视觉片段不能改变连续状态: ${blockId}`);
    if (states.length) {
      if (span.binding) validateBinding(span.binding, resolvedText, [...new Map(span.binding.mentions.filter(m => m.entity).map(m => [m.entity!.id, m.entity!])).values()]);
      const owners = boundVisibleEntities(span.binding).map(e => e.name);
      if (evidencedContinuityStates(resolvedText, states, source.slice(0, start), owners).rejected.length) throw new FactWorkflowError(`连续状态缺少原文证据: ${blockId}`);
    }
    lastBeat = span.beat;
    cursor = end;
    return { ...span, states, text: resolvedText, id: `f_${hash([sceneId, blockId, start + baseOffset, cursor + baseOffset]).slice(0, 20)}`, scene_id: sceneId, block_id: blockId, start: start + baseOffset, end: cursor + baseOffset };
  });
  if (!isPunctuationOrFiller(source.slice(cursor))) throw new FactWorkflowError(`来源片段尾部遗漏: ${blockId}@${cursor}`);
  return facts;
}

/** Keep source order when an earlier non-visual beat was numbered above a later visible moment. */
export function stabilizeFactBeats<T extends { scene_id: string; block_id: string; beat: number; start?: number }>(facts: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const fact of facts) {
    const key = `${fact.scene_id}\0${fact.block_id}`;
    const list = groups.get(key);
    if (list) list.push(fact);
    else groups.set(key, [fact]);
  }
  for (const spans of groups.values()) {
    const ordered = [...spans].sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || spans.indexOf(a) - spans.indexOf(b));
    for (let index = 0; index < ordered.length; index++) {
      if (!ordered.slice(0, index).some(span => span.beat > ordered[index]!.beat)) continue;
      const target = ordered[index]!.beat;
      for (let earlier = 0; earlier < index; earlier++) if (ordered[earlier]!.beat > target) ordered[earlier]!.beat = target;
    }
  }
  return facts;
}

export function validateFactSources(doc: ScriptDocument, facts: VisualFact[]) {
  if (new Set(facts.map(f => f.id)).size !== facts.length) throw new FactWorkflowError('事实 ID 重复');
  for (const scene of doc.scenes) for (const block of scene.blocks.filter(b => b.type === 'action')) {
    const spans = facts.filter(f => f.scene_id === scene.id && f.block_id === block.id).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    const anchored = anchorSpans(scene.id, block.id, block.text, { spans });
    if (hash(anchored) !== hash(spans)) throw new FactWorkflowError(`事实来源偏移或 ID 被修改: ${block.id}`);
  }
  for (const fact of facts) {
    const block = doc.scenes.find(s => s.id === fact.scene_id)?.blocks.find(b => b.id === fact.block_id);
    if (!block || block.type !== 'action') throw new FactWorkflowError(`事实跨场或引用未知来源: ${fact.id}`);
  }
  for (const scene of doc.scenes) {
    let previous = -1;
    for (const fact of facts.filter(f => f.scene_id === scene.id && f.kind === 'visual')) {
      if (fact.beat < previous) throw new FactWorkflowError('分场节拍顺序颠倒');
      previous = fact.beat;
    }
  }
}

export const MAX_SHOT_SECONDS = 15;
/** One shot per independent beat, plus one when the same beat holds mutually exclusive states. The allocator default remains 20 so a larger board still has to be accepted explicitly. */
export const CHAPTER_SHOT_LIMIT = STORYBOARD_CANDIDATE_SHOT_LIMIT;
/** Speech time follows the quoted line when narration was left in the same dialogue block. */
const spokenCharacters = (block: { type: string; text: string }) => {
  const compact = block.text.replace(/\s/g, '');
  if (block.type !== 'dialogue') return compact.length;
  const quoted = [...block.text.matchAll(/“[^”]*”/g)].map(match => match[0].replace(/\s/g, ''));
  const quotedLength = quoted.reduce((total, part) => total + part.length, 0);
  return quotedLength > 0 && quotedLength < compact.length ? quotedLength : compact.length;
};
const audioSeconds = (block: { type: string; text: string }) => block.type === 'dialogue' || block.type === 'voiceover' ? Math.max(1, spokenCharacters(block) / 4) : 0;
export function allocateBudgets(doc: ScriptDocument, facts: VisualFact[], limit = 20) {
  const budgets = doc.scenes.map(scene => {
    const visual = facts.filter(f => f.scene_id === scene.id && f.kind === 'visual');
    const beats = new Set(visual.map(f => f.beat));
    const speechSeconds = scene.blocks.filter(b => b.type === 'dialogue' || b.type === 'voiceover')
      .reduce((n, b) => n + audioSeconds(b), 0);
    const longLine = scene.blocks.find(b => audioSeconds(b) > MAX_SHOT_SECONDS);
    if (longLine) throw new FactWorkflowError(`声音预算冲突: ${scene.id}/${longLine.id} 单条语音超过 ${MAX_SHOT_SECONDS} 秒，请按完整语句拆分有声块`);
    if (scene.estimatedDurationSec && speechSeconds > scene.estimatedDurationSec) {
      throw new FactWorkflowError(`声音时长冲突: ${scene.id} 预计语音 ${Math.ceil(speechSeconds)} 秒，场景仅 ${scene.estimatedDurationSec} 秒`);
    }
    const duration = Math.max(scene.estimatedDurationSec || 0, speechSeconds, beats.size * 3, 3);
    const groups = visualPlanGroups(visual);
    const stateSlots = groups.reduce((count, group) => count + buildFactSlots(group).length, 0);
    return { scene_id: scene.id, minimum: Math.max(1, beats.size, stateSlots, Math.ceil(duration / MAX_SHOT_SECONDS)), duration };
  });
  const minimum = budgets.reduce((n, b) => n + b.minimum, 0);
  if (minimum > limit) throw new FactWorkflowError(`镜头预算冲突: 最少需要 ${minimum} 镜，上限 ${limit}；${budgets.map(b => `${b.scene_id}: ${b.minimum}镜`).join('；')}。请核对独立节拍或调整时长，不能静默并镜。`);
  return budgets;
}

type State = { entity: string; attribute: string; value: string; fact_id: string; item?: string; operation?: 'set' | 'remove' };
/** One posture and one unlabeled body state per person. A later value replaces the earlier one. Garments and held objects stay per item. */
export function stateResourceKey(s: { entity: string; attribute: string; value: string; item?: string }) {
  if (s.attribute === 'pose') return `${s.entity}:pose:`;
  if (s.attribute === 'body') return `${s.entity}:body:${s.item || ''}`;
  const garment = s.value.match(/外套|围巾|里衣|外衣|外袍|长袍|衣襟|手套|帽子|雨伞|蓝伞|伞|信封|杯|衣领|臂膀/u)?.[0];
  const item = s.item || (['wardrobe', 'holding'].includes(s.attribute) ? garment || s.value : '');
  return `${s.entity}:${s.attribute}:${item}`;
}
export function continuityAfter(previous: State[], facts: VisualFact[]): State[] {
  const states = new Map(previous.filter(s => isFactStateAttribute(s.attribute)).map(s => [stateResourceKey(s), s]));
  for (const fact of facts.filter(f => f.kind === 'visual')) {
    for (const s of fact.states) {
      if (!isFactStateAttribute(s.attribute) || s.attribute === 'expression') continue;
      const key = stateResourceKey(s);
      if (s.operation === 'remove' && s.attribute !== 'wardrobe') states.delete(key);
      else states.set(key, { ...s, fact_id: fact.id });
    }
    // Only the explicit, completed handover grammar is deterministic. Attempts,
    // "递出" and unbound references must not silently transfer possession.
    if (fact.binding && !needsBindingReview(fact.binding)) for (const relation of transferRelations(boundText(fact.text, fact.binding))) {
      const names = boundVisibleEntities(fact.binding).map(e => e.name);
      if (!names.includes(relation.actor) || !names.includes(relation.recipient)) continue;
      for (const [key, state] of states) if (state.entity === relation.actor && state.attribute === 'holding' && (state.item === relation.object || state.value === relation.object)) states.delete(key);
      const holding = { entity: relation.recipient, attribute: 'holding', value: relation.object, item: relation.object, fact_id: fact.id };
      states.set(stateResourceKey(holding), holding);
    }
  }
  return [...states.values()].sort((a, b) => `${a.entity}:${a.attribute}`.localeCompare(`${b.entity}:${b.attribute}`));
}
export function continuityForScene(state: State[], doc: ScriptDocument, facts: VisualFact[], sceneId: string) {
  const current = doc.scenes.find(s => s.id === sceneId)!;
  return state.filter(s => {
    if (s.attribute === 'expression') return false;
    if (!facts.some(f => f.scene_id === sceneId && f.kind === 'visual' && (boundVisibleEntities(f.binding).some(e => e.name === s.entity) || (!f.binding && f.text.includes(s.entity))))) return false;
    const origin = facts.find(f => f.id === s.fact_id);
    const originScene = doc.scenes.find(sc => sc.id === origin?.scene_id);
    return !['position', 'presence', 'pending_action'].includes(s.attribute) || originScene?.locationId === current.locationId;
  });
}
export const continuityLiteral = (states: State[]) => states.map(s => {
  const label = factStateLabel(s.attribute);
  const desc = s.attribute === 'wardrobe' && s.operation === 'remove' ? `已脱下衣物：${s.item || s.value}` : `${label}：${s.value}`;
  return { id: `state_${hash(s).slice(0, 16)}`, text: (s as Partial<ContinuityVisualState>).entity_id ? continuityVisualFact(s as ContinuityVisualState) : `${s.entity} ${desc}` };
});
export function inheritedStates(state: State[], selected: VisualFact[], present: string[] = [], location = '') {
  const visible = new Set(present);
  const texts = selected.map((fact) => fact.text);
  return state.filter(s => {
    if (s.attribute === 'expression') return false;
    if (selected.some(f => f.id === s.fact_id)) return false;
    if (!(visible.has(s.entity) || texts.some(text => text.includes(s.entity)))) return false;
    if (s.attribute === 'position') return positionApplies(s.value, location, texts);
    return true;
  });
}

/** Names are visible only through this fact's confirmed binding, never historical name occurrence. */
export function subjectEvidence(sceneFacts: VisualFact[], selected: VisualFact[], name: string): boolean {
  if (!name || !selected.length) return false;
  return selected.some(fact => fact.binding && boundVisibleEntities(fact.binding).some(e => e.name === name));
}

export const PlanSchema = z.object({ shots: z.array(z.object({
  fact_ids: z.array(z.string()), primary_fact_id: z.string().nullable(),
})).min(1).max(20) });
export type FactPlan = z.infer<typeof PlanSchema>['shots'];
/** A pronoun is not a name. Another confirmed person's name in the same clause blocks the binding fallback. */
function ownsWardrobeOrHolding(clause: string, entity: string, owners: string[]): boolean {
  if (entity && clause.includes(entity)) return true;
  if (!entity || !owners.includes(entity)) return false;
  return !owners.some(name => name !== entity && name.length > 0 && clause.includes(name));
}

/** Wardrobe and holding need the entity's name in the clause, or that entity as a confirmed binding. */
export function evidencedContinuityStates<T extends { entity: string; attribute: string; value: string; item?: string; operation?: string }>(text: string, states: T[], context = '', owners: string[] = []) {
  const accepted: T[] = [];
  const rejected: T[] = [];
  for (const state of states) {
    if (!text.includes(state.value)) { rejected.push(state); continue; }
    if ((state.attribute === 'wardrobe' || state.attribute === 'holding') && state.item && !text.includes(state.item)) { rejected.push(state); continue; }
    if (state.attribute === 'wardrobe' && state.operation === 'remove' && !/脱下|脱掉|脱去|摘下|摘掉|褪下|褪去|解下|解开|解|除下|扯下|拉下|滑落/u.test(text)) { rejected.push(state); continue; }
    if (state.attribute === 'wardrobe' || state.attribute === 'holding') {
      const quotedValue = state.value.replace(/[，,。;；!?！？]+$/u, '');
      const clauses = text.split(/[，,。;；!?！？]/u).filter(clause => quotedValue && clause.includes(quotedValue) && (!state.item || clause.includes(state.item)));
      (clauses.some(clause => ownsWardrobeOrHolding(clause, state.entity, owners)) ? accepted : rejected).push(state);
      continue;
    }
    const currentNames = [...new Set(states.map(s => s.entity))].filter(name => text.includes(name));
    const entitySeen = owners.includes(state.entity) || text.includes(state.entity) || (currentNames.length === 0 && context.includes(state.entity));
    (entitySeen ? accepted : rejected).push(state);
  }
  return { accepted, rejected };
}

const CLAUSE_EDGE = /[，,；;。！？!?、：:—–—~～…”’」』"'\n\s]+$/u;
const CLAUSE_JOIN = /^(?:[—–—~～…”’」』“‘「『"'\n\s]+|然后|随后|接着|之后|继而|并(?![列排拢肩非且得]))/u;

/** A cut is valid at punctuation or a succession word. A cut inside a clause is not. */
export function clauseBoundaryBetween(head: string, tail: string): boolean {
  return CLAUSE_EDGE.test(head) || CLAUSE_JOIN.test(tail);
}

/** Join fragments the model cut out of one clause. Leave a real clause boundary, a source gap, or a new beat alone. */
export function groupAdjacentClauseFragments<T extends { text: string; beat: number; start: number; end: number; block_id: string; scene_id: string }>(facts: T[]): number[][] {
  const groups: number[][] = [];
  for (let index = 0; index < facts.length; index++) {
    const fact = facts[index]!;
    const previous = groups.at(-1)?.at(-1);
    const prior = previous === undefined ? undefined : facts[previous];
    if (prior && prior.scene_id === fact.scene_id && prior.block_id === fact.block_id && prior.beat === fact.beat && prior.end === fact.start && !clauseBoundaryBetween(prior.text, fact.text)) groups.at(-1)!.push(index);
    else groups.push([index]);
  }
  return groups;
}

/** A model split counts only when the pieces are verbatim source quotes in order. */
export function verbatimActionSplit(source: string, spans: string[]): string[] | null {
  if (spans.length < 2 || spans.some(span => !span)) return null;
  for (let i = 0; i < spans.length - 1; i++) {
    const trimmed = spans[i]!.replace(/[，,；;。！？\n\s]+$/u, '').trim();
    if (/(?:[把将从向朝被在往且]|对于|关于|和|与|跟|同)$/u.test(trimmed)) return null;
  }
  if (spans.join('') === source) return spans;
  const joined = spans.join('');
  if (source.startsWith(joined) && source.slice(joined.length).match(/^[，,；;。！？\n\s]+$/u)) {
    const adjusted = [...spans];
    adjusted[adjusted.length - 1] += source.slice(joined.length);
    if (adjusted.join('') === source) return adjusted;
  }
  return null;
}

export function alignSpansToSource<T extends { text: string }>(source: string, spans: T[]): T[] | null {
  if (spans.length === 0) return spans;
  const clean = (s: string) => s.replace(/[\s\p{P}]/gu, '');
  const cleanSource = clean(source);
  if (spans.length === 1) {
    const cleanSpan = clean(spans[0]!.text);
    if (cleanSpan === cleanSource || cleanSource.includes(cleanSpan)) {
      return [{ ...spans[0]!, text: source }];
    }
    return spans;
  }
  const cleanSpans = spans.map(s => clean(s.text));
  if (cleanSpans.join('') !== cleanSource) return null;

  const aligned: T[] = [];
  let sourceCursor = 0;
  for (let i = 0; i < spans.length; i++) {
    const targetCleanLen = cleanSpans[i]!.length;
    let cleanCount = 0;
    const startIdx = sourceCursor;
    while (sourceCursor < source.length && cleanCount < targetCleanLen) {
      if (clean(source[sourceCursor]!)) cleanCount++;
      sourceCursor++;
    }
    if (i === spans.length - 1) {
      sourceCursor = source.length;
    } else {
      while (sourceCursor < source.length && !clean(source[sourceCursor]!)) {
        if (/[‘“"'(（\[【]/.test(source[sourceCursor]!)) break;
        sourceCursor++;
      }
    }
    aligned.push({ ...spans[i]!, text: source.slice(startIdx, sourceCursor) });
  }
  return aligned;
}

/** A quoted comma is split into tags and rejoined. Compare the words, so that split still counts as the sentence. */
export function promptContainsTranslation(prompt: string, english: string): boolean {
  const words = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const needle = words(english);
  return !needle || words(prompt).includes(needle);
}

/** Ask the text model to replace invented continuity with an exact source quote, or with no state. */
export function continuityEvidenceRepair(text: string, rejected: Array<{ entity: string; attribute: string; value: string }>, context = '') {
  const listed = rejected.map(state => `${state.attribute}：${state.entity}=${state.value}`).join('；');
  const earlier = context ? `前文「${context}」或` : '';
  return `原文「${text}」里没有这些连续状态的逐字证据：${listed}。请重新抽取。value 必须是该句里的连续原文。entity 必须是${earlier}该句里的连续原文，不能写无、没有、不存在、英文或同义改写。没有明确持续状态就返回 states:[]。`;
}

/** Keep one beat in source order. A fact that changes an entity attribute starts the next slot. */
function buildFactSlots(facts: VisualFact[]): VisualFact[][] {
  const slots: VisualFact[][] = [];
  let current: VisualFact[] = [];
  let beat: number | undefined;
  const states = new Map<string, string>();
  const flush = () => {
    if (!current.length) return;
    slots.push(current);
    current = [];
    states.clear();
  };
  for (const fact of facts) {
    const conflict = fact.states.some(state => {
      const key = stateResourceKey(state);
      return states.has(key) && states.get(key) !== state.value;
    });
    if (current.length && (fact.beat !== beat || conflict)) flush();
    beat = fact.beat;
    current.push(fact);
    for (const state of fact.states) states.set(stateResourceKey(state), state.value);
  }
  flush();
  return slots;
}

export function assignFactSlots(facts: VisualFact[], count: number): VisualFact[][] {
  const slots = buildFactSlots(facts);
  if (slots.length > count) throw new FactWorkflowError(`同镜互斥状态需要 ${slots.length} 镜，本组预算 ${count}`);
  while (slots.length < count) slots.push([]);
  return slots;
}

/** Pack up to four beats, or until the planning input would pass 1400 characters. */
export function visualPlanGroups(visual: VisualFact[]): VisualFact[][] {
  const beats = [...new Set(visual.map(f => f.beat))].map(beat => visual.filter(f => f.beat === beat));
  const groups: VisualFact[][] = [];
  for (const beat of beats) {
    if (beat.reduce((n, f) => n + f.text.length, 0) > 1800) throw new FactWorkflowError(`完整节拍超出规划输入预算: ${beat[0]!.scene_id}/${beat[0]!.beat}`);
    if (!groups.length || new Set(groups.at(-1)!.map(f => f.beat)).size >= 4 || groups.at(-1)!.reduce((n, f) => n + f.text.length, 0) + beat.reduce((n, f) => n + f.text.length, 0) > 1400) groups.push([]);
    groups.at(-1)!.push(...beat);
  }
  return groups;
}

/** Mutex slots stay on the group that contains the conflict. Spare duration shots stay on the last group. */
export function groupShotCounts(groups: VisualFact[][], minimum: number): number[] {
  const required = groups.map(group => buildFactSlots(group).length);
  const spare = minimum - required.reduce((count, slots) => count + slots, 0);
  return required.map((count, index) => count + (index === groups.length - 1 ? Math.max(0, spare) : 0));
}

export function validatePlan(facts: VisualFact[], plan: FactPlan, count: number) {
  if (plan.length !== count) throw new FactWorkflowError(`分场预算不匹配: 需要 ${count} 镜，返回 ${plan.length} 镜`);
  const required = facts.filter(f => f.kind === 'visual');
  const map = new Map(required.map(f => [f.id, f]));
  const seen = new Set<string>();
  let last = -1;
  for (const shot of plan) {
    if (shot.fact_ids.length && (!shot.primary_fact_id || !shot.fact_ids.includes(shot.primary_fact_id))) throw new FactWorkflowError('主动作必须属于本镜事实');
    if (!shot.fact_ids.length && shot.primary_fact_id !== null) throw new FactWorkflowError('空事实镜头不能引用未知主动作');
    const beats = new Set<string>();
    const states = new Map<string, string>();
    for (const id of shot.fact_ids) {
      const f = map.get(id);
      if (!f || seen.has(id)) throw new FactWorkflowError(`未知、跨场或重复事实: ${id}`);
      seen.add(id);
      const index = required.indexOf(f);
      if (index < last) throw new FactWorkflowError(`视觉事实顺序颠倒: ${id}`);
      last = index;
      beats.add(String(f.beat));
      for (const s of f.states) {
        const key = stateResourceKey(s);
        if (states.has(key) && states.get(key) !== s.value) throw new FactWorkflowError(`同镜互斥状态: ${id}`);
        states.set(key, s.value);
      }
    }
    if (beats.size > 1) throw new FactWorkflowError('不能把独立叙事节拍机械并为同镜');
  }
  const missing = required.filter(f => !seen.has(f.id));
  if (missing.length) throw new FactWorkflowError(`遗漏视觉事实: ${missing.map(f => f.id).join(', ')}`);
}

/** 朝 + place + 的方向 is a direction. The leading 朝 is not a surname. */
export function directionPlace(text: string): string | null {
  const match = /^朝([\p{Script=Han}]{2,8})的方向/u.exec(text.trim());
  return match?.[1] ?? null;
}

/** A single toward-place clause is already checked. The model audit must not reject that same clause again. */
export function directionPlaceSettled(text: string, english: string): boolean {
  if (!directionPlace(text) || directionPlaceProblem(text, english)) return false;
  return /^(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+)?(?:walks?|walking|comes?|coming|heads?|heading)\s+towards?\s+(?:the\s+direction\s+of\s+)?(?:the\s+)?[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}\.?$/i.test(english.trim());
}

/** Reject a split place name or a person invented from 朝 before the model audit spends the only repair on a vague failure. */
export function directionPlaceProblem(text: string, english: string): string | null {
  const place = directionPlace(text);
  if (!place) return null;
  const reasons: string[] = [];
  if (!/\b(?:toward|towards)\b/i.test(english)) reasons.push('须用 toward 表示朝向');
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\s+(?:walks|comes|goes|heads)\b/.test(english.trim())) reasons.push('不能把朝和地名拆成新人名');
  if (place.includes('宫')) {
    if (!/\b(?:palace|hall|court|gong)\b/i.test(english)) reasons.push('宫要保留为 palace、hall、court 或 gong');
    const proper = english.match(/\b[A-Z][a-z]{2,}\b/g) || [];
    const generic = new Set(['Palace', 'Hall', 'Court', 'Gong', 'Walk', 'Walking', 'Walks', 'Toward', 'Towards', 'Direction', 'Outer', 'Inner', 'The']);
    if (!proper.some(word => !generic.has(word))) reasons.push(`地名 ${place} 要整词保留，不能只译后半`);
  }
  if (!reasons.length) return null;
  return `朝${place}的方向：朝是朝向，${place}是一个地名。${reasons.join('；')}。上次译文「${english}」`;
}

export async function auditFacts(provider: AIProvider, facts: Array<{ id: string; text: string }>, english: string, context: unknown = {}) {
  if (!english.trim() || containsCjk(english)) throw new FactWorkflowError('译文格式错误: 必须为非空英文', 502);
  const referenceProblem = englishReferenceProblem(english, (context as any)?.glossary || {});
  if (referenceProblem) throw new FactWorkflowError(`译文待核对: ${referenceProblem}`, 502);
  for (const fact of facts) {
    const missingTerms = bodyOwnerTerms(fact.text, (context as any)?.glossary || {}).filter(term => !english.toLowerCase().includes(term.toLowerCase()));
    if (missingTerms.length) throw new FactWorkflowError(`译文待核对: ${fact.id} 身体部位归属须原样写出 ${missingTerms.join(', ')}`, 502);
    const problem = transferTranslationProblem(fact.text, english, (context as any)?.glossary || {});
    if (problem) throw new FactWorkflowError(`译文待核对: ${fact.id} ${problem}`, 502);
  }
  if (facts.length === 1) {
    const fact = facts[0]!;
    const glossary = (context as any)?.glossary || {};
    if (fact.id === 'interior_exterior' && ((fact.text === '室内' && /\b(?:indoors?|interior)\b/i.test(english)) || (fact.text === '室外' && /\b(?:outdoors?|exterior)\b/i.test(english)))) {
      return;
    }
    if (fact.id === 'time_of_day' && ((fact.text === '白天' && /\b(?:day|daytime)\b/i.test(english)) || (fact.text === '夜间' && /\b(?:night|nighttime)\b/i.test(english)) || (fact.text === '黎明' && /\bdawn\b/i.test(english)) || (fact.text === '黄昏' && /\bdusk\b/i.test(english)))) {
      return;
    }
    if (fact.id === 'location' && glossary[fact.text] && new RegExp(`\\b${glossary[fact.text].replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i').test(english)) {
      return;
    }
    if (directionPlaceSettled(fact.text, english)) return;
  }
  const schema = z.object({ faithful: z.boolean() }).strict();
  let result: z.infer<typeof schema>;
  try {
    result = await provider.generateStructured(JSON.stringify({ task: 'audit', facts, source: facts.map(f => f.text).join('\n'), english, context }), schema,
      'Compare Chinese source facts and an English translation. Return faithful=true ONLY when English preserves ALL source facts, identity, number, agent/patient, color, left/right, negation, clothing, pose, contact, objects and location, and adds no unsupported person, action, color or object. In Chinese, subjects and possessives of body parts or actions are often elided; resolving an elided subject or possessor from context.visible_names is faithful and expected, not an unsupported addition. Camera/style tags and numeric emphasis weights are technical formatting, not scene facts. Appearance locks in context are permitted only for context.visible_names and must never contradict source facts for the same attribute or garment. Names use context.glossary. Do not produce explanations or quotations.', { temperature: 0.1, maxTokens: 64 });
  } catch (error) {
    if (error instanceof z.ZodError) throw new FactWorkflowError('审核格式错误: 事实核对结果不完整或含未知 ID', 502);
    throw error;
  }
  if (!result.faithful) throw new FactWorkflowError(`译文待核对: ${facts.map(f => f.id).join(', ')} 存在遗漏、矛盾、新增或不确定性`, 502);
}

export const shotEvidenceIds = (shot: StoryboardCandidateShot) => [...(shot.fact_ids || []), ...(shot.hold_fact_ids || [])];
export const auditHash = (shot: StoryboardCandidateShot, contract: StoryboardFactContract, model: string) => hash([FACT_POLICY_VERSION, model, contract.source_hash, contract.facts.filter(f => shotEvidenceIds(shot).includes(f.id)), shot]);
export const factSourceHash = (doc: ScriptDocument, facts: VisualFact[], entities: StoryboardFactContract['entities']) => hash([doc, entities || [], facts.map(f => [f.id, f.binding])]);
export const sceneContext = (doc: ScriptDocument, scene: ScriptDocument['scenes'][number]) => ({ location_description: doc.locations.find(l => l.id === scene.locationId)?.description || '', interior_exterior: scene.interiorExterior, time_of_day: scene.timeOfDay });
export const sceneContextFacts = (context: ReturnType<typeof sceneContext>) => [
  ...(context.location_description ? [{ id: 'location_description', text: context.location_description }] : []),
  { id: 'interior_exterior', text: context.interior_exterior === 'interior' ? '室内' : '室外' },
  { id: 'time_of_day', text: ({ day: '白天', night: '夜间', dawn: '黎明', dusk: '黄昏' } as Record<string, string>)[context.time_of_day] || context.time_of_day },
];
/** Clothing changes stay on the shot continuity state. Appearance text is not rewritten by garment class. */
export function scopedWardrobeLock(_name: string, lock: string, _facts: VisualFact[] = [], _inherited: State[] = []) {
  return lock.split(',').map(clause => clause.trim()).filter(Boolean).join(', ');
}
export function shotSoundText(doc: ScriptDocument, shot: StoryboardCandidateShot, contract: StoryboardFactContract) {
  const scene = doc.scenes.find(s => s.id === shot.script_scene_id)!;
  return scene.blocks.flatMap(block => block.type === 'sound' && shot.block_ids.includes(block.id) ? [block.text.trim()]
    : contract.facts.filter(f => f.block_id === block.id && shot.audio_fact_ids?.includes(f.id)).map(f => f.text)).join('; ');
}
export async function hasAudit(key: string) {
  return Boolean(await db.get("SELECT task_id FROM generation_task WHERE task_id=? AND kind='storyboard_audit' AND status='completed'", `audit_${key}`));
}
export async function saveAudit(key: string) {
  await db.run("INSERT OR IGNORE INTO generation_task(task_id,kind,status,progress_json) VALUES(?,'storyboard_audit','completed',?)", `audit_${key}`, JSON.stringify({ policy: FACT_POLICY_VERSION }));
}

/** Inventory declarations alone do not establish that a prop is visible. */
export function visiblePropEvidence(doc: ScriptDocument, facts: VisualFact[]) {
  return doc.scenes.flatMap(scene => doc.props.filter(prop => scene.propIds.includes(prop.id)).flatMap(prop => {
    const matching = facts.filter(f => f.scene_id === scene.id && f.kind === 'visual' && f.text.includes(prop.name));
    return matching.length ? [{ scene_id: scene.id, name: prop.name, beats: matching.map(f => f.beat) }] : [];
  }));
}

/** Shared by generation, candidate editing and adoption; references are not proof of depiction. */
export function validateFactPayload(doc: ScriptDocument, payload: StoryboardCandidatePayload) {
  const contract = payload.fact_contract;
  if (!contract || contract.version !== 3 || contract.policy !== FACT_POLICY_VERSION) throw new FactWorkflowError('旧事实契约需要重新生成，不能自动获得人物绑定确认');
  if (contract.source_hash !== factSourceHash(doc, contract.facts, contract.entities)) throw new FactWorkflowError('事实契约缺失或剧本来源版本不符');
  validateFactSources(doc, contract.facts);
  for (const fact of contract.facts.filter(f => f.kind === 'visual')) {
    if (!fact.binding) throw new FactWorkflowError('人物绑定契约缺失');
    validateBinding(fact.binding, fact.text, contract.entities || []);
    const { automatic } = actionBindingSource(doc, fact.scene_id, fact.block_id, contract.entities || [], fact.start, fact.end);
    if (fact.binding.context_hash !== automatic.context_hash) throw new FactWorkflowError('人物绑定前文版本已变化，请重新核对');
    if (needsBindingReview(fact.binding)) throw new FactWorkflowError('人物绑定待核对，不能形成可采纳候选');
  }
  if (contract.facts.some(f => f.kind === 'mixed' || f.kind === 'uncertain')) throw new FactWorkflowError('存在待核对事实，不能形成可采纳候选');
  if (hash(allocateBudgets(doc, contract.facts, CHAPTER_SHOT_LIMIT)) !== hash(contract.budgets)) throw new FactWorkflowError('镜头预算被修改');
  let previousScene = -1;
  for (const shot of payload.shots) {
    const index = doc.scenes.findIndex(s => s.id === shot.script_scene_id);
    if (index < previousScene || index < 0) throw new FactWorkflowError('分场顺序错误');
    previousScene = index;
    const spec = JSON.parse(shot.shot_spec);
    const scene = doc.scenes[index]!;
    const declaredLocation = doc.locations.find(l => l.id === scene.locationId)?.name || scene.locationId;
    if (spec.location !== declaredLocation) throw new FactWorkflowError('镜头地点与剧本资产不符');
    if (hash(spec.scene_context) !== hash(sceneContext(doc, scene))) throw new FactWorkflowError('镜头昼夜、内外景或地点描述与剧本不符');
    const audibleBlocks = scene.blocks.filter(b => b.type !== 'action' && shot.block_ids.includes(b.id));
    if (hash(spec.audible_blocks || []) !== hash(audibleBlocks)) throw new FactWorkflowError('镜头声音来源、说话人或顺序被修改');
    const selected = contract.facts.filter(f => shotEvidenceIds(shot).includes(f.id));
    if (spec.shot_intent === 'insert' && !visiblePropEvidence(doc, selected).length) throw new FactWorkflowError(`特写缺少可见道具证据: ${scene.id}`);
    const sceneVisual = contract.facts.filter(f => f.scene_id === scene.id && f.kind === 'visual');
    const expectedNames = [...new Set(selected.flatMap(f => boundVisibleEntities(f.binding).map(e => e.name)))].sort();
    if (hash([...(spec.visible_subjects || [])].sort()) !== hash(expectedNames)) throw new FactWorkflowError('镜头人物字段与已确认入镜绑定不符');
    if ((spec.key_props || []).some((name: string) => !doc.props.some(prop => scene.propIds.includes(prop.id) && prop.name === name) || !selected.some(f => f.text.includes(name)))) throw new FactWorkflowError('镜头道具字段缺少资产或原文证据');
    if (shot.shot_type !== spec.shot_type) throw new FactWorkflowError('景别字段与镜头契约不一致');
    if (shot.negative_prompt !== compileNegativePrompt({ ...spec, visual_prompt: shot.visual_prompt, identity_mode: 'auto' })) throw new FactWorkflowError('负面提示词与程序编译的事实约束不一致');
    const held = shot.hold_fact_ids || [];
    if (held.length) {
      const preceding = payload.shots.slice(0, payload.shots.indexOf(shot)).filter(s => s.script_scene_id === scene.id && s.fact_ids?.length).at(-1);
      if (shot.fact_ids?.length || hash(held) !== hash(preceding?.fact_ids)) throw new FactWorkflowError('保持画面必须沿用本场前一个完整画面事实');
    }
    if (selected.some(f => f.scene_id !== scene.id || f.kind !== 'visual') || selected.length !== shotEvidenceIds(shot).length) throw new FactWorkflowError('画面含未知或跨场事实');
    if (hash(spec.visual_facts || []) !== hash(selected)) throw new FactWorkflowError('镜头契约与事实列表不一致');
    const primary = contract.facts.find(f => f.id === (shot.primary_fact_id || held[0]));
    // packShotSpec trims the stored action. A source newline is not a different action.
    if (spec.primary_action !== (primary?.text || declaredLocation).trim()) throw new FactWorkflowError('主动作与可追溯事实不符');
    if (shot.duration + 0.01 < scene.blocks.filter(b => shot.block_ids.includes(b.id)).reduce((n, b) => n + audioSeconds(b), 0)) throw new FactWorkflowError('镜头语音超过已分配时长');
    const audioFacts = contract.facts.filter(f => shot.audio_fact_ids?.includes(f.id));
    if (audioFacts.length !== (shot.audio_fact_ids || []).length || audioFacts.some(f => f.scene_id !== scene.id || f.kind !== 'audio')) throw new FactWorkflowError('声音含未知或跨场事实');
    if (hash(spec.speech_facts || []) !== hash(audioFacts.map(f => f.text))) throw new FactWorkflowError('镜头声音事实与契约不一致');
    const visualBlocks = new Set([...selected, ...audioFacts].map(f => f.block_id));
    const ownedActions = shot.block_ids.filter(id => doc.scenes[index]!.blocks.find(b => b.id === id)?.type === 'action');
    if (ownedActions.length !== visualBlocks.size || ownedActions.some(id => !visualBlocks.has(id))) throw new FactWorkflowError('事实与动作来源块不一致');
  }
  for (const budget of contract.budgets) {
    const shots = payload.shots.filter(s => s.script_scene_id === budget.scene_id);
    validatePlan(contract.facts.filter(f => f.scene_id === budget.scene_id), shots.map(s => ({ fact_ids: s.fact_ids || [], primary_fact_id: s.primary_fact_id || null })), budget.minimum);
    if (shots.some(s => s.duration > MAX_SHOT_SECONDS) || Math.abs(shots.reduce((n, s) => n + s.duration, 0) - budget.duration) > 0.01) throw new FactWorkflowError('镜头时长与分场预算不符');
    const assigned = shots.flatMap(s => s.audio_fact_ids || []);
    const requiredAudio = contract.facts.filter(f => f.scene_id === budget.scene_id && f.kind === 'audio').map(f => f.id);
    if (hash(assigned) !== hash(requiredAudio)) throw new FactWorkflowError('声音事实遗漏、重复或乱序');
  }
  if (payload.scope) {
    if (payload.shots.some(shot => !JSON.parse(shot.shot_spec).source?.continuity?.reference || shot.script_scene_id !== payload.scope!.target_scene_id)) throw new FactWorkflowError('单场候选缺少已确认时刻引用');
    return;
  }
  let state: State[] = [];
  for (const scene of doc.scenes) {
    let shotState = continuityForScene(state, doc, contract.facts, scene.id);
    for (const shot of payload.shots.filter(s => s.script_scene_id === scene.id)) {
      const selected = contract.facts.filter(f => shotEvidenceIds(shot).includes(f.id));
      const stored = JSON.parse(shot.shot_spec);
      const visible = stored.visible_subjects || [];
      shotState = continuityAfter(shotState, selected);
      if (hash(stored.continuity_states || []) !== hash(inheritedStates(shotState, selected, visible, String(stored.location || '')))) throw new FactWorkflowError('镜头连续状态缺失或与来源依赖不符');
    }
    state = continuityAfter(state, contract.facts.filter(f => f.scene_id === scene.id));
  }
}

export type WorkflowProgress = {
  attempt?: number;
  request?: { request_key: string; expected_revision: number; instructions: string; force_regenerate?: boolean };
  input_hash: string; phase: string; scene_id?: string; shot_index?: number; error?: string;
  candidate_id?: string;
  extracted: Record<string, VisualFact[]>;
  plans: Record<string, FactPlan>;
  shots: Record<string, StoryboardCandidateShot>;
  facts?: VisualFact[];
  metrics: Array<{ stage: string; elapsed_ms: number; attempts: number }>;
  state_checks?: Record<string, boolean>;
  state_review_pending?: string[];
  inference_budget?: WorkflowInferenceBudget;
  repaired_phase_started?: boolean;
};
export const stateCheckKey = (fact: VisualFact) => hash([FACT_POLICY_VERSION, fact.id, fact.text, fact.kind, fact.beat, fact.binding]);
let queue: Promise<unknown> = Promise.resolve();
const active = new Map<string, Promise<unknown>>();
export function serialWorkflow<T>(id: string, work: () => Promise<T>): Promise<T> {
  const existing = active.get(id);
  if (existing) return existing as Promise<T>;
  const task = queue.then(work);
  queue = task.catch(() => undefined);
  active.set(id, task);
  void task.finally(() => active.delete(id)).catch(() => undefined);
  return task;
}

export async function runFactWorkflow(input: {
  doc: ScriptDocument; scriptId: number; revision: number; provider: AIProvider;
  model: string; locks: CharacterLockRef[]; glossary: Record<string, string>; instructions: string;
  characters?: Array<{ id: number; name: string }>;
  inferenceModel?: string;
  reuse?: InferenceReuseOptions;
  continuity_scope?: ContinuityWorkflowScope;
  progress: WorkflowProgress; persist: () => Promise<void>;
}): Promise<{ contract: StoryboardFactContract; shots: StoryboardCandidateShot[] }> {
  const { doc, progress: p, persist } = input;
  if (input.continuity_scope && (doc.scenes.length !== 1 || doc.scenes[0]!.id !== input.continuity_scope.target_scene_id)) throw new FactWorkflowError('单场工作流不能包含其他分场', 409);
  const inferenceBudget = p.inference_budget ||= newWorkflowInferenceBudget();
  for (const call of inferenceBudget.calls) if (call.attempt_state === 'reserved') call.attempt_state = 'interrupted_unknown';
  let activeStage = '', activeKind: 'initial' | 'semantic_repair' = 'initial';
  const provider = workflowBudgetProvider(input.provider, inferenceBudget, persist, () => activeStage, () => activeKind);
  const consumeRepair = async () => {
    if (inferenceBudget.semantic_repairs >= 1) return false;
    inferenceBudget.semantic_repairs++;
    activeKind = 'semantic_repair';
    await persist();
    return true;
  };
  const recordBatch = (stage: string, items: unknown[], reason: 'initial' | 'repair_split' = 'initial') => {
    const input_hash = hash(items);
    if (!inferenceBudget.batches.some(batch => batch.stage === stage && batch.input_hash === input_hash && batch.reason === reason)) inferenceBudget.batches.push({ stage, input_hash, items: items.length, reason });
  };
  const request = async <T>(stage: string, work: (repair: string) => Promise<T>, dependencies?: unknown): Promise<T> => {
    const start = Date.now();
    let error = '';
    const infer = () => withLocalTextInference(async () => {
      activeStage = stage; activeKind = 'initial';
      if (stage.startsWith('repair:')) {
        activeKind = 'semantic_repair';
        if (!p.repaired_phase_started) {
          if (!await consumeRepair()) {
            p.phase = 'needs_review'; await persist();
            throw new FactWorkflowError('事实待核对：逻辑任务的语义修复预算已用尽');
          }
          p.repaired_phase_started = true;
          await persist();
        }
      }
      let attempts = 0;
      while (true) {
        attempts++;
        try {
          const value = await work(error);
          p.metrics.push({ stage, elapsed_ms: Date.now() - start, attempts });
          return value;
        } catch (e: any) {
          error = e?.message || String(e);
          const terminalReview = error.startsWith('连续状态待核对:');
          const cannotRepair = terminalReview || (stage.startsWith('repair:') ? attempts >= 2 : !await consumeRepair());
          if (e instanceof WorkflowTransportError || /超过.*预算|超出.*预算|超预算/.test(error) || cannotRepair) {
            p.phase = 'needs_review'; p.error = error;
            p.metrics.push({ stage, elapsed_ms: Date.now() - start, attempts });
            await persist();
            throw e;
          }
        }
      }
    });
    return await stepCache.run({ stage, scriptId: input.scriptId,
      dependencies: dependencies ?? [doc, input.characters, input.locks, input.glossary, input.instructions],
      model: input.inferenceModel || input.model, configuredModel: textModelFingerprint(), continuity_source: input.continuity_scope ? [input.continuity_scope.snapshot.source_hash,input.continuity_scope.bindings] : undefined,
    }, `${FACT_POLICY_VERSION}:verified-workflow-step-v8-units-cohesion`, infer, input.reuse) as T;
  };
  p.phase = 'facts';
  await persist();
  for (const scene of doc.scenes) {
    p.scene_id = scene.id;
    // Batch complete source sentences across blocks. Never ask for a JSON continuation.
    const units = scene.blocks.filter(b => b.type === 'action').flatMap(block => {
      const matches = [...block.text.matchAll(/[^，,；;。！？\n]+[，,；;。！？\n]*|[，,；;。！？\n]+/gu)];
      return matches.filter(m => !punctuationOnly(m[0])).map(m => ({ id: `u_${hash([block.id, m.index!]).slice(0, 10)}`, block_id: block.id, start: m.index!, text: m[0] }));
    });
    const batches: Array<typeof units> = [];
    for (const unit of units) {
      if (unit.text.length > 900) throw new FactWorkflowError(`分场 ${scene.id} 来源片段超过输入预算，需按完整叙事节拍核对: ${unit.block_id}@${unit.start}`);
      if (!batches.length || batches.at(-1)!.length >= 6 || batches.at(-1)!.reduce((n, u) => n + u.text.length, 0) + unit.text.length > 900) batches.push([]);
      batches.at(-1)!.push(unit);
    }
    for (const batch of batches) {
      const key = hash([scene.id, batch]);
      if (p.extracted[key]) continue;
      recordBatch(`facts:${scene.id}`, batch);
      p.extracted[key] = await request(`facts:${scene.id}:${batch[0]!.id}`, async repair => {
        const prior = Object.values(p.extracted).flat().filter(f => f.scene_id === scene.id && f.kind === 'visual');
        const ids = batch.map(u => u.id) as [string, ...string[]];
        const classified = await provider.generateStructured(JSON.stringify({ task: 'classify', sources: batch.map(u => ({ id: u.id, text: u.text })), repair }), z.object({ items: z.array(z.object({ id: z.enum(ids), kind: FactKindSchema })) }),
          FACT_CLASSIFY_INSTRUCTION, { temperature: 0.1, maxTokens: 384 });
        if (classified.items.length !== batch.length || new Set(classified.items.map(i => i.id)).size !== batch.length) throw new FactWorkflowError('分类结果缺项或重复');
        let lastVisualBeat = prior.length ? prior.at(-1)!.beat : -1;
        let previousText = prior.at(-1)?.text || '';
        const blockBeat = new Map<string, number>();
        for (const fact of Object.values(p.extracted).flat().filter(f => f.scene_id === scene.id)) {
          blockBeat.set(fact.block_id, Math.max(blockBeat.get(fact.block_id) ?? -1, fact.beat));
        }
        const assigned = new Map<string, Array<{ text: string; beat: number; kind: z.infer<typeof FactKindSchema> }>>();
        const place = (source: typeof batch[number], beat: number, kind: z.infer<typeof FactKindSchema>, text = source.text) => {
          const safe = Math.max(beat, blockBeat.get(source.block_id) ?? -1);
          blockBeat.set(source.block_id, safe);
          const parts = assigned.get(source.id) ?? [];
          parts.push({ text, beat: safe, kind });
          assigned.set(source.id, parts);
          return safe;
        };
        for (const source of batch) {
          let kind = classified.items.find(i => i.id === source.id)!.kind;
          if (kind === 'visual') {
            const atomic = await provider.generateStructured(JSON.stringify({ task: 'atomicity', source: source.text, repair }), z.object({ result: z.enum(['one_frame', 'sequence', 'uncertain']) }),
              'Can ALL visible details in this clause coexist in ONE still image? one_frame = compatible appearance, environment, lighting, clothing, objects, posture, emotional reaction, or a single action at one moment (e.g. ambient states like "天光发粉", postures like "坐在玉阶上", reactions/states like "却终究克制不住", "神色凝重", transitive/prepositional actions like "将某人圈入怀中", "从身后抱住某人"). sequence = two or more distinct successive physical actions by characters requiring separate keyframes (e.g. "先坐下然后站起", "打开门并走到屋外"). uncertain = cannot decide. A single clause with only one action or emotional reaction is always one_frame, never sequence. Only distinct successive actions by characters can be sequence. Classify only, do not rewrite. 只返回 JSON，顶层键名必须是 result。', { temperature: 0.1, maxTokens: 48 });
            if (atomic.result === 'uncertain' || source.text.length > 240) {
              classified.items.find(i => i.id === source.id)!.kind = 'uncertain';
              place(source, lastVisualBeat >= 0 ? lastVisualBeat : 0, 'uncertain');
              continue;
            }
            if (atomic.result === 'sequence') {
              const split = await provider.generateStructured(JSON.stringify({ task: 'split_actions', source: source.text, repair }), z.object({ spans: z.array(z.object({ text: z.string().min(1) })).min(1) }),
                'The sentence was already judged to be successive actions. Return at least two spans. Every span must be a complete predicate or action clause, never cut across prepositions (do not end a span with 把, 将, 从, 向, 朝, 被, 在, 往). Every span must be a verbatim contiguous quote, and joining the spans in order must reproduce the source with no added, dropped, or rewritten characters. Do not return the whole sentence as one span. A one-span reply does not change the sequence judgment.', { temperature: 0.1, maxTokens: 256 });
              const quotes = verbatimActionSplit(source.text, split.spans.map(span => span.text));
              if (!quotes) throw new FactWorkflowError(`连续动作未能拆成可核对的原文片段: ${source.text}`);
              let beat = lastVisualBeat < 0 ? 0 : lastVisualBeat + 1;
              for (const text of quotes) {
                beat = place(source, beat, 'visual', text);
                lastVisualBeat = beat;
                beat += 1;
              }
              previousText = quotes.at(-1)!;
              continue;
            }
            const priorUnits = units.slice(0, units.findIndex(u => u.id === source.id));
            const previousUnit = priorUnits.slice().reverse().find(u => u.text === previousText);
            const inSameSentence = previousUnit && previousUnit.block_id === source.block_id && !/[。！？\n]\s*$/u.test(previousText);
            const hasSequentialConjunction = /^(?:随后|然后|接着|之后|继而|立刻|旋即|忽地|突然)/u.test(source.text.trim());
            const result = inSameSentence && !hasSequentialConjunction ? { relation: 'simultaneous' as const } : previousText ? await provider.generateStructured(JSON.stringify({ task: 'beat_relation', previous: previousText, current: source.text, repair }), z.object({ relation: z.enum(['simultaneous', 'sequential', 'uncertain']) }),
              'Classify temporal relation only. simultaneous: current adds an explicitly compatible visible state at the SAME moment as previous (such as clothing state, posture, facial expression, gaze, breathing, touch, or actions occurring together). sequential: a new action, state transition or later moment needs a separate keyframe. uncertain: either reading is possible. Never assume independent actions are simultaneous just because adjacent. Return relation only. 只返回 JSON，顶层键名必须是 relation。', { temperature: 0.1, maxTokens: 64 }) : { relation: 'sequential' as const };
            if (result.relation === 'uncertain') {
              classified.items.find(i => i.id === source.id)!.kind = 'uncertain';
              place(source, lastVisualBeat >= 0 ? lastVisualBeat : 0, 'uncertain');
              continue;
            }
            const beat = result.relation === 'simultaneous' && lastVisualBeat >= 0 ? lastVisualBeat : (lastVisualBeat < 0 ? 0 : lastVisualBeat + 1);
            lastVisualBeat = place(source, beat, 'visual');
            previousText = source.text;
            continue;
          }
          place(source, lastVisualBeat >= 0 ? lastVisualBeat : 0, kind);
        }
        const facts = batch.flatMap(unit => {
          const parts = assigned.get(unit.id)!;
          return anchorSpans(scene.id, unit.block_id, unit.text, { spans: parts.map(span => ({ text: span.text, beat: span.beat, kind: span.kind, states: [] })) }, unit.start);
        });
        if (facts.some(f => f.kind === 'visual' && f.beat < (prior.at(-1)?.beat ?? 0))) throw new FactWorkflowError('分场节拍编号不能倒退');
        return facts;
      }, [scene.id, batch, Object.values(p.extracted).flat().filter(f => f.scene_id === scene.id).map(f => ({ id: f.id, block_id: f.block_id, text: f.text, kind: f.kind, beat: f.beat }))]);
      await persist();
    }
  }
  const sortFacts = (list: VisualFact[]): VisualFact[] => {
    const sceneIdx = new Map(doc.scenes.map((s, i) => [s.id, i]));
    const blockIdx = new Map(doc.scenes.flatMap(s => s.blocks.map((b, i) => [b.id, i])));
    return list.slice().sort((a, b) => {
      const sDiff = (sceneIdx.get(a.scene_id) ?? 0) - (sceneIdx.get(b.scene_id) ?? 0);
      if (sDiff !== 0) return sDiff;
      const bDiff = (blockIdx.get(a.block_id) ?? 0) - (blockIdx.get(b.block_id) ?? 0);
      if (bDiff !== 0) return bDiff;
      return (a.start ?? 0) - (b.start ?? 0);
    });
  };
  let facts = sortFacts(Object.values(p.extracted).flat());
  let merged = false;
  for (const batch of Object.values(p.extracted)) {
    const groups = groupAdjacentClauseFragments(batch);
    if (groups.every(group => group.length === 1)) continue;
    const next = groups.map(group => {
      if (group.length === 1) return batch[group[0]!]!;
      const items = group.map(index => batch[index]!);
      const text = items.map(item => item.text).join('');
      const kinds = new Set(items.map(item => item.kind));
      const kind = kinds.size === 1 ? items[0]!.kind : 'uncertain';
      return anchorSpans(items[0]!.scene_id, items[0]!.block_id, text, { spans: [{ text, kind, beat: items[0]!.beat, states: [] }] }, items[0]!.start)[0]!;
    });
    batch.splice(0, batch.length, ...next);
    merged = true;
  }
  if (merged) facts = sortFacts(Object.values(p.extracted).flat());
  stabilizeFactBeats(facts);
  p.facts = facts;
  await persist();
  for (const fact of facts.filter(item => item.kind === 'mixed' || item.kind === 'uncertain')) {
    const replaced = await request(`repair:${fact.id}`, async repair => {
      const schema = z.object({ spans: z.array(z.object({ text: z.string().min(1), kind: z.enum(['visual', 'audio', 'internal', 'figurative']) })).min(1) });
      const canSplit = /[，,；;。！？!?、：:—–—~～…”’」』"']/u.test(fact.text.slice(0, -1)) || /(?:然后|随后|接着|之后|继而|并(?![列排拢肩非且得]))/u.test(fact.text);
      const instruction = canSplit
        ? 'Repair one stored fact so a person does not have to edit it. If it mixes a visible action with speech, a thought, a sound, or a metaphor, return source-exact spans cut only after punctuation (such as ，、：——) or before 然后、随后、接着、之后、继而 or 并. A speech act such as 说、问、答、应 is audio. A visible reaction in the same sentence stays visual. A cut inside a clause is invalid. Otherwise return one span whose text equals the source. Joining the spans in order must reproduce the source verbatim with no added, dropped, or rewritten characters or punctuation. kind is only visual, audio, internal, or figurative. Return spans with text and kind only.'
        : 'This fact is a single clause with no internal punctuation or conjunctions; it cannot be split. Return exactly ONE span whose text equals the source verbatim, and classify kind as visual, audio, internal, or figurative. Do NOT add, drop, or alter any characters or punctuation.';
      const result = await provider.generateStructured(JSON.stringify({ task: 'repair_fact', text: fact.text, kind: fact.kind, repair }), schema,
        instruction, { temperature: 0.1, maxTokens: 384 });
      const spans = alignSpansToSource(fact.text, result.spans);
      if (!spans) throw new FactWorkflowError(`连续动作未能拆成可核对的原文片段: ${fact.text}`);
      try {
        let valid = spans.length > 0;
        for (let index = 0; index < spans.length - 1; index++) {
          if (!clauseBoundaryBetween(spans[index]!.text, spans[index + 1]!.text)) {
            valid = false;
            break;
          }
        }
        if (!valid) throw new FactWorkflowError(`分句边界不符: ${fact.text}`);
        return anchorSpans(fact.scene_id, fact.block_id, fact.text, { spans: spans.map(span => ({ ...span, beat: fact.beat, states: [] as [] })) }, fact.start);
      } catch (error) { throw error; }
    }, [fact.id, fact.text, fact.kind, fact.beat, fact.start, fact.scene_id, fact.block_id]);
    for (const batch of Object.values(p.extracted)) {
      const index = batch.findIndex(item => item.id === fact.id);
      if (index >= 0) batch.splice(index, 1, ...replaced);
    }
    await persist();
  }
  facts = sortFacts(Object.values(p.extracted).flat());
  stabilizeFactBeats(facts);
  p.facts = facts;
  await persist();
  const roster = entityRoster(input.characters || []);
  for (const scene of doc.scenes) {
    for (const fact of facts.filter(f => f.scene_id === scene.id && f.kind === 'visual')) {
      const block = scene.blocks.find(b => b.id === fact.block_id)!;
      const { automatic, context } = actionBindingSource(doc, scene.id, block.id, roster, fact.start, fact.end);
      if (fact.binding?.text_hash === automatic.text_hash && fact.binding.context_hash === automatic.context_hash) { validateBinding(fact.binding, fact.text, roster); continue; }
      fact.binding = automatic;
      const blockSource = actionBindingSource(doc, scene.id, block.id, roster);
      if (block.type === 'action' && block.binding?.text_hash === textHash(block.text) && block.binding.context_hash === blockSource.automatic.context_hash) {
        validateBinding(block.binding, block.text, roster);
        const supplied = block.binding.mentions.filter(m => m.start >= fact.start && m.end <= fact.end).map(m => ({ ...m, start: m.start - fact.start, end: m.end - fact.start }));
        if (supplied.length) fact.binding.mentions = supplied;
      }
      if (needsBindingReview(fact.binding)) fact.binding = await request(`binding:${fact.id}`, () => proposeBindings(provider, fact.binding!, fact.text, context, roster, { location: doc.locations.find(l => l.id === scene.locationId)?.name || scene.locationId, ...sceneContext(doc, scene) }));
      await persist();
    }
  }
  const pendingBindings = facts.filter(f => f.kind === 'visual' && needsBindingReview(f.binding));
  if (pendingBindings.length) { p.phase = 'needs_review'; await persist(); throw new FactWorkflowError(`人物绑定待核对: ${pendingBindings.map(f => `${f.scene_id}/${f.id}: ${f.text}`).join('；')}`); }
  p.state_checks ||= {};
  for (const scene of input.continuity_scope ? [] : doc.scenes) {
    const visual = facts.filter(f => f.scene_id === scene.id && f.kind === 'visual');
    for (let offset = 0; offset < visual.length; offset++) {
      const group = visual.slice(offset, offset + 1);
      const key = stateCheckKey(group[0]!);
      if (p.state_checks[key]) continue;
      const states = await request(`state:${scene.id}:${offset}`, async repair => {
        const source = group[0]!;
        const block = scene.blocks.find(item => item.id === source.block_id);
        const context = block ? block.text.slice(0, source.start) : '';
        if (source.text.length > 1800 || context.length + JSON.stringify(source.binding || {}).length > 2200) throw new FactWorkflowError('完整状态来源或绑定前文超过输入预算，需人工核对');
        const cast = (input.characters || []).map(item => item.name).filter(Boolean);
        const entities = [...new Set([
          ...boundVisibleEntities(source.binding).map(e => e.name),
          ...doc.props.map(prop => prop.name).filter(name => source.text.includes(name)),
        ])];
        // Background facts stay intact for translation. Don't force the local
        // model to classify an undeclared door/window as a person's presence.
        if (!entities.length) return [];
        const allowedAttributes = new Set<string>(FACT_STATE_ATTRIBUTES);
        const schema = z.object({ states: z.array(z.object({ entity: z.string().min(1), attribute: z.string().min(1), value: z.string().min(1), item: z.string().optional(), operation: z.string().optional() })) });
        const ask = async (note: string) => provider.generateStructured(JSON.stringify({ task: 'state', facts: group.map(f => ({ id: f.id, text: f.text })), context, entities, binding: source.binding, repair: note }), schema,
          'Read this one fact. context is earlier text in the same action block; binding fixes the person this fact is about. Extract explicit states. presence = entry or exit. wardrobe = a garment, not a body part. holding = an external prop, not a body part and not a touch without an object. position = a place, not a posture. pose = sitting, lying, kneeling, or another posture. body = a body condition such as bare feet or an uncovered body. expression = face, blush, or gaze, and it is not carried to later shots. pending_action = an unfinished action. item quotes the garment, prop, body part, or posture from this fact when the attribute uses one. operation is set, or remove only for an explicitly completed removal or release. value MUST be an exact contiguous substring of this fact (NOT from context). If this fact states none of these, return states:[]. entity MUST be in entities when supplied, consistent with binding and explicit ownership. An earlier mentioned person is not ownership evidence. Do not paraphrase or write 无, none or English. Absent attributes are omitted. Return states with entity, attribute, value, item and operation where applicable; states:[] if none is explicit.', { temperature: 0.1, maxTokens: 320 });
        const itemAttributes = new Set(['wardrobe', 'holding', 'body', 'expression', 'pose']);
        const cleanStates = (rows: Array<{ entity: string; attribute: string; value: string; item?: string; operation?: string }>): Array<{ entity: string; attribute: string; value: string; item?: string; operation?: 'set' | 'remove' }> => rows
          .map(s => {
            const normalizedOp: 'set' | 'remove' | undefined = (s.operation === 'set' || s.operation === 'remove') ? s.operation : undefined;
            const { operation: _operation, item, ...rest } = s;
            return {
              ...rest,
              ...(itemAttributes.has(s.attribute) && item !== undefined ? { item } : {}),
              ...(normalizedOp !== undefined ? { operation: normalizedOp } : {}),
            };
          })
          .filter(s => {
            if (!entities.includes(s.entity) || !allowedAttributes.has(s.attribute)) return false;
            if (!s.value) return false;
            // A quoted item that is not in this sentence stays for evidence review.
            // Dropping it would turn an invented prop into an empty, accepted state.
            if (s.attribute === 'holding' && (cast.includes(s.value) || (s.item && cast.includes(s.item)))) return false;
            if (s.attribute === 'presence' && !/进|入|出|来|走|离|退|去|现/u.test(s.value)) return false;
            return true;
          });
        let statesCleaned: ReturnType<typeof cleanStates>;
        try {
          statesCleaned = await reviewExtractedStates(source.text, async (note) => cleanStates((await ask(note ? `${repair} ${note}`.trim() : repair)).states), (state) => stateCategoryConflict(state.attribute, state.value, state.item || ''));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith('连续状态待核对:')) throw new FactWorkflowError(message);
          throw error;
        }
        const owners = boundVisibleEntities(source.binding).map(e => e.name);
        let evidence = evidencedContinuityStates(source.text, statesCleaned, context, owners);
        if (evidence.rejected.length) {
          const note = continuityEvidenceRepair(source.text, evidence.rejected, context);
          try {
            const retried = cleanStates((await ask(note)).states);
            const retriedEvidence = evidencedContinuityStates(source.text, retried, context, owners);
            if (!retriedEvidence.rejected.length) {
              statesCleaned = retried;
              evidence = retriedEvidence;
            }
          } catch {}
        }
        if (evidence.rejected.length) {
          source.states = statesCleaned; p.state_review_pending = [...new Set([...(p.state_review_pending || []), source.id])]; p.phase = 'needs_review'; await persist(); throw new FactWorkflowError(`连续状态归属待核对: ${source.text} ${continuityEvidenceRepair(source.text, evidence.rejected, context)}`);
        }
        return evidence.accepted.map(state => ({ ...state, fact_id: source.id }));
      }, [group, scene.blocks.find(block => block.id === group[0]!.block_id)?.text, doc.props, input.characters]);
      for (const entry of Object.values(p.extracted)) for (const fact of entry.filter(f => group.some(g => g.id === f.id))) {
        fact.states = states.filter(s => s.fact_id === fact.id).map(({ fact_id, ...state }) => state);
      }
      p.state_checks[key] = true;
      p.state_review_pending = p.state_review_pending?.filter(id => !group.some(fact => fact.id === id));
      await persist();
    }
  }
  facts = sortFacts(Object.values(p.extracted).flat());
  if (input.continuity_scope) facts.forEach(fact => { fact.states = []; });
  p.facts = facts;
  validateFactSources(doc, facts);
  const unresolved = facts.filter(f => f.kind === 'mixed' || f.kind === 'uncertain');
  if (unresolved.length) { p.phase = 'needs_review'; await persist(); throw new FactWorkflowError(`待核对事实: ${unresolved.map(f => `${f.scene_id}/${f.id}: ${f.text}`).join('；')}`); }
  const budgets = allocateBudgets(doc, facts, CHAPTER_SHOT_LIMIT);
  const contract: StoryboardFactContract = { version: 3, policy: FACT_POLICY_VERSION, source_hash: factSourceHash(doc, facts, roster), facts, entities: roster, budgets };

  // Freeze chapter composition BEFORE translating. Insert only where a prop is declared.
  const slots = budgets.flatMap(b => {
    const visual = facts.filter(f => f.scene_id === b.scene_id && f.kind === 'visual');
    const beats = [...new Set(visual.map(f => f.beat))];
    return Array.from({ length: b.minimum }, (_, index) => ({ scene_id: b.scene_id, beat: beats[index], shot_intent: 'medium-action', shot_type: 'Medium Shot' }));
  });
  const wideCount = Math.ceil(slots.length * 0.35);
  const visibleProps = visiblePropEvidence(doc, facts);
  const insertIndex = slots.length >= 5 ? slots.findIndex(s => visibleProps.some(prop => prop.scene_id === s.scene_id && prop.beats.includes(s.beat!))) : -1;
  let wide = 0;
  for (let i = 0; i < slots.length; i++) {
    const intent = i === insertIndex ? 'insert' : wide < wideCount ? (wide++ === 0 ? 'establish' : 'wide-action') : i % 2 ? 'payoff' : 'medium-action';
    slots[i]!.shot_intent = intent;
    slots[i]!.shot_type = ({ insert: 'Insert Shot', establish: 'Extreme Long Shot', 'wide-action': 'Wide Shot', payoff: 'Long Shot', 'medium-action': 'Medium Shot' })[intent]!;
  }
  const quota = findChapterShotQuotaViolation(slots, { hasKeyProps: visibleProps.length > 0 });
  if (quota) throw new FactWorkflowError(`景别预算冲突: ${quota.detail}`);
  let state: State[] = [];
  const allShots: StoryboardCandidateShot[] = [];
  for (const [sceneIndex, scene] of doc.scenes.entries()) {
    p.phase = 'planning'; p.scene_id = scene.id;
    const sceneFacts = facts.filter(f => f.scene_id === scene.id);
    const budget = budgets[sceneIndex]!;
    const sceneSlots = slots.filter(s => s.scene_id === scene.id);
    const relevantState = input.continuity_scope ? [] : continuityForScene(state, doc, facts, scene.id);
    if (JSON.stringify(relevantState).length > 2000) throw new FactWorkflowError(`连续性状态超出输入预算: ${scene.id}，需要核对压缩`);
    const dependency = hash([FACT_POLICY_VERSION, scene, sceneFacts, relevantState, sceneSlots, input.glossary, input.instructions,
      ...(input.continuity_scope ? [input.continuity_scope.snapshot.source_hash,input.continuity_scope.bindings] : [])]);
    await persist();
    const visual = sceneFacts.filter(f => f.kind === 'visual');
    const groups = visualPlanGroups(visual);
    if (!groups.length) groups.push([]);
    const shotCounts = groupShotCounts(groups, budget.minimum);
    const plan: FactPlan = [];
    let groupState = relevantState;
    for (const [groupIndex, groupFacts] of groups.entries()) {
      const groupCount = shotCounts[groupIndex]!;
      const groupSlots = sceneSlots.slice(plan.length, plan.length + groupCount);
      const momentInputs = input.continuity_scope ? (groupFacts.length ? groupFacts.map(fact => continuityReadForFacts(input.continuity_scope!, [fact])) : [continuityReadForFacts(input.continuity_scope, [])]).map(read => ({ story_position: read.story_position, values: read.values.map(cell => ({ entity_id: cell.entity_id, attribute_id: cell.attribute_id, knowledge_status: cell.knowledge_status, value: cell.value })) })) : undefined;
      // Several source facts may read the same verified frame. Share its complete values;
      // keep every fact and its binding, and never truncate a distinct moment to fit.
      const confirmedMoments = momentInputs ? [...new Map(momentInputs.map(moment=>[hash(moment),moment])).values()] : undefined;
      if (confirmedMoments && JSON.stringify(confirmedMoments).length > 2000) throw new FactWorkflowError('已确认时刻超过规划输入预算，需缩小读取范围', 409);
      const groupKey = hash([dependency, groupIndex, groupFacts, groupState, groupSlots]);
      recordBatch(`plan:${scene.id}`, groupFacts);
      if (!p.plans[groupKey]) p.plans[groupKey] = await request(`plan:${scene.id}:${groupIndex + 1}`, async repair => {
      const slotFacts = assignFactSlots(groupFacts, groupCount);
      const choices = Object.fromEntries(slotFacts.map((fs, i) => [`s${i + 1}`, fs.length ? z.enum(fs.map(f => f.id) as [string, ...string[]]) : z.null()]));
      const schema = z.object({ primary_by_slot: z.object(choices).strict() });
      const result = await provider.generateStructured(JSON.stringify({ task: 'plan', scene_id: scene.id, group: groupIndex + 1, facts: groupFacts, slots: groupSlots.map((slot, i) => ({ ...slot, id: `s${i + 1}`, fact_ids: slotFacts[i]!.map(f => f.id) })), continuity: groupState, confirmed_moments: confirmedMoments, character_ids: scene.characterIds, location_id: scene.locationId, prop_ids: scene.propIds, instructions: input.instructions, repair }), schema,
        'Select only ONE primary fact ID per slot from that slot fact_ids. Program has fixed complete source coverage and beat order. Do not move, merge or omit facts. Empty slot => null. Return primary_by_slot with EVERY supplied slot ID. No other fields.', { temperature: 0.1, maxTokens: 384 });
      const selected = slotFacts.map((fs, i) => ({ fact_ids: fs.map(f => f.id), primary_fact_id: result.primary_by_slot[`s${i + 1}`] as string | null }));
      validatePlan(groupFacts, selected, groupCount);
      return selected;
      }, [groupKey]);
      plan.push(...p.plans[groupKey]!);
      groupState = continuityAfter(groupState, groupFacts);
      await persist();
    }
    validatePlan(sceneFacts, plan, budget.minimum);
    await persist();
    const audio = scene.blocks.filter(b => b.type !== 'action');
    const buckets = plan.map(() => [] as typeof audio);
    const soundLoads = plan.map(() => 0);
    const audioFacts = plan.map(() => [] as VisualFact[]);
    for (const fact of sceneFacts.filter(f => f.kind === 'audio')) {
      const sourcePosition = facts.indexOf(fact);
      let target = 0;
      plan.forEach((shot, index) => { if (sceneFacts.some(f => shot.fact_ids.includes(f.id) && facts.indexOf(f) <= sourcePosition)) target = index; });
      audioFacts[target]!.push(fact);
    }
    let lastAudioSlot = 0;
    // Keep lines in script order. A later line can use an earlier shot in this scene when the last pictured shot is already full.
    for (const block of audio) {
      const sourceIndex = scene.blocks.indexOf(block);
      const seconds = audioSeconds(block);
      let target = -1;
      plan.forEach((shot, i) => {
        if (target >= 0 || i < lastAudioSlot) return;
        const positions = sceneFacts.filter(f => shot.fact_ids.includes(f.id)).map(f => scene.blocks.findIndex(b => b.id === f.block_id));
        if (positions.length && Math.min(...positions) <= sourceIndex) target = i;
      });
      if (target < 0) target = lastAudioSlot;
      while (target < plan.length && soundLoads[target]! + seconds > MAX_SHOT_SECONDS) target++;
      if (target >= plan.length) throw new FactWorkflowError(`有声对齐预算冲突: ${scene.id}/${block.id} 无足够镜头时长，需调整叙事节拍`);
      buckets[target]!.push(block);
      soundLoads[target]! += seconds;
      lastAudioSlot = target;
    }
    const durations = soundLoads.map(seconds => Math.max(seconds, 1));
    let remaining = budget.duration - durations.reduce((n, seconds) => n + seconds, 0);
    if (remaining < -0.001) throw new FactWorkflowError(`有声对齐时长冲突: ${scene.id}`);
    while (remaining > 0.001 && durations.some(seconds => seconds < MAX_SHOT_SECONDS)) {
      const available = durations.map((seconds, index) => ({ seconds, index })).filter(s => s.seconds < MAX_SHOT_SECONDS);
      const share = remaining / available.length;
      for (const slot of available) {
        const add = Math.min(MAX_SHOT_SECONDS - slot.seconds, share);
        durations[slot.index]! += add; remaining -= add;
      }
    }
    if (remaining > 0.001) throw new FactWorkflowError(`分场时长分配失败: ${scene.id}`);
    let shotState = relevantState;
    for (const [index, shot] of plan.entries()) {
      p.phase = 'translating'; p.shot_index = index + 1;
      const shotKey = hash([dependency, index, shot]);
      await persist();
      const preceding = plan.slice(0, index).filter(s => s.fact_ids.length).at(-1);
      const heldIds = shot.fact_ids.length ? [] : preceding?.fact_ids || [];
      const selected = sceneFacts.filter(f => [...shot.fact_ids, ...heldIds].includes(f.id));
      shotState = continuityAfter(shotState, selected);
      if (p.shots[shotKey]) { allShots.push(p.shots[shotKey]!); continue; }
      const names = [...new Set(selected.flatMap(f => boundVisibleEntities(f.binding).map(e => e.name)))];
      if (names.length > 6) throw new FactWorkflowError(`镜头包含 ${names.length} 位项目人物，超过当前契约上限6位，请核对节拍`);
      const continuityRead = input.continuity_scope ? continuityReadForFacts(input.continuity_scope, selected) : null;
      const location = doc.locations.find(l => l.id === scene.locationId)?.name || scene.locationId;
      const inherited = continuityRead?.states ?? inheritedStates(shotState, selected, names, location);
      const primary = sceneFacts.find(f => f.id === shot.primary_fact_id) || selected[0];
      const contextFields = sceneContext(doc, scene);
      const literal = [...selected.map(f => ({ id: f.id, text: boundText(f.text, f.binding) })), ...continuityLiteral(inherited), { id: 'location', text: location }, ...sceneContextFacts(contextFields)];
      const primaryAction = primary?.text || location;
      const quotedLocks = input.locks.filter(l => names.includes(l.name!));
      const permittedLocks = quotedLocks.map(lock => ({ ...lock, lock: scopedWardrobeLock(lock.name!, lock.lock, selected, inherited) })).filter(lock => lock.lock);
      const translated = await request(`translate:${scene.id}:${index + 1}`, async repair => {
        const translations: Array<{ id: string; english: string }> = [];
        const translateFacts = async (batch: Array<{ id: string; text: string }>, repairNote: string) => {
          const batchIds = batch.map(f => f.id);
          const idSchema = batchIds.length ? z.enum(batchIds as [string, ...string[]]) : z.string();
          const translationSchema = z.object({ translations: z.array(z.object({ id: idSchema, english: z.string().min(1) })) });
          const result = await provider.generateStructured(JSON.stringify({ task: 'translate', facts: batch, required_terms: batch.map(f => ({ id: f.id, terms: bodyOwnerTerms(f.text, input.glossary) })).filter(f => f.terms.length), bindings: selected.filter(f => batch.some(row => row.id === f.id)).map(f => ({ id: f.id, mentions: f.binding?.mentions.map(m => ({ text: m.text, entity: m.entity, visibility: m.visibility })) })), glossary: input.glossary, places: doc.locations.map(location => location.name), repair: repairNote }), translationSchema,
            '只翻译 facts 数组的条目，返回条目数量和 ID 必须与 facts 完全相同。bindings 和 glossary 只是对应关系，禁止把它们作为新增事实翻译。places 是剧本地点。朝加地点再加“的方向”表示走向该地，句首的朝是朝向，不是姓，地名必须整词保留。required_terms 是已确定的身体所有者短语，必须原样写进对应条目的 english，不能改成 his/her。把每条编号事实直译为短英文句，保持原意全部内容，不写镜头、风格或技术标签。保留身份、数量、施受关系、颜色、左右、否定和所有连接词后的事实。禁止补人物、环境、道具、情绪。专名只使用项目glossary给出的译名，无译名时音译，所有人物引用都写确定姓名，绝对禁止使用任何第三人称或物主代词（禁止使用 he/she/him/her/his/they/them/their/theirs，禁止写 their immortal powers，写 the immortal powers 或省略代词；禁止写 her/his chest，写 the chest 或确定人名所有格）。未绑定的人物不能新增。english 只能写英文，禁止出现汉字。返回每条相同id及english。', { temperature: 0.1, maxTokens: 512 });
          if (result.translations.length === batch.length && batch.some(f => !result.translations.some(t => t.id === f.id))) {
            result.translations = result.translations.map((t, i) => ({ ...t, id: batch[i]?.id || t.id }));
          }
          const problems: string[] = [];
          if (result.translations.length !== batch.length || new Set(result.translations.map(t => t.id)).size !== result.translations.length || batch.some(f => !result.translations.some(t => t.id === f.id))) problems.push('ID或数量不符');
          for (const fact of batch) {
            const row = result.translations.find(t => t.id === fact.id);
            if (!row) continue;
            if (fact.id === 'interior_exterior' && !/\b(?:indoors?|interior)\b/i.test(row.english)) {
              row.english = fact.text === '室内' ? 'Indoors.' : 'Outdoors.';
            }
            if (fact.id === 'time_of_day' && !/\b(?:day|daytime|night|nighttime|dawn|dusk)\b/i.test(row.english)) {
              const knownTime: Record<string, string> = { '白天': 'Daytime.', '夜间': 'Night.', '黎明': 'Dawn.', '黄昏': 'Dusk.' };
              const mappedTime = knownTime[fact.text];
              if (mappedTime) row.english = mappedTime;
            }
            if (fact.id === 'location' && input.glossary[fact.text] && !row.english.toLowerCase().includes(input.glossary[fact.text]!.toLowerCase())) {
              row.english = input.glossary[fact.text]!;
            }
            if (containsCjk(row.english)) problems.push(`${fact.id} 仍含中文「${row.english}」`);
            const missingTerms = bodyOwnerTerms(fact.text, input.glossary).filter(term => !row.english.toLowerCase().includes(term.toLowerCase()));
            if (missingTerms.length) throw new FactWorkflowError(`译文待核对: ${fact.id} 身体部位归属须原样写出 ${missingTerms.join(', ')}`, 502);
            let referenceProblem = englishReferenceProblem(row.english, input.glossary);
            if (referenceProblem) {
              const sanitized = row.english.replace(/\btheir\b/gi, 'the').replace(/\b(?:her|his)\b(?=\s+[a-z])/gi, 'the');
              if (!englishReferenceProblem(sanitized, input.glossary)) {
                row.english = sanitized;
                referenceProblem = null;
              }
            }
            if (referenceProblem) throw new FactWorkflowError(`译文待核对: ${fact.id} ${referenceProblem}。上次译文「${row.english}」。须改用 facts 中人物的完整译名及其所有格，不能保留 his/her。`, 502);
            const relationProblem = transferTranslationProblem(fact.text, row.english, input.glossary);
            if (relationProblem) throw new FactWorkflowError(`译文待核对: ${fact.id} ${relationProblem}`, 502);
            for (const [name, englishName] of Object.entries(input.glossary)) {
              if (fact.text.includes(name) && !row.english.toLowerCase().includes(englishName.toLowerCase())) problems.push(`${fact.id} 缺少译名 ${englishName}`);
            }
          }
          if (problems.some(problem => problem.includes('缺少译名'))) throw new FactWorkflowError(`项目资产译名未保留: ${problems.join('；')}`, 502);
          if (problems.length) throw new FactWorkflowError(`翻译格式错误: ${problems.join('；')}`, 502);
          return batch.map(f => result.translations.find(t => t.id === f.id)!);
        };
        for (let offset = 0; offset < literal.length;) {
          const batch = literal.slice(offset, offset + (inferenceBudget.translation_batch_size || 4));
          offset += batch.length;
          const directed = batch.filter(fact => directionPlace(fact.text));
          const ordinary = batch.filter(fact => !directionPlace(fact.text));
          for (const fact of directed) {
            recordBatch(activeStage, [fact]);
            let [row] = await translateFacts([fact], repair);
            const problem = row ? directionPlaceProblem(fact.text, row.english) : '朝向地名没有译文';
            if (problem) {
              if (!await consumeRepair()) throw new FactWorkflowError(`译文待核对: ${fact.id} ${problem}`, 502);
              recordBatch(activeStage, [fact], 'repair_split');
              const retried = (await translateFacts([fact], problem))[0];
              const again = retried ? directionPlaceProblem(fact.text, retried.english) : problem;
              if (!retried || again) throw new FactWorkflowError(`译文待核对: ${fact.id} ${again || problem}`, 502);
              row = retried;
            }
            if (row) translations.push(row);
          }
          if (!ordinary.length) continue;
          recordBatch(activeStage, ordinary);
          try {
            translations.push(...await translateFacts(ordinary, repair));
          } catch (error: any) {
            if (error instanceof WorkflowTransportError || batch.length === 1 || !await consumeRepair()) throw error;
            recordBatch(activeStage, batch, 'repair_split');
            for (const fact of batch) translations.push(...await translateFacts([fact], `${repair} ${error?.message || error}`.trim()));
            inferenceBudget.translation_batch_size = 1;
          }
        }
        const context = { visible_names: names, bindings: selected.map(f => f.binding), original_facts: selected.map(f => ({ id: f.id, text: f.text })), locks: permittedLocks, glossary: input.glossary };
        const reviewEnglish = async () => {
          // Each source sentence is audited on its own translation. The still is composed later.
          const failed: string[] = [];
          for (const fact of literal) {
            const english = translations.find(row => row.id === fact.id)?.english || '';
            try {
              await auditFacts(provider, [fact], english, context);
            } catch (error: any) {
              if (!String(error?.message || '').startsWith('译文待核对')) throw error;
              failed.push(fact.id);
            }
          }
          if (failed.length) throw new FactWorkflowError(`译文待核对: ${failed.join(', ')} 存在遗漏、矛盾、新增或不确定性`, 502);
          return { visual_prompt: '' };
        };
        p.phase = 'auditing'; await persist();
        let compiled: { visual_prompt: string };
        try {
          compiled = await reviewEnglish();
        } catch (error: any) {
          if (literal.length === 0 || !String(error?.message || '').startsWith('译文待核对') || !await consumeRepair()) throw error;
          const failed = new Set(String(error.message).slice('译文待核对: '.length).split(' 存在')[0]!.split(',').map(id => id.trim()).filter(Boolean));
          const targets = literal.filter(fact => failed.has(fact.id));
          if (!targets.length) throw error;
          // A quotation followed by another action is one stored fact. The local model drops or
          // contradicts one of the two clauses. Translate the clauses separately, then audit the join.
          const quotedActionTail = (text: string) => {
            const match = /^([\s\S]*?[’'”"])(\s*\p{Script=Han}[\s\S]*)$/u.exec(text);
            return match ? [match[1]!, match[2]!.trim()] as const : null;
          };
          for (const fact of targets) {
            const parts = quotedActionTail(fact.text);
            let english = '';
            if (parts) {
              recordBatch(activeStage, parts.map(text => ({ id: fact.id, text })), 'repair_split');
              const partRepair = (_text: string) => repair;
              const head = (await translateFacts([{ ...fact, text: parts[0]! }], partRepair(parts[0]!)))[0];
              const tail = (await translateFacts([{ ...fact, text: parts[1]! }], partRepair(parts[1]!)))[0];
              english = `${head?.english || ''} ${tail?.english || ''}`.replace(/\s+/g, ' ').trim();
            }
            if (!english) {
              const next = (await translateFacts([fact], `${repair} ${error.message}`.trim()))[0];
              english = next?.english || '';
            }
            if (!english) throw error;
            const row = { id: fact.id, english };
            const index = translations.findIndex(item => item.id === fact.id);
            if (index >= 0) translations[index] = row;
            else translations.push(row);
          }
          compiled = await reviewEnglish();
        }
        return compiled;
      }, [literal, selected.map(f => f.binding), permittedLocks, names, input.glossary, input.instructions]);
      const blockIds = [...new Set([...selected.map(f => f.block_id), ...audioFacts[index]!.map(f => f.block_id), ...buckets[index]!.map(b => b.id)])].sort((a, b) => scene.blocks.findIndex(x => x.id === a) - scene.blocks.findIndex(x => x.id === b));
      const source = { type: 'script' as const, script_id: input.scriptId, script_revision: input.revision, script_scene_id: scene.id, block_ids: blockIds, ...(continuityRead ? { continuity: continuityRead.reference } : {}) };
      const keyProps = doc.props.filter(prop => scene.propIds.includes(prop.id) && selected.some(f => f.text.includes(prop.name))).map(prop => prop.name).slice(0, 2);
      const speechFacts = audioFacts[index]!.map(fact => fact.text);
      const contractFields = { ...sceneSlots[index]!, scene_context: contextFields, location, primary_action: primaryAction, visual_facts: selected, ...(speechFacts.length ? { speech_facts: speechFacts } : {}), audible_blocks: buckets[index]!, continuity_states: inherited, visible_subjects: names, subject_scale: names.length ? 'medium-20-40' : undefined, key_props: keyProps, source };
      const assembled: StoryboardCandidateShot = {
        index: allShots.length + 1, script_scene_id: scene.id, fact_ids: shot.fact_ids, hold_fact_ids: heldIds, audio_fact_ids: audioFacts[index]!.map(f => f.id), primary_fact_id: shot.primary_fact_id, block_ids: blockIds,
        visual_prompt: translated.visual_prompt, shot_spec: packShotSpec(contractFields), source,
        dialogue: buckets[index]!.filter(b => b.type === 'dialogue').map(b => b.text.trim()).join('\n'),
        narration: buckets[index]!.filter(b => b.type === 'voiceover').map(b => b.text.trim()).join('\n'),
        audio_prompt: '',
        duration: durations[index]!, shot_type: sceneSlots[index]!.shot_type,
        camera_movement: 'Static', camera_angle: 'Eye-level',
        negative_prompt: compileNegativePrompt({ ...contractFields, visual_prompt: translated.visual_prompt, identity_mode: 'auto' }),
      };
      assembled.audio_prompt = shotSoundText(doc, assembled, contract);
      await saveAudit(auditHash(assembled, contract, input.model));
      p.shots[shotKey] = assembled;
      allShots.push(assembled);
      await persist();
    }
    state = continuityAfter(state, sceneFacts);
  }
  return { contract, shots: allShots };
}
