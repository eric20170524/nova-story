// Adds a separate three-scene production fixture. The normal project database is never used.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),area=path.join(root,'local/verification/continuity-browser');
Object.assign(process.env,{DATABASE_URL:path.join(area,'sql_app.db'),NOVASTORY_DATA_DIR:area,NOVASTORY_CONFIG_DIR:area,NOVASTORY_STATIC_DIR:path.join(area,'static'),NOVASTORY_LOG_DIR:path.join(area,'logs')});
const {db,initDb}=await import('../backend/src/db/database.ts');
const {confirmedContinuityFixture}=await import('../backend/src/test_fixtures/continuity_confirmed.ts');
const {createEmptyScriptDocument}=await import('../backend/src/schemas/script.ts');
const {ScriptService}=await import('../backend/src/services/script_service.ts');
const {getContinuityReview,confirmContinuityReview}=await import('../backend/src/services/continuity_review.ts');
const {makeContinuityStoryPosition}=await import('../backend/src/services/continuity_identity.ts');
const {bindContinuityShot}=await import('../backend/src/services/continuity_store.ts');
await initDb();
const material=confirmedContinuityFixture('F01','ordered');
if(!(await db.get('SELECT id FROM project WHERE id=30'))){
  const doc=createEmptyScriptDocument('CT19 三场分轮制作');doc.locations=[{id:'room',name:'房间',description:'A plain room with a wooden door.'}];
  doc.scenes=material.input.context.order.scenes.map(scene=>({id:scene.script_scene_id,locationId:'room',interiorExterior:'interior',timeOfDay:'day',characterIds:[],propIds:[],eventIds:[],beatIds:[],sourceParagraphIds:[],blocks:material.fixture.sources.filter(source=>source.scene_id===scene.script_scene_id&&material.selected.source_ids.includes(source.id)).map(source=>({id:source.id,type:'action',text:source.text}))}));
  doc.scenes[0].blocks.push({id:'rain',type:'sound',text:'雨声。'});
  const content=doc.scenes.flatMap(scene=>scene.blocks).map(block=>block.text).join('\n');
  await db.run("INSERT INTO project(id,title,user_id,settings) VALUES(30,'CT19 三场制作验收','local_admin',?)",JSON.stringify({image_generation:{model:'pony',style:'none',output_spec:{aspect_ratio:'16:9',resolution:'draft',orientation_policy:'fixed'}}}));
  await db.run("INSERT INTO chapter(id,project_id,\"index\",title,content) VALUES('ct19',30,0,'三场制作及局部重做',?)",content);
  const tags={gender:'female',species:'human',age:'adult',hair:{color:'black',style:'short'},clothing:{outfit:'blue coat'}};
  await db.run("INSERT INTO character(id,project_id,name,english_name,visual_tags) VALUES(11,30,'林岚','Lin Lan',?),(12,30,'陈月','Chen Yue',?)",JSON.stringify(tags),JSON.stringify({...tags,hair:{color:'black',style:'long'},clothing:{outfit:'white shirt'}}));
  const snapshot=await ScriptService.createSourceSnapshot('ct19',doc.title,content,30);
  await db.run("INSERT INTO chapter_script(id,chapter_id,revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash) VALUES(50,'ct19',1,'confirmed',?,?,?,?)",JSON.stringify(doc),JSON.stringify(snapshot),snapshot.contentHash,snapshot.contextHash);
  const media=path.join(area,'static/fixtures');fs.mkdirSync(media,{recursive:true});
  await sharp(path.join(root,'backend/src/test_fixtures/continuity/media/F06-broken-umbrella-v2.svg')).png().toFile(path.join(media,'CT19-umbrella-design-v1.png'));
  await db.run("INSERT INTO library_asset(id,project_id,kind,name,revision,status,image_url,visual_prompt) VALUES(31,30,'prop','黑伞参考',1,'completed','/static/fixtures/CT19-umbrella-design-v1.png','One black umbrella with a broken handle')");
  const view=await getContinuityReview(50),entities=material.input.context.entities.map(entity=>({...entity,project_id:30,...(entity.character_id?{character_id:entity.character_id+10}:{}),...(entity.entity_id==='F01:umbrella'?{asset_id:31,asset_revision:1}:{})}));
  const changes=material.input.changes.map((change,index)=>{
    const evidence=change.proposal.evidence[0],source=view.sources.find(source=>source.text===evidence.evidence_quote&&source.source_type==='screenplay');
    const original=material.fixture.sources.find(source=>source.id===evidence.source_document_id);
    return {...change.proposal,story_position:makeContinuityStoryPosition(view.order,{script_scene_id:original.scene_id,change_order:index,moment_id:`ct19:${index}:after`,phase:'after'}),evidence:[{kind:'source',source_type:source.source_type,source_document_id:source.source_document_id,source_revision:source.source_revision,source_text_hash:source.source_text_hash,evidence_quote:source.text,start:0,end:source.text.length}]};
  });
  await confirmContinuityReview(50,{review_action:'human_review',target_scene_id:'F01:s1',expected_script_revision:1,expected_continuity_revision:0,request_key:'ct19-frozen-entry',reason:'Pre-labelled three-scene fixture, manual approved entry and changes',replace_all:true,entities,entry_values:Object.entries(material.fixture.initial_state).flatMap(([entity_id,values])=>Object.entries(values).map(([attribute_id,value])=>({entity_id,attribute_id,knowledge_status:'confirmed',value}))),changes},'fixture-reviewer');
  for(const [index,scene]of doc.scenes.entries()){
    const id=301+index;await db.run("INSERT INTO scene(id,chapter_id,\"index\",asset_status,asset_url,shot_spec) VALUES(?,'ct19',?,'completed',?,?)",id,index,`/static/fixtures/${index?'F06-broken-umbrella-v2.svg':'F06-blue-coat.svg'}`,JSON.stringify({location:'房间',primary_action:scene.blocks[0].text,source:{type:'script',script_id:50,script_revision:1,script_scene_id:scene.id,block_ids:scene.blocks.filter(block=>block.type==='action').map(block=>block.id)}}));
    await bindContinuityShot(id,{script_id:50,script_scene_id:scene.id,moment_id:`${scene.id}:exit`,phase:'after',reads:[{entity_id:index?'F01:umbrella':'F01:coat',attribute_id:index?'integrity':'wetness'}]});
  }
}
const settingsFile=path.join(area,'system_settings.json');
if(!fs.existsSync(settingsFile))fs.writeFileSync(settingsFile,JSON.stringify({llm:{provider:'ollama',api_key:'ollama',base_url:'http://127.0.0.1:11434/v1',model:'novastory-qwen3.5:9b'},comfyui:{enabled:true,mode:'local',base_url:'http://127.0.0.1:8188',local_base_url:'http://127.0.0.1:8188',install_path:'D:\\ComfyUI',default_workflow:'pony_xl_12gb.json'},advanced:{nsfw_enabled:false}},null,2));
const workflows=path.join(area,'static/workflows');fs.mkdirSync(workflows,{recursive:true});
for(const name of ['pony_xl_12gb.json','pony_xl_tier_b_dual_ref_l40.json'])fs.copyFileSync(path.join(root,'backend/static/workflows',name),path.join(workflows,name));
console.log('Production fixture ready: http://127.0.0.1:3005/project/30/director');
