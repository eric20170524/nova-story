// Read-only audit of the explicitly isolated CT08/CT13 acceptance database.
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import sharp from 'sharp';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.join(repo,'local','verification','continuity-ct08');
const db=await open({filename:path.join(repo,'local','verification','continuity-browser','sql_app.db'),driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
try {
  const source=['黑伞的柄只是弯曲，没有折断。','林岚把黑伞递给陈月。','陈月仍握着黑伞。'];
  assert.equal((await db.get("SELECT content FROM chapter WHERE id='ct08-main'")).content,source.join('\n'));
  const document=JSON.parse((await db.get('SELECT document_json FROM chapter_script WHERE id=30')).document_json);
  assert.deepEqual(document.scenes.flatMap(scene=>scene.blocks.map(block=>block.text)),source);
  const shots=await db.all('SELECT id,active_version,asset_url,asset_status,audio_prompt,continuity_status FROM scene WHERE id IN (101,102,103) ORDER BY id');
  assert.equal(shots[0].asset_url,'/static/fixtures/F06-blue-coat.svg');assert.equal(shots[0].active_version,1);
  for(const shot of shots){assert.equal(shot.continuity_status,'current');assert.equal(shot.audio_prompt,'雨声');}
  for(const shot of shots.slice(1)){assert.equal(shot.asset_url,null);assert.ok(shot.active_version>1);}
  const versions=await db.all('SELECT scene_id,version,asset_url,continuity_status FROM scene_version WHERE scene_id IN (101,102,103) ORDER BY scene_id,version');
  for(const id of [102,103])assert.equal(versions.find(version=>version.scene_id===id&&version.version===1).asset_url,'/static/fixtures/F06-broken-umbrella-v2.svg');
  const history=await db.all('SELECT revision,actor_id,reason FROM continuity_revision WHERE script_id=30 ORDER BY revision');
  assert.ok(history.some(record=>record.reason.startsWith('undo:1 ')));assert.equal(history.at(-1).revision,8);
  const legacy=await db.get('SELECT asset_url,continuity_status FROM scene WHERE id=201');assert.equal(legacy.asset_url,'/static/fixtures/F06-blue-coat.svg');
  const screenshots={};
  for(const file of ['stale-1280.jpg','preview-1920.jpg','undo-1920.jpg','conflict-1280.jpg','conflict-1920.jpg','recovery-1280.jpg','recovery-1920.jpg','legacy-1280.jpg','legacy-1920.jpg','script-1280.jpg','script-1920.jpg']){
    const meta=await sharp(path.join(root,file)).metadata();const size=file.includes('1280')?[1280,800]:[1920,1080];assert.deepEqual([meta.width,meta.height],size);screenshots[file]={width:meta.width,height:meta.height};
  }
  const generated=(await db.get('SELECT COUNT(*) n FROM generation_task')).n;
  assert.equal(generated,0);
  await fs.writeFile(path.join(root,'browser-audit.json'),JSON.stringify({time:new Date().toISOString(),database:'local/verification/continuity-browser/sql_app.db',source_unchanged:true,shots,versions,history,legacy,screenshots,formal_generation_tasks:generated,real_model_run:false},null,2)+'\n');
  console.log('CT08/CT13 browser audit passed: source, old media, local versions, history, 11 screenshot dimensions, zero generation tasks');
}finally{await db.close();}
