import '../test_setup';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { db } from '../db/database';
import { createEmptyScriptDocument } from '../schemas/script';
import { confirmedContinuityFixture } from '../test_fixtures/continuity_confirmed';
import { commitContinuityLedger, loadContinuityLedger, currentContinuitySnapshot, bindContinuityShot, continuitySourceFingerprint,
  serializeContinuityRecord, restoreContinuityRecord, ContinuityStoreError } from './continuity_store';
import { replayContinuityScene } from './continuity_replay';
import { createSceneVersion, activateSceneVersion } from './scene_versions';
import { exportContinuity, restoreContinuity } from './continuity_backup';
import { AssetLibraryService } from './asset_library_service';
import { confirmContinuityTimePlan, continuityTimePlanHash } from './continuity_time';
import { continuityHash } from './continuity_replay';
import { continuityAttributeVersion } from '../schemas/continuity_state';
import { bindProductionReferences, requireProductionReferencePin, reviewProductionImage } from './scene_production_media';

beforeEach(async () => { await db.run('DELETE FROM project WHERE id IN (10,20)'); });
async function seed(caseId = 'same-input-revalidation', fixtureId = 'F06') {
  const data = confirmedContinuityFixture(fixtureId, caseId);
  const doc = createEmptyScriptDocument('CT05');
  doc.locations = [{ id: 'room', name: '房间', description: '' }];
  doc.scenes = data.input.context.order.scenes.map(scene => ({ id: scene.script_scene_id, locationId: 'room', interiorExterior: 'interior' as const, timeOfDay: 'day',
    characterIds: [], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [], blocks: [{ id: `${scene.script_scene_id}:block`, type: 'action' as const, text: data.fixture.sources.find(source => source.scene_id === scene.script_scene_id)!.text }] }));
  await db.run("INSERT INTO project(id,title,user_id) VALUES(10,'CT05','test-user')");
  await db.run("INSERT INTO chapter(id,project_id,\"index\",title,content) VALUES('ct05',10,0,'CT05',?)", data.fixture.sources.map(source => source.text).join('\n'));
  await db.run("INSERT INTO character(id,project_id,name) VALUES(1,10,'林岚'),(2,10,'陈月')");
  await db.run("INSERT INTO chapter_script(id,chapter_id,revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash) VALUES(30,'ct05',1,'confirmed',?,'{}','fixture','fixture')", JSON.stringify(doc));
  await db.run(`INSERT INTO scene(id,chapter_id,"index",visual_prompt,audio_prompt,asset_status,asset_url) VALUES(101,'ct05',0,'broken umbrella','rain','completed','/old-umbrella.svg'),(102,'ct05',1,'blue coat','silence','completed','/old-coat.svg')`);
  const params = { script_id: 30, expected_revision: 0, expected_script_revision: 1, request_key: 'entry-1', actor_id: 'fixture-reviewer', reason: '人工确认入口', input: data.input };
  return { ...data, params };
}
const code = (code: string) => (error: unknown) => error instanceof ContinuityStoreError && error.code === code;

test('CT05 approved ledger survives JSON persistence by revalidating original cell/change approvals', async () => {
  const { input, params } = await seed('upstream-revision');
  const serialized = serializeContinuityRecord(input);
  const restored = restoreContinuityRecord(JSON.parse(JSON.stringify(serialized)));
  assert.equal(replayContinuityScene(restored, 'F06:s3').status, 'ready');
  const result = await commitContinuityLedger(params);
  assert.equal(result.snapshots.length, 3);
  const ledger = await loadContinuityLedger(30);
  assert.equal(ledger.revision, 1);
  assert.ok(ledger.input);
  const snapshot = await currentContinuitySnapshot(30, 'F06:s3');
  assert.equal(snapshot.snapshot.exit_state.find(cell => cell.entity_id === 'F06:u1' && cell.attribute_id === 'integrity')!.knowledge_status, 'confirmed');
  const latest = await db.get('SELECT * FROM continuity_snapshot WHERE id=?', snapshot.id);
  assert.equal(latest.source_hash, snapshot.snapshot.source_hash);
});

