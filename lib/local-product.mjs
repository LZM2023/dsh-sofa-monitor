import{readFile,lstat,mkdir}from'node:fs/promises';
import{join}from'node:path';
import{createHash}from'node:crypto';
import{InputError}from'./domain.mjs';
import{applyImageSpecifications,normalizeProductFacts}from'./product-facts.mjs';

// A model repair may reuse verified source files. It cannot revive a browser
// failure, platform restriction, cancelled job, or an archive from another SKU.
export async function localProductSource(tasks,sourceId,sourceUrl,{reuseReview=false}={}){
 const source=await tasks.get(sourceId);
 if(source.saveMode!=='automatic'||(reuseReview?source.status!=='completed':source.status!=='action-required'||!['detail-review-failed','photo-review-failed'].includes(source.errorCode))||source.batchId||source.sourceUrl!==sourceUrl)throw new InputError('此任务不符合本地恢复条件',409);
 const directory=tasks.directory(source.id),folder=join(directory,'details');
 for(const path of[tasks.store.root,join(tasks.store.root,'product-tasks'),directory,folder])if((await lstat(path)).isSymbolicLink())throw new InputError('本地恢复目录不能是链接');
 const read=async path=>{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw new InputError('本地资料文件无效');return JSON.parse(await readFile(path,'utf8'));};
 const checkpoint=await read(join(directory,'browser-capture.json')),manifest=await read(join(folder,'snapshot.json'));
 if(checkpoint.taskId!==source.id||checkpoint.evidence?.readDiagnostics?.stage!=='complete'||checkpoint.product?.sourceUrl!==sourceUrl||manifest.taskId!==source.id||manifest.sourceUrl!==sourceUrl||manifest.status!=='complete'||!Array.isArray(manifest.images)||!manifest.images.length||manifest.images.length>64||manifest.failures.length)throw new InputError('本地详情存档未完整保存，不能用于恢复');
 let total=0;const images=new Map();
 for(const row of manifest.images){
  if(!/^detail-original-[0-9]{2}\.(?:png|jpg|webp|avif|gif)$/u.test(row.file)||images.has(row.file))throw new InputError('本地原图索引无效');
  const path=join(folder,row.file),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)throw new InputError('本地原图文件无效');
  const bytes=await readFile(path);total+=bytes.length;if(total>48*1024*1024||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new InputError('本地原图校验失败，未使用被修改的文件');images.set(row.file,bytes);
 }
 const capture={product:checkpoint.product,evidence:{...checkpoint.evidence,readDiagnostics:{...checkpoint.evidence.readDiagnostics,resumedFromLocalArchive:source.id,additionalPlatformRequests:0}}};let review;
 if(reuseReview){review=await read(join(folder,'review.json'));if(review.status!=='completed'||review.sourceUrl!==sourceUrl||!Array.isArray(review.receipts)||review.receipts.length>32||!Array.isArray(review.fields)||review.fields.length>200||!Array.isArray(review.sellingPoints)||review.sellingPoints.length>192||!Array.isArray(review.photoCandidates)||review.photoCandidates.length>192)throw new InputError('本地模型核对记录无效');
  const tiles=review.receipts.flatMap(row=>row.images||[]),maxImages=tiles.length;if(!maxImages||maxImages>128||tiles.some((tile,index)=>tile.index!==index||!manifest.images.some(row=>row.file===tile.file&&row.sha256===tile.sourceSha256)||!Array.isArray(tile.box)||tile.box.length!==4||tile.box.some(v=>!Number.isFinite(v)||v<0)))throw new InputError('模型核对记录不属于本地原图');
  if(review.photoCandidates.some(row=>!images.has(row.file)||!['main','detail'].includes(row.kind)||!Array.isArray(row.sourceBox)||row.sourceBox.length!==4||row.sourceBox.some(v=>!Number.isFinite(v)||v<0)))throw new InputError('本地选图记录无效');
  const enriched=applyImageSpecifications(capture.product,review.fields,{maxImages});for(const row of enriched.accepted){const tile=tiles[row.imageIndex];Object.assign(enriched.product.fieldEvidence['specs.'+row.field],{sourceFile:tile.file,sourceSha256:tile.sourceSha256,box:tile.box,model:review.model});}
  const facts=review.sellingPoints.filter(row=>Number.isInteger(row.imageIndex)&&row.imageIndex>=0&&row.imageIndex<maxImages&&typeof row.text==='string'&&row.text.length<=100&&typeof row.quote==='string'&&row.quote.length<=240&&row.text.trim()&&row.quote.replace(/\s/gu,'').includes(row.text.replace(/\s/gu,'')));
  capture.product=normalizeProductFacts({...enriched.product,visual:{...enriched.product.visual,imageFacts:facts}});capture.product.detailReview={model:review.model,modelName:review.modelName,provider:review.provider,revision1017Verified:review.revision1017Verified,submittedImages:review.submittedImages,archivedImages:images.size,complete:review.complete,accepted:enriched.accepted.length,sellingPoints:facts.length,reusedFromLocalReview:source.id};capture.evidence.detailReview=capture.product.detailReview;capture.evidence.photoCandidates=review.photoCandidates;
 }
 return{capture,manifest,images,review};
}
export async function openLocalProduct(tasks,task){
 const source=await localProductSource(tasks,task.localSourceTaskId,task.sourceUrl,{reuseReview:task.reuseLocalReview===true}),folder=join(tasks.directory(task.id),'details');await mkdir(folder,{recursive:true});if((await lstat(folder)).isSymbolicLink())throw new InputError('详情目标目录不能是链接');
 for(const[file,bytes]of source.images)await tasks.store.atomic(join(folder,file),bytes);
 const manifest={...source.manifest,taskId:task.id,localSourceTaskId:task.localSourceTaskId};
 await tasks.store.atomic(join(folder,'snapshot.json'),JSON.stringify(manifest,null,2));
 if(source.review)await tasks.store.atomic(join(folder,'review.json'),JSON.stringify({...source.review,reusedFromLocalReview:task.localSourceTaskId},null,2));
 // The original safe HTML contains only relative original-image filenames.
 const originalHtml=join(tasks.directory(task.localSourceTaskId),'details','index.html'),info=await lstat(originalHtml);if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw new InputError('本地详情索引无效');await tasks.store.atomic(join(folder,'index.html'),await readFile(originalHtml));
 await tasks.store.mutate(state=>{state.productTasks.find(row=>row.id===task.id).detailArchive={directory:folder,index:join(folder,'index.html'),savedImages:manifest.images.length,discoveredImages:manifest.discoveredImages,status:manifest.status,localSourceTaskId:task.localSourceTaskId};});
 if(source.review)await tasks.store.mutate(state=>{state.productTasks.find(row=>row.id===task.id).detailReview=source.capture.product.detailReview;});
 return{capture:source.capture,review:source.review,archive:{folder,manifest,read:async row=>{const bytes=source.images.get(row.file);if(!bytes)throw new InputError('原图不属于本地索引');return bytes;}}};
}
