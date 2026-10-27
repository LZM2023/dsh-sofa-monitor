// File names are display names. Stable image IDs remain the product association.
export function firstProductModel(value){
  const first=String(value||'').split(/[/／、,，;；|｜+＋&\r\n]+|\s+(?:或|和|及)\s+/u).map(part=>part.trim()).find(Boolean)||'';
  const codes=first.split(/\s+/u);
  return codes.length>1&&codes.every(code=>/^(?=.*\d)[a-z0-9._-]+$/iu.test(code))?codes[0]:first;
}
function part(value,fallback,max){
  const clean=String(value||fallback).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/gu,' ').replace(/\s+/gu,' ').trim().replace(/[. ]+$/u,'');
  return(clean||fallback).slice(0,max).replace(/[\uD800-\uDBFF]$/u,'');
}
export function productImageName(product,main=false,extension='png'){
  const brand=part(product.brand,'未标注品牌',28),model=part((product.modelSource==='title'?product.model:firstProductModel(product.model))||product.title,'未标注型号',65);
  return brand+'-'+model+'-'+(main?'主图':'产品规格卡')+'.'+extension;
}
export function uniqueImageName(wanted,entries,current=''){
  const occupied=new Set(entries.filter(name=>name!==current).map(name=>name.toLowerCase()));
  if(!occupied.has(wanted.toLowerCase()))return wanted;
  const dot=wanted.lastIndexOf('.'),stem=wanted.slice(0,dot),ext=wanted.slice(dot);
  for(let i=2;i<10000;i++){const name=stem+' ('+i+')'+ext;if(!occupied.has(name.toLowerCase()))return name;}
  throw Error('同名图片数量过多，请整理文件后重试');
}