test('CT05 C09: changing umbrella only marks its read stale and retains rows, old images, versions, coverage and reference snapshots', async () => {
  const data = await seed();
  await commitContinuityLedger(data.params);
  await bindContinuityShot(101, { script_id: 30, script_scene_id: 'F06:s3', moment_id: 'F06:s3:exit', phase: 'after', reads: [{ entity_id: 'F06:u1', attribute_id: 'integrity' }] });
  await bindContinuityShot(102, { script_id: 30, script_scene_id: 'F06:s3', moment_id: 'F06:s3:exit', phase: 'after', reads: [{ entity_id: 'F06:coat', attribute_id: 'wetness' }] });
  await db.run("INSERT INTO coverage_group(id,source_scene_id) VALUES(201,101)");
  await db.run("INSERT INTO coverage_shot(id,coverage_group_id,slot,asset_url) VALUES(301,201,1,'/old-coverage.svg')");
  await db.run("INSERT INTO scene_asset_image_snapshot(scene_id,image_url,references_json) VALUES(101,'/old-umbrella.svg','[]')");
  const oldSnapshot = await db.get('SELECT continuity_snapshot_id FROM scene WHERE id=101');
  const revised = confirmedContinuityFixture('F06', 'upstream-revision');
  const result = await commitContinuityLedger({ ...data.params, expected_revision: 1, request_key: 'correction', reason: '伞柄弯曲修订', input: revised.input });
  assert.deepEqual(result.stale_shot_ids, [101]);
  assert.deepEqual(result.revalidated_shot_ids, [102]);
  const dependent = await db.get('SELECT * FROM scene WHERE id=101'), unrelated = await db.get('SELECT * FROM scene WHERE id=102');
  assert.equal(dependent.continuity_status, 'stale');
  assert.equal(dependent.asset_url, '/old-umbrella.svg');
  assert.equal(dependent.asset_status, 'completed');
  assert.equal(dependent.audio_prompt, 'rain');
  assert.equal(unrelated.continuity_status, 'current');
  assert.equal(unrelated.asset_url, '/old-coat.svg');
  assert.equal((await db.get('SELECT asset_url FROM scene_version WHERE scene_id=101 AND version=1')).asset_url, '/old-umbrella.svg');
  assert.equal((await db.get('SELECT asset_url FROM coverage_shot WHERE id=301')).asset_url, '/old-coverage.svg');
  assert.ok(await db.get('SELECT 1 FROM scene_asset_image_snapshot WHERE scene_id=101'));
  assert.equal((await db.get('SELECT status FROM continuity_snapshot WHERE id=?', oldSnapshot.continuity_snapshot_id)).status, 'stale');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM continuity_snapshot WHERE script_id=30')).n, 6);
});

test('CT05 confirmation writes are idempotent, concurrent conflicts have no partial side effects', async () => {
  const { params } = await seed();
  const [a, b] = await Promise.all([commitContinuityLedger(params), commitContinuityLedger(params)]);
  assert.deepEqual(a, b);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM continuity_revision WHERE script_id=30')).n, 1);
  await assert.rejects(commitContinuityLedger({ ...params, reason: 'different content' }), code('CONTINUITY_REVISION_CONFLICT'));
  await assert.rejects(commitContinuityLedger({ ...params, request_key: 'stale-key' }), code('CONTINUITY_REVISION_CONFLICT'));
  assert.equal((await db.get('SELECT revision FROM continuity_ledger WHERE script_id=30')).revision, 1);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM continuity_snapshot WHERE script_id=30')).n, 3);
});

test('CT05 actual script/source changes invalidate fingerprint and snapshot reads without deleting media', async () => {
  const { params } = await seed();
  await commitContinuityLedger(params);
  const before = await continuitySourceFingerprint(30);
  await db.run("UPDATE chapter SET content=content || '\n' WHERE id='ct05'");
  assert.notEqual(await continuitySourceFingerprint(30), before);
  await assert.rejects(currentContinuitySnapshot(30, 'F06:s3'), code('CONTINUITY_STALE'));
  await db.run('UPDATE chapter_script SET revision=2 WHERE id=30');
  await assert.rejects(currentContinuitySnapshot(30, 'F06:s3'), code('CONTINUITY_STALE'));
  assert.equal((await db.get('SELECT asset_url FROM scene WHERE id=101')).asset_url, '/old-umbrella.svg');
});

