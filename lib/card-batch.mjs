import{abortable}from'./desktop-recovery.mjs';
import{publishIncompleteCard}from'./incomplete-card.mjs';
import{productBudget}from'./product-budget.mjs';
import{processingFailureKind}from'./automation-policy.mjs';
import{saveCaptureCheckpoint}from'./capture-checkpoint.mjs';
import{collectionRisk,platformRisk}from'./collection-pacer.mjs';
import{AUTOMATION_CONTRACT}from'./automation-policy.mjs';
import{randomUUID}from'node:crypto';
import{InputError,validateSettings}from'./domain.mjs';
import{matchesSettings}from'./batch.mjs';
import{jdItemUrl}from'./capture.mjs';
import{helperAdapter}from'./helper-adapter.mjs';
import{pngSize}from'./cards.mjs';
const active=new Set(['ready','running']);
export class CardBatches{
  constructor(store,tasks,{now=Date.now,pick}={}){Object.assign(this,{store,tasks,now,pick});this.locked=new Set();this.controllers=new Map();this.closed=false;tasks.onAutomaticEnded=task=>task.batchId?this.afterItem(task.batchId):undefined;}
  async create(raw){
    if(!raw||Object.keys(raw).some(k=>!['settings','launchMode'].includes(k)))throw new InputError('批量制卡参数无效');
    if(raw.launchMode!==undefined&&!['send','copy'].includes(raw.launchMode))throw new InputError('启动方式无效');
    await this.tasks.pacer.assertOpen();
    const settings=validateSettings(raw.settings);if(settings.platforms.length!==1||settings.platforms[0]!=='jd')throw new InputError('自动商品规格卡目前仅支持京东，请只勾选京东');
    if(settings.quantity>10)throw new InputError('每批最多10张规格图');
    return this.store.mutate(state=>{
      if(this.store.collectionArchive?.choosing)throw new InputError('请先完成或取消文件夹选择',409);
      if(state.jobs.some(j=>j.status==='running'||j.kind==='jd-auto-card-batch'&&active.has(j.status))||state.productTasks.some(t=>['ready','queued','running','cooldown','publishing'].includes(t.status)))throw new InputError('已有制卡任务，请等待完成或先停止',409);
      const job={id:randomUUID(),kind:'jd-auto-card-batch',templateDefinition:this.store.templateLibrary?.selected(),launchMode:raw.launchMode||'send',retained:0,repeated:0,duplicateStreak:0,settings,saveMode:'automatic',status:'ready',stage:'waiting-agent',createdAt:new Date(this.now()).toISOString(),targets:[],cursor:0,attempted:0,completed:0,skipped:0,failed:0,items:[],reason:'等待Agent执行品牌搜索与自动制卡'};
      state.jobs=[job,...state.jobs].slice(0,100);state.settings=settings;return job;
    });
  }
  async get(id){if(typeof id!=='string'||!/^[a-f0-9-]{36}$/u.test(id))throw new InputError('批量制卡ID无效');const job=(await this.store.readState()).jobs.find(j=>j.id===id&&j.kind==='jd-auto-card-batch');if(!job)throw new InputError('批量制卡任务不存在',404);return job;}
  patch(id,change){return this.store.mutate(state=>{const job=state.jobs.find(j=>j.id===id);if(change.status==='running'&&!active.has(job.status))throw new InputError('任务已停止，不能重新激活',409);Object.assign(job,change);return job;});}
  async expire(){
    const state=await this.store.readState();for(const job of state.jobs.filter(j=>j.kind==='jd-auto-card-batch'&&active.has(j.status))){
      if(job.deadlineAtMs<=this.now()){await this.stop(job.id,'timed-out','旧任务时限已到，未接收迟到产物');continue;}
      if((job.status==='ready'&&job.dispatchedAt&&Date.parse(job.dispatchedAt)+600000<=this.now())||(job.status==='running'&&['agent-start-dispatched','agent-next-dispatched'].includes(job.stage)&&job.dispatchDeadlineAtMs<=this.now())){await this.stop(job.id,'blocked','Agent未开始执行，任务已停止，不会自动重复发送');continue;}
      if(job.currentTaskId){const task=state.productTasks.find(t=>t.id===job.currentTaskId);if(task&&!['ready','queued','running','cooldown','publishing','awaiting-confirmation'].includes(task.status))await this.afterItem(job.id);}
    }
  }
  async check(id){if(this.closed)throw new InputError('插件已停止');await this.expire();const job=await this.get(id);if(job.status!=='running')throw new InputError('批量制卡已结束或停止：'+job.reason,409);return job;}
  async waiting(id,stage){const pace=await this.tasks.pacer.inspect();return this.patch(id,{status:'running',stage,nextEligibleAtMs:pace.nextEligibleAtMs,dispatchRevision:((await this.get(id)).dispatchRevision||0)+1,reason:'等待采集间隔，到时自动继续'});}
  async start(id,adapter,signal){
    let job=await this.get(id);if(!['ready','running'].includes(job.status)||job.status==='running'&&!['cooldown-search','agent-start-dispatched'].includes(job.stage))return job;
    const permit=await this.tasks.pacer.reserve({owner:id,createdAt:job.createdAt,minutes:job.settings.intervalMinutes||5});
    if(!permit.granted)return this.waiting(id,'cooldown-search');
    await this.patch(id,{status:'running',stage:'searching',networkLeaseId:permit.lease.id,startedAt:job.startedAt||new Date(this.now()).toISOString(),nextEligibleAtMs:null,reason:'正在按品牌搜索商品'});
    try{
      signal.throwIfAborted();const targets=await abortable(adapter.discover(job.settings,signal),signal);await this.check(id);signal.throwIfAborted();
      if(!Array.isArray(targets)||targets.length>30)throw new InputError('京东搜索候选无效');
      const unique=[...new Set(targets.map(jdItemUrl))],history=this.store.collectionArchive?.records||(await this.store.readState()).products,known=new Set(history.filter(row=>row.platform==='jd').map(row=>row.sourceUrl)),fresh=unique.filter(url=>!known.has(url)),old=unique.filter(url=>known.has(url)),ordered=[...fresh,...old];
      await this.patch(id,{targets:ordered,discovered:unique.length,networkLeaseId:null});await this.tasks.pacer.finish(permit.lease.id);
      if(!ordered.length)return this.complete(id,'candidates-exhausted');
      return this.waiting(id,'cooldown-next');
    }catch(error){await this.tasks.pacer.finish(permit.lease.id,{risk:platformRisk(error),retryAfterMs:error.retryAfterMs});if((await this.get(id)).status==='running')await this.stop(id,'blocked',error.message);throw error;}
  }
  async reconcile(id){
    let job=await this.get(id);if(!job.currentTaskId)return job;
    const task=(await this.store.readState()).productTasks.find(t=>t.id===job.currentTaskId);if(!task)throw new InputError('本批商品任务缺失');
    if(['ready','queued','running','cooldown','publishing','awaiting-confirmation'].includes(task.status))return job;
    if(task.status==='completed'){
      const file=await this.store.file(task.file),size=pngSize(file.body);if(size.width!==1920||size.height!==1080)throw new InputError('已完成任务没有统一尺寸的真实规格图');
      const reconciled=await this.store.mutate(state=>{const row=state.jobs.find(j=>j.id===id),item=row.items.find(i=>i.taskId===task.id);if(item.status!=='completed'){item.status='completed';item.file=task.file;item.isRepeat=task.collectionRecord?.isRepeat===true;item.note=task.collectionRecord?.note||'';item.dataQuality=task.dataQuality;if(task.dataQuality?.level==='partial')row.partial=(row.partial||0)+1;if(task.fallbackDelivery)row.fallbacks=(row.fallbacks||0)+1;row.retained=(row.retained||0)+1;if(item.isRepeat){row.repeated=(row.repeated||0)+1;row.duplicateStreak=(row.duplicateStreak||0)+1;}else{row.completed++;row.duplicateStreak=0;}}row.currentTaskId=null;row.stage='waiting-next';row.reason='已新增 '+row.completed+' 条，已保存 '+row.retained+' 条，继续下一商品';return row;});
      return task.stopAfterDelivery?this.stop(id,'blocked',task.originalError?.message||'已用已有资料出卡，存在需要停止访问的真实阻断'):reconciled;
    }
    const fatal=task.failureKind==='fatal'||/登录|扫码|验证码|风险|拦截|访问受限|助手.*未连接|login|captcha/iu.test(task.message);
    job=await this.store.mutate(state=>{const row=state.jobs.find(j=>j.id===id),item=row.items.find(i=>i.taskId===task.id);if(row.status!=='running'||row.currentTaskId!==task.id)return row;if(item&&item.status!=='failed'){Object.assign(item,{status:'failed',reason:task.message,errorCode:task.errorCode,endedAt:task.endedAt});row.failed++;}row.currentTaskId=null;row.networkLeaseId=null;row.stage='waiting-next';row.reason='本条未完成，阶段资料已保留；按间隔继续下一商品';return row;});
    return fatal?this.stop(id,'blocked',task.message):job;
  }
  async complete(id,stopReason='quantity-limit'){
    const job=await this.get(id);if(job.status!=='running')return job;return this.patch(id,{status:'completed',stage:'finished',stopReason,currentUrl:null,nextEligibleAtMs:null,endedAt:new Date(this.now()).toISOString(),reason:(stopReason==='quantity-limit'?'已达到新增目标':stopReason==='duplicate-streak'?'连续5条重复，停止继续访问':'当前候选已处理完')+'；新增 '+job.completed+' 条，保存 '+(job.retained||0)+' 张，重复 '+(job.repeated||0)+' 条，失败 '+job.failed+' 条；资料待补全 '+(job.partial||0)+' 张'});
  }
  async next(id,adapter,signal,context={}){
    if((await this.get(id)).status==='completed')return{job:await this.get(id),task:null};
    let job=await this.check(id);job=await this.reconcile(id);
    if(job.status!=='running')return{job,task:null};
    if(job.currentTaskId)return{job,task:await this.tasks.get(job.currentTaskId)};
    if(job.completed>=job.settings.quantity||job.cursor>=job.targets.length)return{job:await this.complete(id,job.completed>=job.settings.quantity?'quantity-limit':'candidates-exhausted'),task:null};
    if(!['waiting-next','cooldown-next','agent-next-dispatched'].includes(job.stage))return{job,task:null,waiting:true};
    const permit=await this.tasks.pacer.reserve({owner:id,createdAt:job.createdAt,minutes:job.settings.intervalMinutes||5});
    if(!permit.granted)return{job:await this.waiting(id,'cooldown-next'),task:null,waiting:true};
    const candidateStartedAtMs=this.now(),url=job.targets[job.cursor];await this.patch(id,{candidateStartedAtMs,cursor:job.cursor+1,attempted:job.attempted+1,currentUrl:url,networkLeaseId:permit.lease.id,nextEligibleAtMs:null,stage:'reading-candidate',reason:'读取下一商品资料'});
    try{
      signal.throwIfAborted();const capture=await abortable(adapter.capture(url,signal),signal);await this.check(id);signal.throwIfAborted();
      if(jdItemUrl(capture.product.sourceUrl)!==url)throw new InputError('候选返回了其他商品，已停止');
      if(!matchesSettings(capture.product,job.settings)){
        await this.store.mutate(state=>{const row=state.jobs.find(j=>j.id===id);row.skipped++;row.items.push({url,status:'filtered'});row.networkLeaseId=null;});
        await this.tasks.pacer.finish(permit.lease.id);return{job:await this.afterItem(id),task:null,waiting:true};
      }
      const task=await this.tasks.create({sourceUrl:url,settings:job.settings,saveMode:'automatic',batchId:id},{budgetStartedAtMs:candidateStartedAtMs});
      this.tasks.prefetched.set(task.id,structuredClone(capture));
      await this.store.mutate(state=>{const row=state.productTasks.find(t=>t.id===task.id);row.networkLeaseId=permit.lease.id;});
      job=await this.patch(id,{currentTaskId:task.id,stage:'making-card',reason:'正在生成产品规格卡'});
      await this.store.mutate(state=>{state.jobs.find(j=>j.id===id).items.push({url,taskId:task.id,status:'making-card'});});
      return{job,task:await this.tasks.get(task.id)};
    }catch(error){
      if((await this.get(id)).status!=='running'||(context.signal?context.signal.aborted:context.exec?context.exec.signal.aborted:signal.aborted)){
        await this.tasks.pacer.finish(permit.lease.id,{risk:platformRisk(error),retryAfterMs:error.retryAfterMs});
        if((await this.get(id)).status==='running')await this.stop(id,'blocked',String(error.message));throw error;
      }
      let task;
      try{
        task=await this.tasks.create({sourceUrl:url,settings:job.settings,saveMode:'automatic',batchId:id},{localOnly:true,budgetStartedAtMs:candidateStartedAtMs});
        await this.store.mutate(state=>{const row=state.productTasks.find(r=>r.id===task.id);Object.assign(row,{...productBudget(candidateStartedAtMs,job.deadlineAtMs),status:'running',progressStage:'reading',networkLeaseId:permit.lease.id,stopAfterDelivery:processingFailureKind(error)==='fatal'});const batch=state.jobs.find(r=>r.id===id);batch.currentTaskId=task.id;batch.stage='making-card';batch.items.push({url,taskId:task.id,status:'making-card'});});
        task=await this.tasks.get(task.id);
        const checkpoint=context.getCheckpoint?.();if(checkpoint?.product?.sourceUrl===url)await saveCaptureCheckpoint(this.tasks,task,checkpoint);
        if(context.ctx&&context.exec){
          const recovered=await this.tasks.desktopRecovery.recover(this.tasks,context.ctx,context.exec,task,error,{signal:context.signal||context.exec.signal,retry:async limited=>{
            const capture=await adapter.capture(url,limited);if(capture.product?.sourceUrl!==url)throw Error('补救返回了其他商品');
            await saveCaptureCheckpoint(this.tasks,task,capture);await this.store.mutate(state=>{state.productTasks.find(r=>r.id===task.id).stopAfterDelivery=false;});
            return publishIncompleteCard(this.tasks,await this.tasks.get(task.id),error,{capture});
          }});if(recovered)return{job:await this.get(id),task:null,waiting:true};
        }
        await this.tasks.progress(task.id,'partial-rendering');await publishIncompleteCard(this.tasks,await this.tasks.get(task.id),error,{capture:context.getCheckpoint?.()});return{job:await this.get(id),task:null,waiting:true};
      }catch(deliveryError){
        if(task){const current=await this.tasks.get(task.id);if(current.status==='completed')return{job:await this.get(id),task:null,waiting:true};if(['ready','running','queued','cooldown'].includes(current.status))await this.tasks.fail(task.id,String(deliveryError.message).slice(0,700),'action-required',{failureKind:processingFailureKind(deliveryError),errorCode:'incomplete-delivery-failed'});return{job:await this.afterItem(id),task:null,waiting:true};}
        await this.tasks.pacer.finish(permit.lease.id);throw deliveryError;
      }
    }
  }
  async afterItem(id){
    let job=await this.reconcile(id);if(job.status!=='running'||job.currentTaskId)return job;
    if(job.duplicateStreak>=5)return this.complete(id,'duplicate-streak');
    if(job.completed>=job.settings.quantity)return this.complete(id);
    if(job.cursor>=job.targets.length)return this.complete(id,'candidates-exhausted');
    return this.waiting(id,'cooldown-next');
  }
  async claim(raw){
    if(!raw||Object.keys(raw).some(key=>!['id','action','cursor'].includes(key))||!['start','next'].includes(raw.action))throw new InputError('调度参数无效');await this.expire();
    const pace=await this.tasks.pacer.inspect();if(!pace.ready){let job=await this.get(raw.id);if(job.status==='ready'&&!job.dispatchedAt&&raw.action==='start')job=await this.waiting(raw.id,'cooldown-search');return{claimed:false,job};}
    return this.store.mutate(state=>{const job=state.jobs.find(j=>j.id===raw.id&&j.kind==='jd-auto-card-batch');if(!job)throw new InputError('批次不存在',404);
      if(raw.action==='start'&&(job.status==='ready'&&!job.dispatchedAt||job.status==='running'&&job.stage==='cooldown-search'&&job.nextEligibleAtMs<=this.tasks.pacer.now())){job.dispatchedAt=new Date(this.now()).toISOString();job.stage='agent-start-dispatched';job.dispatchDeadlineAtMs=this.now()+600000;return{claimed:true,job};}
      if(raw.action==='next'&&job.status==='running'&&['waiting-next','cooldown-next'].includes(job.stage)&&!job.currentTaskId&&raw.cursor===job.cursor){job.stage='agent-next-dispatched';job.dispatchDeadlineAtMs=this.now()+600000;return{claimed:true,job};}
      return{claimed:false,job};
    });
  }
  async stop(id,status='cancelled',reason='用户已停止批量制卡'){
    this.controllers.get(id)?.abort();const job=await this.get(id);if(!active.has(job.status))return job;
    await this.patch(id,{status,stage:'stopped',reason:String(reason).slice(0,400),endedAt:new Date(this.now()).toISOString()});
    if(job.currentTaskId){const task=await this.tasks.get(job.currentTaskId);if(['ready','queued','running','cooldown'].includes(task.status))await this.tasks.fail(task.id,reason,status==='timed-out'?'timed-out':'cancelled');}
    await this.tasks.pacer.finish(job.networkLeaseId);return this.get(id);
  }
  async close(){this.closed=true;for(const job of (await this.store.readState()).jobs.filter(j=>j.kind==='jd-auto-card-batch'&&active.has(j.status)))await this.stop(job.id,'interrupted','服务已停止，批量制卡中断');}
}
export function cardBatchTool(batches,ctx,connector){return{
  name:'sofa_monitor_card_batch',description:AUTOMATION_CONTRACT+'执行用户在沙发爬取面板创建的京东品牌全自动制卡批次。start搜索；next返回下一条商品任务；本工具由插件调度器分步调用，不自行循环；生成和归档单品后，调度器安排下一条。completed只统计已归档且未明确重复的1920×1080PNG；retained包含重复留档，repeated为重复数。连续5条重复或最多30个候选耗尽则停止，不能凑满时报告实际数量。每次搜索或商品处理后按intervalMinutes强制等待，默认5分钟；等待时立即返回，不循环调用工具、网页或缩短间隔。遇登录、验证码、403、429或平台拦截就停止，禁止自动重试。',
  parameters:{type:'object',additionalProperties:false,properties:{id:{type:'string',format:'uuid'},action:{type:'string',enum:['start','next','status','stop']},reason:{type:'string',maxLength:400}},required:['id','action']},
  output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},timeoutMs:1800000,isConcurrencySafe:()=>false,
  async execute(args,exec){
    if(!args||Object.keys(args).some(k=>!['id','action','reason'].includes(k)))throw new InputError('批量制卡工具参数无效');exec.signal.throwIfAborted();
    if(batches.locked.has(args.id))throw new InputError('该批次命令正在执行，请等待结果',409);batches.locked.add(args.id);
    try{
      await batches.expire();let job=await batches.get(args.id);
      if(args.action==='status')return{job:await batches.reconcile(args.id)};
      if(args.action==='stop')return{job:await batches.stop(args.id,'cancelled',args.reason||'用户或Agent停止批量制卡')};
      if(!active.has(job.status))return{job,task:null};
      await batches.dispatcher?.bind('batch',args.id,exec);
      const controller=new AbortController();batches.controllers.set(args.id,controller);
      let checkpoint;const rootSignal=AbortSignal.any([exec.signal,controller.signal]);
      const signal=AbortSignal.any([rootSignal,AbortSignal.timeout(180000)]),adapter=helperAdapter(ctx,exec,connector,{automatic:true,collectDetails:!!batches.tasks.detailReview,pause:batches.tasks.pause,pacer:batches.tasks.pacer,onCheckpoint:value=>{if(!rootSignal.aborted)checkpoint=structuredClone(value);}});
      if(args.action==='start')return{job:await batches.start(args.id,adapter,signal),nextAction:'本步骤已结束，插件调度器会安排后续命令，本次直接返回。'};
      if(args.action==='next'){const result=await batches.next(args.id,adapter,signal,{ctx,exec,signal:rootSignal,getCheckpoint:()=>checkpoint});return{...result,nextAction:result.task?'本步骤已准备好商品任务，插件调度器会单独发送该任务，本次只返回结果，不自行循环。':result.waiting?'正在等待后台采集间隔，本次直接返回；不反复查状态、不操作网页、不询问用户。':'按实际批次状态返回，只有终态才报告结束。'};}
      throw new InputError('批量制卡操作无效');
    }catch(error){const current=await batches.get(args.id);if(active.has(current.status))await batches.stop(args.id,exec.signal.aborted?'cancelled':'blocked',error.message||'批次工具失败');throw error;}finally{batches.controllers.delete(args.id);batches.locked.delete(args.id);}
  }
};}
