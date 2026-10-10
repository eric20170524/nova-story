import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/database';
import type { AIProvider } from './ai/base';
import type { ScriptDocument, StoryboardCandidatePayload, StoryboardCandidateShot } from '../schemas/script';
import { FACT_POLICY_VERSION, FactKindSchema, FactStateSchema, type VisualFact, type StoryboardFactContract } from '../schemas/storyboard_facts';
import { EntityBindingSchema } from '../schemas/entity_binding';
import { actionBindingSource, boundVisibleEntities, boundText, entityRoster, needsBindingReview, proposeBindings, textHash, validateBinding, transferTranslationProblem, transferRelations, englishReferenceProblem, bodyOwnerTerms } from './entity_binding';
import { type CharacterLockRef } from './pony_prompt_compiler';
import { packShotSpec } from '../schemas/shot_contract';
import { findChapterShotQuotaViolation } from './shot_intent_quota';
import { containsCjk } from './english_visual_prompt';
import { compileNegativePrompt } from './negative_prompt_compiler';

const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hash = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export class FactWorkflowError extends Error {
  constructor(message: string, public statusCode: 400 | 409 | 502 = 400) { super(message); }
}
const punctuationOnly = (value: string) => !value.replace(/[\s\p{P}]/gu, '');
export const ExtractionSchema = z.object({ spans: z.array(z.object({
  text: z.string().min(1), kind: FactKindSchema, beat: z.number().int().nonnegative(),
  states: z.array(FactStateSchema).default([]),
  binding: EntityBindingSchema.optional(),
})).min(1) });

/** Ordered partition of the ORIGINAL block. No fuzzy matching or guessed repeated offsets. */
export function anchorSpans(sceneId: string, blockId: string, source: string, output: z.infer<typeof ExtractionSchema>, baseOffset = 0): VisualFact[] {
  let cursor = 0;
  let lastBeat = -1;
  const facts = output.spans.map((span) => {
    const start = source.indexOf(span.text, cursor);
    if (start < 0 || !punctuationOnly(source.slice(cursor, start))) throw new FactWorkflowError(`来源片段遗漏或无法定位: ${blockId}@${cursor}`);
    if (span.beat < lastBeat) throw new FactWorkflowError(`事实节拍乱序: ${blockId}`);
    if (span.kind !== 'visual' && span.states.length) throw new FactWorkflowError(`非视觉片段不能改变连续状态: ${blockId}`);
    if (span.states.length) {
      if (span.binding) validateBinding(span.binding, span.text, span.binding.mentions.flatMap(m => m.entity ? [m.entity] : []));
      const owners = boundVisibleEntities(span.binding).map(e => e.name);
      if (evidencedContinuityStates(span.text, span.states, source.slice(0, start), owners).rejected.length) throw new FactWorkflowError(`连续状态缺少原文证据: ${blockId}`);
    }
    lastBeat = span.beat;
    cursor = start + span.text.length;
    return { ...span, id: `f_${hash([sceneId, blockId, start + baseOffset, cursor + baseOffset]).slice(0, 20)}`, scene_id: sceneId, block_id: blockId, start: start + baseOffset, end: cursor + baseOffset };
  });
  if (!punctuationOnly(source.slice(cursor))) throw new FactWorkflowError(`来源片段尾部遗漏: ${blockId}@${cursor}`);
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
    const spans = facts.filter(f => f.scene_id === scene.id && f.block_id === block.id);
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
    return { scene_id: scene.id, minimum: Math.max(1, beats.size, Math.ceil(duration / MAX_SHOT_SECONDS)), duration };
  });
  const minimum = budgets.reduce((n, b) => n + b.minimum, 0);
  if (minimum > limit) throw new FactWorkflowError(`镜头预算冲突: 最少需要 ${minimum} 镜，上限 ${limit}；${budgets.map(b => `${b.scene_id}: ${b.minimum}镜`).join('；')}。请核对独立节拍或调整时长，不能静默并镜。`);
  return budgets;
}

