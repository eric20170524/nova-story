import { randomUUID } from 'node:crypto';
import { ScriptDocumentSchema, type ScriptDocument } from '../schemas/script';
import {
  ContinuityEntitySchema, ContinuityEntityRelationSchema, ContinuityStoryOrderSchema,
  ContinuityStoryPositionSchema, ContinuityShotReferenceSchema,
  type ContinuityEntity, type ContinuityStoryOrder, type ContinuityStoryPosition,
} from '../schemas/continuity';
import { ShotSourceReferenceSchema, type ShotSourceReference } from '../schemas/shot_contract';

export class ContinuityIdentityError extends Error {
  constructor(message: string, public statusCode: 404 | 409 | 422 = 422,
    public code = 'CONTINUITY_SCOPE_INVALID') { super(message); }
}
type ProjectResource = { id: number; project_id: number };
export type ContinuityIdentityResources = { characters: ProjectResource[]; assets: ProjectResource[] };

/** No persistence, name merging, state mutation or legacy fact.states migration. */
export function validateContinuityEntities(projectId: number, raw: unknown[], resources: ContinuityIdentityResources): ContinuityEntity[] {
  const entities = raw.map(entity => ContinuityEntitySchema.parse(entity));
  const map = new Map<string, ContinuityEntity>();
  const characters = new Set<number>();
  const requireResource = (id: number, rows: ProjectResource[]) => {
    if (!rows.some(row => row.id === id && row.project_id === projectId)) throw new ContinuityIdentityError('Project resource not found', 404);
  };
  for (const entity of entities) {
    if (entity.project_id !== projectId) throw new ContinuityIdentityError('Entity not found in project', 404);
    if (map.has(entity.entity_id)) throw new ContinuityIdentityError('Duplicate physical entity ID');
    if (entity.character_id !== undefined) {
      requireResource(entity.character_id, resources.characters);
      if (characters.has(entity.character_id)) throw new ContinuityIdentityError('Character already has a physical identity');
      characters.add(entity.character_id);
    }
    if (entity.asset_id !== undefined) requireResource(entity.asset_id, resources.assets);
    map.set(entity.entity_id, entity);
  }
  for (const entity of entities) {
    const ancestors = new Set([entity.entity_id]);
    let parentId = entity.parent_entity_id;
    while (parentId) {
      const parent = map.get(parentId);
      if (!parent) throw new ContinuityIdentityError('Component parent not found in project', 404);
      if (ancestors.has(parentId)) throw new ContinuityIdentityError('Component parent cycle');
      ancestors.add(parentId); parentId = parent.parent_entity_id;
    }
  }
  return entities;
}

export function registerContinuityEntity(projectId: number,
  input: Omit<ContinuityEntity, 'entity_id' | 'project_id' | 'aliases'> & { aliases?: string[]; entity_id?: string },
  existing: ContinuityEntity[], resources: ContinuityIdentityResources): ContinuityEntity {
  const entity = ContinuityEntitySchema.parse({ ...input, entity_id: input.entity_id ?? randomUUID(), project_id: projectId });
  validateContinuityEntities(projectId, [...existing, entity], resources);
  return entity;
}

export function requireContinuityEntity(projectId: number, entityId: string, entities: ContinuityEntity[]) {
  const entity = entities.find(entity => entity.entity_id === entityId && entity.project_id === projectId);
  if (!entity) throw new ContinuityIdentityError('Entity not found in project', 404);
  return structuredClone(entity);
}

/** Existing cast IDs map directly to physical characters; equal names do not choose a person. */
export function requireContinuityCharacter(projectId: number, characterId: number, entities: ContinuityEntity[]) {
  const matches = entities.filter(entity => entity.project_id === projectId && entity.kind === 'character' && entity.character_id === characterId);
  if (!matches.length) throw new ContinuityIdentityError('Character identity not found in project', 404);
  if (matches.length !== 1) throw new ContinuityIdentityError('Character identity needs review', 409, 'CONTINUITY_REVIEW_REQUIRED');
  return structuredClone(matches[0]!);
}

/** Names are lookup suggestions only; ambiguity is preserved, never resolved by asset identity. */
export function continuityEntityCandidates(projectId: number, name: string, entities: ContinuityEntity[]) {
  const query = name.trim();
  return entities.filter(entity => entity.project_id === projectId && (entity.display_name === query || entity.aliases.includes(query)))
    .map(entity => structuredClone(entity)).sort((a, b) => a.entity_id.localeCompare(b.entity_id));
}

