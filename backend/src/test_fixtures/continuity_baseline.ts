// Offline diagnostic: import test_setup before application modules in every entry point.
import '../test_setup';
import { loadContinuityFixtures } from './continuity';
import { createEmptyScriptDocument } from '../schemas/script';
import type { ContinuityFixture } from './continuity';
import { FACT_POLICY_VERSION, type VisualFact } from '../schemas/storyboard_facts';
import type { AIProvider } from '../services/ai/base';
import { bindEntities, entityRoster } from '../services/entity_binding';
import { continuityAfter, continuityForScene, evidencedContinuityStates, factSourceHash, hash, runFactWorkflow, type WorkflowProgress } from '../services/storyboard_fact_workflow';
import { generateAndReplaceNarrativeTimeline } from '../services/timeline_generation_service';
import { LLMService } from '../services/llm';
import { db } from '../db/database';
import { isNodeTest } from '../services/inference_cache';

const cast = [{ id: 1, name: '林岚' }, { id: 2, name: '陈月' }];
const roster = entityRoster(cast);
const fact = (id: string, text: string, states: VisualFact['states'] = []): VisualFact => ({
  id, scene_id: 'probe', block_id: id, text, start: 0, end: text.length, kind: 'visual', beat: 0,
  states, binding: bindEntities(text, roster),
});
const documentFor = (fixture: ContinuityFixture, sourceIds: string[]) => {
  const doc = createEmptyScriptDocument(`${fixture.id} 合成基线`);
  const sources = fixture.sources.filter(row => sourceIds.includes(row.id));
  doc.locations = [{ id: `${fixture.id}:room`, name: '房间', description: '' }];
  doc.scenes = [...new Set(sources.map(row => row.scene_id))].map(id => ({
    id, locationId: `${fixture.id}:room`, interiorExterior: 'interior' as const, timeOfDay: 'day',
    characterIds: [], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [],
    blocks: sources.filter(row => row.scene_id === id).map(row => ({ id: row.id, type: 'action' as const, text: row.text })),
  }));
  return doc;
};

