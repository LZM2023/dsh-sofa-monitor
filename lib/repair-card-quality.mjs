import{seatLabel}from'./seat-label.mjs';
import {mkdir,readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {automaticCardData,automaticPhotos} from './automatic-card.mjs';
import {cardAsset,saveCard,validateCardFields} from './cards.mjs';
import {renderStandardCard} from './card-renderer.mjs';
import {productImageName} from './image-names.mjs';
import {collectionFields} from './collection-review.mjs';

// One-time local repair of previously generated automatic cards. It never
// navigates, downloads images, invokes a model, or rewrites original evidence.
export async function repairCardQuality(store,archive){
 const repaired=[],skipped=[];
 for(const product of (await store.readState()).products){
  if(product.saveMode!=='automatic'||product.qualityRepairVersion===1)continue;
  let saved;try{saved=JSON.parse(await readFile(join(store.root,'cards',product.id+'.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(saved.sourceUrl!==product.sourceUrl)continue;
  try{
   const folder=join(store.root,'repairs','0.1.31',product.id);await mkdir(folder,{recursive:true});
   for(const path of[join(store.root,'repairs'),join(store.root,'repairs','0.1.31'),folder])if((await lstat(path)).isSymbolicLink())throw Error('修复备份目录不能是链接');
   const once=async(name,bytes)=>{try{await lstat(join(folder,name));}catch(error){if(error.code!=='ENOENT')throw error;await store.atomic(join(folder,name),bytes);}};
   const current=await store.file(product.id+'.png');await once('card-before.png',current.body);await once('product-before.json',JSON.stringify(product,null,2));await once('metadata-before.json',JSON.stringify(saved,null,2));
   let input=product;
   try{const receipt=JSON.parse(await readFile(join(store.root,'repairs','verified-parameters',product.id+'.json'),'utf8'));if(receipt.sourceUrl===product.sourceUrl&&receipt.expectedCapturedAt===product.capturedAt&&Number.isFinite(Date.parse(receipt.observedAt))&&Date.parse(receipt.observedAt)>=Date.parse(product.capturedAt)&&Array.isArray(receipt.rows)&&receipt.rows.length<=30&&receipt.rows.every(row=>Array.isArray(row)&&row.length===2&&row.every(value=>typeof value==='string'&&value.length<=500)&&row[0].length<=40&&!['__proto__','prototype','constructor'].includes(row[0]))){const selected=(Array.isArray(receipt.selectedRows)?receipt.selectedRows:[]).filter(row=>Array.isArray(row)&&['尺寸','款式','系列品','颜色','尺码'].includes(row[0])&&typeof row[1]==='string'&&row[1].length<=200),specs={...product.specs,...Object.fromEntries([...receipt.rows,...selected])},fieldEvidence={...product.fieldEvidence};for(const[key,value]of receipt.rows)fieldEvidence['specs.'+key]={kind:'official-parameter',quote:key+'：'+value,observedAt:receipt.observedAt};for(const[key,value]of selected)fieldEvidence['specs.'+key]={kind:'selected-option',quote:key+'：'+value,observedAt:receipt.observedAt};await once('verified-parameters.json',JSON.stringify(receipt,null,2));input={...product,specs,fieldEvidence,parameterVerification:{sourceUrl:receipt.sourceUrl,observedAt:receipt.observedAt}};}}catch(error){if(error.code!=='ENOENT')throw error;}
   const notes=String(saved.notes||'').replace(/未取得官方型号，型号栏使用商品标题。|官方尺寸未标注。|座位规格按原图视觉识别，非官方参数。/gu,'');
   const normalized=automaticCardData(input,{...saved,notes,price:undefined},{detailCount:saved.features.length}),photos=await automaticPhotos({id:product.id},(_task,name)=>cardAsset(store,product.id,name),normalized.fields),fields=validateCardFields(photos.fields),rendered=await renderStandardCard(normalized.product,fields,photos.photos);
   await store.mutate(state=>{const index=state.products.findIndex(row=>row.id===product.id);if(state.products[index].capturedAt!==product.capturedAt)throw Error('商品正在更新，未接收旧修复');state.products[index]={...normalized.product,qualityRepairPending:true};});
   await saveCard(store,product.id,'card',rendered.bytes,fields);
   for(const [id,main]of[[product.id+'.png',false],[product.id+'-01.png',true]])if((await store.readState()).artifacts[id]?.nameSource!=='user')await store.renameImageWithOrigin({name:id,newName:productImageName(normalized.product,main)},'automatic');
   const task=(await store.readState()).productTasks.find(row=>row.productId===product.id&&row.status==='completed');
   if(archive&&task){await archive.serial(async()=>{
    const index=archive.records.findIndex(row=>row.taskId===task.id);if(index<0)return;const old=archive.records[index];await once('archive-record-before.json',JSON.stringify(old,null,2));
    const row={...old,...collectionFields(normalized.product),model:normalized.product.model,modelSource:normalized.product.modelSource,seatLabel:fields.seatLabel,seatLabelSource:seatLabel(normalized.product)!=='未标注'?'页面参数/标题':normalized.product.visual?.seatEvidence||'未取得',note:[old.note,normalized.product.dataQuality.missing.length?'资料待补全：'+normalized.product.dataQuality.missing.join('、'):''].filter(Boolean).join('；'),product:normalized.product,specs:normalized.product.specs,dataQuality:normalized.product.dataQuality};archive.records[index]=row;
    try{await archive.persist();await archive.writeSummary(row.platform);}catch(error){archive.records[index]=old;throw error;}
   });}
   await store.mutate(state=>{const row=state.products.find(p=>p.id===product.id);delete row.qualityRepairPending;row.qualityRepairVersion=1;if(task){const item=state.productTasks.find(t=>t.id===task.id);item.fields=fields;item.dataQuality=normalized.product.dataQuality;item.dataConflicts=normalized.product.dataConflicts;item.message=item.dataQuality.level==='partial'?'规格卡已修正；未取得：'+item.dataQuality.missing.join('、'):'规格卡已按新规则修正';item.warnings=[...new Set([...(item.warnings||[]),'未取得：'+item.dataQuality.missing.join('、')].filter(value=>value!=='未取得：'))];}});
   repaired.push({id:product.id,file:product.id+'.png',brand:normalized.product.brand,model:normalized.product.model,missing:normalized.product.dataQuality.missing});
  }catch(error){skipped.push({id:product.id,reason:String(error.message).slice(0,160)});}
 }
 return{repaired,skipped};
}
