import crypto from 'node:crypto';
import { z } from 'zod';
import type { AIProvider } from './ai/base';
import type { EntityBinding, EntityRef } from '../schemas/entity_binding';
import type { ScriptDocument } from '../schemas/script';
import { expandScriptReferences } from '../schemas/script_entity_references';

export const textHash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
export const entityRoster = (characters: Array<{ id: number; name: string }>): EntityRef[] => characters.map(c => ({ id: `character:${c.id}`, name: c.name }));
const quote = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pronouns = /她们|他们|它们|(?<!其)她|(?<!其)他(?!人)|它|对方|自己|前者|后者|两人/gu;
const implicitPerson = /^(?:随后|然后|接着|并)?(?:将|把)?(?:随后|然后|接着|并)?(?:伸手|抬手|抬头|低头|转身|坐下|起身|站起|举起|接过|递出|握住|拿起|放下|推开|走出|走进|解开|褪|脱|戴|穿|里衣|外衣|衣襟|衣领|双手|左手|右手|手中)/u;
const represented = /^(?:的)?(?:照片|画像|肖像|名字|姓名|传闻|故事|声音|来信|信件)/u;
const representedPrefix = /(?:照片|画像|肖像)(?:里|中|上)(?:的)?$|(?:提起|提到|谈起|谈到|想起|听说|呼喊|喊出)(?:了)?$/u;
const unnamedParticipant = /母亲|父亲|女儿|儿子|孩子|老人|女孩|男孩|女人|男人|女子|男子|路人|同事|朋友|侍女|服务员|陌生人|客人|守卫|保安|老师|学生|众人/u;

export function namedMentions(text: string, roster: EntityRef[]) {
  const mentions: EntityBinding['mentions'] = [];
  // A longer exact project name owns its span; substring names cannot create a second person.
  for (const entity of [...roster].sort((a, b) => b.name.length - a.name.length)) {
    for (const match of text.matchAll(new RegExp(quote(entity.name), 'gu'))) {
      const start = match.index!; const end = start + match[0].length;
      if (mentions.some(m => start < m.end && end > m.start)) continue;
      const visibility = represented.test(text.slice(end)) || representedPrefix.test(text.slice(0, start)) ? 'mentioned' : 'visible';
      const candidates = roster.filter(e => e.name === entity.name);
      mentions.push({ text: match[0], start, end, entity: candidates.length === 1 ? entity : null, candidates, status: candidates.length === 1 ? 'resolved' : 'ambiguous', authority: candidates.length === 1 ? 'literal' : 'model_proposal', confirmed: candidates.length === 1, visibility: candidates.length === 1 ? visibility : 'uncertain' });
    }
  }
  return mentions.sort((a, b) => a.start - b.start);
}

export function bindEntities(text: string, roster: EntityRef[], context = ''): EntityBinding {
  const mentions = namedMentions(text, roster);
  const add = (word: string, start: number, end: number) => {
    if (mentions.some(m => start < m.end && end > m.start)) return;
    const prior = [...new Map(namedMentions(context + text.slice(0, start), roster).filter(m => m.entity && m.visibility === 'visible').map(m => [m.entity!.id, m.entity!])).values()];
    const observed = [...new Map([...prior, ...mentions.filter(m => m.entity && m.visibility === 'visible').map(m => m.entity!)].map(e => [e.id, e])).values()];
    const candidates = observed.length ? observed : roster;
    // Only a single named subject in this same source block is automatic. Multi-person
    // discourse, plural/reflexive references and cross-block inference remain proposals.
    const departure = /离开|离场|走出|退出|不在场|只剩/u.test(context + text.slice(0, start));
    const discourse = context + text;
    const masked = roster.reduce((source, entity) => source.replace(new RegExp(quote(entity.name), 'gu'), 'ENTITY'), discourse);
    const anotherParticipant = unnamedParticipant.test(masked) || namedMentions(discourse, roster).some(m => m.visibility === 'mentioned');
    const single = !departure && !anotherParticipant && prior.length === 1 && observed.length === 1 && (word === '' || /^[她他]$/u.test(word));
    mentions.push({ text: word, start, end, entity: single ? prior[0]! : null,
      candidates, status: single ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'unknown',
      authority: single ? 'single_subject' : 'model_proposal', confirmed: single, visibility: single ? 'visible' : 'uncertain' });
  };
  for (const match of text.matchAll(pronouns)) add(match[0], match.index!, match.index! + match[0].length);
  if (!mentions.length && implicitPerson.test(text)) add('', 0, 0);
  return { version: 1, text_hash: textHash(text), context_hash: textHash(context), mentions: mentions.sort((a, b) => a.start - b.start) };
}