export async function collectContinuityBaseline() {
  if (process.env.DATABASE_URL !== ':memory:' || !isNodeTest()) throw new Error('Continuity baseline requires the test runner and in-memory database');
  const fixtures = loadContinuityFixtures();
  const main = fixtures[0]!.fixture;
  const ordered = main.cases.find(row => row.id === 'ordered')!;
  const doc = documentFor(main, ordered.source_ids);
  const requests: Array<{ input: Record<string, any>; output: unknown }> = [];
  const provider: AIProvider = {
    async generateStructured(prompt, schema) {
      const input = JSON.parse(prompt);
      let output: unknown;
      switch (input.task) {
        case 'classify': output = { items: input.sources.map((row: any) => ({ id: row.id, kind: 'visual' })) }; break;
        case 'atomicity': output = { result: 'one_frame' }; break;
        case 'beat_relation': output = { relation: 'sequential' }; break;
        case 'state': output = { states: main.legacy_mock!.states[input.facts[0].text] || [] }; break;
        case 'plan': output = { primary_by_slot: Object.fromEntries(input.slots.map((row: any) => [row.id, row.fact_ids[0] || null])) }; break;
        case 'translate': output = { translations: input.facts.map((row: any) => {
          const english = main.legacy_mock!.translations[row.text]
            || main.legacy_mock!.translations[String(row.text || '').replace(' 手持：', ' 持物：')];
          if (!english) throw new Error(`CT01 mock translation missing: ${row.text}`);
          return { id: row.id, english };
        }) }; break;
        case 'audit': output = { faithful: true }; break;
        default: throw new Error(`CT01 mock task unsupported: ${input.task}`);
      }
      requests.push({ input, output });
      return schema.parse(output);
    },
    async generateText() { throw new Error('CT01 never generates free text'); },
    async generateImage() { throw new Error('CT01 never generates images'); },
  };
  const progress: WorkflowProgress = { input_hash: 'CT01-offline', phase: 'queued', extracted: {}, plans: {}, shots: {}, metrics: [] };
  let workflow: { status: string; result?: Awaited<ReturnType<typeof runFactWorkflow>>; error?: string };
  try {
    const result = await runFactWorkflow({ doc, scriptId: 1, revision: 1, provider, model: 'CT01-mock',
      locks: [], glossary: { 林岚: 'Lin Lan', 陈月: 'Chen Yue' }, characters: cast, instructions: '',
      progress, persist: async () => {}, reuse: { forceRegenerate: true },
    });
    workflow = { status: 'observed', result };
  } catch (error) { workflow = { status: 'failed', error: error instanceof Error ? error.message : String(error) }; }

  const sameNameItems = [
    fact('left', '林岚握着左侧黑伞。', [{ entity: '林岚', attribute: 'holding', item: '黑伞', value: '左侧黑伞' }]),
    fact('right', '林岚握着右侧黑伞。', [{ entity: '林岚', attribute: 'holding', item: '黑伞', value: '右侧黑伞' }]),
  ];
  const coat = { entity: '林岚', attribute: 'wardrobe', item: '外套', value: '蓝外套', fact_id: 'coat' };
  const scarf = { entity: '林岚', attribute: 'wardrobe', item: '围巾', value: '白围巾', fact_id: 'scarf' };
  const a = continuityAfter([coat, scarf], []), b = continuityAfter([scarf, coat], []);
  const wetSource = fixtures[6]!.fixture.sources.find(row => row.id === 'coat')!.text;
  const normalized = evidencedContinuityStates(wetSource, [{ entity: '陈月', attribute: 'wetness', value: 'wet' }]);
  const legacySupported = evidencedContinuityStates(wetSource, [{ entity: '陈月', attribute: 'wardrobe', item: '外套', value: '蓝外套' }]);
  const returnDoc = documentFor(fixtures[2]!.fixture, ['leave', 'return']);
  const locationInput = [{ entity: '门锁', attribute: 'position', value: '房间', fact_id: 'lock' }];
  const returnFacts = fixtures[2]!.fixture.sources.filter(row => ['leave', 'return'].includes(row.id)).map(row => ({ ...fact(row.id, row.text), scene_id: row.scene_id }));
  const invisibleObject = continuityForScene(locationInput, returnDoc, returnFacts, 'F03:s3');
  const coverage = LLMService.buildCoverageFallbackFromSource({ shot_spec: JSON.stringify({ location: 'room', primary_action: 'Chen Yue holds umbrella', moment_id: 'F05:after-handover', snapshot_id: 'F05:snapshot-r1' }) });
  let directWrite: { status: string; http_status?: number; error?: string };
  try {
    await generateAndReplaceNarrativeTimeline({ chapterId: 'CT01', projectId: 1, content: '合成剧情' });
    directWrite = { status: 'unexpected_success' };
  } catch (error) { directWrite = { status: 'rejected', http_status: (error as { statusCode?: number }).statusCode, error: error instanceof Error ? error.message : String(error) }; }

  const hashDoc = documentFor(fixtures[7]!.fixture, ['wardrobe']);
  const revisedDoc = structuredClone(hashDoc);
  revisedDoc.scenes[0]!.blocks[0]!.text += '\n';
  const observations = {
    F01: { workflow, progress, requests, preview_scope: 'unsupported: current workflow iterates the whole document', matrix_status: 'not_accepted' },
    F02: { probe_kind: 'isolated legacy helper', same_name_input: sameNameItems, legacy_output: continuityAfter([], sameNameItems), physical_identity: 'unsupported', matrix_status: 'not_accepted' },
    F03: { probe_kind: 'isolated legacy helper', input: { state: locationInput, doc: returnDoc, facts: returnFacts }, invisible_location_object_output: invisibleObject, component_snapshots: 'unsupported', matrix_status: 'not_accepted' },
    F04: { confirmed_during_overlay: 'unsupported/N/A', matrix_status: 'not_accepted' },
    F05: { fallback_candidates: coverage, endpoint_moment_snapshot_gates: 'not_run/N/A: fallback compilation is not endpoint acceptance', matrix_status: 'not_accepted' },
    F06: { mark_continuity_stale: 'unsupported/N/A', old_image_browser_verification: 'not_run/N/A', matrix_status: 'not_accepted' },
    F07: { input_text: wetSource, normalized_value: normalized, legacy_source_quote: legacySupported, confirmed_ledger: 'unsupported/N/A', matrix_status: 'not_accepted' },
    F08: {
      exact_repeat_hash_equal: hash(a) === hash(continuityAfter([coat, scarf], [])),
      equivalent_item_permutation_hash_equal: hash(a) === hash(b), legacy_a: a, legacy_b: b,
      source_revision_hash_changes: factSourceHash(hashDoc, [], roster) !== factSourceHash(revisedDoc, [], roster),
      entity_enumeration_hash_equal: factSourceHash(hashDoc, [], roster) === factSourceHash(hashDoc, [], [...roster].reverse()),
      direct_write_service: directWrite, continuity_copy_import: 'unsupported/N/A', matrix_status: 'not_accepted',
    },
  };
  const writes = {
    scenes: Number((await db.get('SELECT COUNT(*) AS n FROM scene')).n),
    scripts: Number((await db.get('SELECT COUNT(*) AS n FROM chapter_script')).n),
    candidates: Number((await db.get('SELECT COUNT(*) AS n FROM script_change')).n),
    audits: Number((await db.get("SELECT COUNT(*) AS n FROM generation_task WHERE kind='storyboard_audit'")).n),
  };
  return {
    schema_version: 1, purpose: 'CT01 baseline only; no CT08 or model qualification', policy: FACT_POLICY_VERSION,
    runtime: { node: process.version, database: ':memory:', provider: 'deterministic mock', real_model: 'not_run', images: 'not_run' },
    fixtures: fixtures.map(({ fixture, ...fingerprints }) => ({ id: fixture.id, matrix: fixture.matrix, ...fingerprints,
      input: { entities: fixture.entities, initial_state: fixture.initial_state, sources: fixture.sources, shots: fixture.shots },
      cases: fixture.cases.map(row => ({ id: row.id, input: { source_ids: row.source_ids, operations: row.operations, entry_confirmed: row.entry_confirmed }, human_labels: row.expected })),
      expected_dependencies: fixture.expected_dependencies,
    })), observations, database_writes: writes,
  };
}