type State = { entity: string; attribute: string; value: string; fact_id: string; item?: string; operation?: 'set' | 'remove' };
/** Per garment/object, so a scarf never replaces a coat. Other attributes retain their scope. */
export function stateResourceKey(s: { entity: string; attribute: string; value: string; item?: string }) {
  const item = s.item || (['wardrobe', 'holding'].includes(s.attribute) ? s.value.match(/外套|围巾|里衣|外衣|外袍|长袍|衣襟|手套|帽子|雨伞|蓝伞|伞|信封|杯|衣领|臂膀/u)?.[0] || s.value : '');
  return `${s.entity}:${s.attribute}:${item}`;
}
export function continuityAfter(previous: State[], facts: VisualFact[]): State[] {
  const states = new Map(previous.map(s => [stateResourceKey(s), s]));
  for (const fact of facts.filter(f => f.kind === 'visual')) {
    for (const s of fact.states) {
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
    if (!facts.some(f => f.scene_id === sceneId && f.kind === 'visual' && (boundVisibleEntities(f.binding).some(e => e.name === s.entity) || (!f.binding && f.text.includes(s.entity))))) return false;
    const origin = facts.find(f => f.id === s.fact_id);
    const originScene = doc.scenes.find(sc => sc.id === origin?.scene_id);
    return !['position', 'presence', 'pending_action'].includes(s.attribute) || originScene?.locationId === current.locationId;
  });
}
export const continuityLiteral = (states: State[]) => states.map(s => ({ id: `state_${hash(s).slice(0, 16)}`, text: s.attribute === 'wardrobe' && s.operation === 'remove' ? `${s.entity} 已脱下衣物：${s.item || s.value}` : `${s.entity} ${({ presence: '在场状态', wardrobe: '衣着', holding: '持物', position: '位置', pending_action: '未完成动作' } as Record<string, string>)[s.attribute] || s.attribute}：${s.value}` }));
function inheritedStates(state: State[], selected: VisualFact[], present: string[] = []) {
  const visible = new Set(present);
  return state.filter(s => !selected.some(f => f.id === s.fact_id) && (visible.has(s.entity) || selected.some(f => f.text.includes(s.entity))));
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
    if (state.item && !text.includes(state.item)) { rejected.push(state); continue; }
    if (state.attribute === 'wardrobe' && state.operation === 'remove' && !/脱下|脱掉|摘下|摘掉|褪下/u.test(text)) { rejected.push(state); continue; }
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

const CLAUSE_EDGE = /[，,；;。！？!?、：:]$/u;
const CLAUSE_JOIN = /^(?:然后|随后|接着|之后|继而|并(?![列排拢肩非且得]))/u;

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
  if (spans.length < 2 || spans.some(span => !span) || spans.join('') !== source) return null;
  return spans;
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
export function assignFactSlots(facts: VisualFact[], count: number): VisualFact[][] {
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
  if (slots.length > count) throw new FactWorkflowError(`同镜互斥状态需要 ${slots.length} 镜，本组预算 ${count}`);
  while (slots.length < count) slots.push([]);
  return slots;
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
  const schema = z.object({ faithful: z.boolean() }).strict();
  let result: z.infer<typeof schema>;
  try {
    result = await provider.generateStructured(JSON.stringify({ task: 'audit', facts, source: facts.map(f => f.text).join('\n'), english, context }), schema,
      'Compare Chinese source facts and an English translation. Return faithful=true ONLY when English preserves ALL source facts, identity, number, agent/patient, color, left/right, negation, clothing, pose, contact, objects and location, and adds no unsupported person, action, color or object. Otherwise faithful=false. Camera/style tags and numeric emphasis weights are technical formatting, not scene facts. Appearance locks in context are permitted only for context.visible_names and must never contradict source facts for the same attribute or garment. Names use context.glossary. Do not produce explanations or quotations.', { temperature: 0.1, maxTokens: 64 });
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
  if (hash(allocateBudgets(doc, contract.facts)) !== hash(contract.budgets)) throw new FactWorkflowError('镜头预算被修改');
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
    if (spec.primary_action !== (primary?.text || declaredLocation)) throw new FactWorkflowError('主动作与可追溯事实不符');
    if (shot.duration + 0.01 < scene.blocks.filter(b => shot.block_ids.includes(b.id)).reduce((n, b) => n + audioSeconds(b), 0)) throw new FactWorkflowError('镜头语音超过已分配时长');
    const audioFacts = contract.facts.filter(f => shot.audio_fact_ids?.includes(f.id));
    if (audioFacts.length !== (shot.audio_fact_ids || []).length || audioFacts.some(f => f.scene_id !== scene.id || f.kind !== 'audio')) throw new FactWorkflowError('声音含未知或跨场事实');
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
  let state: State[] = [];
  for (const scene of doc.scenes) {
    let shotState = continuityForScene(state, doc, contract.facts, scene.id);
    for (const shot of payload.shots.filter(s => s.script_scene_id === scene.id)) {
      const selected = contract.facts.filter(f => shotEvidenceIds(shot).includes(f.id));
      const visible = JSON.parse(shot.shot_spec).visible_subjects || [];
      shotState = continuityAfter(shotState, selected);
      if (hash(JSON.parse(shot.shot_spec).continuity_states || []) !== hash(inheritedStates(shotState, selected, visible))) throw new FactWorkflowError('镜头连续状态缺失或与来源依赖不符');
    }
    state = continuityAfter(state, contract.facts.filter(f => f.scene_id === scene.id));
  }
}

export type WorkflowProgress = {
  attempt?: number;
  request?: { request_key: string; expected_revision: number; instructions: string };
  input_hash: string; phase: string; scene_id?: string; shot_index?: number; error?: string;
  candidate_id?: string;
  extracted: Record<string, VisualFact[]>;
  plans: Record<string, FactPlan>;
  shots: Record<string, StoryboardCandidateShot>;
  facts?: VisualFact[];
  metrics: Array<{ stage: string; elapsed_ms: number; attempts: number }>;
  state_checks?: Record<string, boolean>;
  state_review_pending?: string[];
};
export const stateCheckKey = (fact: VisualFact) => hash([fact.id, fact.text, fact.kind, fact.beat, fact.binding]);
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
  progress: WorkflowProgress; persist: () => Promise<void>;
}): Promise<{ contract: StoryboardFactContract; shots: StoryboardCandidateShot[] }> {
  const { doc, progress: p, provider, persist } = input;
  const request = async <T>(stage: string, work: (repair: string) => Promise<T>): Promise<T> => {
    const start = Date.now();
    let error = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = await work(error);
        p.metrics.push({ stage, elapsed_ms: Date.now() - start, attempts: attempt + 1 });
        return value;
      } catch (e: any) { error = e?.message || String(e); if (attempt) throw e; }
    }
    throw new FactWorkflowError(error, 502);
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
      if (unit.text.length > 1800) throw new FactWorkflowError(`分场 ${scene.id} 来源片段超过输入预算，需按完整叙事节拍核对: ${unit.block_id}@${unit.start}`);
      if (!batches.length || batches.at(-1)!.length >= 6 || batches.at(-1)!.reduce((n, u) => n + u.text.length, 0) + unit.text.length > 900) batches.push([]);
      batches.at(-1)!.push(unit);
    }
    for (const batch of batches) {
      const key = hash([scene.id, batch]);
      if (p.extracted[key]) continue;
      p.extracted[key] = await request(`facts:${scene.id}:${batch[0]!.id}`, async repair => {
        const prior = Object.values(p.extracted).flat().filter(f => f.scene_id === scene.id && f.kind === 'visual');
        const ids = batch.map(u => u.id) as [string, ...string[]];
        const classified = await provider.generateStructured(JSON.stringify({ task: 'classify', sources: batch.map(u => ({ id: u.id, text: u.text })), repair }), z.object({ items: z.array(z.object({ id: z.enum(ids), kind: FactKindSchema })) }),
          'Classify each unchanged ID only. visual = observable appearance, action, object, number, position or location. audio = sound or silence. internal = thought, memory or intention. figurative = metaphor. mixed = visual AND nonvisual in the SAME clause, never multiple visual details. uncertain = cannot decide. An empty scene is visual. Return items with id and kind only.', { temperature: 0.1, maxTokens: 384 });
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
              'Can ALL visible details in this clause coexist in ONE still image? one_frame = compatible appearance, objects or one action at one moment. sequence = successive actions or before/after state changes require separate keyframes. uncertain = cannot decide. Multiple objects can coexist; successive actions cannot. Classify only, do not rewrite.', { temperature: 0.1, maxTokens: 48 });
            if (atomic.result === 'uncertain' || source.text.length > 240) {
              classified.items.find(i => i.id === source.id)!.kind = 'uncertain';
              place(source, lastVisualBeat >= 0 ? lastVisualBeat : 0, 'uncertain');
              continue;
            }
            if (atomic.result === 'sequence') {
              const split = await provider.generateStructured(JSON.stringify({ task: 'split_actions', source: source.text, repair }), z.object({ spans: z.array(z.object({ text: z.string().min(1) })).min(1) }),
                'Decide whether this one sentence is two successive visible actions. If it is, return each action as its own span. Every span must be a verbatim contiguous quote, and joining the spans in order must reproduce the source with no added, dropped, or rewritten characters. If it is one action, return one span whose text equals the source.', { temperature: 0.1, maxTokens: 256 });
              const quotes = verbatimActionSplit(source.text, split.spans.map(span => span.text));
              if (quotes) {
                let beat = lastVisualBeat < 0 ? 0 : lastVisualBeat + 1;
                for (const text of quotes) {
                  beat = place(source, beat, 'visual', text);
                  lastVisualBeat = beat;
                  beat += 1;
                }
                previousText = quotes.at(-1)!;
                continue;
              }
              lastVisualBeat = place(source, lastVisualBeat >= 0 ? lastVisualBeat : 0, 'visual');
              previousText = source.text;
              continue;
            }
            const result = previousText ? await provider.generateStructured(JSON.stringify({ task: 'beat_relation', previous: previousText, current: source.text, repair }), z.object({ relation: z.enum(['simultaneous', 'sequential', 'uncertain']) }),
              'Classify temporal relation only. simultaneous: current adds an explicitly compatible visible state at the SAME moment as previous. sequential: a new action, state transition or later moment needs a separate keyframe. uncertain: either reading is possible. Never assume independent actions are simultaneous just because adjacent. Return relation only.', { temperature: 0.1, maxTokens: 64 }) : { relation: 'sequential' as const };
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
      });
      await persist();
    }
  }
  let facts = Object.values(p.extracted).flat();
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
  if (merged) facts = Object.values(p.extracted).flat();
  stabilizeFactBeats(facts);
  p.facts = facts;
  await persist();
  for (const fact of facts.filter(item => item.kind === 'mixed' || item.kind === 'uncertain')) {
    const replaced = await request(`repair:${fact.id}`, async repair => {
      const schema = z.object({ spans: z.array(z.object({ text: z.string().min(1), kind: z.enum(['visual', 'audio', 'internal', 'figurative']) })).min(1) });
      const result = await provider.generateStructured(JSON.stringify({ task: 'repair_fact', text: fact.text, kind: fact.kind, repair }), schema,
        'Repair one stored fact so a person does not have to edit it. If it mixes a visible action with a thought, sound, or metaphor, return source-exact spans cut only after punctuation or before 然后、随后、接着、之后、继而 or 并. A cut inside a clause is invalid. Otherwise return one span whose text equals the source. Joining the spans in order must reproduce the source with no added, dropped, or rewritten characters. kind is only visual, audio, internal, or figurative. Return spans with text and kind only.', { temperature: 0.1, maxTokens: 384 });
      const spans = result.spans;
      try {
        for (let index = 0; index < spans.length - 1; index++) {
          if (!clauseBoundaryBetween(spans[index]!.text, spans[index + 1]!.text)) throw new FactWorkflowError('修复片段没有落在分句边界');
        }
        return anchorSpans(fact.scene_id, fact.block_id, fact.text, { spans: spans.map(span => ({ ...span, beat: fact.beat, states: [] as [] })) }, fact.start);
      } catch (error) {
        if (!repair) throw error;
        const decided = await provider.generateStructured(JSON.stringify({ task: 'repair_kind', text: fact.text, repair: `${repair} ${error instanceof Error ? error.message : ''}` }), z.object({ kind: z.enum(['visual', 'audio', 'internal', 'figurative']) }),
          'Choose one kind for the whole unchanged sentence. visual = something that can be photographed. audio = only a sound. internal = thought or feeling. figurative = a metaphor with no literal picture. Return kind only.', { temperature: 0.1, maxTokens: 32 });
        return anchorSpans(fact.scene_id, fact.block_id, fact.text, { spans: [{ text: fact.text, kind: decided.kind, beat: fact.beat, states: [] }] }, fact.start);
      }
    });
    for (const batch of Object.values(p.extracted)) {
      const index = batch.findIndex(item => item.id === fact.id);
      if (index >= 0) batch.splice(index, 1, ...replaced);
    }
    await persist();
  }
  facts = Object.values(p.extracted).flat();
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
  for (const scene of doc.scenes) {
    const visual = facts.filter(f => f.scene_id === scene.id && f.kind === 'visual');
    for (let offset = 0; offset < visual.length; offset++) {
      const group = visual.slice(offset, offset + 1);
      const key = stateCheckKey(group[0]!);
      if (p.state_checks[key]) continue;
      const states = await request(`state:${scene.id}:${offset}`, async repair => {
        const source = group[0]!;
        const block = scene.blocks.find(item => item.id === source.block_id);
        const context = block ? block.text.slice(0, source.start) : '';
        const cast = (input.characters || []).map(item => item.name).filter(Boolean);
        const entities = [...new Set([
          ...boundVisibleEntities(source.binding).map(e => e.name),
          ...doc.props.map(prop => prop.name).filter(name => source.text.includes(name)),
        ])];
        // Background facts stay intact for translation. Don't force the local
        // model to classify an undeclared door/window as a person's presence.
        if (!entities.length) return [];
        const schema = z.object({ states: z.array(z.object({ entity: entities.length ? z.enum(entities as [string, ...string[]]) : z.string().min(1), attribute: z.enum(['presence', 'wardrobe', 'holding', 'position', 'pending_action']), value: z.string().min(1), item: z.string().optional(), operation: z.enum(['set', 'remove']).optional() })) });
        const ask = async (note: string) => provider.generateStructured(JSON.stringify({ task: 'state', facts: group.map(f => ({ id: f.id, text: f.text })), context, entities, binding: source.binding, repair: note }), schema,
          'Read this one fact. context is earlier text in the same action block; binding fixes the person this fact is about. Extract explicit persistent states. wardrobe = a stated clothing state; holding = an object held; position = where the entity stands or sits; presence = explicit entry or exit; pending_action = unfinished action. For wardrobe/holding extract one state per garment/object; item MUST quote its name from this fact. operation is set, or remove only for explicitly completed removal/release. value MUST be an exact contiguous substring of this fact. entity MUST be in entities when supplied, consistent with binding and explicit ownership. An earlier mentioned person is not ownership evidence. Do not paraphrase or write 无, none or English. Absent attributes are omitted. Return states with entity, attribute, value, item and operation where applicable; states:[] if none is explicit.', { temperature: 0.1, maxTokens: 256 });
        let result = await ask(repair);
        const owners = boundVisibleEntities(source.binding).map(e => e.name);
        let evidence = evidencedContinuityStates(source.text, result.states, context, owners);
        // The local model often writes 无 for an absent attribute. Ask it to quote the sentence or drop the state.
        if (evidence.rejected.length) {
          result = await ask(`${repair} ${continuityEvidenceRepair(source.text, evidence.rejected, context)}`.trim());
          evidence = evidencedContinuityStates(source.text, result.states, context, owners);
        }
        if (evidence.rejected.length) { source.states = result.states; p.state_review_pending = [...new Set([...(p.state_review_pending || []), source.id])]; p.phase = 'needs_review'; await persist(); throw new FactWorkflowError(`连续状态归属待核对: ${source.text}`); }
        return evidence.accepted.map(state => ({ ...state, fact_id: source.id }));
      });
      for (const entry of Object.values(p.extracted)) for (const fact of entry.filter(f => group.some(g => g.id === f.id))) {
        fact.states = states.filter(s => s.fact_id === fact.id).map(({ fact_id, ...state }) => state);
      }
      p.state_checks[key] = true;
      await persist();
    }
  }
  facts = Object.values(p.extracted).flat();
  p.facts = facts;
  validateFactSources(doc, facts);
  const unresolved = facts.filter(f => f.kind === 'mixed' || f.kind === 'uncertain');
  if (unresolved.length) { p.phase = 'needs_review'; await persist(); throw new FactWorkflowError(`待核对事实: ${unresolved.map(f => `${f.scene_id}/${f.id}: ${f.text}`).join('；')}`); }
  const budgets = allocateBudgets(doc, facts);
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
    const relevantState = continuityForScene(state, doc, facts, scene.id);
    if (JSON.stringify(relevantState).length > 2000) throw new FactWorkflowError(`连续性状态超出输入预算: ${scene.id}，需要核对压缩`);
    const dependency = hash([FACT_POLICY_VERSION, scene, sceneFacts, relevantState, sceneSlots, input.glossary, input.instructions]);
    await persist();
    const visual = sceneFacts.filter(f => f.kind === 'visual');
    const beats = [...new Set(visual.map(f => f.beat))].map(beat => visual.filter(f => f.beat === beat));
    const groups: VisualFact[][] = [];
    for (const beat of beats) {
      if (beat.reduce((n, f) => n + f.text.length, 0) > 1800) throw new FactWorkflowError(`完整节拍超出规划输入预算: ${scene.id}/${beat[0]!.beat}`);
      if (!groups.length || new Set(groups.at(-1)!.map(f => f.beat)).size >= 4 || groups.at(-1)!.reduce((n, f) => n + f.text.length, 0) + beat.reduce((n, f) => n + f.text.length, 0) > 1400) groups.push([]);
      groups.at(-1)!.push(...beat);
    }
    if (!groups.length) groups.push([]);
    const plan: FactPlan = [];
    let groupState = relevantState;
    for (const [groupIndex, groupFacts] of groups.entries()) {
      const groupCount = new Set(groupFacts.map(f => f.beat)).size + (groupIndex === groups.length - 1 ? budget.minimum - beats.length : 0);
      const groupSlots = sceneSlots.slice(plan.length, plan.length + groupCount);
      const groupKey = hash([dependency, groupIndex, groupFacts, groupState, groupSlots]);
      if (!p.plans[groupKey]) p.plans[groupKey] = await request(`plan:${scene.id}:${groupIndex + 1}`, async repair => {
      const slotFacts = assignFactSlots(groupFacts, groupCount);
      const choices = Object.fromEntries(slotFacts.map((fs, i) => [`s${i + 1}`, fs.length ? z.enum(fs.map(f => f.id) as [string, ...string[]]) : z.null()]));
      const schema = z.object({ primary_by_slot: z.object(choices).strict() });
      const result = await provider.generateStructured(JSON.stringify({ task: 'plan', scene_id: scene.id, group: groupIndex + 1, facts: groupFacts, slots: groupSlots.map((slot, i) => ({ ...slot, id: `s${i + 1}`, fact_ids: slotFacts[i]!.map(f => f.id) })), continuity: groupState, character_ids: scene.characterIds, location_id: scene.locationId, prop_ids: scene.propIds, instructions: input.instructions, repair }), schema,
        'Select only ONE primary fact ID per slot from that slot fact_ids. Program has fixed complete source coverage and beat order. Do not move, merge or omit facts. Empty slot => null. Return primary_by_slot with EVERY supplied slot ID. No other fields.', { temperature: 0.1, maxTokens: 384 });
      const selected = slotFacts.map((fs, i) => ({ fact_ids: fs.map(f => f.id), primary_fact_id: result.primary_by_slot[`s${i + 1}`] as string | null }));
      validatePlan(groupFacts, selected, groupCount);
      return selected;
      });
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
      const inherited = inheritedStates(shotState, selected, names);
      const primary = sceneFacts.find(f => f.id === shot.primary_fact_id) || selected[0];
      const location = doc.locations.find(l => l.id === scene.locationId)?.name || scene.locationId;
      const contextFields = sceneContext(doc, scene);
      const literal = [...selected.map(f => ({ id: f.id, text: boundText(f.text, f.binding) })), ...continuityLiteral(inherited), { id: 'location', text: location }, ...sceneContextFacts(contextFields)];
      const primaryAction = primary?.text || location;
      const quotedLocks = input.locks.filter(l => names.includes(l.name!));
      const permittedLocks = quotedLocks.map(lock => ({ ...lock, lock: scopedWardrobeLock(lock.name!, lock.lock, selected, inherited) })).filter(lock => lock.lock);
      const translated = await request(`translate:${scene.id}:${index + 1}`, async repair => {
        const translations: Array<{ id: string; english: string }> = [];
        const translationSchema = z.object({ translations: z.array(z.object({ id: z.string(), english: z.string().min(1) })) });
        const translateFacts = async (batch: Array<{ id: string; text: string }>, repairNote: string) => {
          const result = await provider.generateStructured(JSON.stringify({ task: 'translate', facts: batch, required_terms: batch.map(f => ({ id: f.id, terms: bodyOwnerTerms(f.text, input.glossary) })).filter(f => f.terms.length), bindings: selected.filter(f => batch.some(row => row.id === f.id)).map(f => ({ id: f.id, mentions: f.binding?.mentions.map(m => ({ text: m.text, entity: m.entity, visibility: m.visibility })) })), glossary: input.glossary, repair: repairNote }), translationSchema,
            '只翻译 facts 数组的条目，返回条目数量和 ID 必须与 facts 完全相同。bindings 和 glossary 只是对应关系，禁止把它们作为新增事实翻译。required_terms 是已确定的身体所有者短语，必须原样写进对应条目的 english，不能改成 his/her。把每条编号事实直译为短英文句，保持原意全部内容，不写镜头、风格或技术标签。保留身份、数量、施受关系、颜色、左右、否定和所有连接词后的事实。禁止补人物、环境、道具、情绪。专名只使用项目glossary给出的译名，无译名时音译，所有人物引用都写确定姓名，不使用 he/she/him/her/his/they/them/their，包括身体部位所有者。未绑定的人物不能新增。english 只能写英文，禁止出现汉字。返回每条相同id及english。', { temperature: 0.1, maxTokens: 512 });
          const problems: string[] = [];
          if (result.translations.length !== batch.length || new Set(result.translations.map(t => t.id)).size !== result.translations.length || batch.some(f => !result.translations.some(t => t.id === f.id))) problems.push('ID或数量不符');
          for (const fact of batch) {
            const row = result.translations.find(t => t.id === fact.id);
            if (!row) continue;
            if (containsCjk(row.english)) problems.push(`${fact.id} 仍含中文「${row.english}」`);
            const missingTerms = bodyOwnerTerms(fact.text, input.glossary).filter(term => !row.english.toLowerCase().includes(term.toLowerCase()));
            if (missingTerms.length) throw new FactWorkflowError(`译文待核对: ${fact.id} 身体部位归属须原样写出 ${missingTerms.join(', ')}`, 502);
            const referenceProblem = englishReferenceProblem(row.english, input.glossary);
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
        for (let offset = 0; offset < literal.length; offset += 4) {
          const batch = literal.slice(offset, offset + 4);
          try {
            translations.push(...await translateFacts(batch, repair));
          } catch (error: any) {
            if (batch.length === 1) throw error;
            for (const fact of batch) translations.push(...await translateFacts([fact], `${repair} ${error?.message || error}`.trim()));
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
          if (literal.length <= 1 || !String(error?.message || '').startsWith('译文待核对')) throw error;
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
              const partRepair = (text: string) => text.includes('低喘') ? '低喘=soft panting，不要译成 whimper、whistle 或 shout。' : repair;
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
      });
      const blockIds = [...new Set([...selected.map(f => f.block_id), ...audioFacts[index]!.map(f => f.block_id), ...buckets[index]!.map(b => b.id)])].sort((a, b) => scene.blocks.findIndex(x => x.id === a) - scene.blocks.findIndex(x => x.id === b));
      const source = { type: 'script' as const, script_id: input.scriptId, script_revision: input.revision, script_scene_id: scene.id, block_ids: blockIds };
      const keyProps = doc.props.filter(prop => scene.propIds.includes(prop.id) && selected.some(f => f.text.includes(prop.name))).map(prop => prop.name).slice(0, 2);
      const contractFields = { ...sceneSlots[index]!, scene_context: contextFields, location, primary_action: primaryAction, visual_facts: selected, audible_blocks: buckets[index]!, continuity_states: inherited, visible_subjects: names, subject_scale: names.length ? 'medium-20-40' : undefined, key_props: keyProps, source };
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
