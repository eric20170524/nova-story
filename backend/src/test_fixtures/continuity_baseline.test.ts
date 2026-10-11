import '../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadContinuityFixtures, validateContinuityFixture } from './continuity';
import { collectContinuityBaseline } from './continuity_baseline';
import frozenLabels from './continuity/labels-v1.json';

test('CT01 F01–F08 have independent positive/negative labels and closed dependencies', () => {
  const loaded = loadContinuityFixtures();
  assert.equal(loaded.length, 8);
  assert.deepEqual(Object.fromEntries(loaded.map(row => [row.fixture.id, row.labels_sha256])), frozenLabels.labels_sha256, 'labels changed: review and version the fixture dataset before changing the frozen oracle');
  const matrix = new Set(loaded.flatMap(row => row.fixture.matrix));
  for (const id of ['C01-A', 'C02-A', 'C03-A', 'C04-A', 'C05-A', 'C06-A', 'C07-A', 'C08-A', 'C09-A', 'C10-A', 'C11-A', 'C13-A', 'C16']) assert.ok(matrix.has(id), id);
  const allIds = loaded.flatMap(row => row.fixture.entities.map(entity => entity.id));
  assert.equal(new Set(allIds).size, allIds.length);
  for (const row of loaded) {
    assert.match(row.input_sha256, /^[a-f0-9]{64}$/);
    assert.match(row.labels_sha256, /^[a-f0-9]{64}$/);
    for (const evidence of row.evidence) {
      const source = row.fixture.sources.find(source => source.id === evidence.source_id)!;
      assert.equal(source.text.slice(evidence.start, evidence.end), evidence.evidence_quote);
      assert.equal(evidence.source_revision, 1);
    }
  }
});

test('CT01 validator rejects cross-project relations and component parents', () => {
  const fixture = loadContinuityFixtures()[1]!.fixture;
  for (const change of [
    (value: typeof fixture) => { value.initial_state['F02:u1']!.holder = 'F01:lin'; },
    (value: typeof fixture) => { value.entities[0]!.parent_entity_id = 'F01:door'; },
  ]) {
    const invalid = structuredClone(fixture); change(invalid);
    assert.throws(() => validateContinuityFixture(invalid), /cross-project relation|unknown component parent/);
  }
});

test('CT01 validator distinguishes same names, confirmed null and unknown', () => {
  const fixture = loadContinuityFixtures()[1]!.fixture;
  assert.equal(fixture.entities.filter(entity => entity.name === '黑伞').length, 2);
  assert.deepEqual(fixture.initial_state['F02:coat1']!.wetness, { unknown: true });
  assert.equal(fixture.initial_state['F02:u2']!.holder, null);
  const invalid = structuredClone(fixture);
  invalid.entities[6]!.id = invalid.entities[5]!.id;
  assert.throws(() => validateContinuityFixture(invalid), /duplicate physical entity/);
  const invalidClear = structuredClone(fixture);
  invalidClear.cases[0]!.expected.changes[1]!.value = { unknown: true };
  assert.throws(() => validateContinuityFixture(invalidClear), /clear must be confirmed null/);
});

test('CT01 during labels preserve intact entry state and require an independent overlay', () => {
  const fixture = loadContinuityFixtures()[3]!.fixture;
  const during = fixture.cases[0]!.expected.moments!.find(moment => moment.phase === 'during')!;
  assert.equal(during.checks['F04:cup']!.integrity, 'intact');
  assert.equal(fixture.cases[0]!.expected.checks['F04:cup']!.integrity, 'broken');
  const invalid = structuredClone(fixture);
  const invalidDuring = invalid.cases[0]!.expected.moments!.find(moment => moment.phase === 'during')!;
  delete invalidDuring.source_id;
  assert.throws(() => validateContinuityFixture(invalid), /during requires separate evidence/);
});

test('CT01 stale labels preserve images and separate unrelated shots', () => {
  const { fixture, media } = loadContinuityFixtures()[5]!;
  assert.equal(fixture.shots[0]!.versions!.length, 2);
  assert.ok(fixture.shots[0]!.coverage_ids!.length);
  assert.ok(fixture.shots[0]!.reference_snapshot_id);
  assert.ok(fixture.shots.every(shot => shot.asset_url));
  assert.deepEqual(media.map(image => image.version), ['F06:v1', 'F06:v2', 'F06:v3']);
  assert.ok(media.every(image => image.data_url.startsWith('data:image/svg+xml;base64,')));
  assert.notEqual(media[0]!.sha256, media[1]!.sha256);
  const invalid = structuredClone(fixture);
  invalid.expected_dependencies.affected_shots.push('F06:unrelated');
  invalid.expected_dependencies.unchanged_shots = [];
  assert.throws(() => validateContinuityFixture(invalid), /dependency label contradicts/);
});

test('CT01 shared holding and unknown time retain evidence without forced confirmation', () => {
  const fixture = loadContinuityFixtures()[6]!.fixture;
  const shared = fixture.cases.find(row => row.id === 'shared-holder')!;
  assert.deepEqual(shared.expected.retained_entity_ids, ['F07:lin', 'F07:chen']);
  assert.equal(shared.expected.status, 'pending_review');
  assert.equal(shared.expected.changes.length, 0);
  const unknown = fixture.cases.find(row => row.id === 'unknown-time')!;
  assert.deepEqual(unknown.expected.checks['F07:u1']!.integrity, { unknown: true });
  assert.ok(unknown.source_ids.every(id => fixture.sources.some(source => source.id === id)));
});

test('CT01 offline baseline captures current outputs and N/A without production writes', async () => {
  const report = await collectContinuityBaseline();
  // Existing capabilities must succeed; missing future capabilities are recorded separately.
  assert.equal(report.observations.F01.workflow.status, 'observed', report.observations.F01.workflow.error);
  const shots = report.observations.F01.workflow.result!.shots;
  assert.deepEqual([...new Set(shots.map(shot => shot.script_scene_id))], ['F01:s1', 'F01:s2', 'F01:s3']);
  assert.equal(report.observations.F02.legacy_output.length, 1);
  assert.equal(report.observations.F07.legacy_source_quote.accepted.length, 1);
  assert.equal(report.observations.F07.normalized_value.rejected.length, 1);
  assert.equal(report.observations.F08.exact_repeat_hash_equal, true);
  assert.equal(report.observations.F08.equivalent_item_permutation_hash_equal, false);
  assert.equal(report.observations.F08.direct_write_service.http_status, 410);
  assert.equal(report.database_writes.scenes, 0);
  assert.equal(report.database_writes.scripts, 0);
  assert.equal(report.database_writes.candidates, 0);
  assert.equal(report.runtime.real_model, 'not_run');
  assert.ok(Object.values(report.observations).every(row => row.matrix_status === 'not_accepted'));
  if (process.env.CONTINUITY_BASELINE_REPORT) {
    const root = path.resolve(__dirname, '../../..');
    const output = path.resolve(root, process.env.CONTINUITY_BASELINE_REPORT);
    const relative = path.relative(root, output);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'report must be inside workspace');
    const git = (...args: string[]) => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
    const archive = { recorded_at: new Date().toISOString(), code: { head: git('rev-parse', 'HEAD'), working_tree: git('status', '--short') }, ...report };
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(archive, null, 2) + '\n', 'utf8');
  }
});
