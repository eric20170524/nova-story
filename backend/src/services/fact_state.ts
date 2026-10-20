import { FACT_STATE_ATTRIBUTES, type FactStateAttribute } from '../schemas/storyboard_facts';

export { FACT_STATE_ATTRIBUTES, factStateLabel } from '../schemas/storyboard_facts';

const BODY_EXACT = new Set(['手', '手指', '指尖', '手臂', '臂', '腿', '脚', '赤足', '身', '身体', '胸', '背', '腰', '唇', '额', '眉', '瞳', '眼', '眼眶', '脸颊', '面容', '耳根', '双颊', '双乳', '胸口']);
const BODY_PHRASES = ['脸颊', '眼眶', '面容', '耳根', '双颊', '双乳', '胸口', '赤足', '指尖', '手指'];
const POSE_PHRASES = ['跨坐', '骑坐', '翻身', '起来', '转头', '回头', '起身', '低头', '抬头', '跪下', '躺下', '趴下'];
const POSE_MARKS = ['坐', '卧', '跪', '躺', '趴'];
const CONTACT = new Set(['按倒', '触碰', '安抚', '拥抱', '拉扯', '纠缠']);

function exactTerm(text: string, terms: ReadonlySet<string>): boolean {
  return terms.has(text.trim());
}

/** Reject only an exact illegal pair. The note must not name a replacement category. */
export function stateCategoryConflict(attribute: string, value: string, item = ''): string | null {
  if (!isFactStateAttribute(attribute)) return '未知连续状态';
  if (attribute === 'position' && (CONTACT.has(value.trim()) || CONTACT.has(item.trim()))) return 'position 与取值不符';
  const body = exactTerm(item, BODY_EXACT) || exactTerm(value, BODY_EXACT) || BODY_PHRASES.some((term) => value.trim() === term || item.trim() === term);
  const pose = POSE_PHRASES.some((term) => value.trim() === term) || POSE_MARKS.some((term) => value.trim() === term);
  if ((attribute === 'wardrobe' || attribute === 'holding') && body) return `${attribute} 与取值不符`;
  if (attribute === 'holding' && (CONTACT.has(value.trim()) || CONTACT.has(item.trim()))) return 'holding 与取值不符';
  if (attribute === 'position' && pose) return 'position 与取值不符';
  return null;
}

export function isFactStateAttribute(attribute: string): attribute is FactStateAttribute {
  return (FACT_STATE_ATTRIBUTES as readonly string[]).includes(attribute);
}

/** Ask once more when the category is illegal. A second miss stays for review. */
export async function reviewExtractedStates<T>(text: string, load: (note: string) => Promise<T[]>, conflictOf: (state: T) => string | null): Promise<T[]> {
  let note = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const states = await load(note);
    const conflicts = [...new Set(states.map(conflictOf).filter((item): item is string => Boolean(item)))];
    if (!conflicts.length) return states;
    note = conflicts.join('；');
    if (attempt === 1) throw new Error(`连续状态待核对: ${text} ${note}`);
  }
  throw new Error(`连续状态待核对: ${text}`);
}

/** Keep a position only when it is this location, or this location's name contains that place name. A longer phrase that merely mentions the location, such as leaving it, does not stay. */
export function positionApplies(place: string, location: string, texts: readonly string[]): boolean {
  const value = place.trim();
  if (!value) return false;
  const here = location.trim();
  if (here && (here === value || here.includes(value))) return true;
  return texts.some((text) => text.includes(value));
}

export function appendSpeechFacts(facts: string[], speech: unknown): string[] {
  const lines = Array.isArray(speech) ? speech : [];
  const next = [...facts];
  for (const line of lines) {
    const text = String(line || '').trim();
    if (text && !next.includes(text)) next.push(text);
  }
  return next;
}
