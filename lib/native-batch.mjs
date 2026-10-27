import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {InputError} from './domain.mjs';
import {jdItemUrl} from './capture.mjs';
import {validateNativeCapture} from './native-capture.mjs';

export function searchUrl(settings){return 'https://search.jd.com/Search?keyword='+encodeURIComponent(settings.brand+' '+settings.keyword)+'&enc=utf-8';}
export function searchTargets(raw,settings){
  if(!raw||raw.sourceUrl!==searchUrl(settings)||!Array.isArray(raw.candidates)||raw.candidates.length>30)throw new InputError('中央搜索结果格式或来源不正确，任务已停止');
  const targets=raw.candidates.map(value=>{if(typeof value!=='string'||jdItemUrl(value)!==value)throw new InputError('搜索结果包含无效商品来源');return value;});
  return [...new Set(targets)];
}
// Remote adapter only. The existing runner remains authoritative for time,
// filtering, quantities, persistence and admitting each draft.
export class NativeBatchBridge{
  constructor(store,runner,{now=Date.now,leaseMs=5000}={}){Object.assign(this,{store,runner,now,leaseMs});this.runs=new Map();this.starting=false;this.closed=false;}
  entry(raw){
    const entry=this.runs.get(raw?.id),token=raw?.token;
    if(!entry||typeof token!=='string'||!/^[a-f0-9]{64}$/u.test(token)||!timingSafeEqual(Buffer.from(token),Buffer.from(entry.token)))throw new InputError('中央任务凭据已失效，请新建任务',403);
    return entry;
  }
  async start(raw){
    if(this.closed||this.starting||this.runner.active)throw new InputError('已有任务运行或执行器正在关闭',409);
    if(!raw||Object.keys(raw).some(key=>key!=='settings'))throw new InputError('中央任务参数不正确');
    this.starting=true;
    try{
      const job=await this.runner.create({mode:'native-search',settings:raw.settings});
      const entry={id:job.id,token:randomBytes(32).toString('hex'),pulse:this.now(),pending:null,consumed:new Set(),ended:false};this.runs.set(job.id,entry);
      for(const [id,old] of this.runs)if(this.runs.size>20&&old.ended)this.runs.delete(id);
      const adapter={
        discover:async(settings,signal)=>{
          const state=await this.store.readState(),current=state.jobs.find(row=>row.id===job.id);
          return searchTargets(await this.request(entry,'search',{settings,deadlineAt:current.deadlineAt,deadlineAtMs:current.deadlineAtMs},signal),settings);
        },
        capture:async(url,signal)=>validateNativeCapture(await this.request(entry,'capture',{url},signal),this.now())
      };
      entry.done=this.runner.run(job.id,adapter).catch(async error=>{
        const state=await this.store.readState(),current=state.jobs.find(row=>row.id===job.id);
        if(current?.status==='ready')await this.runner.patch(job.id,{status:'blocked',reason:error instanceof InputError?error.message:'中央任务未能启动',endedAt:new Date(this.now()).toISOString()});
      }).finally(()=>{entry.ended=true;clearInterval(entry.watchdog);});
      entry.watchdog=setInterval(()=>{if(this.now()-entry.pulse>this.leaseMs&&this.runner.active?.id===entry.id)this.runner.cancel(entry.id,'interrupted');},Math.min(1000,this.leaseMs));entry.watchdog.unref?.();
      return{id:job.id,token:entry.token};
    }finally{this.starting=false;}
  }
  request(entry,kind,args,signal){
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const command={id:randomUUID(),kind,args};
      const finish=(fn,value)=>{signal.removeEventListener('abort',abort);if(entry.pending?.command.id===command.id)entry.pending=null;fn(value);};
      const abort=()=>finish(reject,signal.reason);
      entry.pending={command,resolve:value=>finish(resolve,value),reject:error=>finish(reject,error)};
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
    });
  }
  async pull(raw){
    const entry=this.entry(raw);entry.pulse=this.now();
    const state=await this.store.readState(),job=state.jobs.find(row=>row.id===entry.id);
    return{job,command:job?.status==='running'?entry.pending?.command||null:null};
  }
  pulse(raw){const entry=this.entry(raw);entry.pulse=this.now();return{alive:!entry.ended};}
  reply(raw){
    const entry=this.entry(raw);entry.pulse=this.now();
    if(entry.consumed.has(raw.commandId))return{accepted:true,duplicate:true};
    if(entry.ended||entry.pending?.command.id!==raw.commandId)throw new InputError('任务已停止或命令已过期，未接收结果',409);
    const pending=entry.pending;entry.consumed.add(raw.commandId);
    if(typeof raw.error==='string')pending.reject(new InputError(raw.error.slice(0,240).replace(/[\u0000-\u001f]/gu,' ')));
    else if(!Object.hasOwn(raw,'result')){pending.reject(new InputError('中央读取结果缺失'));}
    else pending.resolve(raw.result);
    return{accepted:true};
  }
  async stop(raw){
    const entry=this.entry(raw);
    if(this.runner.active?.id===entry.id)this.runner.cancel(entry.id,raw.reason==='interrupted'?'interrupted':'cancelled');
    await entry.done;return{stopped:true};
  }
  async close(){this.closed=true;for(const entry of this.runs.values()){if(this.runner.active?.id===entry.id)this.runner.cancel(entry.id,'interrupted');}await Promise.all([...this.runs.values()].map(entry=>entry.done));}
}
