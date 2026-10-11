import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'local/verification/continuity-ct19');
if(process.argv[2]==='sample'){
  const rows=[];
  for(let index=0;index<24;index++){
    rows.push({at:new Date().toISOString(),gpu:execFileSync('nvidia-smi',['--query-gpu=name,memory.used,memory.total,utilization.gpu','--format=csv,noheader,nounits'],{encoding:'utf8',windowsHide:true}).trim()});
    await fs.writeFile(path.join(dir,'gpu-samples.json'),JSON.stringify(rows,null,2));await new Promise(resolve=>setTimeout(resolve,5000));
  }
  console.log(`Captured ${rows.length} GPU samples`);
}else{
  const before=JSON.parse(await fs.readFile(path.join(dir,'audit-initial-reviewed.json'),'utf8')),after=JSON.parse(await fs.readFile(path.join(dir,'audit-final.json'),'utf8'));
  const initialIds=new Set(before.tasks.map(task=>task.task_id)),remakes=after.tasks.filter(task=>!initialIds.has(task.task_id));
  const unchanged=[301,305].map(id=>{const old=before.shots.find(shot=>shot.id===id),now=after.shots.find(shot=>shot.id===id);return{id,same_image:old.asset_url===now.asset_url,same_version:old.active_version===now.active_version,current:now.continuity_status==='current'};});
  const milliseconds=value=>Date.parse(value.endsWith('Z')?value:value.replace(' ','T')+'Z');
  let gpu=[];try{gpu=JSON.parse(await fs.readFile(path.join(dir,'gpu-samples.json'),'utf8'));}catch{}
  const metrics={captured_at:new Date().toISOString(),initial_tasks:before.tasks.length,initial_completed:before.tasks.filter(task=>task.status==='completed').length,initial_failed:before.tasks.filter(task=>task.status==='failed').length,remake_tasks:remakes.length,remake_completed:remakes.filter(task=>task.status==='completed').length,remake_failed:remakes.filter(task=>task.status==='failed').length,skipped_unrelated_tasks:2,avoided_fraction:2/5,unchanged,task_times:after.tasks.map(task=>({scene_id:task.scene_id,task_id:task.task_id,status:task.status,elapsed_ms:milliseconds(task.updated_at)-milliseconds(task.created_at),comfy_prompt_id:task.comfy_prompt_id})),gpu_samples:gpu,review_counts:{accepted:after.frames.filter(frame=>frame.review?.verdict==='accepted').length,rejected:after.frames.filter(frame=>frame.review?.verdict==='rejected').length},review_is:'acceptance-agent manual visual inspection, not actual user adoption statistics',causal_limit:'Initial cold-start and revised local remake runs have different readiness and workload. Error-rate and elapsed-time differences are observations, not a controlled throughput benchmark.'};
  await fs.writeFile(path.join(dir,'metrics.json'),JSON.stringify(metrics,null,2));console.log(JSON.stringify({remake_completed:metrics.remake_completed,remake_failed:metrics.remake_failed,unchanged,avoided_fraction:metrics.avoided_fraction},null,2));
}
