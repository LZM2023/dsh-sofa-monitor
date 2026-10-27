import {randomUUID,randomInt} from 'node:crypto';
import {InputError,validateSettings} from './domain.mjs';
import {jdItemUrl} from './capture.mjs';
import {deadlineFields,deadlineTimer} from './deadline.mjs';
import {platformDetail,requireOnline} from './platforms.mjs';
import {findDuplicateTitle} from './dedup.mjs';

export function batchPlan(raw) {
  const settings=validateSettings(raw?.settings);
  if(raw.mode==='helper-search'){
    settings.platforms.forEach(requireOnline);
    if(settings.quantity>10)throw new InputError('每批最多10条，先核对后入库');
    return{id:randomUUID(),kind:'browser-helper-batch',createdAt:new Date().toISOString(),settings,targets:[],status:'ready',completed:0,attempted:0,skipped:0,items:[],reason:'等待在右侧Agent启动浏览器助手搜索；尚未访问网页'};
  }
  if(settings.platforms.length!==1||settings.platforms[0]!=='jd')throw new InputError('执行器目前仅支持京东，请只选择京东');
  if(raw.mode==='native-search'){
    if(settings.quantity>10)throw new InputError('中央首版每批最多10条；资料须人工确认');
    return{id:randomUUID(),kind:'jd-native-search-batch',createdAt:new Date().toISOString(),settings,targets:[],status:'ready',completed:0,attempted:0,skipped:0,items:[],reason:'等待中央搜索执行'};
  }
  if(!Array.isArray(raw.targets)||!raw.targets.length||raw.targets.length>20)throw new InputError('请提供 1–20 条明确的京东商品详情链接');
  const targets=[...new Set(raw.targets.map(jdItemUrl))];
  return {id:randomUUID(),kind:'jd-link-batch',createdAt:new Date().toISOString(),settings,targets,status:'ready',completed:0,attempted:0,skipped:0,items:[],reason:'等待在 Agent 中启动；尚未访问网页'};
}
const folded=text=>text.normalize('NFKC').toLocaleLowerCase();
export function matchesSettings(product,settings) {
  if(product.recordType==='note'){const text=folded(product.title+' '+product.body);return text.includes(folded(settings.brand))&&text.includes(folded(settings.keyword));}
  return folded(product.brand).includes(folded(settings.brand))&&folded([product.title,product.model,...Object.values(product.specs)].join(' ')).includes(folded(settings.keyword));
}
export function shuffled(values,pick=randomInt) {
  const result=[...values];for(let i=result.length-1;i>0;i--){const j=pick(i+1);[result[i],result[j]]=[result[j],result[i]];}return result;
}
class BatchStop extends Error {constructor(code){super(code);this.code=code;}}

