// CT01 test data only. These labels are not the future production continuity schema.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const valueSchema = z.union([z.string(), z.null(), z.object({ unknown: z.literal(true) }).strict()]);
const statesSchema = z.record(z.string(), z.record(z.string(), valueSchema));
const dependencySchema = z.object({ entity_id: z.string(), attribute_id: z.string() });
const fixtureSchema = z.object({
  id: z.string().regex(/^F0[1-8]$/), version: z.literal(1), title: z.string().min(1),
  matrix: z.array(z.string()).min(1), project_id: z.string(), source_revision: z.number().int().positive(),
  story_order_revision: z.number().int().positive(),
  entities: z.array(z.object({
    id: z.string(), kind: z.enum(['character', 'garment', 'prop', 'object', 'component', 'location']),
    name: z.string().min(1), character_id: z.number().int().optional(),
    parent_entity_id: z.string().optional(), asset_id: z.string().optional(),
  })).min(1),
  initial_state: statesSchema,
  sources: z.array(z.object({ id: z.string(), scene_id: z.string(), text: z.string().min(1) })).min(1),
  cases: z.array(z.object({
    id: z.string(), polarity: z.enum(['positive', 'negative']), source_ids: z.array(z.string()).min(1),
    entry_confirmed: z.boolean().optional(), operations: z.array(z.string()).min(1),
    expected: z.object({
      status: z.enum(['ready', 'pending_review', 'conflict']),
      changes: z.array(z.object({
        entity_id: z.string(), attribute_id: z.string(), operation: z.enum(['assign', 'clear', 'transfer']),
        value: valueSchema, source_id: z.string(), from: z.string().optional(), authority: z.literal('human').optional(),
      })),
      checks: statesSchema, issues: z.array(z.string()),
      moments: z.array(z.object({
        id: z.string(), phase: z.enum(['before', 'during', 'after']), checks: statesSchema,
        source_id: z.string().optional(), design_id: z.string().optional(), overlay: statesSchema.optional(),
      })).optional(),
      retained_entity_ids: z.array(z.string()).optional(),
    }).passthrough(),
  })).min(2),
  shots: z.array(z.object({
    id: z.string(), scene_id: z.string(), reads: z.array(dependencySchema),
    asset_url: z.string().optional(), versions: z.array(z.string()).optional(),
    moment_id: z.string().optional(), snapshot_id: z.string().optional(),
    reference_snapshot_id: z.string().optional(), coverage_ids: z.array(z.string()).optional(),
    version_media: z.record(z.string(), z.string()).optional(),
  })),
  expected_dependencies: z.object({
    trigger: dependencySchema, affected_shots: z.array(z.string()), unchanged_shots: z.array(z.string()),
  }),
  legacy_mock: z.object({
    states: z.record(z.string(), z.array(z.object({ entity: z.string(), attribute: z.string(), item: z.string(), value: z.string() }))),
    translations: z.record(z.string(), z.string()),
  }).optional(),
});
export type ContinuityFixture = z.infer<typeof fixtureSchema>;
export type FixtureStates = z.infer<typeof statesSchema>;
const relationAttributes = new Set(['wearer', 'holder', 'owner', 'location']);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function validateContinuityFixture(raw: unknown): ContinuityFixture {
  const fixture = fixtureSchema.parse(raw);
  const require = (ok: boolean, message: string) => { if (!ok) throw new Error(`${fixture.id}: ${message}`); };
  const ids = new Set(fixture.entities.map(entity => entity.id));
  const sources = new Set(fixture.sources.map(source => source.id));
  const shots = new Set(fixture.shots.map(shot => shot.id));
  require(ids.size === fixture.entities.length, 'duplicate physical entity ID');
  require(sources.size === fixture.sources.length, 'duplicate source ID');
  require(shots.size === fixture.shots.length, 'duplicate shot ID');
  require(new Set(fixture.cases.map(row => row.id)).size === fixture.cases.length, 'duplicate case ID');
  require(fixture.project_id === `${fixture.id}:project`, 'fixture project mismatch');
  for (const entity of fixture.entities) {
    require(entity.id.startsWith(`${fixture.id}:`), 'cross-project entity');
    if (entity.parent_entity_id) require(ids.has(entity.parent_entity_id), 'unknown component parent');
    if (entity.kind === 'character') require(entity.character_id !== undefined, 'character ID required');
  }
  const validateValue = (attribute: string, value: z.infer<typeof valueSchema>) => {
    if (relationAttributes.has(attribute) && typeof value === 'string') require(ids.has(value), 'cross-project relation');
  };
  const validateStates = (state: FixtureStates) => {
    for (const [entity, cells] of Object.entries(state)) {
      require(ids.has(entity), 'unknown state entity');
      for (const [attribute, value] of Object.entries(cells)) validateValue(attribute, value);
    }
  };
  validateStates(fixture.initial_state);
  for (const source of fixture.sources) require(source.scene_id.startsWith(`${fixture.id}:`), 'cross-project scene');
  for (const row of fixture.cases) {
    require(row.source_ids.every(id => sources.has(id)), 'unknown case source');
    if (row.expected.status !== 'ready') require(row.expected.issues.length > 0, 'blocked case requires issue');
    for (const change of row.expected.changes) {
      require(ids.has(change.entity_id), 'unknown change entity');
      require(row.source_ids.includes(change.source_id), 'change evidence outside case');
      validateValue(change.attribute_id, change.value);
      if (change.operation === 'clear') require(change.value === null, 'clear must be confirmed null');
      if (change.operation === 'transfer') require(change.attribute_id === 'holder' && !!change.from && ids.has(change.from) && typeof change.value === 'string', 'transfer requires old and new holders');
    }
    validateStates(row.expected.checks);
    for (const moment of row.expected.moments || []) {
      validateStates(moment.checks);
      if (moment.overlay) validateStates(moment.overlay);
      if (moment.phase === 'during') {
        require(!!moment.overlay && (!!moment.source_id || !!moment.design_id), 'during requires separate evidence or design overlay');
        if (moment.source_id) require(row.source_ids.includes(moment.source_id), 'moment evidence outside case');
      }
    }
    for (const id of row.expected.retained_entity_ids || []) require(ids.has(id), 'unknown retained entity');
    if (typeof row.expected.same_as === 'string') require(fixture.cases.some(other => other.id === row.expected.same_as && other.id !== row.id), 'unknown equivalent case');
  }
  require(fixture.cases.some(row => row.polarity === 'positive') && fixture.cases.some(row => row.polarity === 'negative'), 'positive and negative inputs required');
  for (const shot of fixture.shots) {
    require(shot.scene_id.startsWith(`${fixture.id}:`), 'cross-project shot scene');
    for (const dependency of shot.reads) require(ids.has(dependency.entity_id), 'unknown shot dependency');
    if (shot.asset_url) require((shot.versions?.length || 0) > 0, 'old image requires version data');
  }
  const deps = fixture.expected_dependencies;
  require(ids.has(deps.trigger.entity_id), 'unknown trigger entity');
  const allExpectedShots = [...deps.affected_shots, ...deps.unchanged_shots];
  require(allExpectedShots.every(id => shots.has(id)), 'unknown expected shot');
  require(new Set(allExpectedShots).size === allExpectedShots.length, 'affected and unchanged overlap');
  for (const shot of fixture.shots) {
    const readsTrigger = shot.reads.some(read => read.entity_id === deps.trigger.entity_id && read.attribute_id === deps.trigger.attribute_id);
    require(readsTrigger === deps.affected_shots.includes(shot.id), 'dependency label contradicts declared reads');
    require(allExpectedShots.includes(shot.id), 'shot has no dependency label');
  }
  return fixture;
}

