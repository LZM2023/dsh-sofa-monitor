import{abortable}from'./desktop-recovery.mjs';
import{publishIncompleteCard}from'./incomplete-card.mjs';
import{DELIVERY_RESERVE_MS}from'./product-budget.mjs';
import{archiveDetailDocument}from'./detail-archive.mjs';
import{saveCaptureCheckpoint}from'./capture-checkpoint.mjs';
import{openLocalProduct}from'./local-product.mjs';
import{photoAssets}from'./photo-assets.mjs';
import{processingFailureKind}from'./automation-policy.mjs';
import{collectionRisk,platformRisk}from'./collection-pacer.mjs';
import{setTimeout as pause}from'node:timers/promises';
import{selectConnectedBrowser}from'./helper-connection.mjs';
import{join}from'node:path';
import{automaticJdAdapter}from'./jd-automatic-reader.mjs';import{productImage}from'./cards.mjs';
import{normalizeProductFacts,applyImageSpecifications,productDataQuality}from'./product-facts.mjs';
export async function runAutomaticProduct(tasks,ctx,exec,id,options={}){if(tasks.automaticRuns.has(id))return{...await tasks.get(id),replayed:true,instructions:'已有执行者，直接返回当前状态，不重复执行，不询问。'};tasks.automaticRuns.add(id);try{return await runClaimedProduct(tasks,ctx,exec,id,options);}finally{tasks.automaticRuns.delete(id);}}
async function runClaimedProduct(tasks,ctx,exec,id,{readImage=productImage,readDetailImage,connector}={}){
 const previous=await tasks.get(id);if(previous.saveMode!=='automatic')throw Error('固定自动执行器只接受automatic任务');
 if(['completed','running'].includes(previous.status))return tasks.start(id);
 let task,capture,detailArchive,process,detailsReviewed=false;const galleryCache=new Map();
 const controller=new AbortController();tasks.controllers.set(id,controller);let signal=AbortSignal.any([exec.signal,controller.signal]);
 try{
  const working=ctx.get('workingDirectory');if(!working||!exec.agent)throw Object.assign(new Error('DSH工作区尚未就绪'),{code:'tool-unavailable'});
  const workspace=await working.ensure(exec.agent,exec.signal);task=await tasks.start(id,{workspace});
  if(task.waiting)return{...task,instructions:'等待后台采集间隔，本次立即返回；不轮询工具，不访问网页，到时插件自动调度。'};
  signal=AbortSignal.any([exec.signal,controller.signal,AbortSignal.timeout(Math.max(1,Math.min(2147483647,(task.processingDeadlineAtMs??task.deadlineAtMs-DELIVERY_RESERVE_MS)-tasks.now())))]);
  process=async(processSignal,retry=false)=>{const signal=processSignal,cleaner=tasks.imageCleaner?.forTask?tasks.imageCleaner.forTask(exec):tasks.imageCleaner;if(retry&&['reading','details'].includes((await tasks.get(id)).recovery?.failedStage)){capture=null;detailArchive=null;detailsReviewed=false;}
  const local=task.localSourceTaskId?await openLocalProduct(tasks,task):null,prefetched=local?.capture||tasks.prefetched.get(id);
  if(connector&&!prefetched){try{const connection=await connector.ensure(ctx,exec,signal);if(connection.phase!=='connected')throw new Error(connection.message);await selectConnectedBrowser(ctx,exec,connection,signal);}catch(error){error.code||='tool-unavailable';throw error;}}
  const readCapture=capture||prefetched||await automaticJdAdapter(ctx,exec,{pause:tasks.pause,pacer:tasks.pacer,collectDetails:!!tasks.detailReview,onCheckpoint:value=>saveCaptureCheckpoint(tasks,task,value)}).capture(task.sourceUrl,signal);signal.throwIfAborted();capture=readCapture;capture.product=normalizeProductFacts(capture.product);await saveCaptureCheckpoint(tasks,task,capture);
  await tasks.store.mutate(state=>{const row=state.productTasks.find(t=>t.id===id);row.readDiagnostics=capture.evidence?.readDiagnostics||{stage:'complete',reusedBatchCapture:!!prefetched,fieldCount:Object.keys(capture.product.specs||{}).length};});
  const draft=await tasks.store.prepareCapture(capture);
  if(tasks.detailReview){
   await tasks.progress(id,'details');const archive=detailArchive=detailArchive||local?.archive||await archiveDetailDocument(tasks,task,capture,{signal,...(readDetailImage?{readImage:readDetailImage}:{})});
   capture.evidence.detailDocument={sourceUrl:task.sourceUrl,rootCount:archive.manifest.rootCount,discoveredImages:archive.manifest.discoveredImages,archiveTaskId:id,textInLocalSnapshot:true};
   await tasks.store.mutate(state=>{const current=state.drafts.find(row=>row.id===draft.id);if(current)current.evidence=capture.evidence;});
   await tasks.progress(id,'analyzing');if(!local?.review&&!detailsReviewed)await tasks.detailReview.inspect(tasks,task,capture,archive,exec,signal);detailsReviewed=true;
   capture.product.detailArchive={taskId:id,savedImages:archive.manifest.images.length,discoveredImages:archive.manifest.discoveredImages,status:archive.manifest.status};
   await tasks.store.mutate(state=>{const current=state.drafts.find(row=>row.id===draft.id);if(current){current.product=capture.product;current.evidence=capture.evidence;}});
  }
  await tasks.progress(id,'images');
  const {createCanvas,loadImage}=await import('@napi-rs/canvas'),buffers=[],sourceUrls=[],gallery=capture.product.visual?.gallery||[];let mainBuffer;
  // No parallel platform downloads and no platform retry on access controls.
  const readLimit=local?0:tasks.photoSelector?8:!tasks.detailReview&&cleaner?.enabled&&cleaner.readSpecifications?3:1;
  for(let i=0;i<Math.min(gallery.length,readLimit);i++){
   const cached=galleryCache.get(gallery[i]);if(cached){buffers.push(cached);sourceUrls.push(gallery[i]);if(i===0&&capture.product.visual?.mainImageAvailable!==false)mainBuffer=cached;continue;}
   if(i)await (tasks.pause||pause)(5000,undefined,{signal});signal.throwIfAborted();
   try{const source=await readImage({collectionPacer:tasks.pacer,readState:async()=>({products:[capture.product]})},capture.product.id,i,{signal}),image=await loadImage(source.body);signal.throwIfAborted();if(!image.width||!image.height||image.width>8192||image.height>8192)continue;const canvas=createCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);const bytes=canvas.toBuffer('image/png');galleryCache.set(gallery[i],bytes);buffers.push(bytes);sourceUrls.push(gallery[i]);if(i===0&&capture.product.visual?.mainImageAvailable!==false)mainBuffer=bytes;if(tasks.photoSelector)await tasks.store.atomic(join(tasks.directory(id),'source-gallery-'+(i+1)+'.png'),bytes);}catch(error){if(signal.aborted||collectionRisk(error))throw error;}
  }
  let photoChoice;if(tasks.photoSelector){await tasks.progress(id,'selecting');photoChoice=await tasks.photoSelector.select(tasks,task,capture,detailArchive,buffers.map((bytes,index)=>({bytes,url:sourceUrls[index]})),exec,signal);mainBuffer=photoChoice.main;await tasks.store.atomic(join(tasks.directory(id),'selected-main.png'),photoChoice.main);for(const [index,detail]of photoChoice.details.entries())await tasks.store.atomic(join(tasks.directory(id),'selected-detail-'+(index+1)+'.png'),detail.bytes);await tasks.store.atomic(join(tasks.directory(id),'selected-photos.json'),JSON.stringify({details:photoChoice.details.map(({part,label})=>({part,label}))}));}
  let imageServiceBlocked=false;const parameterWarnings=[];if(!tasks.detailReview&&buffers.length&&cleaner?.enabled&&cleaner.readSpecifications){try{const read=await cleaner.readSpecifications(buffers,{signal,sourceUrl:task.sourceUrl,selectedConfiguration:Object.entries(capture.product.specs).filter(([key])=>/款式|颜色|尺码|系列/u.test(key)).map(([key,value])=>key+'：'+value).join('；')}),enriched=applyImageSpecifications(capture.product,read.fields.filter(row=>Number.isInteger(row?.imageIndex)&&row.imageIndex>=0&&row.imageIndex<buffers.length));capture.product=enriched.product;capture.evidence.imageParameterRead={model:read.model,imageCount:buffers.length,sourceUrls,accepted:enriched.accepted};for(let i=0;i<buffers.length;i++)await tasks.store.atomic(join(tasks.directory(id),'source-parameter-'+(i+1)+'.png'),buffers[i]);}catch(error){if(signal.aborted)throw error;if([401,403,429].includes(error.status))imageServiceBlocked=true;parameterWarnings.push(String(error.message).slice(0,180));}}
  // Extra source images are read for literal parameters. Detail crops remain
  // explicit; unrelated gallery images must not be presented as close-ups.
  capture.product.visual={...capture.product.visual,imageMissing:!mainBuffer};
  await tasks.progress(id,'editing');const assets=await photoAssets(mainBuffer?[mainBuffer]:[],{cleaner:imageServiceBlocked?null:cleaner,signal,...(photoChoice?{detailSources:photoChoice.details,mainView:photoChoice.mainView,requireProductParts:true}:{})});
  for(const asset of [...assets.files,...assets.originals||[]]){signal.throwIfAborted();tasks.check();await tasks.store.atomic(join(task.outputDir,asset.name),asset.bytes);if(asset.name.startsWith('source-'))await tasks.store.atomic(join(tasks.directory(id),asset.name),asset.bytes);}
  signal.throwIfAborted();tasks.check();await tasks.store.atomic(join(task.outputDir,'image-processing.json'),JSON.stringify({images:assets.metadata,notes:assets.notes,analysis:assets.analysis||null},null,2));
  await tasks.store.atomic(join(tasks.directory(id),'image-processing.json'),JSON.stringify({images:assets.metadata,notes:assets.notes,analysis:assets.analysis||null},null,2));
  if(photoChoice)capture.product.visual={...capture.product.visual,reviewedDetailCount:photoChoice.details.length,mainView:photoChoice.mainView,detailPhotoPolicy:'reviewed-parts'};
  const warnings=[...capture.evidence?.limitations||[],...parameterWarnings,...assets.notes];
  await tasks.store.mutate(state=>{const row=state.productTasks.find(task=>task.id===id);row.imageProcessing=assets.metadata;row.warnings=warnings;const draftRow=state.drafts.find(d=>d.id===draft.id);if(draftRow){if(assets.analysis)capture.product.visual={...capture.product.visual,seatLabel:assets.analysis.seatLabel,seatConfidence:assets.analysis.seatConfidence,imageFacts:[...(capture.product.visual?.imageFacts||[]),...assets.analysis.imageFacts],seatEvidence:'图片视觉识别，非官方参数'};draftRow.product=normalizeProductFacts(capture.product);draftRow.evidence={...capture.evidence,fieldEvidence:draftRow.product.fieldEvidence};row.dataQuality=productDataQuality(draftRow.product);if(row.dataQuality.missing.length)row.warnings.push('未取得：'+row.dataQuality.missing.join('、'));}});
  await tasks.store.atomic(join(task.outputDir,'manifest.json'),JSON.stringify({sourceUrl:task.sourceUrl,model:capture.product.model,fields:{...assets.fields,notes:warnings.join(' ')},files:assets.files.map(row=>row.name)}));
  const result=await tasks.prepared(id,draft.id);return{...result,instructions:result.dataQuality?.level==='partial'?'规格卡已归档，但资料未齐全；必须列出dataQuality.missing，不得仅回复采集成功，不询问重做或另建任务。':'按实际已归档文件和来源简报，不询问后续选择。'};
  };return await abortable(process(signal),signal);
 }catch(error){
  let current=await tasks.get(id);
  if(current.status==='running'&&!exec.signal.aborted){
   const rootSignal=AbortSignal.any([exec.signal,controller.signal]);
   const recovered=await tasks.desktopRecovery.recover(tasks,ctx,exec,current,error,{signal:rootSignal,retry:limited=>process(limited,true)});if(recovered)return recovered;
   current=await tasks.get(id);
   if(current.status==='running'&&!exec.signal.aborted&&current.deadlineAtMs>tasks.now()){
    const failureKind=processingFailureKind(error);await tasks.store.mutate(state=>{const row=state.productTasks.find(r=>r.id===id);row.failureKind=failureKind;row.stopAfterDelivery=failureKind==='fatal'||row.recovery?.blocked===true;});
    try{await tasks.progress(id,'partial-rendering');return await publishIncompleteCard(tasks,current,error,{capture});}catch(deliveryError){error=Object.assign(new Error(String(error.message)+'；已有资料出卡失败：'+String(deliveryError.message),{cause:error}),{code:error.code||'incomplete-delivery-failed'});}
   }
  }
if(['ready','queued','running','cooldown'].includes(current.status)){
   await tasks.pacer.finish(current.networkLeaseId,{risk:platformRisk(error),retryAfterMs:error.retryAfterMs});
   const after=await tasks.get(id),reason=(String(error.message||'自动商品执行失败')+(after.browserCheckpoint?'；已保存阶段资料，未生成规格卡':'')).slice(0,700),diagnostics={errorCode:error.code||'product-processing-failed',failureKind:processingFailureKind(error,{cancelled:exec.signal.aborted}),...(error.readDiagnostics?{readDiagnostics:error.readDiagnostics}:{})},failed=['ready','queued','running','cooldown'].includes(after.status)?await tasks.fail(id,reason,signal.aborted?'timed-out':'action-required',diagnostics):after;
   await tasks.onAutomaticEnded?.(failed);
  }
  // Ordinary failed products have already been accounted for by the batch;
  // return their actual status rather than making the Agent choose a recovery.
  return{...await tasks.get(id),error:String(error.message||'自动商品执行失败').slice(0,700),instructions:'本条已自动处理错误，直接返回实际状态，不询问用户，不重建任务；批次由插件继续或按真实阻断停止。'};
 }finally{tasks.controllers.delete(id);}
}