// Adapter calls must honour the supplied signal. The race also excludes late
// results from drafts even when an adapter settles after cancellation.
function abortable(promise,signal) {
  // Observe the adapter promise even when the signal was already aborted.
  // Otherwise its later rejection can escape the task and become unhandled.
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
    if(signal.aborted){signal.removeEventListener('abort',abort);abort();}
  });
}
export class BatchRunner {
  constructor(store,{now=Date.now,schedule=setTimeout,unschedule=clearTimeout,pick=randomInt}={}) {Object.assign(this,{store,now,schedule,unschedule,pick});this.active=null;this.closed=false;}
  async create(raw){const job=batchPlan(raw);return this.store.mutate(state=>{if(state.jobs.some(j=>j.kind==='jd-auto-card-batch'&&['ready','running'].includes(j.status)))throw new InputError('品牌自动制卡正在执行，请等待或先停止',409);if(job.kind==='browser-helper-batch'&&state.jobs.some(row=>row.kind==='browser-helper-batch'&&row.status==='ready'))throw new InputError('已有待启动助手任务，请先发送或取消，避免重复提交');if(['jd-native-search-batch','browser-helper-batch'].includes(job.kind)&&state.drafts.length+job.settings.quantity>10)throw new InputError('待确认区空间不足，请先核对或减少本批数量');state.jobs=[job,...state.jobs.filter(j=>j.status==='running'),...state.jobs.filter(j=>j.status!=='running')].slice(0,100);state.settings=job.settings;return job;});}
  cancelReady(id){return this.store.mutate(state=>{const job=state.jobs.find(row=>row.id===id&&row.kind==='browser-helper-batch');if(!job||job.status!=='ready')throw new InputError('该助手任务已启动或结束，请刷新状态',409);Object.assign(job,{status:'cancelled',stopReason:'cancelled-before-start',endedAt:new Date(this.now()).toISOString(),reason:'已取消待启动任务，不会读取网页'});return job;});}
  async patch(id,change){return this.store.mutate(state=>{const job=state.jobs.find(j=>j.id===id);if(!job)throw new InputError('采集任务不存在',404);Object.assign(job,change);return job;});}
  cancel(id,code='cancelled') {
    if(this.active?.id!==id)throw new InputError('该任务当前没有运行',409);
    this.active.controller.abort(new BatchStop(code));return {stopping:true,id};
  }
  async close(){this.closed=true;if(this.active){this.cancel(this.active.id,'interrupted');await this.active.done;}}
  async run(id,adapter,parentSignal) {
    if(this.store.collectionPacer)throw new InputError('旧版快速采集执行器已停用，请使用面板带商品间隔的自动制卡流程',409);
    if(this.closed)throw new InputError('插件正在卸载',409);
    if(this.active)throw new InputError('已有采集任务正在运行，请先停止',409);
    parentSignal?.throwIfAborted();
    const controller=new AbortController();let resolveDone;
    const active={id,controller,done:new Promise(resolve=>{resolveDone=resolve;})};this.active=active;
    const {signal}=controller;
    const abortParent=()=>controller.abort(new BatchStop('cancelled'));
    parentSignal?.addEventListener('abort',abortParent,{once:true});
    let timer,started=false;
    try {
      const job=await this.store.mutate(state=>{
        const value=state.jobs.find(j=>j.id===id&&['jd-link-batch','jd-native-search-batch','browser-helper-batch'].includes(j.kind));
        if(!value)throw new InputError('采集任务不存在',404);
        if(value.status!=='ready')throw new InputError('此任务已执行或停止；重新运行请新建任务',409);
        const startedAtMs=this.now();Object.assign(value,{status:'running',...deadlineFields(startedAtMs,value.settings.durationMinutes),reason:value.kind==='jd-native-search-batch'?'正在中央按品牌和关键词搜索':value.kind==='browser-helper-batch'?'正在浏览器助手按品牌和关键词搜索':'正在读取明确指定的京东商品详情'});return value;
      });started=true;
      const deadline=job.deadlineAtMs;
      const checkpoint=()=>{if(this.now()>=deadline&&!signal.aborted)controller.abort(new BatchStop('time-limit'));signal.throwIfAborted();};
      timer=deadlineTimer(deadline,()=>controller.abort(new BatchStop('time-limit')),{now:this.now,schedule:this.schedule,unschedule:this.unschedule});
      const normalizeTarget=url=>{
        if(job.kind!=='browser-helper-batch')return jdItemUrl(url);
        const detail=platformDetail(url);requireOnline(detail.platform);
        if(!job.settings.platforms.includes(detail.platform)||detail.sourceUrl!==url)throw new InputError('搜索结果包含未选择平台或非规范链接');
        return detail.sourceUrl;
      };
      if(['jd-native-search-batch','browser-helper-batch'].includes(job.kind)){
        if(typeof adapter.discover!=='function')throw new InputError('中央任务只能从面板启动');
        checkpoint();const discovered=await abortable(adapter.discover(job.settings,signal),signal);checkpoint();
        if(!Array.isArray(discovered)||discovered.length>(job.kind==='browser-helper-batch'?60:30))throw new InputError('搜索候选范围无效');
        job.targets=[...new Set(discovered.map(normalizeTarget))];
        await this.store.mutate(state=>{checkpoint();const row=state.jobs.find(j=>j.id===id);row.targets=job.targets;row.discovered=job.targets.length;row.reason=job.kind==='browser-helper-batch'?'正在浏览器助手逐条读取正文或官方参数':'正在中央逐条读取商品详情';});
      }
      const targets=job.settings.randomMode?shuffled(job.targets,this.pick):job.targets;
      let count=0,attempted=0,skipped=0;
      for(const url of targets){
        if(count>=job.settings.quantity)break;checkpoint();
        await this.patch(id,{currentUrl:url,attempted:++attempted});checkpoint();
        const capture=await abortable(Promise.resolve().then(()=>{checkpoint();return adapter.capture(url,signal);}),signal);checkpoint();
        if(!matchesSettings(capture.product,job.settings)){
          skipped++;await this.store.mutate(state=>{checkpoint();const row=state.jobs.find(j=>j.id===id);row.skipped=skipped;row.items.push({url,status:'filtered'});});continue;
        }
        // Admission and deadline are checked inside the serialized storage write.
        await this.store.mutate(state=>{
          checkpoint();
          if(normalizeTarget(capture.product.sourceUrl)!==url)throw new InputError('适配器返回了其他商品或笔记，任务已停止');
          const duplicate=findDuplicateTitle(capture.product,[...state.products,...state.drafts.map(d=>d.product)],{excludeSelf:false});
          if(duplicate){const row=state.jobs.find(j=>j.id===id);row.skipped=++skipped;row.items.push({url,status:'duplicate',reason:'相同来源或完全相同规格已保存',duplicateTitle:duplicate.title});return;}
          if(state.drafts.length>=10)throw new InputError('待确认区已满，请先确认或丢弃资料');
          const draft={id:randomUUID(),createdAt:new Date(this.now()).toISOString(),jobId:id,product:capture.product,evidence:capture.evidence};
          state.drafts.unshift(draft);
          const row=state.jobs.find(j=>j.id===id);row.completed=++count;row.items.push({url,status:'awaiting-confirmation',draftId:draft.id});
        });
      }
      if(count<job.settings.quantity)checkpoint();
      return await this.patch(id,{status:'completed',endedAt:new Date(this.now()).toISOString(),stopReason:count>=job.settings.quantity?'quantity-limit':'queue-exhausted',currentUrl:null,reason:count>=job.settings.quantity?'已达到目标数量；资料等待人工确认':'指定链接已处理完；符合条件的资料等待人工确认'});
    }catch(error){
      if(!started)throw error;
      const code=signal.aborted?(signal.reason?.code||'cancelled'):'blocked';
      return await this.patch(id,{status:code==='time-limit'?'timed-out':code,endedAt:new Date(this.now()).toISOString(),stopReason:code,currentUrl:null,...(code==='blocked'?{failure:{stage:error.stage||'capture',code:error.code||'capture-failed'}}:{}),reason:code==='time-limit'?'已达到整批任务最长运行时间；不再读取或接收迟到结果':code==='cancelled'?'用户或 Agent 已停止任务':code==='interrupted'?'插件卸载或服务重启，任务已停止':error instanceof InputError?error.message:'浏览器读取失败，任务已停止；请检查连接、登录和读取审批'});
    }finally{
      timer?.cancel();
      parentSignal?.removeEventListener('abort',abortParent);
      this.active=null;resolveDone();
    }
  }
}