export function validateContinuityEntityRelation(projectId: number, raw: unknown, entities: ContinuityEntity[]) {
  const relation = ContinuityEntityRelationSchema.parse(raw);
  if (relation.project_id !== projectId) throw new ContinuityIdentityError('Relation not found in project', 404);
  requireContinuityEntity(projectId, relation.entity_id, entities);
  requireContinuityEntity(projectId, relation.target_entity_id, entities);
  return relation;
}

/** The initial linear segment uses screenplay revision as its order revision. */
export function buildContinuityStoryOrder(input: {
  project_id: number; script_id: number; script_revision: number; story_segment_id: string; document: ScriptDocument;
}): ContinuityStoryOrder {
  const document = ScriptDocumentSchema.parse(input.document);
  return ContinuityStoryOrderSchema.parse({
    version: 1, project_id: input.project_id, script_id: input.script_id, script_revision: input.script_revision,
    screenplay_order_revision: input.script_revision, story_segment_id: input.story_segment_id,
    scenes: document.scenes.map((scene, index) => ({ script_scene_id: scene.id, scene_order: index, beat_ids: [...scene.beatIds] })),
  });
}

export function validateContinuityStoryPosition(raw: unknown, order: ContinuityStoryOrder): ContinuityStoryPosition {
  const position = ContinuityStoryPositionSchema.parse(raw);
  const checkedOrder = ContinuityStoryOrderSchema.parse(order);
  if (position.project_id !== checkedOrder.project_id) throw new ContinuityIdentityError('Story position not found in project', 404);
  if (position.script_id !== checkedOrder.script_id || position.story_segment_id !== checkedOrder.story_segment_id) throw new ContinuityIdentityError('Story position belongs to another script or segment');
  if (position.script_revision !== checkedOrder.script_revision || position.screenplay_order_revision !== checkedOrder.screenplay_order_revision) throw new ContinuityIdentityError('Story order revision changed', 409, 'CONTINUITY_STALE');
  const scene = checkedOrder.scenes.find(scene => scene.script_scene_id === position.script_scene_id);
  if (!scene || scene.scene_order !== position.scene_order) throw new ContinuityIdentityError('Scene does not match screenplay order');
  if (position.beat_id !== null && (scene.beat_ids[position.beat_order!] !== position.beat_id)) throw new ContinuityIdentityError('Beat does not belong to screenplay scene');
  return position;
}

export function makeContinuityStoryPosition(order: ContinuityStoryOrder, input: {
  script_scene_id: string; beat_id?: string; change_order: number; moment_id: string; phase: ContinuityStoryPosition['phase'];
}) {
  const checkedOrder = ContinuityStoryOrderSchema.parse(order);
  const scene = checkedOrder.scenes.find(scene => scene.script_scene_id === input.script_scene_id);
  if (!scene) throw new ContinuityIdentityError('Unknown screenplay scene');
  const beatOrder = input.beat_id === undefined ? null : scene.beat_ids.indexOf(input.beat_id);
  if (beatOrder === -1) throw new ContinuityIdentityError('Beat does not belong to screenplay scene');
  const { scenes: _scenes, ...revision } = checkedOrder;
  return validateContinuityStoryPosition({ ...revision, script_scene_id: scene.script_scene_id,
    scene_order: scene.scene_order, beat_id: input.beat_id ?? null, beat_order: beatOrder,
    change_order: input.change_order, moment_id: input.moment_id, phase: input.phase,
  }, checkedOrder);
}

/** Coverage insertion order is intentionally not an input to story position. CT06 supplies endpoint gates. */
export function coverageContinuitySource(input: {
  project_id: number; source_shot_id: number; source: ShotSourceReference;
}, order: ContinuityStoryOrder, entities: ContinuityEntity[]): ShotSourceReference {
  const source = ShotSourceReferenceSchema.parse(input.source);
  if (!source.continuity) throw new ContinuityIdentityError('Continuity reference required', 409, 'CONTINUITY_ENTRY_REQUIRED');
  if (input.project_id !== order.project_id) throw new ContinuityIdentityError('Source shot not found in project', 404);
  const position = validateContinuityStoryPosition(source.continuity.story_position, order);
  for (const entityId of source.continuity.entity_ids) requireContinuityEntity(input.project_id, entityId, entities);
  return ShotSourceReferenceSchema.parse({ ...source, continuity: ContinuityShotReferenceSchema.parse({
    ...source.continuity, story_position: position, source_shot_id: input.source_shot_id,
  }) });
}
