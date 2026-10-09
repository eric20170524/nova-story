import type { EntityBinding } from '../backend/src/schemas/entity_binding';
export interface ReviewFact {
  scene_id: string;
  block_id: string;
  text: string;
  kind: string;
  beat: number;
  states: Array<{ entity: string; attribute: string; value: string; item?: string; operation?: 'set' | 'remove' }>;
  binding?: EntityBinding;
}

/** Pull an earlier sequence number down when it sits above a later sentence in the same source block. */
export function stabilizeReviewBeats<T extends { scene_id: string; block_id: string; beat: number }>(facts: T[]): T[] {
  const copy = facts.map(fact => ({ ...fact }));
  const groups = new Map<string, T[]>();
  for (const fact of copy) {
    const key = `${fact.scene_id}\0${fact.block_id}`;
    const list = groups.get(key);
    if (list) list.push(fact);
    else groups.set(key, [fact]);
  }
  for (const spans of groups.values()) {
    for (let index = 0; index < spans.length; index++) {
      if (!spans.slice(0, index).some(span => span.beat > spans[index]!.beat)) continue;
      const target = spans[index]!.beat;
      for (let earlier = 0; earlier < index; earlier++) if (spans[earlier]!.beat > target) spans[earlier]!.beat = target;
    }
  }
  return copy;
}

/** Insert new beats without merging into, or reversing, later scene beats. */
export function splitReviewFact(facts: ReviewFact[], index: number): ReviewFact[] {
  const source = facts[index];
  if (!source) return facts;
  const parts = source.text.split('\n').filter(text => text.trim());
  if (parts.length < 2) return facts;
  const shift = parts.length - 1;
  return facts.flatMap<ReviewFact>((fact, position) => {
    if (position === index) return parts.map((text, part) => ({ ...fact, text, kind: 'uncertain', beat: fact.beat + part, states: [], binding: undefined }));
    return [{ ...fact, beat: position > index && fact.scene_id === source.scene_id ? fact.beat + shift : fact.beat }];
  });
}
