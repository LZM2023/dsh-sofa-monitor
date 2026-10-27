import{productSubdirectory}from'./output-layout.mjs';
import{outputDate}from'./output-date.mjs';
import{copyDetailArchive}from'./detail-archive.mjs';
import{seatLabel}from'./seat-label.mjs';
import{mkdir,readFile,lstat,realpath}from'node:fs/promises';import{join,isAbsolute}from'node:path';import{InputError}from'./domain.mjs';import{productImageName}from'./image-names.mjs';import{reviewCollection,collectionFields}from'./collection-review.mjs';
const platforms={jd:'京东',taobao:'淘宝',tmall:'天猫',xiaohongshu:'小红书'},valid=value=>Object.hasOwn(platforms,value);
const csvCell=value=>{let text=String(value??'');if(/^[\s\u0000-\u001f]*[=+@-]/u.test(text))text="'"+text;return'"'+text.replaceAll('"','""')+'"';};
export function collectionCsv(records){
  const keys=['capturedAt','platform','title','brand','model','color','specification','seatLabel','seatLabelSource','sku','ranking','sales','sourceUrl','isRepeat','note','relatedSources','archivePath','productJson'];
  const titles=['爬取时间','平台','商品标题','品牌','型号','颜色','规格','沙发类型','沙发类型识别来源','商品编号','平台榜单排名原文','平台销量原文','来源链接','重复标记','备注','关联历史来源','归档文件夹','全部商品字段JSON'];
  return'\ufeff'+[titles,...records.map(row=>keys.map(key=>key==='platform'?platforms[row.platform]:key==='productJson'?JSON.stringify(row.product||{title:row.title,brand:row.brand,model:row.model,specs:row.specs}):key==='isRepeat'?(row.isRepeat?'是':'否'):row[key]))].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
export class CollectionArchive{
  constructor(store,{pickDirectory,canChoose}={}){this.store=store;this.pickDirectory=pickDirectory;this.canChoose=canChoose;this.records=[];this.folders={};this.queue=Promise.resolve();this.choosing=false;store.collectionArchive=this;}
  serial(fn){const operation=this.queue.then(fn);this.queue=operation.catch(()=>{});return operation;}
  async init(){
    try{const data=JSON.parse(await readFile(join(this.store.root,'collection-index.json'),'utf8'));if(data.version!==1||!Array.isArray(data.records)||typeof data.folders!=='object'||!data.folders)throw Error('Invalid history');if(data.records.length>10000||new Set(data.records.map(row=>row.taskId)).size!==data.records.length||data.records.some(row=>!row||typeof row.taskId!=='string'||!/^[a-zA-Z0-9-]+$/u.test(row.taskId)||!valid(row.platform)||typeof row.sourceUrl!=='string'||!Number.isFinite(Date.parse(row.capturedAt))||!isAbsolute(row.archivePath)))throw Error('Invalid history record');this.records=data.records;this.folders=data.folders;for(const[key,path]of Object.entries(this.folders))if(!valid(key)||!isAbsolute(path))throw Error('Invalid output folder');}
    catch(error){if(error.code!=='ENOENT')throw Error('采集汇总索引无法读取，已停止，原资料保持不变',{cause:error});}
    const state=await this.store.readState();for(const product of state.products){if(this.records.some(row=>row.productId===product.id))continue;try{await this.record({id:'legacy-'+product.id,productId:product.id,sourceUrl:product.sourceUrl,fields:{},legacy:true},product);}catch(error){if(error instanceof InputError&&error.status===404)continue;throw error;}}
    return this;
  }
  root(platform){if(!valid(platform))throw new InputError('平台无效');return this.folders[platform]||join(this.store.root,'exports',platform);}
  outputRoot(platform){if(!valid(platform))throw new InputError('平台无效');return this.folders[platform]||join(this.store.root,'outputs');}
  settings(){return{tables:Object.fromEntries(Object.keys(platforms).map(platform=>[platform,join(this.root(platform),platforms[platform]+'-采集汇总.csv')])),folders:Object.fromEntries(Object.keys(platforms).map(platform=>[platform,this.outputRoot(platform)])),counts:Object.fromEntries(Object.keys(platforms).map(platform=>[platform,this.records.filter(row=>row.platform===platform).length])),canChoose:this.canChoose?this.canChoose():typeof this.pickDirectory==='function'};}
  review(product,products=[]){return reviewCollection(product,[...products,...this.records]);}
  async checkFolder(path){await mkdir(path,{recursive:true});if((await lstat(path)).isSymbolicLink())throw new InputError('归档目录不能是链接');return realpath(path);}
  async persist(){await this.store.atomic(join(this.store.root,'collection-index.json'),JSON.stringify({version:1,folders:this.folders,records:this.records},null,2));}
  async writeSummary(platform){
    const rows=this.records.filter(row=>row.platform===platform).sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt)),root=await this.checkFolder(this.root(platform));
    await this.store.atomic(join(root,platforms[platform]+'-采集汇总.csv'),collectionCsv(rows));
    const outputRoot=await this.checkFolder(this.outputRoot(platform));
    for(const day of new Set(rows.filter(row=>row.dayFolder&&row.dayFolder===join(outputRoot,row.outputDay)).map(row=>row.outputDay))){
      const directory=await this.checkFolder(join(outputRoot,day));await this.store.atomic(join(directory,platforms[platform]+'-当日汇总.csv'),collectionCsv(rows.filter(row=>row.outputDay===day)));
    }
  }
  async assertIdle(){const state=await this.store.readState();if(state.jobs.some(job=>['ready','running'].includes(job.status))||state.productTasks.some(task=>['ready','queued','running','cooldown','publishing'].includes(task.status)))throw new InputError('请先停止或完成采集任务，再更换保存位置',409);}
  async choose(raw,signal){
    if(!raw||Object.keys(raw).some(key=>key!=='platform')||!valid(raw.platform))throw new InputError('文件夹设置只接受目标平台');if(!this.settings().canChoose)throw new InputError('DSH本机文件夹选择器尚未加载');if(this.choosing)throw new InputError('文件夹选择窗口已打开',409);
    this.choosing=true;try{await this.assertIdle();const chosen=await this.pickDirectory(signal);if(!chosen)return{cancelled:true};signal?.throwIfAborted();if(!isAbsolute(chosen)||(await lstat(chosen)).isSymbolicLink())throw new InputError('请选择普通的本机文件夹');const base=await realpath(chosen),folder=await this.checkFolder(join(base,'SofaMonitor-'+raw.platform));
      return await this.serial(async()=>{await this.assertIdle();signal?.throwIfAborted();const original=this.folders;this.folders={...original,[raw.platform]:folder};try{await this.writeSummary(raw.platform);await this.persist();}catch(error){this.folders=original;throw error;}return{folder,platform:raw.platform};});
    }finally{this.choosing=false;}
  }
  record(task,product){return this.serial(async()=>{
    const existing=this.records.find(row=>row.taskId===task.id);if(existing){await this.writeSummary(product.platform);return existing;}
    if(this.records.length>=10000)throw new InputError('采集记录已达10000条，请先归档索引后继续');
    const main=await this.store.file(product.id+'-01.png'),card=await this.store.file(product.id+'.png'),root=await this.checkFolder(this.outputRoot(product.platform)),day=product.outputDay||outputDate(product.importedAt||product.capturedAt||this.store.now()),dayFolder=await this.checkFolder(join(root,day)),location=await this.store.mutate(state=>this.store.productLocation(state,product,day));
    const capturedAt=product.capturedAt||product.importedAt||new Date().toISOString(),safeTime=capturedAt.replace(/[^0-9TZ]/gu,''),name=safeTime+'-'+task.id;
    if(!/^[a-zA-Z0-9-]+$/u.test(name))throw new InputError('采集归档编号无效');const productDirectory=await productSubdirectory(dayFolder,location.group,{create:true});let directory=productDirectory;
    const prior=this.records.some(row=>row.archivePath===productDirectory);if(prior){const history=await this.checkFolder(join(productDirectory,'历史采集'));directory=await this.checkFolder(join(history,name));}
    const review=product.collectionReview||this.review(product,(await this.store.readState()).products.filter(row=>row.id!==product.id));
    const record={outputDay:day,productFolder:location.group,dayFolder,id:task.id,taskId:task.id,productId:product.id,platform:product.platform,seatLabel:task.fields?.seatLabel||'',seatLabelSource:seatLabel(product)!=='未标注'?'页面参数/标题':product.visual?.seatEvidence||'未取得',ranking:product.specs?.['榜单排名']||'',sales:product.specs?.['销量标注']||'',...collectionFields(product),model:product.model||'',modelSource:product.modelSource||'',product,specs:product.specs||{},sku:new URL(product.sourceUrl).pathname.split('/').at(-1).replace(/\.html$/u,''),sourceUrl:product.sourceUrl,capturedAt,isRepeat:task.legacy?false:review.isRepeat,note:[task.legacy?'由已有商品资料补建汇总记录':review.note,product.dataQuality?.missing?.length?'资料待补全：'+product.dataQuality.missing.join('、'):''].filter(Boolean).join('；'),relatedSources:review.matches.map(row=>row.sourceUrl).join('；'),archivePath:directory};
    for(const[file,bytes]of[[main.name||productImageName(product,true),main.body],[card.name||productImageName(product),card.body],['product.json',Buffer.from(JSON.stringify({record,product,fields:task.fields||{}},null,2))]]){const target=join(directory,file);let same=false;try{same=(await readFile(target)).equals(bytes);}catch(error){if(error.code!=='ENOENT')throw error;}if(!same)await this.store.atomic(target,bytes);}
    for(let i=1;i<=3;i++){try{const source=join(this.store.root,'cards',product.id,'detail-'+i+'.png'),info=await lstat(source);if(info.isSymbolicLink()||!info.isFile())throw new InputError('细节图文件无效');await this.store.atomic(join(directory,'细节图-'+String(i).padStart(2,'0')+(/未取得/u.test(task.fields?.detailTitles?.[i-1]||'')?'-未取得':'')+'.png'),await readFile(source));}catch(error){if(error.code!=='ENOENT')throw error;}}
    try{const deck=await this.store.file(product.id+'.pptx');await this.store.atomic(join(directory,deck.name||productImageName(product,false,'pptx')),deck.body);}catch(error){if(!(error instanceof InputError&&error.status===404))throw error;}
    if(/^[a-f0-9-]{36}$/u.test(task.id)){const sourceDir=join(this.store.root,'product-tasks',task.id);for(const name of ['source-main.png','source-detail-1.png','source-detail-2.png','source-detail-3.png','source-parameter-1.png','source-parameter-2.png','source-parameter-3.png','image-processing.json','photo-selection.json','selected-photos.json','browser-capture.json',...Array.from({length:8},(_,i)=>'source-gallery-'+(i+1)+'.png')]){try{const path=join(sourceDir,name),info=await lstat(path);if(info.isSymbolicLink()||!info.isFile()||info.size>24*1024*1024|| (await lstat(sourceDir)).isSymbolicLink())throw new InputError('原图归档文件无效');await this.store.atomic(join(directory,name),await readFile(path));}catch(error){if(error.code!=='ENOENT')throw error;}}}
    if(/^[a-f0-9-]{36}$/u.test(task.id))await copyDetailArchive(this.store,task.id,directory);
    this.records.push(record);try{await this.persist();}catch(error){this.records.pop();throw error;}
    await this.writeSummary(product.platform);return record;
  });}
}
