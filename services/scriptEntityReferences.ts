import type { EntityBinding, EntityRef } from '../backend/src/schemas/entity_binding';
import type { ScriptDocument } from '../backend/src/schemas/script';
import { expandScriptReferences } from '../backend/src/schemas/script_entity_references';

export async function editScriptReferences(text: string, binding: EntityBinding): Promise<{ text: string; binding: EntityBinding }> {
  const expanded = expandScriptReferences(text, binding, true);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expanded.text));
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  return { text: expanded.text, binding: { ...binding, text_hash: hash, mentions: expanded.mentions,
    context_hash: expanded.mentions.every(m => m.confirmed && m.entity?.name === m.text)
      ? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' : binding.context_hash } };
}

/** All people appearing anywhere in this script or its source passages can be selected. */
export function scriptReviewCharacters(doc: ScriptDocument | null, characters: Array<{ id: number; name: string }>): EntityRef[] {
  const ids = new Set(doc?.scenes.flatMap(scene => scene.characterIds).map(id => `character:${id}`));
  const texts = doc ? [
    ...doc.scenes.flatMap(scene => scene.blocks.map(block => block.text)),
    ...doc.outline.mustKeepEvents.flatMap(event => [event.text, ...(event.sourceBindings || []).map(source => source.text)]),
  ] : [];
  return characters.filter(character => ids.has(`character:${character.id}`) || texts.some(text => text.includes(character.name)))
    .map(character => ({ id: `character:${character.id}`, name: character.name }));
}