test('CT05 version cloning retains dependencies and old-version activation preserves the image while marking stale', async () => {
  const data = await seed(); await commitContinuityLedger(data.params);
  await bindContinuityShot(101, { script_id: 30, script_scene_id: 'F06:s3', moment_id: 'F06:s3:exit', phase: 'after', reads: [{ entity_id: 'F06:u1', attribute_id: 'integrity' }] });
  const clone = await createSceneVersion(101, { clearAsset: false });
  assert.equal(clone?.version.continuity_status, 'current');
  assert.equal(clone?.version.asset_url, '/old-umbrella.svg');
  assert.ok(await db.get('SELECT 1 FROM continuity_shot_dependency WHERE scene_id=101 AND scene_version=2'));
  await commitContinuityLedger({ ...data.params, expected_revision: 1, request_key: 'change', input: confirmedContinuityFixture('F06', 'upstream-revision').input });
  const old = await activateSceneVersion(101, 1);
  assert.equal(old.continuity_status, 'stale'); assert.equal(old.asset_url, '/old-umbrella.svg');
  assert.equal((await db.get('SELECT COUNT(*) n FROM scene_version WHERE scene_id=101')).n, 2);
});

async function restoreDestination(data: Awaited<ReturnType<typeof seed>>, unsigned: boolean | 'tampered' = false, assets = new Map<number, number>()) {
  await db.run("INSERT INTO project(id,title,user_id) VALUES(20,'restored','test-user')");
  await db.run("INSERT INTO chapter(id,project_id,\"index\",title,content) SELECT 'copy',20,0,title,content FROM chapter WHERE id='ct05'");
  await db.run("INSERT INTO character(id,project_id,name) VALUES(3,20,'林岚'),(4,20,'陈月')");
  await db.run("INSERT INTO chapter_script(id,chapter_id,revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash) SELECT 40,'copy',revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash FROM chapter_script WHERE id=30");
  await db.run(`INSERT INTO scene(id,chapter_id,"index",visual_prompt,asset_url,asset_status,active_version,shot_spec) SELECT id+100,'copy',"index",visual_prompt,asset_url,asset_status,active_version,CASE WHEN json_valid(shot_spec) THEN json_set(shot_spec,'$.source.script_id',40) ELSE shot_spec END FROM scene WHERE chapter_id='ct05'`);
  const backup = await exportContinuity(10);
  if (unsigned === true) delete backup.signature;
  if (unsigned === 'tampered') backup.ledgers[0]!.revision = 999;
  for (const [oldId,newId] of assets) await db.run('INSERT INTO library_asset(id,project_id,kind,name,revision) SELECT ?,20,kind,name,revision FROM library_asset WHERE id=?', newId, oldId);
  const result = await restoreContinuity(backup, 20, { scripts: new Map([[30,40]]), chapters: new Map([['ct05','copy']]), characters: new Map([[1,3],[2,4]]), scenes: new Map([['101',201],['102',202]]), assets });
  return { backup, result };
}