/** The same discourse dependency is used by script edits, fact review and generation. */
export function actionBindingSource(doc: ScriptDocument, sceneId: string, blockId: string, roster: EntityRef[], start = 0, end?: number) {
  const sceneIndex = doc.scenes.findIndex(scene => scene.id === sceneId);
  const scene = doc.scenes[sceneIndex]!;
  const blockIndex = scene.blocks.findIndex(block => block.id === blockId);
  const block = scene.blocks[blockIndex]!;
  const text = block.text.slice(start, end);
  const sameBlockContext = block.text.slice(0, start);
  const previous = doc.scenes[sceneIndex - 1];
  const context = [previous?.locationId === scene.locationId ? previous.blocks.slice(-2).map(b => b.text).join('\n') : '',
    ...scene.blocks.slice(0, blockIndex).map(b => b.text), sameBlockContext].filter(Boolean).join('\n');
  const automatic = bindEntities(text, roster, sameBlockContext);
  automatic.context_hash = textHash(automatic.mentions.some(m => m.authority !== 'literal') ? context : '');
  return { automatic, context };
}

export function refreshActionBindings(doc: ScriptDocument, roster: EntityRef[]) {
  for (const scene of doc.scenes) for (const block of scene.blocks) {
    if (block.type !== 'action') continue;
    const { automatic } = actionBindingSource(doc, scene.id, block.id, roster);
    if (!block.binding || block.binding.text_hash !== automatic.text_hash || block.binding.context_hash !== automatic.context_hash) block.binding = automatic;
    validateBinding(block.binding, block.text, roster);
  }
}

export const isPluralMention = (m: { text: string }) => /^(?:她们|他们|它们|两人|双方|众人)$/u.test(m.text);
export const needsBindingReview = (binding?: EntityBinding) => Boolean(binding?.mentions.some(m => !m.confirmed || m.status !== 'resolved' || m.visibility === 'uncertain'));
export const outlineBindingNeedsReview = (binding?: EntityBinding) =>
  Boolean(binding?.mentions.some(m => !isPluralMention(m) && (!m.confirmed || m.status !== 'resolved' || m.visibility === 'uncertain')));
export const boundVisibleEntities = (binding?: EntityBinding): EntityRef[] => [...new Map((binding?.mentions || []).filter(m => m.confirmed && m.status === 'resolved' && m.visibility === 'visible' && m.entity).map(m => [m.entity!.id, m.entity!])).values()];
export function boundText(text: string, binding?: EntityBinding): string {
  if (!binding || binding.text_hash !== textHash(text)) throw new Error('人物绑定与文本版本不符');
  let result = text;
  for (const m of [...binding.mentions].sort((a, b) => b.start - a.start)) {
    if (m.confirmed && m.entity && m.visibility === 'visible') result = result.slice(0, m.start) + m.entity.name + result.slice(m.end);
  }
  return result;
}

/** A complete off-by-one index list is only a suggestion. A legal permutation is kept. Mixed or duplicate indexes are not repaired. */
export function admitBindingRows<T extends { index: number }>(rows: T[], pending: number[]): { rows: T[]; repaired: boolean } {
  if (rows.length !== pending.length) throw new Error('人物自动解析缺项或重复');
  const indexes = rows.map(row => row.index);
  if (new Set(indexes).size !== rows.length) throw new Error('人物自动解析缺项或重复');
  const pendingSet = new Set(pending);
  if (indexes.every(index => pendingSet.has(index))) return { rows, repaired: false };
  if (indexes.every(index => !pendingSet.has(index))) {
    return { rows: rows.map((row, i) => ({ ...row, index: pending[i]! })), repaired: true };
  }
  throw new Error('人物自动解析缺项或重复');
}

