import{productSellingPoints}from'./selling-points.mjs';
import{validateTemplate,templateDetailCount}from'./template-schema.mjs';
import{cardRecipe,cardAsset,validateCardFields}from'./cards.mjs';
import{renderStandardCard}from'./card-renderer.mjs';
import{InputError}from'./domain.mjs';
export async function templatePreview(store,raw){
  if(!raw||Object.keys(raw).some(key=>!['template','productId'].includes(key)))throw new InputError('模板预览参数无效');
  let template;try{template=validateTemplate(raw.template);}catch(error){throw new InputError(error.message);}
  if(typeof raw.productId!=='string')throw new InputError('请先采集一个商品，再预览实际效果');
  const recipe=await cardRecipe(store,raw.productId),count=templateDetailCount(template),points=productSellingPoints(recipe.product,recipe.fields,count),main=await cardAsset(store,raw.productId,'main.png'),photos=[main],crops=[],subtitles=[];
  for(let i=0;i<count;i++){let image;try{image=await cardAsset(store,raw.productId,'detail-'+(i+1)+'.png');}catch(error){if(!(error instanceof InputError&&error.status===404))throw error;}photos.push(image||main);crops.push(image?recipe.fields.detailCrops?.[i]||[0,0,1,1]:[[0,.05,.6,.95],[.4,.05,1,.95],[.2,.12,.8,.78]][i]);subtitles.push(((points.detailSubtitles[i]||'')+(!image?'；主图同源裁切':'')).slice(0,80));}
  const fields=validateCardFields({...recipe.fields,...points,detailCrops:crops,detailSubtitles:subtitles,templateDefinition:template});
  return renderStandardCard(recipe.product,fields,photos);
}
