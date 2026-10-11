// Isolated browser acceptance server. Never points at the project's normal database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(repo, 'local', 'verification', 'continuity-browser');
fs.mkdirSync(fixtureRoot, { recursive: true });
const dbFile = path.join(fixtureRoot, 'sql_app.db');
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, '');
Object.assign(process.env, { DATABASE_URL: dbFile, NOVASTORY_DATA_DIR: fixtureRoot,
  NOVASTORY_CONFIG_DIR: fixtureRoot, NOVASTORY_STATIC_DIR: path.join(fixtureRoot, 'static'),
  NOVASTORY_LOG_DIR: path.join(fixtureRoot, 'logs'), PORT: '3005', HOST: '127.0.0.1' });
const { db, initDb } = await import('../backend/src/db/database.ts');
const { confirmedContinuityFixture } = await import('../backend/src/test_fixtures/continuity_confirmed.ts');
const { createEmptyScriptDocument } = await import('../backend/src/schemas/script.ts');
const { ScriptService } = await import('../backend/src/services/script_service.ts');
const { confirmContinuityReview, getContinuityReview } = await import('../backend/src/services/continuity_review.ts');
const { bindContinuityShot } = await import('../backend/src/services/continuity_store.ts');
await initDb();
const data = confirmedContinuityFixture('F06', 'upstream-revision');
const doc = createEmptyScriptDocument('连续性浏览器验收');
doc.locations = [{ id: 'room', name: '房间', description: '' }];
doc.scenes = data.input.context.order.scenes.map(scene => ({ id: scene.script_scene_id,
  locationId: 'room', interiorExterior: 'interior', timeOfDay: 'day', characterIds: [], propIds: [], eventIds: [], beatIds: [], sourceParagraphIds: [],
  blocks: data.fixture.sources.filter(source => source.scene_id === scene.script_scene_id).map(source => ({ id: source.id, type: 'action', text: source.text })) }));
const mediaRoot = path.join(fixtureRoot, 'static', 'fixtures'); fs.mkdirSync(mediaRoot, { recursive: true });
for (const name of ['F06-broken-umbrella-v1.svg', 'F06-broken-umbrella-v2.svg', 'F06-blue-coat.svg']) {
  fs.copyFileSync(path.join(repo, 'backend', 'src', 'test_fixtures', 'continuity', 'media', name), path.join(mediaRoot, name));
}
if (!(await db.get('SELECT id FROM project WHERE id=10'))) {
  const content = data.fixture.sources.map(source => source.text).join('\n');
  await db.run("INSERT INTO project(id,title,user_id,settings) VALUES(10,'CT08 连续性验收','local_admin','{}'),(20,'CT08 旧项目验收','local_admin','{}')");
  await db.run("INSERT INTO character(id,project_id,name,english_name) VALUES(1,10,'林岚','Lin Lan'),(2,10,'陈月','Chen Yue')");
  for (const [chapter, project, index, script] of [['ct08-main', 10, 0, 30], ['ct08-next', 10, 1, 31], ['ct08-legacy', 20, 0, 40]]) {
    await db.run('INSERT INTO chapter(id,project_id,"index",title,content) VALUES(?,?,?,?,?)', chapter, project, index, index ? '第二章：保留核对草稿' : '第一章：旧图与局部恢复', content);
    const source = await ScriptService.createSourceSnapshot(chapter, doc.title, content, project);
    await db.run("INSERT INTO chapter_script(id,chapter_id,revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash) VALUES(?,?,1,'confirmed',?,?,?,?)", script, chapter, JSON.stringify(doc), JSON.stringify(source), source.contentHash, source.contextHash);
  }
  const view = await getContinuityReview(30);
  const proposal = data.input.changes[1].proposal, evidence = proposal.evidence[0];
  const source = view.sources.find(source => source.source_type === 'screenplay' && source.text === data.fixture.sources.find(source => source.id === evidence.source_document_id).text);
  await confirmContinuityReview(30, { review_action: 'human_review', target_scene_id: 'F06:s1', expected_script_revision: 1, expected_continuity_revision: 0, request_key: 'browser-entry', reason: '预标注夹具人工入口', replace_all: true,
    entities: data.input.context.entities, entry_values: Object.entries(data.fixture.initial_state).flatMap(([entity_id, attributes]) => Object.entries(attributes).map(([attribute_id, value]) => ({ entity_id, attribute_id, knowledge_status: 'confirmed', value }))),
    changes: [{ ...proposal, evidence: [{ kind: 'source', source_type: source.source_type, source_document_id: source.source_document_id, source_revision: 1, source_text_hash: source.source_text_hash, evidence_quote: source.text, start: 0, end: source.text.length }] }] }, 'fixture-reviewer');
  for (const [index, scene] of doc.scenes.entries()) {
    const id = 101 + index, spec = { location: '房间', primary_action: scene.blocks[0].text, visible_subjects: [], key_props: [], source: { script_id: 30, script_scene_id: scene.id, block_ids: scene.blocks.map(block => block.id) } };
    await db.run('INSERT INTO scene(id,chapter_id,"index",visual_prompt,audio_prompt,asset_url,asset_status,shot_spec) VALUES(?,\'ct08-main\',?,\'fixture prompt\',\'雨声\',?,\'completed\',?)', id, index, `/static/fixtures/${index ? 'F06-broken-umbrella-v2.svg' : 'F06-blue-coat.svg'}`, JSON.stringify(spec));
    await bindContinuityShot(id, { script_id: 30, script_scene_id: scene.id, moment_id: `${scene.id}:exit`, phase: 'after', reads: [{ entity_id: index ? 'F06:u1' : 'F06:coat', attribute_id: index ? 'integrity' : 'wetness' }] });
  }
  await db.run("INSERT INTO scene(id,chapter_id,\"index\",asset_url,asset_status,shot_spec) VALUES(201,'ct08-legacy',0,'/static/fixtures/F06-blue-coat.svg','completed',?)", JSON.stringify({ location: '房间', primary_action: '陈月仍握着黑伞。', visible_subjects: [], key_props: [], source: { script_id: 40, script_scene_id: 'F06:s3', block_ids: ['downstream'] } }));
}
console.log('Isolated CT08 fixture server: http://127.0.0.1:3005/project/10/director');
await import('../server.ts');
