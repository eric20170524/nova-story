type Startup = { alive:()=>boolean };
/** Retain a still-booting process after timeout; another caller must not spawn a duplicate. */
export class ComfyStartupCoordinator {
  private processes=new Map<string,Startup>();
  private waits=new Map<string,Promise<boolean>>();
  async ensure(key:string,check:()=>Promise<boolean>,start:()=>Startup,timeoutMs:number,clock=Date.now,delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))):Promise<boolean>{
    if(await check())return true;
    const active=this.waits.get(key);if(active)return active;
    const pending=(async()=>{
      let process=this.processes.get(key);
      if(!process?.alive()){process=start();this.processes.set(key,process);}
      const deadline=clock()+timeoutMs;
      while(clock()<deadline){await delay(1000);if(await check())return true;if(!process.alive())break;}
      return false;
    })();
    this.waits.set(key,pending);
    try{return await pending;}finally{if(this.waits.get(key)===pending)this.waits.delete(key);}
  }
}
