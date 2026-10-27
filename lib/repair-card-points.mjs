import{readFile}from'node:fs/promises';
import{join}from'node:path';
import{genericFeature}from'./selling-points.mjs';
import{automaticCardData,automaticPhotos}from'./automatic-card.mjs';
import{cardAsset,saveCard,validateCardFields}from'./cards.mjs';
import{renderStandardCard}from'./card-renderer.mjs';

// Repair presentation only, using already saved official facts and images.
// Historical capture bundles, source facts, names and creation times stay intact.
export async function repairCardPoints(store){
 const repaired=[],skipped=[];
 for(const product of (await store.readState()).products){
  let metadata;try{metadata=JSON.parse(await readFile(join(store.root,'cards',product.id+'.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;skipped.push({id:product.id,reason:'规格卡元数据无法读取'});continue;}
  if(metadata.deliveryIncomplete||metadata.sourceUrl!==product.sourceUrl||!metadata.features?.some(genericFeature))continue;
  try{const normalized=automaticCardData(product,{...metadata,price:undefined},{detailCount:metadata.features.length}),photos=await automaticPhotos({id:product.id},(_task,name)=>cardAsset(store,product.id,name),normalized.fields),fields=validateCardFields(photos.fields),rendered=await renderStandardCard(normalized.product,fields,photos.photos);await saveCard(store,product.id,'card',rendered.bytes,fields);repaired.push({id:product.id,file:product.id+'.png',sellingPoints:fields.sellingPoints});}
  catch(error){skipped.push({id:product.id,reason:'已保留原图；自动修复未完成'});}
 }
 return{repaired,skipped};
}