test('CT05 signed backup remaps independent entities, relations, approved ledger, snapshots, image versions and dependencies', async () => {
  const data = await seed('upstream-revision'); await commitContinuityLedger(data.params);
  await bindContinuityShot(101, { script_id: 30, script_scene_id: 'F06:s3', moment_id: 'F06:s3:exit', phase: 'after', reads: [{ entity_id: 'F06:u1', attribute_id: 'integrity' }] });
  await createSceneVersion(101, { clearAsset: false });
  const { result } = await restoreDestination(data);
  assert.equal(result.trusted, true);
  const ledger = await loadContinuityLedger(40); assert.ok(ledger.input);
  const ids = ledger.input.context.entities.map(entity => entity.entity_id);
  assert.ok(ids.every(id => !data.input.context.entities.some(old => old.entity_id === id)));
  assert.deepEqual(ledger.input.context.entities.filter(entity => entity.kind === 'character').map(entity => entity.character_id), [3,4]);
  const current = await currentContinuitySnapshot(40, 'F06:s3');
  assert.equal(current.snapshot.project_id, 20);
  const umbrella = ledger.input.context.entities.find(entity => entity.display_name === '黑伞')!;
  const integrity = current.snapshot.exit_state.find(cell => cell.entity_id === umbrella.entity_id && cell.attribute_id === 'integrity');
  assert.ok(integrity?.knowledge_status === 'confirmed'); assert.equal(integrity.value, 'damaged');
  const dependency = await db.get('SELECT * FROM continuity_shot_dependency WHERE scene_id=201 AND scene_version=2');
  assert.equal(dependency.script_id, 40); assert.equal(dependency.snapshot_id, current.id); assert.equal(dependency.status, 'current');
  assert.equal((await db.get('SELECT asset_url FROM scene_version WHERE scene_id=201 AND version=1')).asset_url, '/old-umbrella.svg');
  assert.equal((await db.get('SELECT continuity_status FROM scene WHERE id=201')).continuity_status, 'current');
});

test('CT05 shared design keeps distinct physical identities, component closure and pinned historical asset revision on restore', async () => {
  const data = await seed();
  await db.run("INSERT INTO library_asset(id,project_id,kind,name,revision) VALUES(501,10,'prop','黑伞',1)");
  data.input.context = { ...data.input.context, entities: [...data.input.context.entities.map(entity => entity.entity_id === 'F06:u1' ? { ...entity, asset_id: 501, asset_revision: 1 } : entity),
    { entity_id: 'second-umbrella', project_id: 10, kind: 'prop', display_name: '黑伞', aliases: [], asset_id: 501, asset_revision: 1 },
    { entity_id: 'umbrella-handle', project_id: 10, kind: 'component', display_name: '伞柄', aliases: [], parent_entity_id: 'F06:u1' }] };
  data.params.input = data.input;
  await commitContinuityLedger(data.params);
  await assert.rejects(AssetLibraryService.remove(501), /bound to a continuity entity/);
  await db.run('UPDATE library_asset SET revision=2 WHERE id=501');
  assert.ok(await currentContinuitySnapshot(30, 'F06:s3'));
  await restoreDestination(data, false, new Map([[501,601]]));
  const rows = (await db.all('SELECT entity_json FROM continuity_entity WHERE project_id=20')).map(row => JSON.parse(row.entity_json));
  const umbrellas = rows.filter(entity => entity.asset_id === 601);
  assert.equal(umbrellas.length, 2); assert.notEqual(umbrellas[0].entity_id, umbrellas[1].entity_id);
  assert.equal(umbrellas[0].asset_revision, 1);
  assert.equal(rows.find(entity => entity.kind === 'component').parent_entity_id, umbrellas[0].entity_id);
  assert.ok(await db.get('SELECT 1 FROM continuity_reference_version WHERE project_id=20 AND asset_id=601 AND asset_revision=1'));
  const backup = await exportContinuity(10); delete backup.signature;
  backup.entities[0]!.entity_json = JSON.stringify({ ...JSON.parse(String(backup.entities[0]!.entity_json)), character_id: 9999 });
  await assert.rejects(restoreContinuity(backup, 20, { scripts: new Map(), chapters: new Map(), characters: new Map([[1,3],[2,4]]), scenes: new Map(), assets: new Map([[501,601]]) }), /Dangling character_id/);
});

test('CT05 unsigned import preserves suggestions, old images and identities but cannot self-certify approval', async () => {
  const data = await seed(); await commitContinuityLedger(data.params);
  await bindContinuityShot(101, { script_id: 30, script_scene_id: 'F06:s3', moment_id: 'F06:s3:exit', phase: 'after', reads: [{ entity_id: 'F06:u1', attribute_id: 'integrity' }] });
  const { result } = await restoreDestination(data, true); assert.equal(result.trusted, false);
  const ledger = await loadContinuityLedger(40); assert.equal(ledger.input, null); assert.equal(ledger.issues[0]?.code, 'CONTINUITY_REVIEW_REQUIRED');
  assert.equal((await db.get('SELECT asset_url FROM scene WHERE id=201')).asset_url, '/old-umbrella.svg');
  assert.equal((await db.get('SELECT COUNT(*) n FROM continuity_entity WHERE project_id=20')).n, data.input.context.entities.length);
  await assert.rejects(currentContinuitySnapshot(40, 'F06:s3'), code('CONTINUITY_REVIEW_REQUIRED'));
});