export function loadContinuityFixtures() {
  return Array.from({ length: 8 }, (_, index) => {
    const id = `F0${index + 1}`;
    const file = path.join(__dirname, 'continuity', `${id}.json`);
    const raw = readFileSync(file, 'utf8');
    const fixture = validateContinuityFixture(JSON.parse(raw));
    const media = fixture.shots.flatMap(shot => Object.entries(shot.version_media || {}).map(([version, relativePath]) => {
      if (!shot.versions?.includes(version) || !/^media\/[\w-]+\.svg$/.test(relativePath)) throw new Error(`${id}: invalid version media`);
      const svg = readFileSync(path.join(__dirname, 'continuity', relativePath), 'utf8');
      if (!svg.startsWith('<svg ') || !svg.includes('</svg>')) throw new Error(`${id}: invalid SVG fixture`);
      return { shot_id: shot.id, version, path: relativePath, sha256: sha256(svg), data_url: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
    }));
    return {
      fixture,
      input_sha256: sha256(raw),
      labels_sha256: sha256(JSON.stringify(fixture.cases.map(row => ({ id: row.id, expected: row.expected })))),
      media,
      // Evidence offsets use JavaScript string indices: UTF-16, [start, end).
      evidence: fixture.sources.map(source => ({
        source_document_id: `${id}:script`, source_revision: fixture.source_revision,
        source_id: source.id, source_text_hash: sha256(source.text),
        start: 0, end: source.text.length, evidence_quote: source.text,
      })),
    };
  });
}
