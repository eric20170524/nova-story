import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {OpenAIProvider} from '../src/services/ai/openai_provider';
import {CONTINUITY_EVAL_FIXTURES} from '../src/test_fixtures/continuity_eval';
import {continuityEvaluationTask} from '../src/test_fixtures/continuity_eval_task';
import {extractContinuitySuggestions,continuitySuggestionPolicyFingerprint} from '../src/services/continuity_suggestions';
async function main(){
  const hand=process.argv.includes('--hand');
  const bytes=await fs.readFile(path.resolve(__dirname,`../src/test_fixtures/continuity/${hand?'eval-hand-labels-v1.json':'eval-special-labels-v1.json'}`)),labels=JSON.parse(bytes.toString()),labels_hash=createHash('sha256').update(bytes).digest('hex');
  const models=await(await fetch('http://127.0.0.1:11434/v1/models',{signal:AbortSignal.timeout(10000)})).json() as any;
  if(!models.data?.some((model:any)=>model.id==='novastory-qwen3.5:9b'))throw new Error('Real local model preflight failed');
  const output=path.resolve(__dirname,`../../local/verification/${hand?'continuity-ct21/hand-mini-v1':'continuity-ct14/supplementary-v2'}`);await fs.mkdir(output,{recursive:true});
  const provider=new OpenAIProvider('ollama','novastory-qwen3.5:9b','http://127.0.0.1:11434/v1',{isOllama:true,timeoutMs:90000}),results:any[]=[];
  for(const source of labels.cases)for(const seed of labels.seeds){
    const base=CONTINUITY_EVAL_FIXTURES.find(fixture=>fixture.id===source.base_fixture)!;
    const fixture={...base,entities:source.entities||base.entities,prior:source.prior||base.prior};
    const sourceCase={id:source.id,source:source.source,expected:source.expected},task=continuityEvaluationTask(fixture,sourceCase,provider,seed);
    if(source.time_relation)task.context={...task.context,time_relation:source.time_relation};
    const filename=path.join(output,`${source.id}-${seed}.json`);let record:any;
    try{record=JSON.parse(await fs.readFile(filename,'utf8'));}catch{}
    if(!record?.completed||record.labels_hash!==labels_hash){
      const result=await extractContinuitySuggestions(task);
      const same=(change:any,expected:any)=>['entity_id','attribute_id','operation','value'].every(key=>change[key]===expected[key]);
      const missing=source.expected.filter((expected:any)=>!result.proposals.some(change=>same(change,expected)));
      const pending=result.pending.some((pending:any)=>pending.code===source.expected_pending||(source.expected_pending==='shared_holder'&&pending.code==='CONTINUITY_SHARED_HOLDER_UNSUPPORTED'));
      record={completed:true,id:source.id,seed,labels_hash,policy_fingerprint:continuitySuggestionPolicyFingerprint,source,initial_state:task.prior_state,result,adjudication:{missing,expected_pending_preserved:pending,acceptable:source.expected_pending?pending&&result.proposals.length===0:!missing.length&&result.proposals.length===source.expected.length&&!result.pending.length},automatic_accepted:0};
      await fs.writeFile(filename,JSON.stringify(record,null,2));
    }
    results.push(record);
  }
  await fs.writeFile(path.join(output,'summary.json'),JSON.stringify({logical_tasks:results.length,actual_calls:results.reduce((n,row)=>n+row.result.budget.calls.length,0),acceptable:results.filter(row=>row.adjudication.acceptable).length,automatic_accepted:0,automatic_error_rate:null,labels_hash,cases:results.map(row=>({id:row.id,seed:row.seed,status:row.result.status,acceptable:row.adjudication.acceptable,pending:row.result.pending}))},null,2));
}
main().catch(error=>{process.stderr.write(String(error.stack||error));process.exitCode=1;});
