import { z } from 'zod';

export const CONTINUITY_IDENTITY_VERSION = 1 as const;
const id = z.string().min(1).max(160).refine(value => value === value.trim(), 'IDs must not contain surrounding whitespace');
const resourceId = z.number().int().positive();

/** One physical identity. Display names and design assets are deliberately not unique. */
export const ContinuityEntitySchema = z.object({
  entity_id: id,
  project_id: resourceId,
  kind: z.enum(['character', 'garment', 'prop', 'object', 'component', 'location']),
  display_name: z.string().trim().min(1).max(240),
  aliases: z.array(z.string().trim().min(1).max(240)).default([]),
  parent_entity_id: id.optional(),
  character_id: resourceId.optional(),
  asset_id: resourceId.optional(),
  asset_revision: resourceId.optional(),
}).strict().superRefine((entity, context) => {
  if ((entity.kind === 'character') !== (entity.character_id !== undefined)) context.addIssue({ code: 'custom', path: ['character_id'], message: 'Only character identities require a character ID' });
  if (entity.kind === 'component' && !entity.parent_entity_id) context.addIssue({ code: 'custom', path: ['parent_entity_id'], message: 'Components require a parent identity' });
  if (entity.parent_entity_id === entity.entity_id) context.addIssue({ code: 'custom', path: ['parent_entity_id'], message: 'An entity cannot be its own parent' });
  if (entity.asset_revision !== undefined && entity.asset_id === undefined) context.addIssue({ code: 'custom', path: ['asset_revision'], message: 'An asset revision requires an asset ID' });
});
export type ContinuityEntity = z.infer<typeof ContinuityEntitySchema>;

/** Attribute semantics and confirmation belong to CT03; this only establishes reference scope. */
export const ContinuityEntityRelationSchema = z.object({
  project_id: resourceId, entity_id: id, target_entity_id: id,
}).strict();
export type ContinuityEntityRelation = z.infer<typeof ContinuityEntityRelationSchema>;

export const ContinuityStoryOrderSchema = z.object({
  version: z.literal(CONTINUITY_IDENTITY_VERSION), project_id: resourceId, script_id: resourceId,
  script_revision: resourceId, screenplay_order_revision: resourceId, story_segment_id: id,
  scenes: z.array(z.object({ script_scene_id: id, scene_order: z.number().int().nonnegative(), beat_ids: z.array(id) }).strict()).min(1),
}).strict().superRefine((order, context) => {
  if (order.screenplay_order_revision !== order.script_revision) context.addIssue({ code: 'custom', path: ['screenplay_order_revision'], message: 'Initial linear order is versioned by its screenplay revision' });
  if (new Set(order.scenes.map(scene => scene.script_scene_id)).size !== order.scenes.length) context.addIssue({ code: 'custom', path: ['scenes'], message: 'Duplicate screenplay scene ID' });
  order.scenes.forEach((scene, index) => {
    if (scene.scene_order !== index) context.addIssue({ code: 'custom', path: ['scenes', index, 'scene_order'], message: 'Story order must follow the screenplay array' });
    if (new Set(scene.beat_ids).size !== scene.beat_ids.length) context.addIssue({ code: 'custom', path: ['scenes', index, 'beat_ids'], message: 'Duplicate beat ID in scene' });
  });
});
export type ContinuityStoryOrder = z.infer<typeof ContinuityStoryOrderSchema>;

export const ContinuityStoryPositionSchema = z.object({
  version: z.literal(CONTINUITY_IDENTITY_VERSION), project_id: resourceId, script_id: resourceId,
  script_revision: resourceId, screenplay_order_revision: resourceId, story_segment_id: id,
  script_scene_id: id, scene_order: z.number().int().nonnegative(),
  beat_id: id.nullable(), beat_order: z.number().int().nonnegative().nullable(),
  change_order: z.number().int().nonnegative(), moment_id: id,
  phase: z.enum(['before', 'during', 'after']),
  time_scope: z.object({version:z.literal(1),day_id:id,branch_id:id}).strict().optional(),
}).strict().superRefine((position, context) => {
  if ((position.beat_id === null) !== (position.beat_order === null)) context.addIssue({ code: 'custom', path: ['beat_order'], message: 'Beat ID and beat order must both be present or both be null' });
});
export type ContinuityStoryPosition = z.infer<typeof ContinuityStoryPositionSchema>;

/** A timeline shot may read a moment without creating or advancing a story event. */
export const ContinuityShotReferenceSchema = z.object({
  story_position: ContinuityStoryPositionSchema,
  entity_ids: z.array(id),
  source_shot_id: resourceId.optional(),
  reference: z.object({
    snapshot_id: id, snapshot_revision: resourceId,
    state_hash: z.string().regex(/^[a-f0-9]{64}$/), source_hash: z.string().regex(/^[a-f0-9]{64}$/), dependency_hash: z.string().regex(/^[a-f0-9]{64}$/),
    reads: z.array(z.object({ entity_id: id, attribute_id: id }).strict()),
  }).strict().optional(),
}).strict().superRefine((reference, context) => {
  if (new Set(reference.entity_ids).size !== reference.entity_ids.length) context.addIssue({ code: 'custom', path: ['entity_ids'], message: 'Duplicate physical entity dependency' });
});
export type ContinuityShotReference = z.infer<typeof ContinuityShotReferenceSchema>;