/** Gemma sometimes puts the character id in resolved, or nests entity_id and status there. */
function coerceBindingRow(row: Record<string, any>, roster: EntityRef[]): Record<string, any> {
  const source = row && typeof row === 'object' ? row : {};
  const resolved = source.resolved ?? source.resolution;
  let entityId = source.entity_id;
  let status = source.status;
  let visibility = source.visibility;
  if (typeof resolved === 'string') entityId = entityId ?? resolved;
  else if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
    entityId = entityId ?? resolved.entity_id ?? null;
    status = status ?? resolved.status;
    visibility = visibility ?? resolved.visibility;
  }
  if (Array.isArray(entityId)) {
    const valid = entityId.filter((id: any) => typeof id === 'string' && roster.some(e => e.id === id || e.name === id));
    if (valid.length === 1) {
      entityId = valid[0];
    } else {
      entityId = null;
      status = valid.length > 1 ? 'ambiguous' : (status === 'ambiguous' ? 'ambiguous' : 'unknown');
    }
  }
  if (entityId === 'ambiguous' || entityId === 'unknown') {
    status = entityId;
    entityId = null;
  }
  if (typeof entityId === 'string' && !roster.some(entity => entity.id === entityId)) {
    const named = roster.filter(entity => entity.name === entityId);
    entityId = named.length === 1 ? named[0]!.id : null;
  } else if (typeof entityId !== 'string') entityId = null;
  if (!['resolved', 'ambiguous', 'unknown'].includes(status)) status = entityId ? 'resolved' : 'unknown';
  if (status !== 'resolved') entityId = null;
  if (!['visible', 'mentioned', 'uncertain'].includes(visibility)) visibility = 'uncertain';
  return { index: source.index, entity_id: entityId, status, visibility };
}

/** Model resolution is a proposal, even when it returns status=resolved. */
export async function proposeBindings(provider: AIProvider, binding: EntityBinding, text: string, context: string, roster: EntityRef[], scene?: { location: string; interior_exterior?: string; time_of_day?: string }): Promise<EntityBinding> {
  const pending = binding.mentions.map((m, index) => ({ ...m, index })).filter(m => !m.confirmed);
  if (!pending.length || !roster.length) return binding;
  if (context.length + text.length + JSON.stringify(roster).length + JSON.stringify(pending.map(m => ({ index: m.index, text: m.text, start: m.start, end: m.end }))).length > 2200) throw new Error('人物指代上下文超过预算，请核对或按完整语句拆分');
  const schema = z.object({ bindings: z.array(z.object({ index: z.number().int(), entity_id: z.enum(roster.map(e => e.id) as [string, ...string[]]).nullable(), status: z.enum(['resolved', 'ambiguous', 'unknown']) })) });
  const result = await provider.generateStructured(JSON.stringify({ task: 'entity_binding', text, context, scene, entities: roster, mentions: pending.map(m => ({ index: m.index, text: m.text, start: m.start, end: m.end })) }), schema,
    '为当前动作的代词或省略主语建议人物绑定。按前文先判断谁离开、谁留下，再判断当前 scene 地点内谁能够执行动作。已离开当前地点的人，除非原文明确跟随、转场或画外，不作为当前现场动作的执行者。不要仅按最近人名选择，也不要根据姓名猜性别。只剩一名有明确现场依据的候选时，status=resolved，entity_id=该ID。确有多种有依据的解释时，status=ambiguous，entity_id=null。没有依据时，status=unknown，entity_id=null。照片、提及和画外声音不证明本人在现场。每个 index 返回一项，只有 resolved 可以填写 entity_id。结果仅为待核对建议，不能自行标记为已确认。只返回 JSON，顶层键名必须是 bindings。', { temperature: 0.1, maxTokens: 256 });
  const pendingIndices = new Set(pending.map(m => m.index));
  const admitted = admitBindingRows(result.bindings, pending.map(m => m.index));
  const proposals = admitted.rows;
  const byIndex = new Map(proposals.map(b => [b.index, b]));
  return { ...binding, context_hash: textHash(context), mentions: binding.mentions.map((m, index) => {
    const proposal = byIndex.get(index) || (pendingIndices.has(index) ? { index, status: 'unknown' as const, entity_id: null } : undefined);
    return proposal ? { ...m, status: proposal.status, entity: proposal.status === 'resolved' ? roster.find(e => e.id === proposal.entity_id) || null : null, candidates: roster, authority: 'model_proposal', confirmed: false } : m;
  }) };
}

/** Script generation accepts a model's unambiguous resolution; fact review keeps its proposal-only policy. */
export const SCRIPT_ENTITY_RESOLUTION_POLICY_VERSION = 'script-entity-resolution-2';

