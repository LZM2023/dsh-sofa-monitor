import{readFile,lstat}from'node:fs/promises';
import{join}from'node:path';
import{validateProduct}from'./domain.mjs';
import{pngSize}from'./cards.mjs';
import{safeBrowserError}from'./browser-result.mjs';
import{platformRisk}from'./collection-pacer.mjs';

// Only this task's saved data may be used. Missing photos stay visibly missing.
export async function publishIncompleteCard(tasks,task,error,options={}){
 try{return await publishLocal(tasks,task,error,options);}finally{if(platformRisk(error))await tasks.pacer.finish(task.networkLeaseId,{risk:true,retryAfterMs:error.retryAfterMs});}
}
async function publishLocal(tasks,task,error,{capture}={}){
 const current=await tasks.get(task.id);if(current.status!=='running')throw Error('任务已停止，未接收补全卡片');
 const directory=tasks.directory(task.id),state=await tasks.store.readState();
 const read=async(name,json=false)=>{try{const path=join(directory,name),info=await lstat(path);if(info.isSymbolicLink()||!info.isFile()||info.size>(json?1024*1024:24*1024*1024))return null;const bytes=await readFile(path);return json?JSON.parse(bytes.toString()):bytes;}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return null;throw e;}};
 const saved=await read('browser-capture.json',true),draft=state.drafts.find(row=>row.productTaskId===task.id&&row.product.sourceUrl===task.sourceUrl);
 let product=draft?.product||capture?.product||(saved?.taskId===task.id&&saved.product?.sourceUrl===task.sourceUrl?saved.product:null);
 if(!product)product={...validateProduct({platform:'jd',sourceUrl:task.sourceUrl,title:'商品资料未取得（'+task.sku+'）',brand:'未标注',model:'',specs:{}}),capturedAt:new Date(tasks.now()).toISOString(),provenance:'browser-assisted'};
 if(product.sourceUrl!==task.sourceUrl)throw Error('补全卡片资料不属于本商品');
 const reason=safeBrowserError(error.message||'处理未完成'),parts=await read('selected-photos.json',true),files=[],missing=[];
 const choose=async(names)=>{for(const name of names){const bytes=await read(name);if(!bytes)continue;try{const size=pngSize(bytes);if(size.width&&size.height&&Math.max(size.width,size.height)<=8192)return bytes;}catch{}}return null;};
 let main=await choose(['main.png','selected-main.png','source-main.png','source-gallery-1.png']);
 if(main){await tasks.store.atomic(join(task.outputDir||directory,'main.png'),main);files.push('main.png');}else missing.push('商品主图未取得');
 const titles=[];for(let i=1;i<=3;i++){
  const bytes=await choose(['detail-'+i+'.png',...(parts?.details?.[i-1]?['selected-detail-'+i+'.png']:[])]);
  if(!bytes)continue;const name='detail-'+(titles.length+1)+'.png';await tasks.store.atomic(join(task.outputDir||directory,name),bytes);files.push(name);titles.push(parts?.details?.[i-1]?.label||parts?.details?.[i-1]?.part||'已取得细节原图');
 }
 while(titles.length<2){titles.push('细节图未取得');missing.push('细节图'+titles.length+'未取得');}
 product={...product,incompleteDelivery:{reason,missing,failedStage:current.recovery?.failedStage||current.progressStage}};
 const prepared=await tasks.store.prepareCapture({product,evidence:{...(draft?.evidence||capture?.evidence||saved?.evidence||{}),incompleteDelivery:{errorCode:error.code||'product-processing-failed',reason,recovery:current.recovery||null}}});
 await tasks.store.atomic(join(task.outputDir||directory,'manifest.json'),JSON.stringify({sourceUrl:task.sourceUrl,model:product.model||product.title,fields:{deliveryIncomplete:true,detailTitles:titles,detailSubtitles:titles.map(title=>title==='细节图未取得'?'商品图片未取得':'已取得的原图'),mainAnnotation:main?'主图 | 已取得原图，流程未完成':'主图 | 未取得',notes:'本卡资料不完整。停止原因：'+reason+'。缺失项目保留未取得，未补造参数或照片。'},files}));
 await tasks.store.mutate(next=>{const row=next.productTasks.find(r=>r.id===task.id);row.fallbackDelivery=true;if(error.readDiagnostics)row.readDiagnostics=error.readDiagnostics;row.errorCode=error.code||'product-processing-failed';row.originalError={code:error.code||'product-processing-failed',message:reason};});
 return tasks.prepared(task.id,prepared.id);
}
