// Dedicated CT20/21 browser fixture; normal data and existing production evidence remain intact.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),area=path.join(root,'local/verification/continuity-browser');
Object.assign(process.env,{DATABASE_URL:path.join(area,'sql_app.db'),NOVASTORY_DATA_DIR:area,NOVASTORY_CONFIG_DIR:area,NOVASTORY_STATIC_DIR:path.join(area,'static'),NOVASTORY_LOG_DIR:path.join(area,'logs')});
const {db,initDb}=await import('../backend/src/db/database.ts');
const {createEmptyScriptDocument}=await import('../backend/src/schemas/script.ts');
const {getContinuityReview,confirmContinuityReview}=await import('../backend/src/services/continuity_review.ts');
const {makeContinuityStoryPosition}=await import('../backend/src/services/continuity_identity.ts');
const {bindContinuityShot}=await import('../backend/src/services/continuity_store.ts');
const {ScriptService}=await import('../backend/src/services/script_service.ts');
await initDb();
if(!(await db.get('SELECT script_id FROM continuity_ledger WHERE script_id=60'))){
  // Recover only this named isolated fixture if initial setup was interrupted.
  await db.run('DELETE FROM project WHERE id=40');
  const doc=createEmptyScriptDocument('故事日、回忆与持物手别验收');doc.locations=[{id:'room',name:'房间',description:''}];
  const blocks=[['林岚的蓝外套湿透了。','黑伞的伞柄折断了。'],['次日，林岚再次进入房间。'],['林岚回忆起第一天。','回忆中林岚把黑伞换到自己的右手。','回忆中黑伞的伞面受损了。'],['回到现实，林岚仍站在门边。','蓝外套已晾干。'],['时间不明，林岚站在门边。']];
  doc.scenes=blocks.map((texts,index)=>({id:`T20:s${index+1}`,locationId:'room',interiorExterior:'interior',timeOfDay:'day',characterIds:[],propIds:[],eventIds:[],beatIds:[],sourceParagraphIds:[],blocks:texts.map((text,i)=>({id:`T20:s${index+1}:b${i}`,type:'action',text}))}));
  const content=blocks.flat().join('\n');await db.run("INSERT INTO project(id,title,user_id,settings) VALUES(40,'CT20/21 时间与手别验收','local_admin','{}')");
  await db.run("INSERT INTO chapter(id,project_id,\"index\",title,content) VALUES('ct20',40,0,'逐属性继承与回忆隔离',?)",content);
  await db.run("INSERT INTO character(id,project_id,name,english_name) VALUES(21,40,'林岚','Lin Lan')");
  const snapshot=await ScriptService.createSourceSnapshot('ct20',doc.title,content,40);await db.run("INSERT INTO chapter_script(id,chapter_id,revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash) VALUES(60,'ct20',1,'confirmed',?,?,?,?)",JSON.stringify(doc),JSON.stringify(snapshot),snapshot.contentHash,snapshot.contextHash);
  const entities=[{entity_id:'T20:lin',project_id:40,kind:'character',display_name:'林岚',character_id:21,aliases:[]},{entity_id:'T20:coat',project_id:40,kind:'garment',display_name:'蓝外套',aliases:[]},{entity_id:'T20:umbrella',project_id:40,kind:'prop',display_name:'黑伞',aliases:[]}];
  const view=await getContinuityReview(60),values=[['T20:coat','wetness','dry'],['T20:umbrella','integrity','intact'],['T20:umbrella','holder','T20:lin'],['T20:umbrella','holding_hand','physical_left']];
  const changes=[['T20:s1','b0','T20:coat','wetness','wet'],['T20:s1','b1','T20:umbrella','integrity','broken'],['T20:s3','b1','T20:umbrella','holding_hand','physical_right'],['T20:s3','b2','T20:umbrella','integrity','damaged']].map(([scene,block,entity,attribute,value],index)=>{const source=view.sources.find(s=>s.source_document_id===`script:60:${scene}:${scene}:${block}`);return {schema_version:attribute==='holding_hand'?2:1,policy_version:attribute==='holding_hand'?'continuity-state-2':'continuity-state-1',change_id:`ct20:${index}`,change_revision:1,binding_revision:1,story_position:makeContinuityStoryPosition(view.order,{script_scene_id:scene,change_order:index,moment_id:`ct20:${index}`,phase:'after'}),entity_id:entity,attribute_id:attribute,operation:'assign',value,basis:'story',time_relation:'confirmed_linear',origin:'human_entry',evidence:[{kind:'source',source_type:'screenplay',source_document_id:source.source_document_id,source_revision:1,source_text_hash:source.source_text_hash,evidence_quote:source.text,start:0,end:source.text.length}]};});
  await confirmContinuityReview(60,{review_action:'human_review',target_scene_id:'T20:s1',expected_script_revision:1,expected_continuity_revision:0,request_key:'ct20-baseline',reason:'Frozen manual entry/change fixture; temporal plan awaits explicit browser review',replace_all:true,entities,entry_values:values.map(([entity_id,attribute_id,value])=>({entity_id,attribute_id,knowledge_status:'confirmed',value})),changes},'fixture-reviewer');
  for(const [index,scene]of doc.scenes.entries()){
    const id=401+index;await db.run("INSERT INTO scene(id,chapter_id,\"index\",asset_status,asset_url,shot_spec) VALUES(?,'ct20',?,'completed','/static/fixtures/F06-broken-umbrella-v2.svg',?)",id,index,JSON.stringify({location:'房间',primary_action:scene.blocks[0].text,source:{type:'script',script_id:60,script_revision:1,script_scene_id:scene.id,block_ids:[scene.blocks[0].id]}}));
    await bindContinuityShot(id,{script_id:60,script_scene_id:scene.id,moment_id:`${scene.id}:exit`,phase:'after',reads:[{entity_id:'T20:umbrella',attribute_id:'holding_hand'},{entity_id:'T20:umbrella',attribute_id:'integrity'}]});
  }
}
console.log('Temporal/physical-hand fixture: http://127.0.0.1:3005/project/40/director');
