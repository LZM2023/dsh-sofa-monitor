import{mkdir,lstat,readFile}from'node:fs/promises';
import{setTimeout as wait}from'node:timers/promises';
import{join}from'node:path';
import{createHash}from'node:crypto';
import{collectionRisk}from'./collection-pacer.mjs';
import{automationError}from'./automation-policy.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function selectDetailSources(images,limit=24){
 if(images.length<=limit)return images.map((row,index)=>({...row,sourceOrder:row.order??index}));
 const selected=new Set(),add=index=>{if(index>=0&&index<images.length&&selected.size<limit)selected.add(index);};
 images.forEach((row,index)=>{if(/尺寸|规格|参数|座深|坐深|座高|座宽/u.test(row.label||''))add(index);});
 add(0);add(1);for(let index=images.length-1;index>=Math.max(0,images.length-8);index--)add(index);
 for(let n=0;n<limit;n++)add(Math.round(n*(images.length-1)/(limit-1)));for(let i=0;i<images.length;i++)add(i);
 return[...selected].sort((a,b)=>a-b).map(index=>({...images[index],sourceOrder:images[index].order??index}));
}
export function officialDetailUrl(raw){const url=new URL(raw);if(url.protocol!=='https:'||!/^img[0-9]{1,2}\.360buyimg\.com$/u.test(url.hostname)||!url.pathname.includes('/jfs/')||url.username||url.password||url.port||url.search||url.hash)throw Error('详情图片来源无效');return url.href;}
export async function downloadDetailImage(url,{signal,pacer,fetcher=fetch}={}){
 officialDetailUrl(url);await pacer?.assertOpen();signal?.throwIfAborted();
 const response=await fetcher(url,{signal,redirect:'error',headers:{Accept:'image/avif,image/webp,image/png,image/jpeg,image/gif'}});
 if([403,429].includes(response.status))throw automationError('verification-required','官方详情图片被拒绝，已停止本条访问');
 const type=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();if(!response.ok||!['image/jpeg','image/png','image/webp','image/avif','image/gif'].includes(type))throw Error('详情原图读取失败（HTTP '+response.status+'，类型 '+(type||'未提供')+'）');
 let size=0;const chunks=[];for await(const part of response.body){size+=part.length;if(size>8*1024*1024)throw Error('单张详情原图超过8MB');chunks.push(Buffer.from(part));}return{body:Buffer.concat(chunks),type};
}
export async function archiveDetailDocument(tasks,task,capture,{signal,readImage=downloadDetailImage}={}){
 const folder=join(tasks.directory(task.id),'details');await mkdir(folder,{recursive:true});if((await lstat(folder)).isSymbolicLink())throw Error('详情存档目录不能是链接');
 const doc=capture.evidence?.detailDocument||{sourceUrl:task.sourceUrl,section:'商品详情',images:[],text:'',rootCount:0};
 if(doc.sourceUrl!==task.sourceUrl||!Array.isArray(doc.images)||doc.images.length>64)throw Error('详情资料不属于本次商品');
 const manifest={version:1,taskId:task.id,sourceUrl:task.sourceUrl,title:capture.product.title,capturedAt:capture.product.capturedAt,parameters:capture.product.specs,text:doc.text||'',rootCount:doc.rootCount,discoveredImages:doc.discoveredImages??doc.images.length,limits:{maxImages:64,maxBytes:48*1024*1024},images:[],failures:[],status:'archiving'};
 const save=async()=>{
  await tasks.store.atomic(join(folder,'snapshot.json'),JSON.stringify(manifest,null,2));
  const html='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>商品详情存档</title><style>body{font:16px system-ui;max-width:1000px;margin:32px auto;color:#20242a}img{max-width:100%;height:auto}pre{white-space:pre-wrap}figure{margin:24px 0;border-top:1px solid #ddd;padding-top:16px}</style><h1>'+escape(manifest.title)+'</h1><p>'+escape(task.sourceUrl)+'</p><p>采集：'+escape(manifest.capturedAt)+' · 原图 '+manifest.images.length+' / 发现 '+manifest.discoveredImages+'</p><pre>'+escape(JSON.stringify(manifest.parameters,null,2))+'</pre><pre>'+escape(manifest.text)+'</pre>'+manifest.images.map(row=>'<figure><figcaption>'+escape(row.file+' · '+(row.label||'官方详情原图'))+'</figcaption><img loading="lazy" src="'+row.file+'"></figure>').join('');
  await tasks.store.atomic(join(folder,'index.html'),html);
  await tasks.store.mutate(state=>{const row=state.productTasks.find(t=>t.id===task.id);if(row)row.detailArchive={directory:folder,index:join(folder,'index.html'),savedImages:manifest.images.length,discoveredImages:manifest.discoveredImages,status:manifest.status};});
 };
 await save();let total=0;
 for(const [index,row]of selectDetailSources(doc.images,64).entries()){
  if(index)await (tasks.pause||wait)(5000,undefined,{signal});signal.throwIfAborted();
  try{officialDetailUrl(row.url);const source=await readImage(row.url,{signal,pacer:tasks.pacer});if(total+source.body.length>manifest.limits.maxBytes){manifest.failures.push({index,reason:'详情原图达到48MB存档上限'});break;}const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif','image/gif':'gif'}[source.type];if(!ext)throw Error('详情原图格式无效');const file='detail-original-'+String(index+1).padStart(2,'0')+'.'+ext;await tasks.store.atomic(join(folder,file),source.body);total+=source.body.length;manifest.images.push({index,sourceOrder:row.sourceOrder,file,label:String(row.label||'').slice(0,100),sourceUrl:row.url,...(source.type==='image/gif'?{animationFramePolicy:'first-frame-for-analysis',originalAnimationPreserved:true}:{}),bytes:source.body.length,sha256:createHash('sha256').update(source.body).digest('hex')});await save();}
  catch(error){manifest.failures.push({index,reason:String(error.message).slice(0,160)});if(signal.aborted||collectionRisk(error)){manifest.status='interrupted';await save();throw error;}await save();}
 }
 manifest.status=manifest.images.length>0&&manifest.images.length===manifest.discoveredImages&&!doc.truncated&&!manifest.failures.length?'complete':'partial';await save();
 await tasks.store.mutate(state=>{const row=state.productTasks.find(t=>t.id===task.id);row.detailArchive={directory:folder,index:join(folder,'index.html'),savedImages:manifest.images.length,discoveredImages:manifest.discoveredImages,status:manifest.status};});
 return{folder,manifest,read:async row=>{const path=join(folder,row.file);if((await lstat(path)).isSymbolicLink())throw Error('详情原图不能是链接');return readFile(path);}};
}

export async function copyDetailArchive(store,taskId,destination){
 if(!/^[a-f0-9-]{36}$/u.test(taskId))throw Error('详情任务编号无效');
 const source=join(store.root,'product-tasks',taskId,'details');let data;
 try{const path=join(source,'snapshot.json');if((await lstat(source)).isSymbolicLink()||(await lstat(path)).isSymbolicLink())throw Error('详情存档不能是链接');data=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}
 const target=join(destination,'details');await mkdir(target,{recursive:true});if((await lstat(target)).isSymbolicLink())throw Error('详情归档目录不能是链接');
 if(data.taskId!==taskId||!Array.isArray(data.images)||data.images.length>64)throw Error('详情存档索引无效');
 const files=['snapshot.json','index.html','review.json','review-prompt.txt',...data.images.map(row=>{if(!/^detail-original-[0-9]{2}\.(?:png|jpg|webp|avif|gif)$/u.test(row.file))throw Error('详情原图文件名无效');return row.file;})];
 for(const name of files){try{const path=join(source,name),info=await lstat(path);if(info.isSymbolicLink()||!info.isFile()||info.size>(name.endsWith('.json')?1024*1024:8*1024*1024))throw Error('详情文件无效或过大');await store.atomic(join(target,name),await readFile(path));}catch(error){if(error.code!=='ENOENT')throw error;}}
}
