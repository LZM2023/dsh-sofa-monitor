import{ensureCollectionPacer,collectionRisk,platformRisk}from'./collection-pacer.mjs';
import{productBudget}from'./product-budget.mjs';
import{DesktopRecovery}from'./desktop-recovery.mjs';
import{templateDetailCount}from'./template-schema.mjs';
import{runAutomaticProduct}from'./run-product.mjs';
import{localProductSource}from'./local-product.mjs';
import{AUTOMATION_CONTRACT,productTimingContract}from'./automation-policy.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,lstat,readFile,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {InputError,validateSettings} from './domain.mjs';
import {jdItemUrl} from './capture.mjs';
import {pngSize,validateCardFields,saveCard} from './cards.mjs';
import {renderStandardCard} from './card-renderer.mjs';
import {automaticCardData,automaticPhotos} from './automatic-card.mjs';

const active=new Set(['ready','queued','running','cooldown']);
const compact=value=>String(value).normalize('NFKC').replace(/\s+/gu,'').toLocaleLowerCase();
const uuid=/^[a-f0-9-]{36}$/u;
export class ProductTasks{
  constructor(store,{now=Date.now,archive}={}){this.automaticRuns=new Set();this.controllers=new Map();this.archive=archive;this.store=store;this.now=now;this.closed=false;this.pacer=ensureCollectionPacer(store);this.prefetched=new Map();this.desktopRecovery=new DesktopRecovery({now});}
  check(){if(this.closed)throw new InputError('插件正在重新加载，旧商品任务不再接收结果',409);}
  async close(){this.closed=true;for(const controller of this.controllers.values())controller.abort();this.prefetched.clear();const state=await this.store.readState();if(!state.productTasks.some(task=>active.has(task.status)||task.status==='publishing'))return;await this.store.mutate(next=>{for(const task of next.productTasks)if(active.has(task.status)||task.status==='publishing')Object.assign(task,{status:task.status==='publishing'?'card-error':'interrupted',message:'服务已停止；不会接收旧任务迟到结果',endedAt:new Date(this.now()).toISOString()});});}
  directory(id){if(typeof id!=='string'||!uuid.test(id))throw new InputError('商品任务ID无效');return join(this.store.root,'product-tasks',id);}
  async asset(id,name){
    if(!['manifest.json','card.png','main.png','detail-1.png','detail-2.png','detail-3.png'].includes(name))throw new InputError('任务文件名称无效',404);
    const directory=this.directory(id),path=join(directory,name);
    try{
      for(const item of [this.store.root,join(this.store.root,'product-tasks'),directory,path])if((await lstat(item)).isSymbolicLink())throw new InputError('任务目录或文件不能是链接');
      const info=await lstat(path),folder=await realpath(directory),actual=await realpath(path);
      if(!info.isFile()||dirname(actual)!==folder||info.size>(name==='manifest.json'?128*1024:24*1024*1024))throw new InputError('任务文件无效或过大');
      return await readFile(actual);
    }catch(error){if(error.code==='ENOENT')throw new InputError('缺少任务文件：'+name);throw error;}
  }
  async inputAsset(task,name){
    if(!task.outputDir)return this.asset(task.id,name);
    if(!['manifest.json','card.png','main.png','detail-1.png','detail-2.png','detail-3.png'].includes(name))throw new InputError('任务文件名称无效');
    const parent=join(task.workspaceRoot,'SofaMonitor-outputs'),path=join(task.outputDir,name);
    for(const item of [task.workspaceRoot,parent,task.outputDir,path])if((await lstat(item)).isSymbolicLink())throw new InputError('工作区任务产物不能是链接');
    if(dirname(await realpath(parent))!==await realpath(task.workspaceRoot)||dirname(await realpath(task.outputDir))!==await realpath(parent)||dirname(await realpath(path))!==await realpath(task.outputDir))throw new InputError('工作区任务文件路径无效');
    const info=await lstat(path);if(!info.isFile()||info.size>(name==='manifest.json'?128*1024:24*1024*1024))throw new InputError('工作区任务产物无效或过大');return readFile(path);
  }
  async expire(){
    const rows=(await this.store.readState()).productTasks.filter(task=>active.has(task.status)&&(task.deadlineAtMs<=this.now()||task.status==='queued'&&task.dispatchDeadlineAtMs<=this.now()));
    for(const task of rows){await this.store.mutate(next=>{const row=next.productTasks.find(t=>t.id===task.id);if(active.has(row.status))Object.assign(row,{status:'timed-out',...(task.status==='queued'?{failureKind:'fatal'}:{}),message:task.status==='queued'?'Agent未开始执行，已停止且不重复发送':'本条处理超时，迟到产物不会入库',endedAt:new Date(this.now()).toISOString()});});this.controllers.get(task.id)?.abort();await this.pacer.finish(task.networkLeaseId);this.prefetched.delete(task.id);}
  }
  async create(raw,{localSourceTaskId,reuseLocalReview=false,localOnly=false,budgetStartedAtMs}={}){
    if(this.store.collectionArchive?.choosing)throw new InputError('请先完成或取消文件夹选择',409);
    this.check();
    if(!raw||Object.keys(raw).some(key=>!['sourceUrl','settings','saveMode','batchId'].includes(key)))throw new InputError('当前商品任务参数无效');
    if(!localOnly)await this.pacer.assertOpen();
    const sourceUrl=jdItemUrl(raw.sourceUrl),settings=validateSettings(raw.settings);
    if(raw.saveMode!==undefined&&!['automatic','review'].includes(raw.saveMode))throw new InputError('保存方式无效');
    if(raw.batchId){const batch=(await this.store.readState()).jobs.find(row=>row.id===raw.batchId&&row.kind==='jd-auto-card-batch');if(!batch||batch.status!=='running'||!batch.targets.includes(sourceUrl)||batch.deadlineAtMs<=this.now())throw new InputError('批量任务已停止或目标不属于任务');}
    await this.expire();
    return this.store.mutate(async state=>{
      if(this.store.collectionArchive?.choosing)throw new InputError('请先完成或取消文件夹选择',409);
      if(!raw.batchId&&state.jobs.some(job=>job.status==='running'||job.kind==='jd-auto-card-batch'&&job.status==='ready'))throw new InputError('品牌批量制卡正在执行，请等待完成或先停止',409);
      const current=state.productTasks.find(task=>active.has(task.status));
      if(current){if(current.sourceUrl===sourceUrl&&(!localSourceTaskId||current.localSourceTaskId===localSourceTaskId))return current;throw new InputError('另一商品任务仍在执行，请先停止或等待完成',409);}
      if(raw.saveMode!=='automatic'&&state.drafts.length>=10)throw new InputError('待确认区已满，请先核对资料');
      const id=randomUUID(),directory=this.directory(id);await mkdir(directory,{recursive:true});
      const templateDefinition=raw.batchId?state.jobs.find(job=>job.id===raw.batchId)?.templateDefinition:this.store.templateLibrary?.selected();
      const task={id,...(Number.isFinite(budgetStartedAtMs)?{budgetStartedAtMs}:{}),...(templateDefinition?{templateDefinition}:{}),...(localSourceTaskId?{localSourceTaskId,reuseLocalReview}:{}),saveMode:raw.saveMode||'review',...(raw.batchId?{batchId:raw.batchId}:{}),kind:'agent-product-card',sourceUrl,sku:new URL(sourceUrl).pathname.slice(1,-5),status:'ready',createdAt:new Date(this.now()).toISOString(),settings:{...settings,platforms:['jd'],quantity:1},message:localSourceTaskId?'从已校验的详情存档继续制卡，不再次访问商品网页':'已绑定当前商品，等待交给右侧Agent'};
      if(raw.batchId){const sessionId=state.jobs.find(job=>job.id===raw.batchId)?.executionSessionId;if(sessionId)task.executionSessionId=sessionId;}
      state.productTasks=[task,...state.productTasks].slice(0,100);return task;
    });
  }
  async resumeLocal(raw){
    if(!raw||typeof raw.id!=='string'||Object.keys(raw).some(key=>key!=='id'))throw new InputError('本地恢复只接受来源任务编号');
    const source=await this.get(raw.id);await localProductSource(this,source.id,source.sourceUrl);
    return this.create({sourceUrl:source.sourceUrl,settings:source.settings,saveMode:'automatic'},{localSourceTaskId:source.id});
  }
  async refineLocal(raw){
    if(!raw||typeof raw.id!=='string'||Object.keys(raw).some(key=>key!=='id'))throw new InputError('本地重排只接受来源任务编号');
    const source=await this.get(raw.id);await localProductSource(this,source.id,source.sourceUrl,{reuseReview:true});
    return this.create({sourceUrl:source.sourceUrl,settings:source.settings,saveMode:'automatic'},{localSourceTaskId:source.id,reuseLocalReview:true});
  }
  async claim(raw){if(!raw||Object.keys(raw).some(key=>key!=='id'))throw new InputError('调度参数无效');await this.get(raw.id);return this.store.mutate(state=>{const task=state.productTasks.find(row=>row.id===raw.id);if(!['ready','cooldown'].includes(task.status)||task.dispatchedAt||task.nextEligibleAtMs>this.pacer.now())return{claimed:false,task};Object.assign(task,{status:'queued',dispatchedAt:new Date(this.now()).toISOString(),dispatchDeadlineAtMs:this.now()+600000,progressStage:'queued'});return{claimed:true,task};});}
  async progress(id,stage){if(!['reading','details','analyzing','images','selecting','editing','rendering','archiving','recovering','partial-rendering'].includes(stage))throw new InputError('进度阶段无效');return this.store.mutate(state=>{const task=state.productTasks.find(row=>row.id===id);if(!task)throw new InputError('任务不存在',404);if(!['running','awaiting-confirmation','publishing'].includes(task.status))return task;if(task.progressStage!==stage)Object.assign(task,{progressStage:stage,progressAt:new Date(this.now()).toISOString()});return task;});}
  async dispatched(id){return this.store.mutate(state=>{const task=state.productTasks.find(row=>row.id===id);if(!task)throw new InputError('任务不存在',404);if(task.status==='ready')Object.assign(task,{status:'queued',message:'已交给右侧Agent，等待读取当前目标'});return task;});}
  async get(id){this.check();this.directory(id);await this.expire();const task=(await this.store.readState()).productTasks.find(row=>row.id===id);if(!task)throw new InputError('商品任务不存在',404);return task;}
  async start(id,{workspace}={}){
    const task=await this.get(id);
    if(task.saveMode==='automatic'&&task.status==='completed')return{...task,replayed:true,instructions:'本任务已完成。直接返回已有file与来源；dataQuality为partial时列出缺项，不能声称资料齐全。不读取网页，不新建任务，不询问重做。'};
    if(task.saveMode==='automatic'&&task.status==='running')return{...task,replayed:true,instructions:'本任务已有执行者。直接返回当前状态，不重复执行，不询问用户。'};
    if(!['ready','queued','cooldown'].includes(task.status))throw new InputError('任务已启动或停止，请不要重复执行',409);
    const reserved=task.networkLeaseId?{granted:true,lease:await this.pacer.resume(task.networkLeaseId,task.batchId||id)}:await this.pacer.reserve({owner:id,createdAt:task.createdAt,minutes:task.settings.intervalMinutes||5,mode:task.batchId?'batch':'single'});
    if(!reserved.granted&&!task.batchId)throw new InputError('已有采集任务占用浏览器，请等待当前任务完成；单次采集没有批量间隔',409);
    if(!reserved.granted)return this.store.mutate(state=>{const row=state.productTasks.find(t=>t.id===id);if(!['ready','queued','cooldown'].includes(row.status))throw new InputError('任务已启动或停止',409);Object.assign(row,{status:'cooldown',progressStage:'cooldown',nextEligibleAtMs:reserved.nextEligibleAtMs,dispatchedAt:null,dispatchRevision:(row.dispatchRevision||0)+1,message:'等待采集间隔，到时自动继续'});return{...row,waiting:true};});
    try{await this.store.mutate(state=>{const row=state.productTasks.find(t=>t.id===id);if(!['ready','queued','cooldown'].includes(row.status))throw new InputError('任务已停止',409);row.networkLeaseId=reserved.lease.id;row.nextEligibleAtMs=null;});
    let location={};
    if(workspace){const workspaceRoot=await realpath(workspace),parent=join(workspaceRoot,'SofaMonitor-outputs'),outputDir=join(parent,id);await mkdir(parent,{recursive:true});if((await lstat(parent)).isSymbolicLink())throw new InputError('工作区产物目录不能是链接');await mkdir(outputDir,{recursive:true});if((await lstat(outputDir)).isSymbolicLink())throw new InputError('工作区任务目录不能是链接');location={workspaceRoot,outputDir};}
    const result=await this.store.mutate(state=>{const row=state.productTasks.find(task=>task.id===id);if(!['ready','queued','cooldown'].includes(row.status))throw new InputError('任务已被另一执行器启动',409);const batch=row.batchId?state.jobs.find(job=>job.id===row.batchId):null;if(row.batchId&&(!batch||batch.status!=='running'||batch.deadlineAtMs<=this.now()))throw new InputError('批量任务已停止或到达时限');Object.assign(row,{...productBudget(row.budgetStartedAtMs??this.now(),batch?.deadlineAtMs),...location,status:'running',progressStage:'reading',message:'Agent正在读取指定商品并制作规格图'});return row;});
    return{...result,outputDir:result.outputDir||this.directory(id),workflowReference:fileURLToPath(new URL(task.saveMode==='automatic'?'../assets/automatic-card-workflow.md':'../assets/workbench-card.md',import.meta.url)),workflowText:await readFile(new URL(task.saveMode==='automatic'?'../assets/automatic-card-workflow.md':'../assets/workbench-card.md',import.meta.url),'utf8'),instructions:task.saveMode==='automatic'?AUTOMATION_CONTRACT+productTimingContract(task)+'后台run负责读取、图片、统一制卡和归档；Agent不再拆分start、finish或调用旧采集工具。':'只处理sourceUrl，使用DSH正常浏览器助手与本次返回的制卡规范，直接使用官方原图排版。先读取官方信息，用sofa_monitor_capture_jd生成该来源的待确认草稿，记下draftId。只将main.png和detail-N.png及manifest.json写入outputDir，不必排版card.png。finish由插件任务选定模板生成规格图。需要登录、验证码、工具缺失或资料不足时调用fail并明确原因，不改成历史商品、不自动入库。',manifestExample:task.saveMode==='automatic'?{sourceUrl:task.sourceUrl,model:'',fields:{},files:['main.png']}:{sourceUrl:task.sourceUrl,model:'来自官方资料的真实型号',fields:{dimensions:'与草稿官方尺寸一致',price:null,priceAt:'实际价格读取时间ISO格式',priceLabel:'实际价格口径',seatLabel:'按真实商品判断',features:['已核实卖点1','已核实卖点2'],notes:'优惠条件及必要说明'},files:['main.png','detail-1.png','detail-2.png']}};
    }catch(error){await this.pacer.finish(reserved.lease.id);throw error;}
  }
  async prepared(id,draftId){
    const task=await this.get(id);
    if(task.saveMode==='automatic'){if(task.status==='completed'&&task.draftId===draftId)return task;return this.prepareAutomatic(task,draftId);}
    if(task.status!=='running')throw new InputError('商品任务未运行或已停止，不能接收产物',409);
    const draft=(await this.store.readState()).drafts.find(row=>row.id===draftId);
    if(!draft||draft.productTaskId!==task.id||draft.product.sourceUrl!==task.sourceUrl||draft.product.recordType==='note'||Date.parse(draft.createdAt)<Date.parse(task.startedAt))throw new InputError('草稿不属于本次当前商品，拒绝历史资料或其他SKU');
    let manifest;try{manifest=JSON.parse((await this.inputAsset(task,'manifest.json')).toString('utf8'));}catch(error){if(error instanceof InputError)throw error;throw new InputError('任务manifest.json无法读取或不是有效JSON');}
    if(!manifest||Object.keys(manifest).some(key=>!['sourceUrl','model','fields','files'].includes(key))||manifest.sourceUrl!==task.sourceUrl||!draft.product.model||manifest.model!==draft.product.model)throw new InputError('规格图来源或型号与当前草稿不一致');
    const fields=validateCardFields({...manifest.fields,...(task.templateDefinition?{templateDefinition:task.templateDefinition}:{})}),specs=draft.product.specs;
    if(!Object.entries(specs).some(([key,value])=>/尺寸|尺码|规格|长宽高/u.test(key)&&compact(value)===compact(fields.dimensions)))throw new InputError('规格图尺寸须与本次草稿的官方尺寸一致，缺失时不能出卡');
    const priceMatches=Object.entries(specs).some(([key,value])=>/(?:价|price)/iu.test(key)&&[...value.replace(/,/gu,'').matchAll(/[0-9]+(?:\.[0-9]+)?/gu)].some(match=>Number(match[0])===fields.price));
    if(!priceMatches||!Number.isFinite(Date.parse(draft.product.capturedAt))||Math.abs(Date.parse(fields.priceAt)-Date.parse(draft.product.capturedAt))>10*60000)throw new InputError('规格图价格或读取时间未得到本次草稿支持');
    const names=['card.png','main.png',...fields.features.map((_,index)=>'detail-'+(index+1)+'.png')];
    const incoming=manifest.files;
    if(!Array.isArray(incoming)||![names,names.slice(1)].some(list=>list.length===incoming.length&&list.every((name,index)=>incoming[index]===name)))throw new InputError('规格图文件列表须使用固定任务文件名');
    const bytes=new Map();for(const name of names.slice(1)){this.check();const value=await this.inputAsset(task,name),size=pngSize(value);if(!size.width||!size.height||Math.max(size.width,size.height)>8192)throw new InputError('主图或细节须有效且每边不超过8192像素：'+name);bytes.set(name,value);}
    const rendered=await renderStandardCard(draft.product,{...fields,...(task.templateDefinition?{templateDefinition:task.templateDefinition}:{})},[...bytes.values()]);bytes.set('card.png',rendered.bytes);
    // Agent-provided card.png is deliberately replaced by the shared local template.
    for(const [name,value]of bytes)await this.store.atomic(join(this.directory(id),name),value);
    await this.store.atomic(join(this.directory(id),'manifest.json'),JSON.stringify({...manifest,files:names,template:rendered.template}));
    return this.store.mutate(state=>{this.check();const row=state.productTasks.find(task=>task.id===id),current=state.drafts.find(row=>row.id===draftId);if(row.status!=='running'||row.deadlineAtMs<=this.now()||!current)throw new InputError('任务已停止、超时或草稿已处理，迟到产物未接收');Object.assign(row,{status:'awaiting-confirmation',draftId,productId:current.product.id,fields,files:names,template:rendered.template,message:'统一模板规格图已生成，请核对后确认入库',preparedAt:new Date(this.now()).toISOString()});current.preparedCard={taskId:id,fields};return row;});
  }
  async prepareAutomatic(task,draftId){
    const id=task.id;this.check();
    const checkpoint=async()=>{const state=await this.store.readState(),row=state.productTasks.find(t=>t.id===id),batch=task.batchId?state.jobs.find(j=>j.id===task.batchId):null;if(!row||row.status!=='running'||row.deadlineAtMs<=this.now()||task.batchId&&(!batch||batch.status!=='running'||batch.deadlineAtMs<=this.now()))throw new InputError('任务已停止或超时，未自动保存迟到产物',409);};
    await checkpoint();
    const draft=(await this.store.readState()).drafts.find(d=>d.id===draftId);
    if(!draft||draft.productTaskId!==id||draft.product.sourceUrl!==task.sourceUrl||draft.product.recordType==='note'||Date.parse(draft.createdAt)<Date.parse(task.startedAt))throw new InputError('草稿不属于本次商品任务，未自动保存');
    let manifest;try{manifest=JSON.parse((await this.inputAsset(task,'manifest.json')).toString());}catch(error){throw new InputError('自动制卡manifest.json缺失或无效');}
    if(!manifest||Object.keys(manifest).some(key=>!['sourceUrl','model','fields','files'].includes(key))||manifest.sourceUrl!==task.sourceUrl||manifest.model&&manifest.model!==draft.product.model&&manifest.model!==draft.product.title)throw new InputError('规格图来源或型号与本次商品不一致');
    if(!Array.isArray(manifest.files)||manifest.files.some(name=>!['main.png','detail-1.png','detail-2.png','detail-3.png','card.png'].includes(name)))throw new InputError('自动制卡仅接受固定图片文件名');
    await this.progress(id,'rendering');
    const normalized=automaticCardData(draft.product,manifest.fields,{detailCount:manifest.fields?.deliveryIncomplete?Math.max(2,Math.min(3,manifest.fields.detailTitles?.length||2)):draft.product.visual?.detailPhotoPolicy==='reviewed-parts'&&[2,3].includes(draft.product.visual.reviewedDetailCount)?draft.product.visual.reviewedDetailCount:Math.max(templateDetailCount(task.templateDefinition),manifest.files.filter(name=>/^detail-[1-3]\.png$/u.test(name)).length)}),prepared=await automaticPhotos(task,(...args)=>this.inputAsset(...args),normalized.fields),fields=validateCardFields({...prepared.fields,...(task.templateDefinition?{templateDefinition:task.templateDefinition}:{})});
    normalized.product.qualityRepairVersion=1;await checkpoint();const rendered=await renderStandardCard(normalized.product,fields,prepared.photos);
    const names=['main.png',...fields.features.map((_,i)=>'detail-'+(i+1)+'.png'),'card.png'];
    for(let i=0;i<prepared.photos.length;i++)await this.store.atomic(join(this.directory(id),names[i]),prepared.photos[i]);
    await this.store.atomic(join(this.directory(id),'card.png'),rendered.bytes);
    await this.store.atomic(join(this.directory(id),'manifest.json'),JSON.stringify({...manifest,model:normalized.product.model,fields,files:names,template:rendered.template}));
    await checkpoint();
    await this.store.mutate(state=>{this.check();const row=state.productTasks.find(t=>t.id===id),current=state.drafts.find(d=>d.id===draftId),batch=task.batchId?state.jobs.find(j=>j.id===task.batchId):null;
      if(row.status!=='running'||row.deadlineAtMs<=this.now()||!current||task.batchId&&batch?.status!=='running')throw new InputError('任务已停止，未自动保存');
      current.product=normalized.product;current.preparedCard={taskId:id,fields};
      Object.assign(row,{status:'awaiting-confirmation',draftId,productId:current.product.id,fields,dataQuality:normalized.product.dataQuality,dataConflicts:normalized.product.dataConflicts,files:names,template:rendered.template,message:'正在自动归档规格图',preparedAt:new Date(this.now()).toISOString(),saveAuthority:'user-requested-automatic'});
    });
    await this.store.confirmCapture({id:draftId,rightsConfirmed:true});
    const result=await this.publish(id);
    // Remove only superseded drafts from this same task, never unrelated work.
    await this.store.mutate(state=>{state.drafts=state.drafts.filter(d=>d.productTaskId!==id);});
    return result;
  }
  async recoverAutomaticPublications(){
    const recovered=[];
    for(const task of (await this.store.readState()).productTasks){
      if(task.saveMode!=='automatic'||task.saveAuthority!=='user-requested-automatic'||!['awaiting-confirmation','card-error'].includes(task.status)||(task.recoveryAttempts||0)>=3||task.recoveryAtMs&&Date.now()-task.recoveryAtMs<5000)continue;
      await this.store.mutate(state=>{const row=state.productTasks.find(t=>t.id===task.id);row.recoveryAttempts=(row.recoveryAttempts||0)+1;row.recoveryAtMs=Date.now();});
      const state=await this.store.readState(),draft=state.drafts.find(d=>d.id===task.draftId);
      if(draft){if(draft.productTaskId!==task.id||draft.product.sourceUrl!==task.sourceUrl||draft.preparedCard?.taskId!==task.id)continue;await this.store.confirmCapture({id:draft.id,rightsConfirmed:true});}
      if(!(await this.store.readState()).products.some(p=>p.id===task.productId&&p.sourceUrl===task.sourceUrl))continue;
      try{await this.publish(task.id);recovered.push(task.id);}catch(error){if(!(error instanceof InputError)&&error.code!=='ENOENT')throw error;}
    }
    return recovered;
  }
  async recoverStoredArtifacts(){
    const state=await this.store.readState(),recovered=[];
    for(const task of state.productTasks){
      if(!['action-required','completed','card-error'].includes(task.status)||!task.outputDir||state.drafts.some(draft=>draft.productTaskId===task.id))continue;
      const product=state.products.find(product=>product.sourceUrl===task.sourceUrl);if(!product)continue;
      if((await this.store.files()).some(file=>file.id===product.id+'.png')){
        if(task.recoveredAt)continue;
        try{
          const metadata=JSON.parse(await readFile(join(this.store.root,'cards',product.id+'.json'),'utf8')),image=await this.store.file(product.id+'.png');
          if(metadata.recoveredTaskId===task.id&&metadata.sourceUrl===task.sourceUrl&&metadata.model===product.model&&metadata.sha256===createHash('sha256').update(image.body).digest('hex')){
            await this.store.file(product.id+'-01.png');
            await this.store.mutate(next=>{Object.assign(next.productTasks.find(row=>row.id===task.id),{status:'completed',productId:product.id,file:product.id+'.png',message:'本次规格图已归档到文件管理',recoveredAt:new Date().toISOString()});});recovered.push(task.id);
          }
        }catch(error){if(!(error instanceof InputError)&&error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
        continue;
      }
      try{
        const manifest=JSON.parse((await this.inputAsset(task,'manifest.json')).toString()),fields=validateCardFields(manifest.fields);
        if(manifest.sourceUrl!==task.sourceUrl||manifest.model!==product.model||!Object.entries(product.specs).some(([key,value])=>/尺寸|尺码|规格|长宽高/u.test(key)&&compact(value)===compact(fields.dimensions))||!Object.entries(product.specs).some(([key,value])=>/价|price/iu.test(key)&&[...value.replace(/,/gu,'').matchAll(/[0-9]+(?:\.[0-9]+)?/gu)].some(match=>Number(match[0])===fields.price))||Math.abs(Date.parse(fields.priceAt)-Date.parse(product.capturedAt))>600000||!Number.isFinite(Date.parse(product.capturedAt)))continue;
        const names=['main.png',...fields.features.map((_,i)=>'detail-'+(i+1)+'.png'),'card.png'],assets=[];
        for(const name of names){const bytes=await this.inputAsset(task,name),size=pngSize(bytes);if(!size.width||!size.height||Math.max(size.width,size.height)>8192||name==='card.png'&&Math.abs(size.width/size.height-16/9)>0.01)throw new InputError('旧产物尺寸无效');assets.push([name,bytes]);}
        for(const [name,bytes]of assets)await saveCard(this.store,product.id,name==='card.png'?'card':name.slice(0,-4),bytes,fields);
        await this.store.mutate(next=>{Object.assign(next.productTasks.find(row=>row.id===task.id),{status:'completed',productId:product.id,file:product.id+'.png',message:'已接回已入库商品的现有规格图，保存到文件管理',recoveredAt:new Date().toISOString()});});recovered.push(task.id);
      }catch(error){if(!(error instanceof InputError)&&!['ENOENT','ENOTDIR'].includes(error.code)&&!(error instanceof SyntaxError))throw error;}
    }
    return recovered;
  }
  async fail(id,reason,status='action-required',diagnostics={}){
    if(typeof reason!=='string'||!reason.trim()||reason.length>800)throw new InputError('请提供具体停止原因，勿包含账号、验证码或登录票据');
    const failed=await this.store.mutate(state=>{const task=state.productTasks.find(row=>row.id===id);if(!task)throw new InputError('任务不存在',404);if(!active.has(task.status)&&!(status==='cancelled'&&task.status==='awaiting-confirmation'))throw new InputError('任务已停止或完成',409);Object.assign(task,diagnostics,{status,message:reason,endedAt:new Date(this.now()).toISOString()});return task;});
    this.controllers.get(id)?.abort();await this.pacer.finish(failed.networkLeaseId,{risk:platformRisk({message:reason})});this.prefetched.delete(id);return failed;
  }
  async publish(id){
    const task=await this.get(id);if(task.status==='completed')return task;
    if(!['awaiting-confirmation','card-error'].includes(task.status))throw new InputError('任务尚无已核对的规格图',409);
    const state=await this.store.readState();if(state.drafts.some(draft=>draft.id===task.draftId)||!state.products.some(product=>product.id===task.productId&&product.sourceUrl===task.sourceUrl))throw new InputError('请先核对当前商品并确认入库');
    let claimed=false;
    try{
      await this.store.mutate(next=>{const row=next.productTasks.find(task=>task.id===id);if(!['awaiting-confirmation','card-error'].includes(row.status))throw new InputError('规格图已在发布或任务已停止',409);row.status='publishing';row.progressStage='archiving';row.message='已确认资料，正在发布本次规格图';});
      claimed=true;
      for(const name of ['main.png',...task.files.filter(name=>name.startsWith('detail-')),'card.png']){this.check();await saveCard(this.store,task.productId,name==='card.png'?'card':name.slice(0,-4),await this.asset(id,name),task.fields);}
      const archived=this.archive?await this.archive.record(task,state.products.find(product=>product.id===task.productId)):null;
      const published=await this.store.mutate(next=>{this.check();const row=next.productTasks.find(task=>task.id===id);Object.assign(row,{...(archived?{collectionRecord:{id:archived.id,isRepeat:archived.isRepeat,note:archived.note,archivePath:archived.archivePath}}:{}),status:'completed',progressStage:'completed',file:task.productId+'.png',message:row.dataQuality?.level==='partial'?'规格卡已归档；未取得：'+row.dataQuality.missing.join('、'):'当前商品已入库，产品规格图已发布',endedAt:new Date(this.now()).toISOString()});return row;});
      await this.pacer.finish(published.networkLeaseId);this.prefetched.delete(id);
      if(published.saveMode==='automatic')await this.onAutomaticEnded?.(published);
      return published;
    }catch(error){if(claimed&&!this.closed)await this.store.mutate(next=>{Object.assign(next.productTasks.find(task=>task.id===id),{status:'card-error',message:'商品已入库，规格图发布失败，可重试发布'});});throw error;}
  }
}
export function productTaskTool(tasks,ctx,connector,{imageReader,detailImageReader}={}){return{name:'sofa_monitor_product_task',description:AUTOMATION_CONTRACT+'只执行当前商品的run固定自动流程，独立单次立即执行；仅批次商品遵守批量间隔。status只读状态，stop停止任务。读取、图片整理、模板制卡及归档由后台完成，不拆分人工步骤；平台暂停时不得创建替代任务或绕过保护。',parameters:{type:'object',properties:{id:{type:'string',format:'uuid'},action:{type:'string',enum:['run','status','stop']},draftId:{type:'string'},stage:{type:'string',enum:['reading','images']},reason:{type:'string',maxLength:800}},required:['id','action'],additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},timeoutMs:1800000,isConcurrencySafe:()=>false,async execute(args,exec){exec.signal.throwIfAborted();if(!args||Object.keys(args).some(key=>!['id','action','draftId','reason','stage'].includes(key)))throw new InputError('商品任务参数无效');if(args.action==='status')return tasks.get(args.id);if(args.action==='stop')return tasks.fail(args.id,'用户已停止当前商品任务','cancelled');if(args.action==='run'){await tasks.dispatcher?.bind('single',args.id,exec);return runAutomaticProduct(tasks,ctx,exec,args.id,{connector,readImage:imageReader,readDetailImage:detailImageReader});}if(args.action==='start'){const existing=await tasks.get(args.id);if(existing.saveMode==='automatic'&&['completed','running'].includes(existing.status))return tasks.start(args.id);const working=ctx?.get?.('workingDirectory');if(!working||!exec.agent)throw new InputError('DSH工作区服务未就绪，无法确定安全的产物目录');const workspace=await working.ensure(exec.agent,exec.signal);exec.signal.throwIfAborted();return tasks.start(args.id,{workspace});}if(args.action==='progress'){if(!['reading','images'].includes(args.stage))throw new InputError('Agent只能报告读取或图片准备阶段');return tasks.progress(args.id,args.stage);}if(args.action==='finish')return tasks.prepared(args.id,args.draftId);if(args.action==='fail'){const task=await tasks.fail(args.id,args.reason);if(task.saveMode==='automatic')await tasks.onAutomaticEnded?.(task);return task;}throw new InputError('商品任务操作无效');}};}