test('CT05 changing any signed backup content invalidates its approval receipt', async () => {
  const data = await seed(); await commitContinuityLedger(data.params);
  const { result } = await restoreDestination(data, 'tampered'); assert.equal(result.trusted, false);
  assert.equal((await loadContinuityLedger(40)).issues[0]?.code, 'CONTINUITY_REVIEW_REQUIRED');
});

test('CT19 lifecycle: authenticated copy retains stale source evidence and old images without renewing approval',async()=>{
  const data=await seed();await commitContinuityLedger(data.params);await bindContinuityShot(101,{script_id:30,script_scene_id:'F06:s3',moment_id:'F06:s3:exit',phase:'after',reads:[{entity_id:'F06:u1',attribute_id:'integrity'}]});
  await db.run("UPDATE chapter SET content=content||' source edit' WHERE id='ct05'");
  assert.equal((await loadContinuityLedger(30)).input,null);
  const {backup,result}=await restoreDestination(data);assert.equal(result.trusted,true);assert.equal(backup.ledgers[0]!.approval_current,false);assert.equal((await loadContinuityLedger(40)).input,null);assert.equal((await db.get('SELECT asset_url FROM scene WHERE id=201')).asset_url,'/old-umbrella.svg');assert.equal((await db.get('SELECT status FROM continuity_shot_dependency WHERE scene_id=201')).status,'stale');
});
test('CT19 lifecycle: authenticated copy cannot repair an invalid frozen pin or keep its accepted verdict current',async()=>{
  const data=await seed();await commitContinuityLedger(data.params);await bindContinuityShot(101,{script_id:30,script_scene_id:'F06:s3',moment_id:'F06:s3:exit',phase:'after',reads:[{entity_id:'F06:u1',attribute_id:'integrity'}]});
  await db.run('UPDATE scene SET asset_url=NULL WHERE id=101');const bound=await bindProductionReferences(30,101,{expected_version:1,references:[],reason:'reference review'});await db.run("UPDATE scene SET asset_url='/old-umbrella.svg' WHERE id=101");
  await reviewProductionImage(30,101,{expected_version:1,expected_image_url:'/old-umbrella.svg',reference_hash:bound.reference_hash,verdict:'accepted',checks:{wardrobe:true,damage:true,count:true,holder:true,openings:true,space:true},note:'human checked'});
  await db.run('UPDATE scene_production_frame SET reference_versions_json=? WHERE scene_id=101',JSON.stringify({...bound.pin,dependency_hash:'0'.repeat(64)}));
  await assert.rejects(requireProductionReferencePin(await db.get('SELECT * FROM scene WHERE id=101')));
  const {backup}=await restoreDestination(data);assert.equal(backup.production_frames![0]!.pin_valid,false);const copied=await db.get('SELECT * FROM scene_production_frame WHERE scene_id=201');assert.equal(JSON.parse(copied.image_review_json).verdict,'pending_review');assert.equal(JSON.parse(copied.image_review_json).original_verdict,'accepted');assert.equal(JSON.parse(copied.reference_versions_json).dependency_hash,'0'.repeat(64));await assert.rejects(requireProductionReferencePin(await db.get('SELECT * FROM scene WHERE id=201')));
});

