import { z } from 'zod';

export const EntityRefSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });
export const EntityMentionSchema = z.object({
  text: z.string(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
  status: z.enum(['resolved', 'ambiguous', 'unknown']),
  entity: EntityRefSchema.nullable(), candidates: z.array(EntityRefSchema),
  authority: z.enum(['literal', 'single_subject', 'model_proposal', 'model_resolution', 'human']),
  confirmed: z.boolean(), visibility: z.enum(['visible', 'mentioned', 'uncertain']),
});
/** Embedded in the exact text version it interprets; never a mutable side table. */
export const EntityBindingSchema = z.object({
  version: z.literal(1), text_hash: z.string(), context_hash: z.string(),
  mentions: z.array(EntityMentionSchema),
});
export type EntityRef = z.infer<typeof EntityRefSchema>;
export type EntityBinding = z.infer<typeof EntityBindingSchema>;

export const isPluralMention = (m: { text: string }) => /^(?:她们|他们|它们|两人|双方|众人)$/u.test(m.text);
