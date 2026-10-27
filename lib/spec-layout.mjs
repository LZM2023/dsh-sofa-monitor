import{drawTemplateCard}from'./template-layout.mjs';
export const CARD_TEMPLATE='reference-gold';
export function validateCardRecipe(recipe,images){
  const p=recipe.product,f=recipe.fields,missing=[];
  if(!p.model)missing.push('型号');if(!f.dimensions)missing.push('尺寸');if(!(f.price===null&&f.priceLabel==='未标注')&&(!Number.isFinite(f.price)||f.price<=0))missing.push('到手价');if(!Number.isFinite(Date.parse(f.priceAt)))missing.push('价格时间');
  if(!images[0])missing.push('完整主图');if(images.length<3||images.length>4||f.features?.length!==images.length-1)missing.push('2至3张细节图及对应卖点');
  if(images.some(i=>!(i.naturalWidth||i.width)||!(i.naturalHeight||i.height)))missing.push('可读取的有效图片');
  if(missing.length)throw Error('暂不能出卡，请补齐：'+missing.join('、'));
}
export function drawSpecCard(recipe,images,canvas){validateCardRecipe(recipe,images);return drawTemplateCard(recipe,images,canvas);}
