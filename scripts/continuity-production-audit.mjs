// Read-only audit of the isolated acceptance project, never the user database.
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const label=process.argv[2]||'latest';if(!/^[a-z0-9-]+$/.test(label))throw new Error('Invalid audit label');
const db=await open({filename:path.join(root,'local/verification/continuity-browser/sql_app.db'),driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
try{
  const shots=await db.all('SELECT s.* FROM scene s JOIN chapter c ON c.id=s.chapter_id WHERE c.project_id=30 ORDER BY s."index",s.id');
  const ids=shots.map(shot=>shot.id);const params=ids.map(()=>'?').join(',');
  const tasks=await db.all(`SELECT * FROM generation_task WHERE scene_id IN (${params}) ORDER BY created_at,task_id`,...ids);
  const versions=await db.all(`SELECT scene_id,version,asset_url,asset_status,continuity_status FROM scene_version WHERE scene_id IN (${params}) ORDER BY scene_id,version`,...ids);
  const frames=await db.all(`SELECT * FROM scene_production_frame WHERE scene_id IN (${params}) ORDER BY scene_id,scene_version`,...ids);
  const ledger=await db.get('SELECT revision FROM continuity_ledger WHERE script_id=50');
  const audit={captured_at:new Date().toISOString(),project_id:30,script_id:50,ledger_revision:ledger?.revision,shots:shots.map(({id,index,active_version,asset_url,asset_status,continuity_status,shot_spec})=>({id,index,active_version,asset_url,asset_status,continuity_status,source:JSON.parse(shot_spec||'{}').source})),tasks,versions,frames:frames.map(frame=>({...frame,reference_versions_json:undefined,image_review_json:undefined,pin:JSON.parse(frame.reference_versions_json||'null'),review:JSON.parse(frame.image_review_json||'null')}))};
  const output=path.join(root,`local/verification/continuity-ct19/audit-${label}.json`);await fs.writeFile(output,JSON.stringify(audit,null,2));
  console.log(JSON.stringify({output,revision:ledger?.revision,shots:audit.shots.map(({id,active_version,asset_status,continuity_status,asset_url})=>({id,version:active_version,asset_status,continuity_status,image:!!asset_url})),tasks:tasks.map(({scene_id,status,error,comfy_prompt_id})=>({scene_id,status,error,comfy_prompt_id}))},null,2));
}finally{await db.close();}
