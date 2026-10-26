/**
 * Identity plates are single figures.
 * The face plate is the approved portrait. The body plate is the turnaround front
 * panel. The stitched three-view sheet and a corner face crop are not references.
 */

export type IdentityPlate = 'face' | 'body' | 'multi' | 'none';

export interface CharacterPlateSource {
  id?: number | null;
  name?: string | null;
  english_name?: string | null;
  visual_tags?: unknown;
}

export interface CharacterRefBinding {
  slot: number;
  character_id: number | null;
  name: string;
  english_name?: string;
  gender?: string;
  image_url: string;
  plate: 'face' | 'body';
}

export interface CharacterPlates {
  face: string | null;
  body: string | null;
}

export const buildQwenMultiReferencePrefix = (
  bindings: CharacterRefBinding[],
  glossary: Record<string, string> = {}
): string => {
  if (!Array.isArray(bindings) || bindings.length === 0) return '';
  const clauses = bindings.map((b) => {
    const rawName = b.english_name || glossary[b.name] || b.name;
    const displayName = /[\u4e00-\u9fa5]/.test(rawName) ? `Character ${b.slot}` : rawName;
    const isFemale = String(b.gender || '').toLowerCase() === 'female';
    const genderLock = isFemale
      ? ' (adult woman, female; preserve her exact feminine facial structure, delicate features, feminine body proportions, hairstyle, and costume)'
      : '';
    return `<Picture ${b.slot}> (image ${b.slot}) is the identity reference for ${displayName}${genderLock}; preserve face, hairstyle, costume and identity details from this picture.`;
  });
  return clauses.join(' ');
};

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

/**
 * Adopt a full-body plate. The single front plate is both the displayed turnaround image
 * and the body identity plate, so both fields move together and legacy side/back urls go.
 * A save that repeats the stored turnaround_url changes nothing: legacy characters keep a
 * stitched sheet there and a separate front plate, and an unrelated edit must not clobber it.
 * Returns true when the plate changed.
 */
export const applyTurnaroundPlate = (
  assets: Record<string, any>,
  url: string | null | undefined,
  previousTurnaroundUrl?: string | null
): boolean => {
  const next = text(url);
  const prev = previousTurnaroundUrl !== undefined
    ? text(previousTurnaroundUrl)
    : text(assets.turnaround_url);
  if (next === prev && (previousTurnaroundUrl !== undefined || assets.turnaround_front_url !== undefined)) {
    return false;
  }
  assets.turnaround_url = url ?? null;
  assets.turnaround_front_url = next || null;
  delete assets.turnaround_side_url;
  delete assets.turnaround_back_url;
  return true;
};

const shotText = (workflow: any): string => [
  workflow?.shot_type,
  workflow?.shot_intent,
  workflow?.shot_spec?.shot_type,
  workflow?.shot_spec?.shot_intent,
  workflow?.shot_spec?.subject_scale,
].map(text).join(' ').toLowerCase();

export const isQwenImageWorkflow = (workflow: any): boolean => {
  const model = text(
    workflow?.model_type
    || workflow?.reference_model_type
    || workflow?.model_class
    || workflow?.project_settings?.image_generation?.model
  ).toLowerCase();
  return /qwen[_-]?image/.test(model);
};

export const orderedVisibleCharacters = (
  workflow: any,
  characters: CharacterPlateSource[]
): CharacterPlateSource[] => {
  const result: CharacterPlateSource[] = [];
  const seen = new Set<string>();
  const add = (char: CharacterPlateSource | undefined | null) => {
    if (!char) return;
    const key = char.id != null ? `id:${char.id}` : `name:${text(char.name)}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(char);
  };

  const names = Array.isArray(workflow?.shot_spec?.visible_subjects)
    ? workflow.shot_spec.visible_subjects.map(text).filter(Boolean)
    : [];
  for (const name of names) {
    add(characters.find((c) => text(c.name) === name));
  }

  const ids = Array.isArray(workflow?.shot_master_character_ids)
    ? workflow.shot_master_character_ids.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  for (const id of ids) {
    add(characters.find((c) => Number(c.id) === id));
  }
  return result;
};

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

  // Qwen-Image 2.1 native multi-image reference branch
  if (isQwenImageWorkflow(workflow)) {
    const shot = shotText(workflow);
    const isEmptyOrOverhead = /\b(overhead-map|absent|insert shot|detail shot|macro shot|object close-up|prop close-up)\b|(?:俯瞰|鸟瞰|空镜)/.test(shot);
    const ordered = isEmptyOrOverhead ? [] : orderedVisibleCharacters(workflow, characters);
    const preferBody = /\b(full(?:\s|-)?body|full shot|全身)\b/.test(shot);

    const pinnedById = new Map<number, string>();
    if (Array.isArray(workflow?.pinned_character_refs)) {
      for (const ref of workflow.pinned_character_refs) {
        if (ref?.id && ref?.image_url) pinnedById.set(Number(ref.id), text(ref.image_url));
      }
    }

    const bindings: CharacterRefBinding[] = [];
    for (const char of ordered.slice(0, 6)) {
      const plates = characterPlates(char.visual_tags);
      const tags = asRecord(char.visual_tags);
      const design = asRecord(tags.design);
      const pinnedUrl = char.id != null ? pinnedById.get(Number(char.id)) : undefined;
      const chosenUrl = pinnedUrl || (preferBody ? (plates.body || plates.face) : (plates.face || plates.body));
      if (!chosenUrl) continue;
      const chosenPlate: 'face' | 'body' = chosenUrl === plates.body && !plates.face ? 'body' : 'face';
      bindings.push({
        slot: bindings.length + 1,
        character_id: char.id != null ? Number(char.id) : null,
        name: text(char.name),
        english_name: text(char.english_name),
        gender: text(design.gender),
        image_url: chosenUrl,
        plate: chosenPlate,
      });
    }

    if (bindings.length > 0) {
      const urls = bindings.map((b) => b.image_url);
      return {
        ...workflow,
        character_ref_url: urls[0],
        ref_image_url: urls[0],
        character_ref_urls: urls,
        character_ref_bindings: bindings,
        identity_plate: bindings.length === 1 ? bindings[0]!.plate : 'multi',
        force_no_character_adapter: false,
        denoise: 1,
      };
    }
    return {
      ...workflow,
      character_ref_url: undefined,
      ref_image_url: undefined,
      character_ref_urls: undefined,
      character_ref_bindings: undefined,
      identity_plate: 'none',
      force_no_character_adapter: true,
      denoise: 1,
    };
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