function localSubjectForReference(text: string, mention: EntityBinding['mentions'][number], roster: EntityRef[]): EntityRef | undefined {
  if (!/^[她他]$/u.test(mention.text) || !/[，,；;]\s*$/u.test(text.slice(0, mention.start))) return undefined;
  const start = Math.max(text.lastIndexOf('。', mention.start - 1), text.lastIndexOf('！', mention.start - 1), text.lastIndexOf('？', mention.start - 1), text.lastIndexOf('\n', mention.start - 1)) + 1;
  const prefix = text.slice(start, mention.start);
  const named = namedMentions(prefix, roster);
  const entities = [...new Map(named.filter(m => m.entity && m.visibility === 'visible').map(m => [m.entity!.id, m.entity!])).values()];
  const masked = roster.reduce((value, entity) => value.replace(new RegExp(quote(entity.name), 'gu'), 'ENTITY'), prefix);
  if (entities.length !== 1 || named.some(m => m.visibility !== 'visible') || unnamedParticipant.test(masked)
    || /离开|离场|走出|退出|不在场|只剩|[“”「」『』‘’"']/u.test(prefix)) return undefined;
  return entities[0];
}

export async function resolveScriptBindings(provider: AIProvider, binding: EntityBinding, text: string, context: string, roster: EntityRef[], scene?: { location: string; interior_exterior?: string; time_of_day?: string }): Promise<EntityBinding> {
  validateBinding(binding, text, roster);
  const preResolvedMentions = binding.mentions.map(m => {
    if (!m.confirmed) {
      const matching = roster.filter(entity => entity.name === m.text);
      if (matching.length === 1 && (!context || context.includes(m.text))) {
        const representedMention = represented.test(text.slice(m.end)) || representedPrefix.test(text.slice(0, m.start));
        if (representedMention || m.visibility === 'uncertain') {
          return {
            ...m,
            entity: matching[0]!,
            status: representedMention ? 'resolved' as const : m.status,
            authority: 'model_proposal' as const,
            confirmed: false,
            visibility: representedMention ? 'mentioned' as const : 'uncertain' as const,
          };
        }
        return {
          ...m,
          entity: matching[0]!,
          status: 'resolved' as const,
          authority: 'literal' as const,
          confirmed: true,
          visibility: m.visibility,
        };
      }
    }
    return m;
  });
  binding = { ...binding, mentions: preResolvedMentions };
  const pending = binding.mentions.map((mention, index) => ({ ...mention, index })).filter(m => !m.confirmed && !roster.some(entity => entity.name === m.text));
  if (!pending.length || !roster.length) return binding;
  const input = { task: 'script_entity_resolution', policy_version: SCRIPT_ENTITY_RESOLUTION_POLICY_VERSION, context, scene, entities: roster, text,
    mentions: pending.map(m => ({ index: m.index, text: m.text, start: m.start, end: m.end, local_subject_id: localSubjectForReference(text, m, roster)?.id })) };
  // Oversized or uncertain passages remain editable review items instead of being guessed.
  if (JSON.stringify(input).length > 6000) return binding;
  const schema = z.object({ bindings: z.array(z.object({ index: z.number().int(), entity_id: z.enum(roster.map(e => e.id) as [string, ...string[]]).nullable(), status: z.enum(['resolved', 'ambiguous', 'unknown']), visibility: z.enum(['visible', 'mentioned', 'uncertain']) })) });
  const loose = z.object({ bindings: z.array(z.record(z.string(), z.any())) });
  const raw = await provider.generateStructured(JSON.stringify(input), loose,
    '只解析 text 中给出的 mentions，context 是补充依据，不能覆盖 text 已明确的动作主语。优先判断当前句语法：同句明确主语连续动作里的他/她沿用该人物；local_subject_id 是当前句已明确主语，resolved 时必须使用该 ID。自己按动作主体判断，前者/后者按先后判断。每个 index 返回一项。明确唯一时 status=resolved 并填写 entity_id；有歧义或无依据时 entity_id=null，不能猜测。复数或两人无法用单个人物表达时保留 ambiguous。跨句指代才参考前文和现场人员，先核对谁离场、谁留场，不按最近人名或姓名猜性别。visibility=visible 表示本人现场出现，mentioned 表示照片、提及或画外，无法判断填 uncertain。明确解析将自动用于剧本，用户可编辑修正。只返回 JSON，顶层键名必须是 bindings。', { temperature: 0.1, maxTokens: 1024 });
  const result = schema.parse({ bindings: raw.bindings.map(row => coerceBindingRow(row, roster)) });
  const admitted = admitBindingRows(result.bindings, pending.map(m => m.index));
  const resolved: EntityBinding = { ...binding, context_hash: textHash(context), mentions: binding.mentions.map((mention, index) => {
    const row = admitted.rows.find(b => b.index === index);
    if (!row) return mention;
    const localSubject = localSubjectForReference(text, mention, roster);
    if (row.status === 'resolved' && !row.entity_id && localSubject) {
      row.entity_id = localSubject.id;
    }
    if (!admitted.repaired && row.status === 'resolved' && localSubject && localSubject.id !== row.entity_id) return { ...mention, entity: null, candidates: roster, status: 'ambiguous', visibility: 'uncertain', authority: 'model_proposal', confirmed: false };
    const entity = row.status === 'resolved' ? roster.find(e => e.id === row.entity_id) || null : null;
    const unique = Boolean(entity && roster.filter(e => e.name === entity.name).length === 1);
    const contradicts = Boolean(localSubject && localSubject.id !== row.entity_id);
    const accepted = !admitted.repaired && row.status === 'resolved' && Boolean(entity) && row.visibility !== 'uncertain' && unique && !contradicts;
    const visibility = row.visibility;
    return { ...mention, entity, candidates: roster, status: entity ? 'resolved' : row.status === 'resolved' ? 'unknown' : row.status,
      visibility, authority: accepted ? 'model_resolution' : 'model_proposal', confirmed: accepted };
  }) };
  validateBinding(resolved, text, roster);
  return resolved;
}

/** Also expand references to people who are mentioned, without changing their visibility. */
export function materializeScriptReferences(text: string, binding: EntityBinding): { text: string; binding: EntityBinding } {
  if (binding.text_hash !== textHash(text)) throw new Error('人物绑定与文本版本不符');
  const expanded = expandScriptReferences(text, binding);
  return { text: expanded.text, binding: { ...binding, text_hash: textHash(expanded.text), mentions: expanded.mentions,
    context_hash: expanded.mentions.every(m => m.authority === 'literal') ? textHash('') : binding.context_hash } };
}

export function validateBinding(binding: EntityBinding, text: string, roster: EntityRef[]) {
  if (binding.text_hash !== textHash(text)) throw new Error('人物绑定与文本版本不符');
  for (const mention of binding.mentions) {
    if (mention.start < 0 || text.slice(mention.start, mention.end) !== mention.text || mention.end < mention.start || mention.end > text.length) throw new Error('人物绑定来源偏移不符');
    if (mention.entity && !roster.some(e => e.id === mention.entity!.id && e.name === mention.entity!.name)) throw new Error('人物绑定引用未知实体');
    if (mention.confirmed && mention.entity && new Set(roster.filter(e => e.name === mention.entity!.name).map(e => e.id)).size > 1) throw new Error('同名角色尚不能共用画面锁，请先为角色档案设置可区分的规范姓名');
    if (mention.authority === 'model_proposal' && mention.confirmed) throw new Error('模型人物建议未经人工确认');
    if (mention.authority === 'model_resolution' && (!mention.confirmed || mention.status !== 'resolved' || mention.visibility === 'uncertain')) throw new Error('人物自动解析必须明确且无歧义');
    if (mention.status !== 'resolved' && mention.entity) throw new Error('歧义不能作为入镜人物');
    if (mention.status === 'resolved' && !mention.entity) throw new Error('已解析的绑定缺少人物');
    if (mention.authority === 'literal' && mention.entity?.name !== mention.text) throw new Error('原文姓名绑定不符');
  }
}

/** Deterministic checks cover explicit handovers. Unrecognized phrasing is reviewed,
 * never treated as equivalent just because both names appear. */
export function transferTranslationProblem(source: string, english: string, glossary: Record<string, string>): string | null {
  for (const relation of transferRelations(source)) {
    const actor = glossary[relation.actor]; const recipient = glossary[relation.recipient];
    if (!actor || !recipient) return '递交双方缺少稳定译名，施受关系待核对';
    const a = quote(actor); const r = quote(recipient);
    const verb = '(?:hands?|handed|passes?|passed|gives?|gave|given|delivers?|delivered|sends?|sent)';
    const active = new RegExp(`\\b${a}\\s+${verb}\\b[^.!?;]*?(?:\\bto\\s+${r}\\b|\\s+${r}\\b)`, 'i');
    const passive = new RegExp(`\\b${verb}\\b[^.!?;]*?(?:\\bto\\s+${r}\\b[^.!?;]*?\\bby\\s+${a}\\b|\\bby\\s+${a}\\b[^.!?;]*?\\bto\\s+${r}\\b)`, 'i');
    const reverse = new RegExp(`\\b${r}\\s+${verb}\\b[^.!?;]*?(?:\\bto\\s+${a}\\b|\\s+${a}\\b)`, 'i');
    if (reverse.test(english) || (!active.test(english) && !passive.test(english))) return '英文递交施受关系不符或未能核实';
  }
  return null;
}

/** Never repair reference errors by deleting words. Mask names such as Qing He. */
export function englishReferenceProblem(english: string, glossary: Record<string, string>): string | null {
  let remaining = english;
  for (const name of Object.values(glossary).sort((a, b) => b.length - a.length)) remaining = remaining.replace(new RegExp(`\\b${quote(name)}\\b`, 'gi'), 'BOUND_ENTITY');
  remaining = remaining.replace(/\bHe[\s-]+(?:Huan|Qi|Tu|Luo|Shou|Bao|Feng|Zun|Xian)\b/g, 'PINYIN_PHRASE');
  return /\b(?:he|him|his|she|her|hers|they|them|their|theirs)\b/iu.test(remaining) ? '英文人物代词未显式绑定，请保留整句重译为确定姓名' : null;
}

/** Small explicit body-owner grammar; never infer ownership from nearest name. */
export function bodyOwnerTerms(source: string, glossary: Record<string, string>): string[] {
  const parts: Record<string, string> = { 左手: 'left hand', 右手: 'right hand', 左臂: 'left arm', 右臂: 'right arm', 左腿: 'left leg', 右腿: 'right leg', 左眼: 'left eye', 右眼: 'right eye' };
  return [...new Set(Object.entries(glossary).flatMap(([name, english]) => [...source.matchAll(new RegExp(`${quote(name)}(?:用|的)(左手|右手|左臂|右臂|左腿|右腿|左眼|右眼)`, 'gu'))].map(match => `${english}'s ${parts[match[1]!]}`)))];
}

/** Limited, conservative equivalence for explicit transfer relations; no n-gram fallback. */
const FIGURATIVE_TRANSFER_OBJECTS = new Set(['身体', '身子', '自己', '心', '命', '性命', '一切']);
const normalized = (text: string) => text.normalize('NFKC').replace(/[\s，,。.!！?？:：;；“”"‘’'（）()]+/gu, '').toLowerCase();
export function transferRelations(text: string) {
  return text.split(/[，,。.!！?？;；\n]+/u).flatMap(clause => {
    const t = normalized(clause);
    const active = /^(.+?)把(.+?)(递给|交给|送给)(.+)$/u.exec(t);
    const passive = /^(.+?)被(.+?)(递给|交给|送给)(.+)$/u.exec(t);
    const m = active || passive;
    if (!m) return [];
    const object = (active ? m[2]! : m[1]!).trim();
    if (FIGURATIVE_TRANSFER_OBJECTS.has(object)) return [];
    return [{ actor: (active ? m[1]! : m[2]!).replace(/(?:用|以)[左右双]手$/u, ''), object, verb: m[3]!, recipient: m[4]!.replace(/(?:的)?手[里中]$/u, '') }];
  });
}
export function eventRelationConflict(event: string, text: string): boolean {
  return transferRelations(event).some(expected => transferRelations(text).some(actual => expected.object === actual.object && expected.verb === actual.verb && (expected.actor !== actual.actor || expected.recipient !== actual.recipient)));
}
export function eventContentCovered(event: string, text: string): boolean {
  if (eventRelationConflict(event, text)) return false;
  const expected = transferRelations(event); const actual = transferRelations(text);
  if (expected.length) return expected.every(e => actual.some(a => JSON.stringify(a) === JSON.stringify(e)));
  const needle = normalized(event);
  return Boolean(needle) && normalized(text).includes(needle);
}

/** A summarized event is not a quote. Keep the source sentences instead of the paraphrase. */
export function groundedEventText(eventText: string, sourceText: string): { text: string; usedSource: boolean } | null {
  if (eventContentCovered(eventText, sourceText)) return { text: eventText, usedSource: false };
  if (sourceText.trim() && eventContentCovered(sourceText, sourceText)) return { text: sourceText, usedSource: true };
  return null;
}
