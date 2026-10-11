import type { EntityBinding } from './entity_binding';

/** Replace resolved spans and move every following span by the exact length difference. */
export function expandScriptReferences(text: string, binding: EntityBinding, preserveAuthority = false) {
  let cursor = 0;
  let expanded = '';
  const ordered = [...binding.mentions].sort((a, b) => a.start - b.start || a.end - b.end);
  const mentions: EntityBinding['mentions'] = [];
  for (let index = 0; index < ordered.length; index++) {
    let mention = ordered[index]!;
    const reflexive = ordered[index + 1];
    // “她自己/他自己” is one reference when both spans resolve to the same person.
    if (/^[她他]$/u.test(mention.text) && reflexive?.text === '自己' && mention.end === reflexive.start
      && mention.confirmed && reflexive.confirmed && mention.entity && mention.entity.id === reflexive.entity?.id) {
      mention = { ...mention, end: reflexive.end, authority: mention.authority === 'human' || reflexive.authority === 'human' ? 'human' : mention.authority };
      index++;
    }
    expanded += text.slice(cursor, mention.start);
    const start = expanded.length;
    const replacement = mention.confirmed && mention.entity ? mention.entity.name : mention.text;
    expanded += replacement;
    cursor = mention.end;
    mentions.push({ ...mention, start, end: expanded.length, text: replacement,
      authority: mention.confirmed && mention.entity && !preserveAuthority ? 'literal' as const : mention.authority });
  }
  expanded += text.slice(cursor);
  return { text: expanded, mentions };
}
