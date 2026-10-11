import test from 'node:test';
import assert from 'node:assert/strict';
import {ComfyStartupCoordinator} from './comfy_startup';
test('CT22 overlapping cold-start callers share one process and successful readiness',async()=>{
  const gate=new ComfyStartupCoordinator();let launches=0,time=0,ready=false;
  const start=()=>{launches++;return{alive:()=>true};},delay=async()=>{time+=1000;await Promise.resolve();if(time>=2000)ready=true;};
  const results=await Promise.all([gate.ensure('local',async()=>ready,start,5000,()=>time,delay),gate.ensure('local',async()=>ready,start,5000,()=>time,delay)]);
  assert.deepEqual(results,[true,true]);assert.equal(launches,1);
});
test('CT22 a timed-out but living startup is reused; a terminated startup can be replaced',async()=>{
  const gate=new ComfyStartupCoordinator();let launches=0,time=0,alive=true;
  const start=()=>{launches++;return{alive:()=>alive};},delay=async()=>{time+=1000;};
  assert.equal(await gate.ensure('local',async()=>false,start,1000,()=>time,delay),false);
  assert.equal(await gate.ensure('local',async()=>false,start,1000,()=>time,delay),false);assert.equal(launches,1);
  alive=false;await gate.ensure('local',async()=>false,start,1000,()=>time,delay);assert.equal(launches,2);
});