for(const unsigned of [false,true])test(`CT20/21 signed=${!unsigned}: time scope, physical hand and frozen image review survive lifecycle with correct authority`,async()=>{
  const data=await seed('ordered','F01'),context=data.input.context;
  const text='次日，陈月用自己的右手握着黑伞。',source={project_id:10,source_type:'screenplay' as const,source_document_id:'script:30:F01:s3:time',source_revision:1,text,bindings:[]};
  context.sources.push(source);
  const evidence={kind:'source' as const,source_type:'screenplay' as const,source_document_id:source.source_document_id,source_revision:1,source_text_hash:createHash('sha256').update(text).digest('hex'),evidence_quote:text,start:0,end:text.length};
  const plan={schema_version:1 as const,policy_version:'continuity-time-1' as const,initial_day_id:'day-1',boundaries:[{script_scene_id:'F01:s3',kind:'new_day' as const,day_id:'day-2',rules:data.input.entry!.state.map(c=>({entity_id:c.entity_id,attribute_id:c.attribute_id,action:'inherit' as const})),evidence}]};
  context.time_plan=confirmContinuityTimePlan(plan,{...context,authority:{kind:'human',review_id:'time-review',review_revision:1,actor_id:'human',proposal_hash:continuityTimePlanHash(plan)}});
  data.input.changes=[...data.input.changes,data.approve({...data.base,...continuityAttributeVersion('holding_hand'),change_id:'right-hand',entity_id:'F01:umbrella',attribute_id:'holding_hand',value:'physical_right',basis:'story',story_position:{...data.base.story_position,script_scene_id:'F01:s3',scene_order:2,change_order:10,moment_id:'right-hand',phase:'after'},evidence:[evidence]})];
  await commitContinuityLedger(data.params);
  await bindContinuityShot(101,{script_id:30,script_scene_id:'F01:s3',moment_id:'F01:s3:exit',phase:'after',reads:[{entity_id:'F01:umbrella',attribute_id:'holding_hand'}]});
  await db.run('UPDATE scene SET asset_url=NULL WHERE id=101');
  const bound=await bindProductionReferences(30,101,{expected_version:1,references:[],reason:'human reference review'});
  await db.run("UPDATE scene SET asset_url='/old-umbrella.svg' WHERE id=101");
  await reviewProductionImage(30,101,{expected_version:1,expected_image_url:'/old-umbrella.svg',reference_hash:bound.reference_hash,verdict:'accepted',checks:{wardrobe:true,damage:true,count:true,holder:true,openings:true,space:true},note:'All six image checks reviewed'});
  await db.run('INSERT INTO scene_production_revision(script_id,revision) VALUES(30,7)');
  await restoreDestination(data,unsigned);
  const frame=await db.get('SELECT * FROM scene_production_frame WHERE scene_id=201 AND scene_version=1'),pin=JSON.parse(frame.reference_versions_json),review=JSON.parse(frame.image_review_json);
  assert.equal(pin.scene_id,201);assert.equal(pin.state_values.find((c:any)=>c.attribute_id==='holding_hand').value,'physical_right');assert.equal((await db.get('SELECT revision FROM scene_production_revision WHERE script_id=40')).revision,7);
  if(unsigned){assert.equal(review.verdict,'pending_review');assert.equal(review.original_verdict,'accepted');assert.equal((await loadContinuityLedger(40)).input,null);await assert.rejects(requireProductionReferencePin(await db.get('SELECT * FROM scene WHERE id=201')));}
  else{const restored=await loadContinuityLedger(40);assert.ok(restored.input);assert.match(restored.input.context.time_plan!.proposal.boundaries[0]!.evidence.source_document_id,/^script:40:/);const snapshot=await currentContinuitySnapshot(40,'F01:s3');assert.equal(snapshot.snapshot.moments[0]!.story_position.time_scope?.day_id,'day-2');assert.equal(review.verdict,'accepted');assert.equal(review.reference_hash,continuityHash(pin));await requireProductionReferencePin(await db.get('SELECT * FROM scene WHERE id=201'));}
});

test('CT05 a failed validation rolls back entity registration, ledger and snapshots; project cleanup closes references', async () => {
  const { params, input } = await seed();
  const invalid = { ...input, context: { ...input.context, entities: input.context.entities.map(entity => ({ ...entity, project_id: 20 })) } };
  await assert.rejects(commitContinuityLedger({ ...params, input: invalid }));
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM continuity_ledger WHERE script_id=30')).n, 0);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM continuity_entity WHERE project_id=10')).n, 0);
  await commitContinuityLedger(params);
  await db.run('DELETE FROM project WHERE id=10');
  for (const table of ['continuity_entity', 'continuity_ledger', 'continuity_snapshot', 'continuity_revision', 'continuity_shot_dependency']) assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n, 0);
});
