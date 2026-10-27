import{validProductFolder,allocateProductFolder,productSubdirectory}from'./output-layout.mjs';
import {outputDate,validOutputDate} from './output-date.mjs';
import {productImageName,uniqueImageName} from './image-names.mjs';
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, InputError, validateImport, validateSettings, makeJob, specCard } from './domain.mjs';
import {reviewCollection} from './collection-review.mjs';
import {readImageInfo,imageInfo} from './image-info.mjs';

const artifactAlias=/^(legacy|[0-9]{4}-[0-9]{2}-[0-9]{2})\/([a-f0-9]{24}(?:(?:-01)?\.(?:png|jpe?g)|\.pptx))$/u;
const artifactKey=(id,record)=>(record.folder||'legacy')+'/'+id;
const imageId=/^[a-f0-9]{24}(?:(?:-01)?\.(?:png|jpe?g)|\.pptx)$/u;
function safeImageName(name){
  if(typeof name!=='string'||name.length>120||name!==name.trim()||/[<>:"/\\|?*\x00-\x1f\x7f]/u.test(name)||/[. ]$/u.test(name)||!/^.+\.(?:png|jpe?g|pptx)$/iu.test(name)||/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(name))throw new InputError('文件名须为120字以内的PNG、JPG或PPTX名称，不能包含路径或Windows保留字符');
  return name;
}

export class Store {
  constructor(root,{now=Date.now}={}) { this.root = resolve(root); this.queue = Promise.resolve(); this.now=now; }
  async init() {
    await mkdir(this.root, {recursive:true});
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('SofaMonitor 数据目录不能是符号链接');
    await mkdir(join(this.root, 'files'), {recursive:true});
    if ((await lstat(join(this.root, 'files'))).isSymbolicLink()) throw new Error('SofaMonitor 文件目录不能是符号链接');
    try { this.state = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw new Error('SofaMonitor 状态文件无法读取；为保护数据已停止加载', {cause:err}); this.state = {schemaVersion:1, settings:{...DEFAULT_SETTINGS}, products:[], jobs:[]}; }
    if (this.state.schemaVersion !== 1 || !Array.isArray(this.state.products) || !Array.isArray(this.state.jobs)) throw new Error('SofaMonitor 数据版本不兼容');
    this.state.drafts ??= [];
    this.state.materials ??= [];
    this.state.productTasks ??= [];
    this.state.artifacts ??= {};
    if(!this.state.artifacts||Array.isArray(this.state.artifacts)||typeof this.state.artifacts!=='object')throw new Error('图片文件关联无法读取');
    this.state.artifactHistory ??= {};
    this.state.documents ??= {};
    this.state.outputGroups ??= {};
    if(!this.state.outputGroups||typeof this.state.outputGroups!=='object'||Array.isArray(this.state.outputGroups)||Object.entries(this.state.outputGroups).some(([key,group])=>!/^\d{4}-\d{2}-\d{2}\/[a-f0-9]{24}$/u.test(key)||!validOutputDate(key.slice(0,10))||!validProductFolder(group)))throw Error('商品文件夹索引无效');
    if(!this.state.artifactHistory||typeof this.state.artifactHistory!=='object'||Array.isArray(this.state.artifactHistory)||!this.state.documents||typeof this.state.documents!=='object'||Array.isArray(this.state.documents))throw new Error('产出历史索引无效');
    const names=new Map();
    const checkRecord=(id,record)=>{
      if(!imageId.test(id)||!record||typeof record!=='object'||record.folder!==undefined&&!validOutputDate(record.folder)||record.group!==undefined&&(!record.folder||!validProductFolder(record.group)))throw new Error('文件关联无效');
      const name=safeImageName(record.name),key=(record.folder||'legacy')+'/'+(record.group||'')+'/'+name.toLowerCase();
      if(names.has(key)&&names.get(key)!==id||name.split('.').at(-1).toLowerCase()!==id.split('.').at(-1))throw new Error('文件关联冲突');names.set(key,id);
    };
    for(const [id,record]of Object.entries(this.state.artifacts))checkRecord(id,record);
    for(const [key,record]of Object.entries(this.state.artifactHistory)){const match=key.match(artifactAlias);if(!match||artifactKey(match[2],record)!==key)throw new Error('产出历史索引无效');checkRecord(match[2],record);}
    for(const [id,record]of Object.entries(this.state.documents))if(!/^[a-f0-9-]+\.(?:json|html)$/u.test(id)||(!validOutputDate(record?.folder)||record.group!==undefined&&!validProductFolder(record.group)))throw new Error('资料文件索引无效');
    if(!Array.isArray(this.state.productTasks))throw new Error('当前商品任务资料无法读取');
    if(!Array.isArray(this.state.materials))throw new Error('研究资料无法读取');
    if(!Array.isArray(this.state.drafts)) throw new Error('SofaMonitor 采集草稿无法读取');
    this.state.settings = validateSettings(this.state.settings);
    const interrupted=this.state.jobs.filter(job=>['jd-link-batch','jd-native-search-batch','browser-helper-batch','jd-auto-card-batch'].includes(job.kind)&&(job.status==='running'||job.kind==='jd-auto-card-batch'&&job.status==='ready'));
    for(const job of interrupted)Object.assign(job,{status:'interrupted',stopReason:'interrupted',currentUrl:null,endedAt:new Date().toISOString(),reason:'服务曾中断；任务已停止，不会自动恢复或重置时限'});
    const productInterrupted=this.state.productTasks.filter(task=>['running','queued','cooldown'].includes(task.status)||task.saveMode==='automatic'&&task.status==='ready');
    for(const task of productInterrupted)Object.assign(task,{status:'interrupted',message:'服务曾中断；请从当前商品重新发起任务',endedAt:new Date().toISOString()});
    const publishInterrupted=this.state.productTasks.filter(task=>task.status==='publishing');
    for(const task of publishInterrupted)Object.assign(task,{status:'card-error',message:'发布期间服务曾中断，可重试发布规格图'});
    if(interrupted.length||productInterrupted.length||publishInterrupted.length)await this.atomic(join(this.root,'state.json'),JSON.stringify(this.state,null,2));
    await this.normalizeDefaultImageNames();
    return this;
  }
  async atomic(path, value) { const tmp = `${path}.${randomUUID()}.tmp`; await writeFile(tmp, value, {flag:'wx'}); await rename(tmp, path); }
  mutate(fn) {
    const operation = this.queue.then(async()=> {
      const next = structuredClone(this.state);
      const result = await fn(next);
      await this.atomic(join(this.root, 'state.json'), JSON.stringify(next, null, 2));
      this.state = next;
      return result;
    });
    this.queue = operation.catch(()=>{});
    return operation;
  }
  async readState() { await this.queue; return structuredClone(this.state); }
  async snapshot() { return {...await this.readState(), dataDir:this.root, outputDir:join(this.root,'outputs'), files:await this.files()}; }
  async artifactDirectory(record,{create=false}={}){
    if(record.folder!==undefined&&!validOutputDate(record.folder)||record.group!==undefined&&(!record.folder||!validProductFolder(record.group)))throw new InputError('产出日期无效');
    const base=join(this.root,record.folder?'outputs':'files'),directory=record.folder?join(base,record.folder):base;
    if((await lstat(this.root)).isSymbolicLink())throw new InputError('产出目录不可用',404);
    if(create)await mkdir(base,{recursive:true});
    if((await lstat(base)).isSymbolicLink()||dirname(await realpath(base))!==await realpath(this.root))throw new InputError('产出目录不可用',404);
    if(record.folder){if(create)await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink()||dirname(await realpath(directory))!==await realpath(base))throw new InputError('产出日期目录不可用',404);}
    return record.group?productSubdirectory(directory,record.group,{create}):directory;
  }
  async productLocation(state,product,folder){
    return{folder,...(product?{group:await allocateProductFolder(this,state,product,folder)}:{})};
  }
  rememberArtifact(state,id,record){
    const previous=state.artifacts[id];if(previous)state.artifactHistory[artifactKey(id,previous)]={...previous};
    state.artifacts[id]={...record};state.artifactHistory[artifactKey(id,record)]={...record};
  }
  async files() {
    await this.queue;
    const state=this.state,records=new Map(Object.entries(state.artifacts));
    for(const[key,record]of Object.entries(state.artifactHistory)){
      const id=key.match(artifactAlias)[2];if(state.artifacts[id]&&artifactKey(id,state.artifacts[id])===key)continue;records.set(key,record);
    }
    const knownLegacy=new Set([...records.values()].filter(record=>!record.folder).map(record=>record.name.toLowerCase()));
    for(const entry of await readdir(join(this.root,'files'),{withFileTypes:true}))if(entry.isFile()&&imageId.test(entry.name)&&!knownLegacy.has(entry.name.toLowerCase()))records.set('legacy/'+entry.name,{name:entry.name});
    const files=[];
    for(const[key,record]of records){
      const id=key.match(artifactAlias)?.[2]||key,presentation=id.endsWith('.pptx');let path,info;
      try{path=await this.imagePath(key,record);info=await lstat(path);}catch(error){if(error instanceof InputError&&error.status===404||error.code==='ENOENT')continue;throw error;}
      let pixels;if(presentation)pixels={width:1920,height:1080,format:'PPTX',type:'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
      else try{pixels=await readImageInfo(path);}catch(error){if(!(error instanceof InputError))throw error;pixels={width:null,height:null,format:null,type:null};}
      const createdAt=record.createdAt||info.birthtime.toISOString(),publicId=key.startsWith('legacy/')&&!state.artifacts[id]&&!state.artifactHistory[key]?id:key;
      files.push({id:publicId,productId:id.replace(/(?:-01)?\.(?:png|jpe?g|pptx)$/u,''),name:record.name,size:info.size,createdAt,date:record.folder||outputDate(createdAt),dailyFolder:!!record.folder,productFolder:record.group||'',historical:!!key.match(artifactAlias)&&publicId!==id,modifiedAt:info.mtime.toISOString(),kind:presentation?'可编辑规格卡':/-01\./u.test(id)?'主图':'产品规格图',...pixels});
    }
    return files.sort((a,b)=>b.date.localeCompare(a.date)||b.modifiedAt.localeCompare(a.modifiedAt));
  }
  imageRecord(name,state=this.state){
    if(typeof name!=='string')throw new InputError('文件名称无效',404);
    const match=name.match(artifactAlias);let id,record;
    if(match){id=match[2];record=state.artifactHistory[name];if(!record&&match[1]==='legacy')record={name:id};if(!record)throw new InputError('历史文件不存在',404);}
    else if(imageId.test(name)){id=name;record=state.artifacts[id]||{name:id};}
    else{
      const candidates=new Map();for(const [key,row]of Object.entries(state.artifacts))if(row.name===name)candidates.set(artifactKey(key,row),{id:key,record:row});
      for(const [key,row]of Object.entries(state.artifactHistory))if(row.name===name)candidates.set(key,{id:key.match(artifactAlias)[2],record:row});
      if(candidates.size!==1)throw new InputError(candidates.size?'多个商品或日期存在同名文件，请从文件列表选择':'文件不存在',404);
      const found=[...candidates.entries()][0];name=found[0];({id,record}=found[1]);
    }
    return{...record,id,key:name,name:record.name};
  }
  async file(name) {
    await this.queue;
    if(typeof name!=='string')throw new InputError('文件名称无效',404);
    if(/\.pptx$/iu.test(name)){
      const record=this.imageRecord(name),path=await this.imagePath(record.key);
      return{body:await readFile(path),type:'application/vnd.openxmlformats-officedocument.presentationml.presentation',name:record.name};
    }
    if(/\.(?:png|jpe?g)$/iu.test(name)){
      const record=this.imageRecord(name),path=await this.imagePath(record.key),body=await readFile(path);
      return{body,type:imageInfo(body).type,name:record.name};
    }
    if (!/^[a-f0-9-]+\.(json|html)$/u.test(name)) throw new InputError('文件名称无效', 404);
    const record=this.state.documents[name],folder=record?await this.artifactDirectory(record):join(this.root,'files'),path=join(folder,name);
    if(dirname(path)!==folder)throw new InputError('文件路径无效',404);
    let info;
    try { info = await lstat(path); } catch(err) { if (err.code === 'ENOENT') throw new InputError('文件不存在',404); throw err; }
    if (!info.isFile() || info.isSymbolicLink()) throw new InputError('文件不可读取',404);
    return {body:await readFile(path),name,type:name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'};
  }
  async imagePath(name,knownRecord){
    const record=knownRecord||this.imageRecord(name);
    try{
      const directory=await this.artifactDirectory(record),path=join(directory,safeImageName(record.name));
      if((await lstat(path)).isSymbolicLink()||!(await lstat(path)).isFile()||dirname(await realpath(path))!==await realpath(directory))throw new InputError('文件位置不可用',404);
      return await realpath(path);
    }catch(error){if(error.code==='ENOENT')throw new InputError('文件不存在',404);throw error;}
  }
  renameImage(raw){return this.renameImageWithOrigin(raw,'user');}
  renameImageWithOrigin(raw,origin){
    const operation=this.queue.then(async()=>{
      if(!raw||Object.keys(raw).some(key=>!['name','newName'].includes(key)))throw new InputError('重命名只接受原文件和新文件名');
      const record=this.imageRecord(raw.name),source=await this.imagePath(raw.name),folder=dirname(source);let newName=safeImageName(raw.newName);if(origin==='automatic')newName=uniqueImageName(newName,await readdir(folder),record.name);
      if(newName.split('.').at(-1).toLowerCase()!==record.id.split('.').at(-1))throw new InputError('重命名不能改变文件格式，请保留原扩展名');
      if(imageId.test(newName)&&newName!==record.id)throw new InputError('不能使用其他商品的文件编号作为文件名');
      const target=join(folder,newName),info=await lstat(source),createdAt=record.createdAt||info.birthtime.toISOString();
      if(newName!==record.name&&(await readdir(folder)).some(name=>name!==record.name&&name.toLowerCase()===newName.toLowerCase()))throw new InputError('同名文件已存在，请换一个名称',409);
      const next=structuredClone(this.state),updated={name:newName,createdAt,nameSource:origin,...(record.folder?{folder:record.folder}:{}),...(record.group?{group:record.group}:{})},key=artifactKey(record.id,record);
      next.artifactHistory[key]=updated;
      if(!next.artifacts[record.id]||artifactKey(record.id,next.artifacts[record.id])===key)next.artifacts[record.id]=updated;
      let moved=false;
      try{if(newName!==record.name){await rename(source,target);moved=true;}await this.atomic(join(this.root,'state.json'),JSON.stringify(next,null,2));this.state=next;}
      catch(error){if(moved)await rename(target,source);throw error;}
      return{id:raw.name,name:newName,createdAt};
    });this.queue=operation.catch(()=>{});return operation;
  }
  async normalizeDefaultImageNames(){
    // Only migrate untouched internal-ID filenames. Explicit user names remain intact.
    for(const file of await this.files()){
      if(file.name!==file.id||this.state.artifacts[file.id]?.nameSource==='user')continue;
      const product=this.state.products.find(product=>product.id===file.id.replace(/(?:-01)?\.(?:png|jpe?g)$/u,''));
      if(product)await this.renameImageWithOrigin({name:file.id,newName:productImageName(product,/-01\./u.test(file.id),file.id.split('.').at(-1))},'automatic');
    }
  }
  writeImage(id,bytes){
    if(!imageId.test(id)||id.endsWith('.pptx'))throw new InputError('图片编号无效');imageInfo(bytes);
    return this.mutate(async state=>{
      const product=state.products.find(product=>product.id===id.replace(/(?:-01)?\.(?:png|jpe?g)$/u,'')),folder=product?.outputDay||outputDate(this.now()),previous=state.artifacts[id],location=await this.productLocation(state,product,folder),directory=await this.artifactDirectory(location,{create:true});
      const wanted=previous?.name||(product?productImageName(product,/-01\./u.test(id),id.split('.').at(-1)):id),name=uniqueImageName(wanted,await readdir(directory),previous?.folder===folder?previous.name:'');
      const path=join(directory,safeImageName(name));try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new InputError('图片不可写入');}catch(error){if(error.code!=='ENOENT')throw error;}
      const createdAt=previous?.folder===folder?previous.createdAt:new Date(this.now()).toISOString();await this.atomic(path,bytes);
      this.rememberArtifact(state,id,{name,...location,createdAt,nameSource:previous?.nameSource||'automatic'});return{file:id,name,createdAt,...location};
    });
  }
  writePresentation(id,bytes){
    if(!/^[a-f0-9]{24}\.pptx$/u.test(id)||!Buffer.isBuffer(bytes)||bytes.length<4||bytes.length>100*1024*1024||bytes.readUInt32LE(0)!==0x04034b50)throw new InputError('PPTX文件无效');
    return this.mutate(async state=>{
      const product=state.products.find(row=>row.id===id.slice(0,-5));if(!product)throw new InputError('PPTX对应商品不存在');
      const previous=state.artifacts[id],png=state.artifacts[product.id+'.png'],folder=png?.folder||product.outputDay||outputDate(this.now()),location=await this.productLocation(state,product,folder),directory=await this.artifactDirectory(location,{create:true});
      const wanted=previous?.name||(png?.name||productImageName(product)).replace(/\.png$/iu,'.pptx'),name=uniqueImageName(wanted,await readdir(directory),previous?.folder===folder?previous.name:''),path=join(directory,safeImageName(name));
      try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new InputError('PPTX文件不可写入');}catch(error){if(error.code!=='ENOENT')throw error;}
      const createdAt=previous?.folder===folder?previous.createdAt:new Date(this.now()).toISOString();await this.atomic(path,bytes);
      this.rememberArtifact(state,id,{name,...location,createdAt,nameSource:previous?.nameSource||'automatic'});return{file:id,name,createdAt,...location};
    });
  }
  saveSettings(value) { const settings = validateSettings(value); return this.mutate(state=>{state.settings = settings; return settings;}); }
  plan(value) { const job = makeJob(value); return this.mutate(state=>{state.settings = job.settings; state.jobs = [job,...state.jobs.filter(j=>j.status==='running'),...state.jobs.filter(j=>j.status!=='running')].slice(0,100); return job;}); }
  import(raw) {
    const products = validateImport(raw);
    return this.mutate(state=>this.writeProducts(state,products));
  }
  async writeProducts(state,products) {
      const merged=new Map(state.products.map(p=>[p.id,p])),accepted=[],duplicates=[];
      for(const incoming of products){const product={...incoming,outputDay:outputDate(this.now()),collectionReview:incoming.collectionReview||(this.collectionArchive?this.collectionArchive.review(incoming,[...merged.values()]):reviewCollection(incoming,[...merged.values()]))};merged.set(product.id,product);accepted.push(product);}
      if (merged.size > 500) throw new InputError('首版最多保存 500 条商品，请先归档现有数据');
      const importId = randomUUID();
      const folder=outputDate(this.now());let firstLocation;
      for(const product of accepted){const prior=state.products.find(row=>row.id===product.id);if(prior?.outputDay===folder&&prior.outputGroup)delete state.outputGroups[folder+'/'+product.id];const location=await this.productLocation(state,product,folder);product.outputGroup=location.group;firstLocation??=location;const directory=await this.artifactDirectory(location,{create:true}),name=product.id+'.html';await this.atomic(join(directory,name),specCard(product));state.documents[name]=location;}
      if(accepted.length){const directory=await this.artifactDirectory(firstLocation,{create:true}),name=importId+'.json';await this.atomic(join(directory,name),JSON.stringify({schemaVersion:1,provenance:accepted.every(p=>p.provenance==='browser-assisted')?'browser-assisted':'user-import',products:accepted},null,2));state.documents[name]=firstLocation;}
      state.products = [...merged.values()];
      return {count:accepted.length, total:state.products.length, skipped:duplicates.length,duplicates,importId};
  }
  prepareCapture({product,evidence}) {
    return this.mutate(state=>{
      const task=state.productTasks.find(task=>task.status==='running'&&task.sourceUrl===product.sourceUrl);
      if(task?.saveMode==='automatic')state.drafts=state.drafts.filter(draft=>draft.productTaskId!==task.id);
      else if(state.drafts.length>=10) throw new InputError('已有 10 条待确认资料，请先确认或丢弃');
      const draft={id:randomUUID(),createdAt:new Date(this.now()).toISOString(),product:{...product,collectionReview:this.collectionArchive?this.collectionArchive.review(product,state.products):reviewCollection(product,state.products)},evidence};
      if(task)draft.productTaskId=task.id;
      state.drafts.unshift(draft);return draft;
    });
  }
  confirmCapture(raw) {
    if(!raw||raw.rightsConfirmed!==true) throw new InputError('确认入库前请核对资料并确认有权使用');
    return this.mutate(async state=>{
      const draft=state.drafts.find(d=>d.id===raw.id);
      if(!draft) throw new InputError('待确认资料不存在或已处理',404);
      if(draft.productTaskId&&state.productTasks.some(task=>task.id===draft.productTaskId&&['ready','queued','running'].includes(task.status)))throw new InputError('当前商品还在制作规格图，请等待完成或先停止任务再确认',409);
      const product={...draft.product,importedAt:new Date().toISOString(),captureEvidence:draft.evidence};
      if(product.recordType==='note'){
        const merged=new Map(state.materials.map(row=>[row.id,row]));merged.set(product.id,product);
        if(merged.size>500)throw new InputError('研究资料已达到500条，请先归档');
        state.materials=[...merged.values()];state.drafts=state.drafts.filter(d=>d.id!==raw.id);
        return{count:1,total:state.materials.length,recordType:'note',id:product.id};
      }
      const result=await this.writeProducts(state,[product]);
      state.drafts=state.drafts.filter(d=>d.id!==raw.id);return result;
    });
  }
  dismissCapture(raw) {
    return this.mutate(state=>{
      if(!state.drafts.some(d=>d.id===raw?.id)) throw new InputError('待确认资料不存在或已处理',404);
      state.drafts=state.drafts.filter(d=>d.id!==raw.id);return {dismissed:true};
    });
  }
}
