// Real local-model chain acceptance against a dedicated database. Frozen approvals are fixture inputs, never model approvals.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'local/verification/continuity-ct14/chain-v2');
await fs.mkdir(output,{recursive:true});
const database = path.join(output,'sql_app.db');
try {await fs.access(database);}catch{await fs.writeFile(database,'');}
Object.assign(process.env,{DATABASE_URL:database,NOVASTORY_DATA_DIR:output,NOVASTORY_CONFIG_DIR:output,NOVASTORY_LOG_DIR:path.join(output,'logs')});
const {db,initDb}=await import('../backend/src/db/database.ts');
const {confirmedContinuityFixture}=await import('../backend/src/test_fixtures/continuity_confirmed.ts');
const {createEmptyScriptDocument}=await import('../backend/src/schemas/script.ts');
const {ScriptService}=await import('../backend/src/services/script_service.ts');
const {commitContinuityLedger}=await import('../backend/src/services/continuity_store.ts');
const {StoryboardGenerationService}=await import('../backend/src/services/ai/storyboard_generation_service.ts');
const {OpenAIProvider}=await import('../backend/src/services/ai/openai_provider.ts');
const {continuityHash}=await import('../backend/src/services/continuity_replay.ts');
const {extractContinuitySuggestions,LogicalContinuityBudget,continuitySuggestionPolicyFingerprint}=await import('../backend/src/services/continuity_suggestions.ts');
const {CONTINUITY_EVAL_FIXTURES}=await import('../backend/src/test_fixtures/continuity_eval.ts');
const {continuityEvaluationTask}=await import('../backend/src/test_fixtures/continuity_eval_task.ts');
const metadata=JSON.parse(await fs.readFile(path.join(root,'local/verification/continuity-ct14',continuitySuggestionPolicyFingerprint.slice(0,16),'summary.json'),'utf8'));
const liveModels=await (await fetch('http://127.0.0.1:11434/v1/models')).json();
if(JSON.stringify(liveModels.data.map(row=>row.meta))!==JSON.stringify(metadata.models.data.map(row=>row.meta)))throw new Error('Model differs from the full-group evaluation');
await initDb();
const fixture=confirmedContinuityFixture('F01','ordered'),doc=createEmptyScriptDocument('Real F01 chain');
doc.locations=[{id:'room',name:'房间',description:''}];
doc.scenes=fixture.input.context.order.scenes.map(scene=>({id:scene.script_scene_id,locationId:'room',interiorExterior:'interior',timeOfDay:'day',characterIds:[],propIds:[],eventIds:[],beatIds:[],sourceParagraphIds:[],blocks:fixture.fixture.sources.filter(source=>source.scene_id===scene.script_scene_id&&fixture.selected.source_ids.includes(source.id)).map(source=>({id:source.id,type:'action',text:source.text}))}));
if(!(await db.get('SELECT id FROM project WHERE id=10'))){
  const content=fixture.fixture.sources.map(source=>source.text).join('\n');
  await db.run("INSERT INTO project(id,title,user_id,settings) VALUES(10,'Real CT14','fixture-reviewer','{}')");
  await db.run('INSERT INTO chapter(id,project_id,"index",title,content) VALUES(\'ct14\',10,0,\'Real chain\',?)',content);
  await db.run("INSERT INTO character(id,project_id,name,english_name) VALUES(1,10,'林岚','Lin Lan'),(2,10,'陈月','Chen Yue')");
  const snapshot=await ScriptService.createSourceSnapshot('ct14',doc.title,content,10);
  await db.run("INSERT INTO chapter_script(id,chapter_id,revision,status,document_json,source_snapshot_json,source_content_hash,source_context_hash) VALUES(30,'ct14',1,'confirmed',?,?,?,?)",JSON.stringify(doc),JSON.stringify(snapshot),snapshot.contentHash,snapshot.contextHash);
  await commitContinuityLedger({script_id:30,expected_revision:0,expected_script_revision:1,request_key:'frozen-entry',actor_id:'fixture-reviewer',reason:'Pre-labelled F01 entry and changes, no model approval',input:fixture.input});
}
const provider=new OpenAIProvider('ollama','novastory-qwen3.5:9b','http://127.0.0.1:11434/v1',{isOllama:true,timeoutMs:90000});
const seeded={...provider,generateStructured:(prompt,schema,system,options)=>provider.generateStructured(prompt,schema,system,{...options,seed:41}),generateText:provider.generateText.bind(provider),generateImage:provider.generateImage.bind(provider)};
const rows=[];
for(const [run,order] of [[3,1,2],[1,2,3]].entries())for(const index of order){
  const id=`chain-${run}-${index}`,filename=path.join(output,`${id}.json`);
  try{const cached=JSON.parse(await fs.readFile(filename,'utf8'));if(cached.completed&&cached.policy_fingerprint===continuitySuggestionPolicyFingerprint){rows.push(cached);continue;}}catch{}
  const target=`F01:s${index}`,scene=doc.scenes.find(scene=>scene.id===target),requestKey=id,before=await db.all('SELECT * FROM scene ORDER BY id'),ledgerBefore=await db.get('SELECT * FROM continuity_ledger WHERE script_id=30');
  const momentBindings=scene.blocks.map(block=>({block_id:block.id,start:0,end:block.text.length,moment_id:`${target}:exit`,phase:'after',reads:[{entity_id:'F01:coat',attribute_id:'wetness'},{entity_id:'F01:umbrella',attribute_id:'holder'},{entity_id:'F01:umbrella',attribute_id:'integrity'},{entity_id:'F01:lock',attribute_id:'lock_function'}]}));
  let candidate,error;
  try{candidate=await StoryboardGenerationService.generateStoryboardCandidate({scriptId:30,expectedRevision:1,requestKey,scope:'scene',targetSceneId:target,momentBindings,provider:seeded});}catch(e){error={code:e.code,message:e.message};}
  const task=await StoryboardGenerationService.getTask(30,StoryboardGenerationService.taskId(30,requestKey));
  const payload=candidate?JSON.parse(candidate.after_json):null;
  const result={id,completed:true,policy_fingerprint:continuitySuggestionPolicyFingerprint,model_fingerprint:metadata.model_fingerprint,target,order,candidate:payload,error,task,actual_inference_calls:task?.progress?.inference_budget?.calls?.length||0,only_target_facts:!task?.progress?.facts?.some(fact=>fact.scene_id!==target),timeline_unchanged:continuityHash(before)===continuityHash(await db.all('SELECT * FROM scene ORDER BY id')),ledger_unchanged:continuityHash(ledgerBefore)===continuityHash(await db.get('SELECT * FROM continuity_ledger WHERE script_id=30')),automatic_accepted:0};
  await fs.writeFile(filename,JSON.stringify(result,null,2));rows.push(result);console.log(`${id}: ${candidate?'candidate':'review'}; calls=${result.actual_inference_calls}`);
}
// These paired/special tasks reuse the same frozen labels, but make fresh real calls.
const special=[];
for(const category of ['E04','E05','E10','E11','E12'])for(const caseId of ['positive','negative','variant']){
  const fixture=CONTINUITY_EVAL_FIXTURES.find(f=>f.id===category),sourceCase=fixture.cases.find(c=>c.id===caseId),task=continuityEvaluationTask(fixture,sourceCase,provider,41);
  const id=`special-${category}-${caseId}`,filename=path.join(output,`${id}.json`);
  let record;try{record=JSON.parse(await fs.readFile(filename,'utf8'));}catch{}
  if(!record?.completed){record={id,completed:true,source:sourceCase.source,prior_context:sourceCase.prior_context||'',expected:sourceCase.expected,result:await extractContinuitySuggestions(task),automatic_accepted:0};await fs.writeFile(filename,JSON.stringify(record,null,2));}
  special.push(record);
}
// Check guards around actual inference, including reuse of a completed real response.
const task=continuityEvaluationTask(CONTINUITY_EVAL_FIXTURES[0],CONTINUITY_EVAL_FIXTURES[0].cases[0],provider,41);let reuse;
task.checkpoint=async state=>{reuse=state.reuse;};const first=await extractContinuitySuggestions(task);
const resumed=await extractContinuitySuggestions({...task,reuse,budget:new LogicalContinuityBudget()});
const controller=new AbortController();controller.abort();const cancelledBudget=new LogicalContinuityBudget();let cancelled;try{cancelled=await extractContinuitySuggestions({...task,signal:controller.signal,budget:cancelledBudget});}catch(error){cancelled={budget:cancelledBudget,status:'cancelled',error:error.message};}
const overBudget=await extractContinuitySuggestions({...task,preceding_context:'甲'.repeat(2201)});
const guards={first_calls:first.budget.calls.length,resume_calls:resumed.budget.calls.length,cancelled_calls:cancelled.budget.calls.length,cancelled_status:cancelled.status,over_budget_calls:overBudget.budget.calls.length,over_budget_status:overBudget.status,resume_semantics_match:continuityHash(first.proposals)===continuityHash(resumed.proposals)};
await fs.writeFile(path.join(output,'summary.json'),JSON.stringify({run_kind:'real_local_model',policy_fingerprint:continuitySuggestionPolicyFingerprint,model_fingerprint:metadata.model_fingerprint,seed:41,chain_logical_tasks:rows.length,chain_candidates:rows.filter(row=>row.candidate).length,chain_pending:rows.filter(row=>row.error).length,chain_actual_calls:rows.reduce((n,row)=>n+row.actual_inference_calls,0),all_target_and_nonwriting:rows.every(row=>row.only_target_facts&&row.timeline_unchanged&&row.ledger_unchanged),special_logical_tasks:special.length,special_actual_calls:special.reduce((n,row)=>n+row.result.budget.calls.length,0),guards,automatic_accepted:0,automatic_error_rate:null,human_confirmation_rate:null,baseline_comparison:'Only shared capability and frozen-input scope may be compared. New registered physical states: N/A.'},null,2));
