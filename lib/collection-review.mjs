import{normalizeTitle}from'./dedup.mjs';
const normalize=value=>normalizeTitle(value);
export function collectionFields(product){
  const specs=product.specs||{},values=pattern=>Object.entries(specs).filter(([key])=>pattern.test(key)).map(([key,value])=>key+'：'+value).join('；');
  return{title:product.title||'',brand:product.brand||'',model:product.modelSource==='title'?'':product.model||'',color:values(/颜色|色号|色系/u),specification:values(/尺寸|规格|尺码|组合|座位|款式/u)};
}
export function reviewCollection(product,candidates){
  const fields=collectionFields(product),matches=[],seen=new Set();let repeated=false;
  for(const prior of candidates){
    if(prior.platform!==product.platform||seen.has(prior.sourceUrl))continue;
    const previous=collectionFields(prior),sameSource=prior.sourceUrl===product.sourceUrl,sameModel=!!fields.model&&normalize(fields.model)===normalize(previous.model)&&!!fields.brand&&normalize(fields.brand)===normalize(previous.brand),sameTitle=!!fields.title&&!!fields.brand&&normalize(fields.title)===normalize(previous.title)&&normalize(fields.brand)===normalize(previous.brand);
    if(!sameSource&&!sameModel&&!sameTitle)continue;
    const sameConfig=sameModel&&!!fields.color&&!!fields.specification&&normalize(fields.color)===normalize(previous.color)&&normalize(fields.specification)===normalize(previous.specification);
    if(sameSource||sameConfig)repeated=true;
    seen.add(prior.sourceUrl);if(matches.length<3)matches.push({productId:prior.productId||prior.id,sourceUrl:prior.sourceUrl,title:prior.title,reason:sameSource?'同平台同商品编号':sameConfig?'品牌、型号、颜色及规格一致':sameModel?'同品牌型号，配置可能不同':'商品标题一致，型号或配置需比对'});
  }
  return{isRepeat:repeated,similar:matches.length>0,matches,note:matches.length?(repeated?'重复或高度重合，已保留本次资料：':'可能与历史商品相似，已保留本次资料：')+matches.map(row=>row.reason+' · '+row.title).join('；'):''};
}
