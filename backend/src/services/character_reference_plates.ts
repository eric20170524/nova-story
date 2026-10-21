/**
 * Identity plates are single figures.
 * The face plate is the approved portrait. The body plate is the turnaround front
 * panel. The stitched three-view sheet and a corner face crop are not references.
 */

export type IdentityPlate = 'face' | 'body' | 'none';

export interface CharacterPlateSource {
  id?: number | null;
  name?: string | null;
  visual_tags?: unknown;
}

export interface CharacterPlates {
  face: string | null;
  body: string | null;
}

const text = (value: unknown): string => String(value || '').trim();

const asRecord = (value: unknown): Record<string, any> => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value as Record<string, any> : {};
};

export const characterPlates = (visualTags: unknown): CharacterPlates => {
  const tags = asRecord(visualTags);
  const assets = asRecord(tags.assets);
  const face = text(assets.avatar_url || tags.avatar_url);
  const body = text(assets.turnaround_front_url || tags.turnaround_front_url);
  return { face: face || null, body: body || null };
};

const shotText = (workflow: any): string => [
  workflow?.shot_type,
  workflow?.shot_intent,
  workflow?.shot_spec?.shot_type,
  workflow?.shot_spec?.shot_intent,
  workflow?.shot_spec?.subject_scale,
].map(text).join(' ').toLowerCase();

/** One person in a calm close or full view may take a plate. Wide, action, and groups stay on text. */
export const identityPlateForShot = (workflow: any): IdentityPlate => {
  const named = Array.isArray(workflow?.shot_spec?.visible_subjects)
    ? workflow.shot_spec.visible_subjects.map(text).filter(Boolean)
    : [];
  const ids = Array.isArray(workflow?.shot_master_character_ids)
    ? workflow.shot_master_character_ids.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  const people = Math.max(named.length, ids.length);
  if (people !== 1) return 'none';
  const shot = shotText(workflow);
  if (/\b(wide|extreme long|establishing|overhead|action|fight|duel|kick|battle)\b|(?:远景|大远景|建立|俯瞰|鸟瞰|空镜|打斗|交锋)/.test(shot)) return 'none';
  if (/\b(establish|wide-action|overhead-map|absent)\b/.test(shot)) return 'none';
  if (/\b(close-?up|portrait|medium close|extreme close|insert|reaction)\b|(?:特写|大特写|近景|中近景|肖像)/.test(shot)) return 'face';
  if (/\b(full(?:\s|-)?body|full shot|medium shot|medium long|cowboy)\b|(?:全身|全景|中景|中远景)/.test(shot)) return 'body';
  return 'none';
};

const plateCharacter = (workflow: any, characters: CharacterPlateSource[]): CharacterPlateSource | null => {
  const ids = Array.isArray(workflow?.shot_master_character_ids)
    ? workflow.shot_master_character_ids.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  if (ids.length === 1) {
    return characters.find((character) => Number(character.id) === ids[0]) || null;
  }
  const names = Array.isArray(workflow?.shot_spec?.visible_subjects)
    ? workflow.shot_spec.visible_subjects.map(text).filter(Boolean)
    : [];
  if (names.length !== 1) return null;
  return characters.find((character) => text(character.name) === names[0]) || null;
};

/**
 * Replace a client character image with the plate this shot is allowed to use.
 * A stitched turnaround sheet never becomes the reference.
 */
export const resolveSceneIdentityPlate = (
  workflow: any,
  characters: CharacterPlateSource[] = []
): any => {
  const genType = text(workflow?.gen_type || 'scene').toLowerCase();
  if (genType === 'portrait' || genType === 'turnaround' || genType === 'turnaround_panel') {
    return workflow;
  }
  const plate = identityPlateForShot(workflow);
  if (plate === 'none') {
    return {
      ...workflow,
      character_ref_url: undefined,
      ref_image_url: undefined,
      character_ref_urls: undefined,
      identity_plate: 'none',
      force_no_character_adapter: true,
      denoise: 1,
    };
  }
  const character = plateCharacter(workflow, characters);
  const plates = characterPlates(character?.visual_tags);
  const url = plate === 'face' ? plates.face : plates.body;
  if (!url) {
    return {
      ...workflow,
      character_ref_url: undefined,
      ref_image_url: undefined,
      character_ref_urls: undefined,
      identity_plate: 'none',
      force_no_character_adapter: true,
      denoise: 1,
    };
  }
  return {
    ...workflow,
    character_ref_url: url,
    ref_image_url: url,
    character_ref_urls: [url],
    identity_plate: plate,
    force_no_character_adapter: false,
    character_adapter_weight: plate === 'body' ? 0.45 : 0.6,
    denoise: plate === 'body' ? 1 : workflow?.denoise,
  };
};
